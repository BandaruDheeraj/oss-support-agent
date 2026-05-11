/**
 * Pipeline orchestrator for live mode.
 *
 * Branches on triage routing:
 *   - clarify   -> comment posted by triage; pipeline stops
 *   - route_fork -> direct fix (skip-PM-gate or low-complexity bug)
 *   - route_pm  -> PM design loop (Gmail) -> fix
 *   - route_docs -> docs agent (no PM design loop)
 *
 * Around fix+sandbox+eval, applies the retry loop up to manifest.max_retries.
 * On max-retries exceeded: labels upstream issue agent-failed and emails PM.
 */

import * as path from 'path';

import type { RepoAdapter } from '../core/adapter.interface';
import type { Manifest } from '../core/manifest/types';
import { runTriage } from '../core/agents/triage';
import type { TriageInput } from '../core/agents/triage-types';
import { createForkAndBranch } from '../core/fork-manager';
import { runFixAgent } from '../core/agents/fix';
import { runBuildAgent } from '../core/agents/build';
import { runDocsAgent } from '../core/agents/docs';
import type {
  ConfirmedIssue,
  FixAgentInput,
  ModuleCommit,
  ModuleFile,
} from '../core/agents/fix-types';
import type { BuildAgentInput, ReferenceModule } from '../core/agents/build-types';
import type { DocsAgentInput } from '../core/agents/docs-types';
import { OpenRouterFixGenerator } from '../core/llm/openrouter-fix-generator';
import { OpenRouterScaffoldGenerator } from '../core/llm/openrouter-scaffold-generator';
import { createDefaultTriageClassifier } from '../core/llm/openrouter-triage-classifier';
import type { IssueEvent } from '../core/webhook/types';

import { scoreDesign } from '../core/agents/pm';
import {
  HeuristicBriefGenerator,
  HeuristicFollowUpGenerator,
  formatDesignBriefEmail,
  extractDecisions,
  summarizeAgreedDesign,
  processReply,
  sendDesignBrief,
} from '../core/pm-email-loop';
import { OpenRouterPMFollowUpGenerator } from '../core/llm/openrouter-pm-followup-generator';
import type { FollowUpGenerator } from '../core/pm-email-types';
import type { PMEmailLoopConfig, DesignBriefInput } from '../core/pm-email-types';
import { detectApproval } from '../core/gmail-mcp';

import {
  runRetryLoop,
  injectRetryContextForFixAgent,
  injectRetryContextForBuildAgent,
} from '../core/retry-loop';
import type { RetryLoopConfig } from '../core/retry-loop-types';

import { GitHubRestClient } from './clients/github-rest';
import type { IssueCommenter } from '../core/agents/triage-types';
import { LocalWorkspace } from './clients/local-workspace';
import { LocalForkCommitter, LocalRepoFileReader } from './clients/local-fork-deps';
import { runLocalSandbox } from './clients/local-sandbox';
import type { LiveDeps } from './clients/live-deps';
import {
  InMemorySweepStateStore,
  listOpenIssues,
  getIssueDetails,
} from './clients/issue-sweep-deps';
import {
  HeuristicIssueSweeper,
  runIssueSweep,
  processScopeReply,
} from '../core/issue-sweep';
import type { ScopeConfirmationConfig } from '../core/issue-sweep-types';
import { GitHubActionsClient } from './clients/github-actions';
import { ensureRegressionWorkflowOnFork, ensureRegressionWorkflowOnBranch, ensureUsabilityWorkflowOnFork, ensureUsabilityWorkflowOnBranch } from './clients/fork-workflow-installer';
import {
  runRegressionGuard,
  createRegressionConfig,
  generateRegressionSummary,
} from '../core/agents/regression-guard';
import {
  runUsabilityAgent,
  DEFAULT_USABILITY_TIMEOUT_MINUTES,
} from '../core/agents/usability-index';
import type { UsabilityAgentInput } from '../core/agents/usability-types';
import { GHAUsabilityExerciser } from './clients/gha-usability-exerciser';
import { inferUsabilityIntrospection } from './clients/usability-introspect';

/** Module-level sweep state store. Keyed by per-run sweep runId; no cross-run conflicts. */
const sweepStateStore = new InMemorySweepStateStore();

export interface PipelineDeps {
  token: string;
  forkOrg: string;
  workspaceRoot: string;
  authorName: string;
  authorEmail: string;
  log: (msg: string) => void;
  /** Optional bundle of Gmail/state/PM deps for the full design + retry path. */
  live?: LiveDeps;
}

export type PipelineResult =
  | { status: 'skipped'; reason: string }
  | { status: 'commented'; reason: string }
  | { status: 'fix-failed'; reason: string }
  | { status: 'sandbox-failed'; reason: string; logsPath?: string }
  | { status: 'max-retries-exceeded'; reason: string }
  | { status: 'pr-opened'; prUrl: string; prNumber: number };

function buildTriageInput(payload: IssueEvent, manifest: Manifest, repoTree: string[]): TriageInput {
  const labels = (payload.issue.labels ?? []).map((l) => l.name);
  return {
    number: payload.issue.number,
    title: payload.issue.title ?? '',
    body: payload.issue.body ?? '',
    labels,
    author: payload.issue.user?.login ?? 'unknown',
    repoTree,
    hasSkipPmGate: !!manifest.skip_pm_gate_label && labels.includes(manifest.skip_pm_gate_label),
    url: `https://github.com/${payload.repository.full_name}/issues/${payload.issue.number}`,
  };
}

/**
 * Extract file paths from a destructive_rewrite retry context. The error
 * message produced by fix.ts is of the form:
 *
 *   Fix agent returned destructive whole-file rewrite(s):
 *     - path/to/file.py: reason ...
 *     - other/file.ts: reason ...
 *   When using action="modify" ...
 *
 * We parse out the paths so the retry loop can augment moduleSource with the
 * actual file content next time around — the LLM otherwise re-attempts a
 * blind whole-file rewrite because the file isn't in the sampled moduleSource.
 *
 * Exported for testing.
 */
export function extractDestructivePaths(retryContext: string): string[] {
  if (!retryContext.includes('destructive whole-file rewrite')) return [];
  const paths: string[] = [];
  for (const line of retryContext.split('\n')) {
    const m = line.match(/^\s*-\s+([^\s:]+(?:\.[A-Za-z0-9]+)?):/);
    if (m && m[1]) paths.push(m[1]);
  }
  return paths;
}

/**
 * Read the actual content of files that a previous fix attempt destroyed and
 * merge them into the FixAgentInput's moduleSource. This ensures that on
 * retry, the LLM sees the full original file (not the sampled approximation
 * gatherModuleFiles produced), giving it a chance to produce a surgical patch.
 */
async function augmentModuleSourceWithFiles(
  baseInput: FixAgentInput,
  paths: string[],
  workspace: LocalWorkspace
): Promise<FixAgentInput> {
  if (paths.length === 0) return baseInput;
  const reader = new LocalRepoFileReader(workspace);
  const have = new Set(baseInput.moduleSource.map((f) => f.path));
  const added: ModuleFile[] = [];
  for (const p of paths) {
    if (have.has(p)) continue;
    try {
      const content = await reader.readFile(baseInput.forkFullName, baseInput.branchName, p);
      added.push({ path: p, content: content.slice(0, 200_000) });
      have.add(p);
    } catch {
      /* file missing; skip */
    }
  }
  if (added.length === 0) return baseInput;
  return { ...baseInput, moduleSource: [...baseInput.moduleSource, ...added] };
}

function gatherModuleFiles(workspace: LocalWorkspace, modulePath: string): ModuleFile[] {
  const files: ModuleFile[] = [];
  const candidates = workspace.listFiles(modulePath);
  for (const f of candidates) {
    if (/\.(test|spec)\.(ts|js|py)$/i.test(f)) continue;
    if (!/\.(ts|tsx|js|jsx|py|go|rs|java|md|yml|yaml)$/i.test(f)) continue;
    try {
      const content = workspace.readFile(f);
      files.push({ path: f, content: content.slice(0, 50_000) });
    } catch {
      /* skip */
    }
  }
  return files.slice(0, 30);
}

function gatherTestFiles(workspace: LocalWorkspace, modulePath: string): ModuleFile[] {
  const candidates = workspace.listFiles(modulePath);
  const tests: ModuleFile[] = [];
  for (const f of candidates) {
    if (!/\.(test|spec)\.(ts|js|py)$/i.test(f)) continue;
    try {
      tests.push({ path: f, content: workspace.readFile(f).slice(0, 50_000) });
    } catch {
      /* skip */
    }
  }
  return tests;
}

function gatherDocFiles(workspace: LocalWorkspace, modulePath: string): ModuleFile[] {
  const candidates = workspace.listFiles(modulePath);
  const docs: ModuleFile[] = [];
  const docExt = /\.(md|mdx|rst|txt|adoc)$/i;
  const docNames = /(^|\/)(README|CHANGELOG|CONTRIBUTING|MIGRATION|UPGRADING|SECURITY)/i;
  for (const f of candidates) {
    if (!docExt.test(f) && !docNames.test(f)) continue;
    try {
      docs.push({ path: f, content: workspace.readFile(f).slice(0, 50_000) });
    } catch {
      /* skip */
    }
  }
  return docs.slice(0, 20);
}

/**
 * Pick up to 2 sibling modules of the affected (new) module to use as
 * structural references for scaffolding. Prefers siblings under the same
 * parent directory; falls back to empty if the affected module is top-level
 * or has no siblings with code.
 */
function pickReferenceModules(
  workspace: LocalWorkspace,
  affectedModule: string
): ReferenceModule[] {
  const normalized = affectedModule.replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/');
  if (parts.length < 2) return [];

  const parentPath = parts.slice(0, -1).join('/');
  const affectedName = parts[parts.length - 1];
  const candidates = workspace
    .listSubdirs(parentPath)
    .filter((d) => d !== affectedName);

  const refs: ReferenceModule[] = [];
  for (const subdir of candidates) {
    const refPath = `${parentPath}/${subdir}`;
    const files = gatherModuleFiles(workspace, refPath);
    if (files.length > 0) {
      refs.push({ path: refPath, files });
      if (refs.length >= 2) break;
    }
  }
  return refs;
}

/**
 * Locate a CONTRIBUTING guide at common paths and return its content,
 * truncated to 30KB. Returns null when not found.
 */
function findContributingGuide(workspace: LocalWorkspace): string | null {
  const candidates = [
    'CONTRIBUTING.md',
    'CONTRIBUTING.rst',
    'CONTRIBUTING.txt',
    'docs/CONTRIBUTING.md',
    '.github/CONTRIBUTING.md',
  ];
  for (const relPath of candidates) {
    try {
      if (workspace.fileExists(relPath)) {
        return workspace.readFile(relPath).slice(0, 30_000);
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

/**
 * Run the PM design loop over Gmail, blocking until approval is received.
 * Returns the agreed design summary.
 */
async function runPMDesignLoop(args: {
  payload: IssueEvent;
  manifest: Manifest;
  triageSummary: string;
  affectedModule: string;
  issueType: 'bug_fix' | 'new_feature' | 'docs';
  live: LiveDeps;
  log: (msg: string) => void;
  runId: string;
}): Promise<{ approved: true; agreedDesign: string }> {
  const { payload, manifest, triageSummary, affectedModule, issueType, live, log, runId } = args;
  const repoFullName = payload.repository.full_name;
  const issueNumber = payload.issue.number;

  log('[pm] gathering design context (related issues, recent PRs, design docs)');
  const [relatedIssues, recentPRs, designDocs] = await Promise.all([
    live.issueSearcher.searchRelatedIssues(repoFullName, affectedModule, null, null),
    live.prFetcher.getRecentMergedPRs(repoFullName, affectedModule, 30),
    live.designDocFinder.findDesignDocs(repoFullName, affectedModule),
  ]);

  const labels = (payload.issue.labels ?? []).map((l) => l.name);

  // PM scoring expects bug_fix | new_feature. Docs issues route around the PM
  // gate entirely, but guard the type narrowing here so a future code path
  // change can't silently mislabel a docs issue as a bug.
  const scoringIssueType: 'bug_fix' | 'new_feature' =
    issueType === 'new_feature' ? 'new_feature' : 'bug_fix';

  const scoringInput = {
    issueType: scoringIssueType,
    affectedModule,
    summary: triageSummary,
    title: payload.issue.title ?? '',
    body: payload.issue.body ?? '',
    labels,
    relatedIssues,
    recentPRs,
    designDocs,
  };

  const scoring = scoreDesign(scoringInput);
  log(`[pm] scoring: design_needed=${scoring.designNeeded}`);

  if (!scoring.designNeeded) {
    return { approved: true, agreedDesign: scoring.reasoning };
  }

  const briefInput: DesignBriefInput = {
    issueSummary: triageSummary,
    affectedModule,
    relatedIssues,
    recentPRs,
    designDocs,
    issueTitle: payload.issue.title ?? '',
    issueBody: payload.issue.body ?? null,
    issueLabels: labels,
    scoringResult: scoring,
  };

  const config: PMEmailLoopConfig = {
    pmEmail: manifest.pm_email,
    replyToAddress: live.replyToFor(runId),
    repo: repoFullName,
    issueNumber,
    issueTitle: payload.issue.title ?? '',
    approvalKeywords: manifest.approval_keywords,
    runId,
  };

  const briefGen = new HeuristicBriefGenerator();
  const followUpGen: FollowUpGenerator = process.env.OPENROUTER_API_KEY
    ? new OpenRouterPMFollowUpGenerator(undefined, {
        browser: live.codeBrowser,
        repo: repoFullName,
      })
    : new HeuristicFollowUpGenerator();

  log(`[pm] sending design brief to ${manifest.pm_email}`);
  const sendResult = await sendDesignBrief(
    live.gmail,
    live.watcher,
    config,
    briefInput,
    briefGen,
    live.pmEmailStateStore
  );
  if (sendResult.action !== 'email_sent') {
    throw new Error(`Unexpected pm-email action ${sendResult.action} from sendDesignBrief`);
  }
  let thread = sendResult.thread;
  let resolvedDecisions: string[] = [];
  let unresolvedQuestions = scoring.signals.length
    ? briefGen.generateBrief(briefInput).openQuestions
    : [];

  // Loop: block on watcher reply, process, send follow-up, until approved.
  while (true) {
    log(`[pm] waiting for PM reply on thread ${thread.threadId} (runId=${runId})`);
    const { reply } = await live.replyWaiter.waitForEmailReply(runId);
    log(`[pm] received reply (${reply.body.length} chars) from ${reply.from}`);

    const result = await processReply(
      live.gmail,
      live.watcher,
      config,
      thread,
      reply.body,
      resolvedDecisions,
      unresolvedQuestions,
      briefInput,
      followUpGen,
      live.pmEmailStateStore
    );

    if (result.action === 'approved') {
      log(`[pm] approved (matched keyword: ${result.approvalResult.matchedKeyword})`);
      return { approved: true, agreedDesign: result.agreedDesign };
    }

    // result.action === 'reply_processed' -- update local state and keep waiting
    thread = result.thread;
    const newDecisions = extractDecisions(reply.body);
    resolvedDecisions = [...resolvedDecisions, ...newDecisions];
    // best-effort: trim resolved questions from unresolvedQuestions
    const replyLower = reply.body.toLowerCase();
    unresolvedQuestions = unresolvedQuestions.filter(
      (q) => !replyLower.includes(q.toLowerCase().split(' ').slice(0, 3).join(' '))
    );
  }
}

interface FixAttemptOutcome {
  ok: boolean;
  /** When ok=true, the eval summary; when ok=false, the retry context to feed back. */
  retryContext: string;
  evalSummary: string;
  fixSummary: string;
}

/**
 * Pure decision helper: turn regression + usability findings into a retry
 * signal. Used by the verification phase to decide whether the fix passes the
 * sandbox-quality gate or needs another fix attempt.
 *
 * Exported for unit testing.
 */
export function decideVerificationOutcome(args: {
  regressionDetected: boolean;
  regressionDiffs?: Array<{ category: string; description: string }>;
  blockers: string[];
}): { ok: boolean; retryContext: string } {
  const parts: string[] = [];

  if (args.regressionDetected) {
    const diffs = args.regressionDiffs ?? [];
    parts.push(
      `Regression guard detected behavioural changes between the fork branch and upstream main (${diffs.length} diff(s)). The fix changed observable behaviour outside the scope of the issue; address this:`
    );
    for (const d of diffs) {
      parts.push(`- [${d.category}] ${d.description}`);
    }
  }

  if (args.blockers.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push(
      `Usability blockers found by the sandbox exerciser (these prevent a real user from consuming the change and must be fixed before opening a PR):`
    );
    for (const b of args.blockers) {
      parts.push(`- ${b}`);
    }
  }

  return { ok: parts.length === 0, retryContext: parts.join('\n') };
}

/**
 * One-line digest of a verification-gate failure, suitable for the
 * max-retries-exceeded `reason` field and any other place where the rich
 * multi-line retry context would be too noisy. Counts regression vs usability
 * findings from the structured retry context so the surface is much more
 * useful than the literal string `'verification-failed'`.
 */
export function summarizeVerificationFailure(retryContext: string): string {
  const lines = retryContext.split('\n');
  const regressionCountMatch = retryContext.match(/(\d+)\s+diff\(s\)/);
  const regressionCount = regressionCountMatch ? Number(regressionCountMatch[1]) : 0;
  const usabilityCount = lines.filter(
    (l) => l.startsWith('- ') && !l.startsWith('- [')
  ).length;
  const sections: string[] = [];
  if (regressionCount > 0) sections.push(`${regressionCount} regression`);
  if (usabilityCount > 0) sections.push(`${usabilityCount} usability blocker${usabilityCount === 1 ? '' : 's'}`);
  if (sections.length === 0) return 'verification-failed';
  return `verification-failed: ${sections.join(', ')}`;
}

interface VerificationResult {
  /** Aggregate gate outcome. ok=false means feed retryContext back to the fix agent. */
  outcome: { ok: boolean; retryContext: string };
  /** PR-body section for the regression guard run (may be empty). */
  regressionSection: string;
  /** Labels to apply to the PR for regression findings. */
  regressionLabels: string[];
  /** PR-body section for the usability run (may be empty). */
  usabilitySection: string;
  /** Labels to apply to the PR for usability findings. */
  usabilityLabels: string[];
}

/**
 * Run the post-fix verification phase: regression guard + usability agent.
 * Gates the PR: if either signal fails, returns ok=false with a retryContext
 * that the fix retry loop will feed back to the LLM.
 *
 * Each agent is wrapped so an infrastructure-level failure (e.g. GHA dispatch
 * error) is non-blocking: the section says "⚠️ Not Run" and the gate passes,
 * matching the prior behaviour of these blocks.
 */
async function runVerification(args: {
  manifest: Manifest;
  adapter: RepoAdapter;
  token: string;
  forkFullName: string;
  branchName: string;
  upstreamRepo: string;
  upstreamDefaultBranch: string;
  workspace: LocalWorkspace;
  affectedModule: string;
  confirmedIssues: ConfirmedIssue[];
  log: (msg: string) => void;
}): Promise<VerificationResult> {
  const {
    manifest,
    adapter,
    token,
    forkFullName,
    branchName,
    upstreamRepo,
    upstreamDefaultBranch,
    workspace,
    affectedModule,
    confirmedIssues,
    log,
  } = args;

  // Verification is GHA-only; in local sandbox mode skip silently with ok=true.
  if (manifest.sandbox_runner !== 'gha') {
    return {
      outcome: { ok: true, retryContext: '' },
      regressionSection: '',
      regressionLabels: [],
      usabilitySection: '',
      usabilityLabels: [],
    };
  }

  let regressionSection = '';
  const regressionLabels: string[] = [];
  let regressionDetected = false;
  let regressionDiffs: Array<{ category: string; description: string }> = [];

  try {
    log(`[verify/regression-guard] sandbox_runner=gha; running regression guard`);
    const testCommands = await adapter.getTestCommands();
    const sandboxServices = await adapter.getSandboxServices();
    const serviceNames = sandboxServices.map((s) =>
      typeof s === 'string' ? s : s.name
    );
    const joinedCommand = testCommands.join(' && ');

    const regressionConfig = createRegressionConfig(
      forkFullName,
      branchName,
      upstreamRepo,
      upstreamDefaultBranch,
      joinedCommand,
      serviceNames,
      manifest.sandbox_timeout_mins ?? 15
    );

    const actionsClient = new GitHubActionsClient(token);
    const regressionResult = await runRegressionGuard(regressionConfig, actionsClient);
    regressionSection = generateRegressionSummary(regressionResult);
    regressionDetected = regressionResult.regressionDetected;
    regressionDiffs = regressionResult.diffs.map((d) => ({
      category: d.category,
      description: d.description,
    }));
    log(
      `[verify/regression-guard] detected=${regressionResult.regressionDetected} diffs=${regressionResult.diffs.length}`
    );
    if (regressionResult.regressionDetected) {
      regressionLabels.push('agent-regression-detected');
    }
  } catch (err: any) {
    log(`[verify/regression-guard] failed (non-blocking): ${err?.message ?? err}`);
    regressionSection = `### Regression Guard: ⚠️ Not Run\n\nRegression guard failed to execute: ${err?.message ?? err}`;
    // Infrastructure failure: do not gate the PR on it.
  }

  let usabilitySection = '';
  const usabilityLabels: string[] = [];
  let usabilityBlockers: string[] = [];

  try {
    log(`[verify/usability] sandbox_runner=gha; running usability agent`);
    const sandboxServices = await adapter.getSandboxServices();
    const serviceNames = sandboxServices.map((s) =>
      typeof s === 'string' ? s : s.name
    );
    const introspection = inferUsabilityIntrospection(workspace, affectedModule);

    const usabilityInput: UsabilityAgentInput = {
      forkFullName,
      branchName,
      affectedModule,
      confirmedIssues: confirmedIssues.map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? null,
        labels: i.labels,
      })),
      sandboxServices: serviceNames,
      timeoutMinutes: manifest.sandbox_timeout_mins ?? DEFAULT_USABILITY_TIMEOUT_MINUTES,
      installCommand: introspection.installCommand,
      entryPoints: introspection.entryPoints,
    };

    const actionsClient = new GitHubActionsClient(token);
    const exerciser = new GHAUsabilityExerciser(token, actionsClient);
    const usabilityResult = await runUsabilityAgent(usabilityInput, exerciser, actionsClient);
    usabilitySection = usabilityResult.summary;
    usabilityBlockers = usabilityResult.blockers;
    log(
      `[verify/usability] completed=${usabilityResult.completed} dx=${usabilityResult.dxScore} blockers=${usabilityResult.blockers.length}`
    );
    if (usabilityResult.blockers.length > 0) {
      usabilityLabels.push('agent-usability-blockers');
    }
  } catch (err: any) {
    log(`[verify/usability] failed (non-blocking): ${err?.message ?? err}`);
    usabilitySection = `### Usability Report: ⚠️ Not Run\n\nUsability agent failed to execute: ${err?.message ?? err}`;
    // Infrastructure failure: do not gate the PR on it.
  }

  const outcome = decideVerificationOutcome({
    regressionDetected,
    regressionDiffs,
    blockers: usabilityBlockers,
  });

  return {
    outcome,
    regressionSection,
    regressionLabels,
    usabilitySection,
    usabilityLabels,
  };
}

/**
 * Run the issue-sweep / scope-confirmation flow over Gmail.
 *
 * After PM design approval, sweep all open issues in the repo and find ones
 * that match the agreed design. If only the primary issue is in scope, this
 * short-circuits with no email. Otherwise sends a scope-confirmation email
 * and blocks on the user's reply (parsed for include/exclude prose).
 *
 * Returns the list of confirmed issue numbers to feed into fix/build agents.
 */
async function runIssueSweepLoop(args: {
  repoFullName: string;
  primaryIssueNumber: number;
  primaryIssueTitle: string;
  agreedDesign: string;
  affectedModule: string;
  manifest: Manifest;
  live: LiveDeps;
  token: string;
  log: (msg: string) => void;
  parentRunId: string;
  sweepStateStore: InMemorySweepStateStore;
}): Promise<{ confirmedIssueNumbers: number[]; skipped: boolean; reason?: string }> {
  const {
    repoFullName,
    primaryIssueNumber,
    primaryIssueTitle,
    agreedDesign,
    affectedModule,
    manifest,
    live,
    token,
    log,
    parentRunId,
    sweepStateStore,
  } = args;

  log(`[sweep] fetching open issues for ${repoFullName}`);
  let openIssues;
  try {
    openIssues = await listOpenIssues(token, repoFullName, 50);
  } catch (err) {
    log(`[sweep] failed to list issues (${(err as Error).message}); skipping sweep`);
    return { confirmedIssueNumbers: [primaryIssueNumber], skipped: true, reason: 'list-failed' };
  }
  log(`[sweep] ${openIssues.length} open issues fetched`);

  // Ensure the primary issue is present in the sweep input (sweeper expects it).
  if (!openIssues.find((i) => i.number === primaryIssueNumber)) {
    openIssues.push({
      number: primaryIssueNumber,
      title: primaryIssueTitle,
      labels: [],
      reason: '',
    });
  }

  const sweeper = new HeuristicIssueSweeper();
  const sweepResult = sweeper.sweepIssues({
    agreedDesign,
    affectedModule,
    openIssues,
    primaryIssueNumber,
  });

  const otherHigh = sweepResult.highConfidence.filter((i) => i.number !== primaryIssueNumber);
  const otherMaybe = sweepResult.maybeInScope.filter((i) => i.number !== primaryIssueNumber);

  log(
    `[sweep] result: high=${sweepResult.highConfidence.length} ` +
      `(${otherHigh.length} besides primary), maybe=${otherMaybe.length}`
  );

  // Short-circuit: no other candidates → don't email, just confirm primary.
  if (otherHigh.length === 0 && otherMaybe.length === 0) {
    log('[sweep] no other in-scope issues found; skipping scope-confirmation email');
    return { confirmedIssueNumbers: [primaryIssueNumber], skipped: true, reason: 'no-candidates' };
  }

  const sweepRunId = `${parentRunId}-sweep`;
  const config: ScopeConfirmationConfig = {
    pmEmail: manifest.pm_email,
    replyToAddress: live.replyToFor(sweepRunId),
    repo: repoFullName,
    issueNumber: primaryIssueNumber,
    issueTitle: primaryIssueTitle,
    runId: sweepRunId,
  };

  log(`[sweep] sending scope-confirmation email to ${manifest.pm_email} (runId=${sweepRunId})`);
  const sendResult = await runIssueSweep(
    live.gmail,
    live.watcher,
    config,
    {
      agreedDesign,
      affectedModule,
      openIssues,
      primaryIssueNumber,
    },
    sweeper,
    sweepStateStore
  );
  if (sendResult.action !== 'scope_email_sent') {
    log(`[sweep] unexpected sweep send action ${sendResult.action}; falling back to primary`);
    return { confirmedIssueNumbers: [primaryIssueNumber], skipped: true, reason: 'send-failed' };
  }

  log(`[sweep] waiting for scope reply on thread ${sendResult.thread.threadId}`);
  const { reply } = await live.replyWaiter.waitForEmailReply(sweepRunId);
  log(`[sweep] received scope reply (${reply.body.length} chars)`);

  const confirmResult = processScopeReply(
    reply.body,
    sendResult.sweepResult,
    sweepStateStore,
    sweepRunId,
    live.watcher,
    sendResult.thread.threadId
  );

  if (confirmResult.action !== 'scope_confirmed') {
    log(`[sweep] unexpected confirm action ${confirmResult.action}; falling back to primary`);
    return { confirmedIssueNumbers: [primaryIssueNumber], skipped: true, reason: 'parse-failed' };
  }

  // Ensure primary is always included (defensive: parser excludes it from highConfidence
  // bucket since it auto-adds with a different reason; if user wrote "drop primary" that's
  // a non-sequitur — we still need to work on it).
  const numbers = Array.from(new Set([primaryIssueNumber, ...confirmResult.confirmedIssueNumbers]));
  log(`[sweep] confirmed issue numbers: ${numbers.join(', ')}`);
  return { confirmedIssueNumbers: numbers, skipped: false };
}

/**
 * Run a single fix → sandbox → eval attempt.
 */
async function runFixAttempt(args: {
  fixInput: FixAgentInput;
  workspace: LocalWorkspace;
  adapter: RepoAdapter;
  manifest: Manifest;
  payload: IssueEvent;
  forkFullName: string;
  branchName: string;
  ghClient: GitHubRestClient;
  log: (msg: string) => void;
}): Promise<FixAttemptOutcome> {
  const { fixInput, workspace, adapter, manifest, payload, log, ghClient } = args;
  const reader = new LocalRepoFileReader(workspace);
  const tokenScopes = await ghClient.getTokenScopes();
  const committer = new LocalForkCommitter(workspace, tokenScopes);
  const generator = new OpenRouterFixGenerator();

  log('[fix] invoking OpenRouter fix generator');
  const fixResult = await runFixAgent(fixInput, generator, committer, reader);
  if (!fixResult.success) {
    return {
      ok: false,
      retryContext: 'Fix generator returned no changes.',
      evalSummary: 'no-changes',
      fixSummary: '',
    };
  }
  log(`[fix] committed ${fixResult.changes.length} files: ${fixResult.summary}`);

  const testCommands = await adapter.getTestCommands();
  const sandboxServices = await adapter.getSandboxServices();
  log(
    `[sandbox] ${testCommands.length} command(s); services=${sandboxServices
      .map((s) => (typeof s === 'string' ? s : s.name))
      .join(',') || '(none)'}`
  );

  const sandboxArtifact = await runLocalSandbox({
    workspace,
    config: {
      repoFullName: payload.repository.full_name,
      forkFullName: args.forkFullName,
      branchName: args.branchName,
      workflowRepoFullName: '',
      testCommands,
      sandboxServices,
      timeoutMinutes: manifest.sandbox_timeout_mins ?? 15,
    },
    services: sandboxServices.filter(
      (s): s is Exclude<typeof s, string> => typeof s !== 'string'
    ),
    options: { log },
  });

  const evalResult = await adapter.runCustomEval(sandboxArtifact.commands);
  log(`[eval] passed=${evalResult.passed} summary=${evalResult.summary}`);

  if (evalResult.passed) {
    return {
      ok: true,
      retryContext: '',
      evalSummary: evalResult.summary,
      fixSummary: fixResult.summary,
    };
  }

  return {
    ok: false,
    retryContext:
      `Eval failed: ${evalResult.summary}\n` +
      (evalResult.retryContext.length
        ? `Retry hints:\n${evalResult.retryContext.map((c) => `- ${c}`).join('\n')}`
        : ''),
    evalSummary: evalResult.summary,
    fixSummary: fixResult.summary,
  };
}

/**
 * Run a single build → sandbox → eval attempt for new_feature issues.
 * Mirrors runFixAttempt but uses the scaffold generator + build agent.
 */
async function runBuildAttempt(args: {
  buildInput: BuildAgentInput;
  workspace: LocalWorkspace;
  adapter: RepoAdapter;
  manifest: Manifest;
  payload: IssueEvent;
  forkFullName: string;
  branchName: string;
  ghClient: GitHubRestClient;
  log: (msg: string) => void;
}): Promise<FixAttemptOutcome> {
  const { buildInput, workspace, adapter, manifest, payload, log, ghClient } = args;
  const reader = new LocalRepoFileReader(workspace);
  const tokenScopes = await ghClient.getTokenScopes();
  const committer = new LocalForkCommitter(workspace, tokenScopes);
  const generator = new OpenRouterScaffoldGenerator();

  log('[build] invoking OpenRouter scaffold generator');
  const buildResult = await runBuildAgent(buildInput, generator, committer, reader);
  if (!buildResult.success) {
    return {
      ok: false,
      retryContext: 'Scaffold generator returned no files.',
      evalSummary: 'no-scaffold',
      fixSummary: '',
    };
  }
  const totalFiles =
    buildResult.moduleFiles.length +
    buildResult.testFiles.length +
    buildResult.indexFiles.length;
  log(`[build] committed ${totalFiles} files: ${buildResult.summary}`);

  const testCommands = await adapter.getTestCommands();
  const sandboxServices = await adapter.getSandboxServices();
  log(
    `[sandbox] ${testCommands.length} command(s); services=${sandboxServices
      .map((s) => (typeof s === 'string' ? s : s.name))
      .join(',') || '(none)'}`
  );

  const sandboxArtifact = await runLocalSandbox({
    workspace,
    config: {
      repoFullName: payload.repository.full_name,
      forkFullName: args.forkFullName,
      branchName: args.branchName,
      workflowRepoFullName: '',
      testCommands,
      sandboxServices,
      timeoutMinutes: manifest.sandbox_timeout_mins ?? 15,
    },
    services: sandboxServices.filter(
      (s): s is Exclude<typeof s, string> => typeof s !== 'string'
    ),
    options: { log },
  });

  const evalResult = await adapter.runCustomEval(sandboxArtifact.commands);
  log(`[eval] passed=${evalResult.passed} summary=${evalResult.summary}`);

  if (evalResult.passed) {
    return {
      ok: true,
      retryContext: '',
      evalSummary: evalResult.summary,
      fixSummary: buildResult.summary,
    };
  }

  return {
    ok: false,
    retryContext:
      `Eval failed: ${evalResult.summary}\n` +
      (evalResult.retryContext.length
        ? `Retry hints:\n${evalResult.retryContext.map((c) => `- ${c}`).join('\n')}`
        : ''),
    evalSummary: evalResult.summary,
    fixSummary: buildResult.summary,
  };
}

/**
 * Run the docs agent path (no PM design loop, no retry loop).
 */
async function runDocsPath(args: {
  payload: IssueEvent;
  manifest: Manifest;
  affectedModule: string;
  workspace: LocalWorkspace;
  forkFullName: string;
  branchName: string;
  ghClient: GitHubRestClient;
  live: LiveDeps;
  log: (msg: string) => void;
  triageSummary: string;
}): Promise<{ summary: string }> {
  const { payload, workspace, forkFullName, branchName, ghClient, live, log, triageSummary, affectedModule } = args;
  const reader = new LocalRepoFileReader(workspace);
  const tokenScopes = await ghClient.getTokenScopes();
  const committer = new LocalForkCommitter(workspace, tokenScopes);

  const docFiles = gatherDocFiles(workspace, affectedModule);
  log(`[docs] gathered ${docFiles.length} doc files`);

  const docInput: DocsAgentInput = {
    confirmedIssues: [
      {
        number: payload.issue.number,
        title: payload.issue.title ?? '',
        body: payload.issue.body ?? '',
        labels: (payload.issue.labels ?? []).map((l) => l.name),
      },
    ],
    affectedModule,
    docFiles,
    recentCommits: [],
    forkFullName,
    branchName,
    triageSummary,
  };

  const result = await runDocsAgent(docInput, live.docsGenerator, committer, reader);
  if (!result.success) {
    throw new Error('Docs agent produced no changes');
  }
  log(`[docs] committed ${result.changes.length} files: ${result.summary}`);
  return { summary: result.summary };
}

export async function runPipeline(args: {
  payload: IssueEvent;
  manifest: Manifest;
  adapter: RepoAdapter;
  deps: PipelineDeps;
}): Promise<PipelineResult> {
  const { payload, manifest, adapter, deps } = args;
  const log = deps.log;
  const repoFullName = payload.repository.full_name;
  const issueNumber = payload.issue.number;
  const runId = `${repoFullName}#${issueNumber}-${Date.now()}`;

  // ---------- Triage ----------
  // Triage uncertainty (clarify / not_applicable) is delivered to the maintainer
  // via email so noisy / off-topic issues don't get a public bot reply. If
  // Gmail/PM deps aren't configured we log the would-be comment instead.
  const triageNotifier: IssueCommenter = deps.live
    ? {
        async postComment(repo, issueNumber, comment) {
          const subject = `[oss-agent] triage notice for ${repo}#${issueNumber}`;
          const issueUrl = `https://github.com/${repo}/issues/${issueNumber}`;
          const body = `${comment}\n\n---\nIssue: ${issueUrl}`;
          await deps.live!.failureNotifier.sendEmail(
            manifest.pm_email,
            subject,
            body,
            manifest.pm_email
          );
          log(`[triage] emailed maintainer at ${manifest.pm_email}`);
        },
      }
    : {
        async postComment(_repo, _issueNumber, comment) {
          log(`[triage] (no live deps; would have emailed) ${comment.slice(0, 200)}`);
        },
      };
  const triageInput = buildTriageInput(payload, manifest, []);

  const routing = await runTriage(
    repoFullName,
    issueNumber,
    triageInput,
    adapter,
    triageNotifier,
    {
      typeClassifier: createDefaultTriageClassifier(
        deps.live
          ? { browser: deps.live.codeBrowser, repo: repoFullName }
          : undefined
      ),
    }
  );
  log(
    `[triage] action=${routing.action} type=${routing.result.issueType} ` +
      `module=${routing.result.affectedModule} confidence=${routing.result.confidence.toFixed(2)} ` +
      `relevance=${routing.result.relevance}`
  );

  if (routing.action === 'route_not_applicable') {
    log(`[triage] not_applicable: ${routing.result.relevanceReason}`);
    return { status: 'commented', reason: 'not-applicable-emailed-maintainer' };
  }

  if (routing.action === 'clarify') {
    return { status: 'commented', reason: 'low-confidence-emailed-maintainer' };
  }

  // route_pm requires live deps for the Gmail design loop.
  if (routing.action === 'route_pm' && !deps.live) {
    log(
      `[skip] issue routed to PM design loop but Gmail/PM deps not configured. ` +
        `Add the manifest skip_pm_gate label to bypass, or set Gmail env vars.`
    );
    return { status: 'skipped', reason: 'pm-design-loop-deps-missing' };
  }

  // ---------- Optional PM design loop ----------
  let designSummary = `Skip-PM-gate fix for issue #${issueNumber}: ${routing.result.summary}`;
  let agreedDesignText: string | null = null;
  if (routing.action === 'route_pm') {
    const result = await runPMDesignLoop({
      payload,
      manifest,
      triageSummary: routing.result.summary,
      affectedModule: routing.result.affectedModule,
      issueType: routing.result.issueType,
      live: deps.live!,
      log,
      runId,
    });
    designSummary = `Approved design for issue #${issueNumber}:\n${result.agreedDesign}`;
    agreedDesignText = result.agreedDesign;
  }

  // ---------- Optional issue sweep (Phase 5) ----------
  // Only sweep when PM design loop ran AND live deps are present. Sweep is a
  // no-op short-circuit when no other in-scope issues are found (no email).
  let extraConfirmedNumbers: number[] = [];
  if (routing.action === 'route_pm' && deps.live && agreedDesignText) {
    try {
      const sweep = await runIssueSweepLoop({
        repoFullName,
        primaryIssueNumber: issueNumber,
        primaryIssueTitle: payload.issue.title ?? '',
        agreedDesign: agreedDesignText,
        affectedModule: routing.result.affectedModule,
        manifest,
        live: deps.live,
        token: deps.token,
        log,
        parentRunId: runId,
        sweepStateStore,
      });
      extraConfirmedNumbers = sweep.confirmedIssueNumbers.filter((n) => n !== issueNumber);
      if (sweep.skipped) {
        log(`[sweep] skipped (${sweep.reason ?? 'unknown'})`);
      }
    } catch (err) {
      // Sweep is best-effort; never block the pipeline on failure.
      log(`[sweep] error: ${(err as Error).message}; falling back to primary issue only`);
      extraConfirmedNumbers = [];
    }
  }

  // ---------- Fork + branch ----------
  const ghClient = new GitHubRestClient(deps.token);
  const fork = await createForkAndBranch(ghClient, {
    upstream: repoFullName,
    forkOrg: deps.forkOrg,
    branchPrefix: manifest.branch_prefix,
    issueIds: [issueNumber],
  });
  log(
    `[fork] ${fork.forkFullName} branch=${fork.branchName} ` +
      `created=${fork.forkCreated} synced=${fork.forkSynced} reset=${fork.branchReset}`
  );

  // ---------- Install verification workflows once (GHA only) ----------
  // The verification gate (regression + usability) runs after each successful
  // fix attempt inside the retry loop. We install the workflow files ONCE here
  // — BEFORE the local workspace clone — so that:
  //   - The local checkout already contains the workflow files; subsequent
  //     `git push origin <branch>` from LocalForkCommitter won't fail
  //     non-fast-forward because of remote-only workflow commits.
  //   - The PUT cost is paid once, not per retry attempt.
  // Failures are non-blocking: the verification step itself will report
  // "⚠️ Not Run" if workflows are missing.
  if (manifest.sandbox_runner === 'gha') {
    try {
      await ensureRegressionWorkflowOnFork(deps.token, fork.forkFullName, log);
      await ensureRegressionWorkflowOnBranch(deps.token, fork.forkFullName, fork.branchName, log);
      await ensureUsabilityWorkflowOnFork(deps.token, fork.forkFullName, log);
      await ensureUsabilityWorkflowOnBranch(deps.token, fork.forkFullName, fork.branchName, log);
    } catch (err: any) {
      log(`[verify/install] failed to install verification workflows (non-blocking): ${err?.message ?? err}`);
    }
  }

  // ---------- Local workspace ----------
  const baseBranch = await ghClient.getDefaultBranch(fork.forkFullName);
  const workspace = new LocalWorkspace(
    {
      rootDir: deps.workspaceRoot,
      token: deps.token,
      authorName: deps.authorName,
      authorEmail: deps.authorEmail,
    },
    fork.forkFullName,
    fork.branchName
  );
  log(`[workspace] cloning ${fork.forkFullName} → ${workspace.dir}`);
  await workspace.ensureCheckedOut(baseBranch);

  const confirmedIssues: ConfirmedIssue[] = [
    {
      number: issueNumber,
      title: payload.issue.title ?? '',
      body: payload.issue.body ?? '',
      labels: triageInput.labels,
    },
  ];

  // Hydrate extra confirmed issues from the sweep with full details.
  for (const num of extraConfirmedNumbers) {
    try {
      const details = await getIssueDetails(deps.token, repoFullName, num);
      if (details) {
        confirmedIssues.push(details);
        log(`[sweep] added confirmed issue #${num}: ${details.title}`);
      }
    } catch (err) {
      log(`[sweep] failed to fetch issue #${num}: ${(err as Error).message}; skipping`);
    }
  }

  let prSummary = '';
  let evalSummary = '';
  let regressionSection = '';
  let regressionLabels: string[] = [];
  let usabilitySection = '';
  let usabilityLabels: string[] = [];

  if (routing.action === 'route_docs') {
    // ---------- Docs path ----------
    const result = await runDocsPath({
      payload,
      manifest,
      affectedModule: routing.result.affectedModule,
      workspace,
      forkFullName: fork.forkFullName,
      branchName: fork.branchName,
      ghClient,
      live: deps.live!,
      log,
      triageSummary: routing.result.summary,
    });
    prSummary = result.summary;
    evalSummary = 'docs-only (no eval)';
  } else if (routing.result.issueType === 'new_feature') {
    // ---------- Build path with retry loop (new_feature issues) ----------
    const referenceModules = pickReferenceModules(workspace, routing.result.affectedModule);
    const contributingGuide = findContributingGuide(workspace);
    log(
      `[build] reference modules: ${referenceModules.length}` +
        ` (${referenceModules.map((r) => r.path).join(', ') || 'none'})` +
        `; CONTRIBUTING: ${contributingGuide ? 'found' : 'not found'}`
    );

    const buildInputBase: BuildAgentInput = {
      designSummary,
      confirmedIssues,
      affectedModule: routing.result.affectedModule,
      referenceModules,
      contributingGuide,
      forkFullName: fork.forkFullName,
      branchName: fork.branchName,
    };

    const maxRetries = manifest.max_retries ?? 3;
    let attempt: FixAttemptOutcome | null = null;
    let currentInput = buildInputBase;

    while (true) {
      try {
        attempt = await runBuildAttempt({
          buildInput: currentInput,
          workspace,
          adapter,
          manifest,
          payload,
          forkFullName: fork.forkFullName,
          branchName: fork.branchName,
          ghClient,
          log,
        });
      } catch (err: any) {
        log(`[build] attempt threw: ${err?.message ?? err}`);
        attempt = {
          ok: false,
          retryContext: `Build attempt threw: ${err?.message ?? err}`,
          evalSummary: 'exception',
          fixSummary: '',
        };
      }

      if (attempt.ok) {
        log(`[build] attempt passed eval; running verification (regression + usability)`);
        const verify = await runVerification({
          manifest,
          adapter,
          token: deps.token,
          forkFullName: fork.forkFullName,
          branchName: fork.branchName,
          upstreamRepo: repoFullName,
          upstreamDefaultBranch: baseBranch,
          workspace,
          affectedModule: routing.result.affectedModule,
          confirmedIssues,
          log,
        });
        regressionSection = verify.regressionSection;
        regressionLabels = verify.regressionLabels;
        usabilitySection = verify.usabilitySection;
        usabilityLabels = verify.usabilityLabels;

        if (verify.outcome.ok) break;

        log(`[build] verification gate FAILED; feeding findings back to retry loop`);
        attempt = {
          ok: false,
          retryContext: verify.outcome.retryContext,
          evalSummary: summarizeVerificationFailure(verify.outcome.retryContext),
          fixSummary: attempt.fixSummary,
        };
      }

      if (deps.live) {
        const retryConfig: RetryLoopConfig = {
          runId,
          maxRetries,
          agentType: 'build',
          upstreamRepo: repoFullName,
          primaryIssueNumber: issueNumber,
          pmEmail: manifest.pm_email,
          replyToAddress: deps.live.replyToFor(runId),
          confirmedIssues,
          forkFullName: fork.forkFullName,
          branchName: fork.branchName,
        };
        const decision = await runRetryLoop(
          attempt.retryContext,
          retryConfig,
          deps.live.retryStateStore,
          deps.live.failureNotifier,
          deps.live.issueLabeler
        );
        if (decision.action === 'max_retries_exceeded') {
          log(`[retry] max_retries exceeded; labeled agent-failed and emailed PM`);
          return { status: 'max-retries-exceeded', reason: attempt.evalSummary };
        }
        log(`[retry] retrying build (attempt ${decision.dispatch.retryCount}/${maxRetries})`);
        currentInput = {
          ...buildInputBase,
          designSummary: injectRetryContextForBuildAgent(designSummary, decision.dispatch),
        };
      } else {
        const attemptsSoFar = (currentInput.designSummary.match(/## Latest Failure/g) ?? []).length;
        if (attemptsSoFar >= maxRetries) {
          log(`[retry] max_retries exceeded (no live deps to label/email)`);
          return { status: 'max-retries-exceeded', reason: attempt.evalSummary };
        }
        log(`[retry] retrying build without persistence (attempt ${attemptsSoFar + 1}/${maxRetries})`);
        currentInput = {
          ...buildInputBase,
          designSummary:
            `${designSummary}\n\n## Latest Failure (address this in your fix)\n\n${attempt.retryContext}`,
        };
      }
    }

    prSummary = attempt!.fixSummary;
    evalSummary = attempt!.evalSummary;
  } else {
    // ---------- Fix path with retry loop ----------
    const moduleSource = gatherModuleFiles(workspace, routing.result.affectedModule);
    const moduleTests = gatherTestFiles(workspace, routing.result.affectedModule);
    const recentCommits: ModuleCommit[] = [];

    const fixInputBase: FixAgentInput = {
      designSummary,
      confirmedIssues,
      affectedModule: routing.result.affectedModule,
      moduleSource,
      moduleTests,
      recentCommits,
      forkFullName: fork.forkFullName,
      branchName: fork.branchName,
    };

    const maxRetries = manifest.max_retries ?? 3;
    let attempt: FixAttemptOutcome | null = null;
    let currentInput = fixInputBase;
    let lastRetryContext: string | null = null;

    while (true) {
      try {
        attempt = await runFixAttempt({
          fixInput: currentInput,
          workspace,
          adapter,
          manifest,
          payload,
          forkFullName: fork.forkFullName,
          branchName: fork.branchName,
          ghClient,
          log,
        });
      } catch (err: any) {
        log(`[fix] attempt threw: ${err?.message ?? err}`);
        attempt = {
          ok: false,
          retryContext: `Fix attempt threw: ${err?.message ?? err}`,
          evalSummary: 'exception',
          fixSummary: '',
        };
      }

      if (attempt.ok) {
        log(`[fix] attempt passed eval; running verification (regression + usability)`);
        const verify = await runVerification({
          manifest,
          adapter,
          token: deps.token,
          forkFullName: fork.forkFullName,
          branchName: fork.branchName,
          upstreamRepo: repoFullName,
          upstreamDefaultBranch: baseBranch,
          workspace,
          affectedModule: routing.result.affectedModule,
          confirmedIssues,
          log,
        });
        regressionSection = verify.regressionSection;
        regressionLabels = verify.regressionLabels;
        usabilitySection = verify.usabilitySection;
        usabilityLabels = verify.usabilityLabels;

        if (verify.outcome.ok) break;

        log(`[fix] verification gate FAILED; feeding findings back to retry loop`);
        attempt = {
          ok: false,
          retryContext: verify.outcome.retryContext,
          evalSummary: summarizeVerificationFailure(verify.outcome.retryContext),
          fixSummary: attempt.fixSummary,
        };
      }

      lastRetryContext = attempt.retryContext;

      if (deps.live) {
        const retryConfig: RetryLoopConfig = {
          runId,
          maxRetries,
          agentType: 'fix',
          upstreamRepo: repoFullName,
          primaryIssueNumber: issueNumber,
          pmEmail: manifest.pm_email,
          replyToAddress: deps.live.replyToFor(runId),
          confirmedIssues,
          forkFullName: fork.forkFullName,
          branchName: fork.branchName,
        };
        const decision = await runRetryLoop(
          attempt.retryContext,
          retryConfig,
          deps.live.retryStateStore,
          deps.live.failureNotifier,
          deps.live.issueLabeler
        );
        if (decision.action === 'max_retries_exceeded') {
          log(`[retry] max_retries exceeded; labeled agent-failed and emailed PM`);
          return { status: 'max-retries-exceeded', reason: attempt.evalSummary };
        }
        log(`[retry] retrying (attempt ${decision.dispatch.retryCount}/${maxRetries})`);
        const destructivePaths = extractDestructivePaths(attempt.retryContext);
        if (destructivePaths.length > 0) {
          log(`[retry] augmenting moduleSource with ${destructivePaths.length} destroyed file(s): ${destructivePaths.join(', ')}`);
        }
        const augmentedBase = await augmentModuleSourceWithFiles(fixInputBase, destructivePaths, workspace);
        currentInput = {
          ...augmentedBase,
          designSummary: injectRetryContextForFixAgent(designSummary, decision.dispatch),
        };
      } else {
        // No live deps -> simple in-memory retry without persistence/notifications.
        const attemptsSoFar = (currentInput.designSummary.match(/## Latest Failure/g) ?? []).length;
        if (attemptsSoFar >= maxRetries) {
          log(`[retry] max_retries exceeded (no live deps to label/email)`);
          return { status: 'max-retries-exceeded', reason: attempt.evalSummary };
        }
        log(`[retry] retrying without persistence (attempt ${attemptsSoFar + 1}/${maxRetries})`);
        const destructivePaths = extractDestructivePaths(attempt.retryContext);
        if (destructivePaths.length > 0) {
          log(`[retry] augmenting moduleSource with ${destructivePaths.length} destroyed file(s): ${destructivePaths.join(', ')}`);
        }
        const augmentedBase = await augmentModuleSourceWithFiles(fixInputBase, destructivePaths, workspace);
        currentInput = {
          ...augmentedBase,
          designSummary:
            `${designSummary}\n\n## Latest Failure (address this in your fix)\n\n${attempt.retryContext}`,
        };
      }
    }

    prSummary = attempt!.fixSummary;
    evalSummary = attempt!.evalSummary;
  }

  // ---------- Draft PR ----------
  const prMeta = await adapter.getPRMetadata(
    confirmedIssues.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      labels: i.labels,
    }))
  );
  const prTitle = `${prSummary} (closes #${issueNumber})`;
  const prBody = [
    `Automated change generated by oss-support-agent.`,
    ``,
    `Closes #${issueNumber}.`,
    ``,
    `## Summary`,
    prSummary,
    ``,
    `## Eval`,
    `- ${evalSummary}`,
    ``,
    ...(regressionSection ? [regressionSection, ``] : []),
    ...(usabilitySection ? [usabilitySection, ``] : []),
    ...(manifest.sandbox_runner === 'gha'
      ? [
          `<!-- agent-setup -->`,
          `> Note: this PR includes \`.github/workflows/regression-test.yml\` and \`.github/workflows/usability-test.yml\` because the oss-support-agent's GHA sandbox runner is enabled. Feel free to delete those files before merging if you don't want them in your repo.`,
          ``,
        ]
      : []),
    ...(prMeta.extraBodySections ?? []),
  ].join('\n');

  const pr = await ghClient.createPullRequest({
    upstream: repoFullName,
    forkFullName: fork.forkFullName,
    headBranch: fork.branchName,
    baseBranch,
    title: prTitle,
    body: prBody,
    draft: true,
  });
  log(`[pr] opened ${pr.url}`);

  const allLabels = [...(prMeta.extraLabels ?? []), ...regressionLabels, ...usabilityLabels];
  if (allLabels.length) {
    try {
      await ghClient.addLabelsToPR(repoFullName, pr.number, allLabels);
    } catch (err: any) {
      log(`[pr] label apply failed (non-fatal): ${err?.message ?? err}`);
    }
  }

  return { status: 'pr-opened', prUrl: pr.url, prNumber: pr.number };
}

export function defaultWorkspaceRoot(): string {
  return path.join(process.cwd(), 'data', 'workspaces');
}

// formatDesignBriefEmail is re-exported for tests / external callers.
export { formatDesignBriefEmail, summarizeAgreedDesign, detectApproval };
