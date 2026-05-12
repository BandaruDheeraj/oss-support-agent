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
import * as childProcess from 'child_process';

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
import { extractFilePathsFromAll } from '../core/issue-file-extractor';
import { runReproLoop } from '../core/agents/repro-loop';
import { LocalReproWorkspace } from '../core/agents/repro-workspace';
import type {
  ReproSpec,
  RequiredCredential,
  BaselineRunResult,
  BaselineRunner,
} from '../core/agents/repro-types';
import {
  ReproUnreproducibleError,
  ReproCredentialsRequiredError,
} from '../core/agents/repro-types';
import { OpenRouterIterativeReproGenerator } from '../core/llm/openrouter-repro-generator';
import {
  validateReproSetup,
  buildPipInstallCommands,
  ReproSetupValidationError,
} from '../core/agents/repro-setup-validation';
import {
  rankMatches,
  validateEditableInstallPath,
} from '../core/repo-path-resolver';
import {
  findMissingDeclaredCredentials,
  detectCredentialError,
  mergeCredentialSources,
} from '../core/credentials-check';

import {
  runRetryLoop,
  injectRetryContextForFixAgent,
  injectRetryContextForBuildAgent,
} from '../core/retry-loop';
import type { RetryLoopConfig } from '../core/retry-loop-types';

import { GitHubRestClient, GitHubIssueCommenter } from './clients/github-rest';
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
  | {
      status: 'awaiting-credentials';
      reason: string;
      missingEnvVars: string[];
    }
  | {
      status: 'repro-not-runnable';
      reason: string;
    }
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
  workspace: LocalWorkspace,
  log: (msg: string) => void = () => {}
): Promise<FixAgentInput> {
  if (paths.length === 0) return baseInput;
  const reader = new LocalRepoFileReader(workspace);
  const have = new Set(baseInput.moduleSource.map((f) => f.path));
  const added: ModuleFile[] = [];
  for (const p of paths) {
    if (have.has(p)) continue;
    // 1. Try the exact path first (direct repo path mentioned in the issue).
    let resolved: string | null = null;
    try {
      const content = await reader.readFile(baseInput.forkFullName, baseInput.branchName, p);
      added.push({ path: p, content: content.slice(0, 200_000) });
      have.add(p);
      resolved = p;
      log(`[fix-prep] resolved ${p} directly`);
    } catch {
      /* fall through to suffix search */
    }
    if (resolved) continue;
    // 2. Treat the path as a suffix and search the workspace. This catches
    //    site-packages-derived paths (`openinference/instrumentation/.../foo.py`)
    //    that don't map to a top-level repo dir.
    const candidates = workspace.findFilesBySuffix(p);
    if (candidates.length === 0) {
      log(`[fix-prep] no suffix match for ${p}`);
      continue;
    }
    const ranked = rankMatches(candidates);
    const picked = ranked[0];
    if (have.has(picked)) continue;
    try {
      const content = await reader.readFile(baseInput.forkFullName, baseInput.branchName, picked);
      added.push({ path: picked, content: content.slice(0, 200_000) });
      have.add(picked);
      log(
        `[fix-prep] suffix-resolved ${p} -> ${picked}${
          ranked.length > 1 ? ` (${ranked.length - 1} other candidate(s) ignored)` : ''
        }`
      );
    } catch {
      log(`[fix-prep] suffix match found but read failed: ${picked}`);
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

/**
 * Inspect the result of running the repro on baseline. A "valid" baseline
 * means the bug actually reproduces — i.e. exit≠0 AND the failureSentinel
 * appears in stdout/stderr. We explicitly reject infrastructure-level
 * failures (ModuleNotFoundError, SyntaxError, pip install failure) so we
 * don't mistake "the repro is broken" for "the bug is reproduced".
 *
 * Exported for testing.
 */
export function validateReproBaseline(args: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failureSentinel: string;
}): { ok: true } | { ok: false; reason: string } {
  const combined = `${args.stdout ?? ''}\n${args.stderr ?? ''}`;
  const exit = args.exitCode ?? 1;
  if (exit === 0) {
    return { ok: false, reason: 'repro exited 0 on baseline; the bug did not reproduce' };
  }
  const infraMarkers = [
    'ModuleNotFoundError',
    'ImportError: cannot import name',
    'No module named',
    'SyntaxError',
    'IndentationError',
    'ERROR: Could not find a version',
    'pip._vendor',
    'pip install',
  ];
  for (const marker of infraMarkers) {
    if (combined.includes(marker)) {
      return {
        ok: false,
        reason: `repro failed for an infrastructure reason (matched "${marker}"), not the reported bug`,
      };
    }
  }
  if (!combined.includes(args.failureSentinel)) {
    return {
      ok: false,
      reason: `repro exited ${exit} but did not print the failure sentinel (${args.failureSentinel}); cannot confirm it reproduces the reported bug`,
    };
  }
  return { ok: true };
}

/**
 * Cheap pre-flight: ask the local Python interpreter to parse the candidate
 * repro before we pay for a full sandbox cycle (~80s + pip install cost).
 * SyntaxError / IndentationError → return a clear reason string.
 *
 * Best-effort: if `python3`/`python` isn't available, returns ok=true and
 * lets the sandbox surface the error normally. Never throws.
 *
 * Exported for testing.
 */
export async function pythonAstCheck(content: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pythons = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const py of pythons) {
    try {
      const out = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const proc = childProcess.spawn(py, ['-c', 'import sys, ast; ast.parse(sys.stdin.read())'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', () => resolve({ code: null, stderr: 'spawn-error' }));
        proc.on('close', (code) => resolve({ code, stderr }));
        // Guard against tools that hang on stdin.
        const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 5_000);
        proc.on('close', () => clearTimeout(t));
        try { proc.stdin.write(content); proc.stdin.end(); } catch { /* ignore */ }
      });
      if (out.stderr === 'spawn-error') continue; // try next interpreter
      if (out.code === 0) return { ok: true };
      // Extract the SyntaxError line — Python writes it on the last line.
      const lines = out.stderr.split('\n').map((l) => l.trim()).filter(Boolean);
      const errLine = lines.reverse().find((l) => /(SyntaxError|IndentationError|TabError):/.test(l));
      return {
        ok: false,
        reason: `Python ${errLine ?? out.stderr.slice(0, 200) ?? 'parse error'}`,
      };
    } catch {
      continue;
    }
  }
  // No usable interpreter — skip the gate, sandbox will catch it later.
  return { ok: true };
}

/**
 * Best-effort `git reset --hard` between repro-loop attempts. The repro
 * loop must always start from a clean slate so attempt N+1 doesn't see
 * files attempt N wrote (or kept around after pip install side effects).
 * Failure to reset is logged but not thrown — the next baseline attempt
 * will surface anything genuinely broken.
 */
async function safeReset(workspace: LocalWorkspace, log: (msg: string) => void): Promise<void> {
  try {
    await workspace.resetWorkingTree();
  } catch (err: any) {
    log(`[repro] workspace reset between attempts failed (continuing): ${err?.message ?? err}`);
  }
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
  /** Optional: a repro spec whose run is prepended to sandbox commands. */
  reproSpec?: ReproSpec;
  /** Setup commands (e.g. `pip install ...`) to prepend before the repro run. */
  reproSetupCmds?: string[];
  /** Committed (baseline) content of the repro file — used to detect modification. */
  reproBaselineContent?: string;
  log: (msg: string) => void;
}): Promise<FixAttemptOutcome> {
  const { fixInput, workspace, adapter, manifest, payload, log, ghClient, reproSpec } = args;
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

  // Hard guard: the fix agent MUST NOT modify the repro file. If it did,
  // refuse the attempt and feed back into the retry loop.
  if (reproSpec && args.reproBaselineContent !== undefined) {
    const modifiedRepro = fixResult.changes.some((c) => c.path === reproSpec.path);
    if (modifiedRepro) {
      return {
        ok: false,
        retryContext:
          `Your fix modified the repro test (${reproSpec.path}). The repro is read-only — ` +
          `you must make the existing assertions pass without rewriting them.`,
        evalSummary: 'modified-repro',
        fixSummary: fixResult.summary,
      };
    }
    try {
      const onDisk = workspace.readFile(reproSpec.path);
      if (onDisk !== args.reproBaselineContent) {
        return {
          ok: false,
          retryContext:
            `Your fix's commit touched the repro test (${reproSpec.path}). The repro is read-only.`,
          evalSummary: 'modified-repro',
          fixSummary: fixResult.summary,
        };
      }
    } catch {
      return {
        ok: false,
        retryContext: `Your fix deleted the repro test (${reproSpec.path}). The repro is read-only.`,
        evalSummary: 'modified-repro',
        fixSummary: fixResult.summary,
      };
    }
  }

  const adapterTestCommands = await adapter.getTestCommands();
  const reproSetupCmds = args.reproSetupCmds ?? [];
  const testCommands = reproSpec
    ? [...reproSetupCmds, reproSpec.runCommand, ...adapterTestCommands]
    : adapterTestCommands;
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
  let reproPRSection: string | null = null;

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

    let fixInputBase: FixAgentInput = {
      designSummary,
      confirmedIssues,
      affectedModule: routing.result.affectedModule,
      moduleSource,
      moduleTests,
      recentCommits,
      forkFullName: fork.forkFullName,
      branchName: fork.branchName,
    };

    // Pre-load files explicitly named in the issue body / traceback so the
    // FIRST fix attempt sees them — avoids the wasted attempt-1-then-retry
    // cycle when gatherModuleFiles' blind sample misses the actual file.
    const issueFragments = confirmedIssues.flatMap((i) => [i.title, i.body]);
    const mentionedPaths = extractFilePathsFromAll(issueFragments);
    if (mentionedPaths.length > 0) {
      log(`[fix-prep] issue mentions ${mentionedPaths.length} candidate path(s): ${mentionedPaths.join(', ')}`);
      const before = fixInputBase.moduleSource.length;
      fixInputBase = await augmentModuleSourceWithFiles(fixInputBase, mentionedPaths, workspace, log);
      const added = fixInputBase.moduleSource.length - before;
      log(`[fix-prep] preloaded ${added} mentioned file(s) into moduleSource`);
    }

    // ---------- Repro stage: prove the bug reproduces BEFORE attempting a fix ----------
    // We ask an LLM to write a small Python test that exits non-zero with a
    // failure sentinel string on the reported bug. We then run it on baseline
    // (pre-fix code) and require: (a) exit≠0 (b) sentinel printed (c) no
    // infrastructure failures (ModuleNotFoundError etc.) (d) no timeout. If
    // valid we commit ONLY the repro file (not -A) so any sandbox side
    // effects don't sneak in, and feed its path+content into the fix agent.
    //
    // Credentials gate: if the LLM declares (or the baseline output implies)
    // env vars we don't have, halt the run, email the user the list of
    // env vars + where to add them, label the issue `awaiting-credentials`,
    // and exit. The user re-triggers after adding the keys.
    let reproSpec: ReproSpec | undefined;
    let reproBaselineContent: string | undefined;
    let reproSetupCmds: string[] = [];

    // Generic halt helper used by both the credentials gate and the
    // repro-not-runnable gate. Resets the working tree, emails PM, comments
    // on the issue, applies a label, and returns the right PipelineResult.
    const haltAndEmail = async (args: {
      label: string;
      subject: string;
      bodyLines: string[];
      commentBody: string;
      result: PipelineResult;
      logTag: string;
    }): Promise<PipelineResult> => {
      try {
        await workspace.resetWorkingTree();
      } catch {
        /* best-effort */
      }
      log(`[repro] HALT (${args.logTag})`);
      if (deps.live) {
        try {
          await deps.live.failureNotifier.sendEmail(
            manifest.pm_email,
            args.subject,
            args.bodyLines.join('\n'),
            manifest.pm_email
          );
          log(`[repro] notification emailed to ${manifest.pm_email}`);
        } catch (mailErr: any) {
          log(`[repro] email send failed: ${mailErr?.message ?? mailErr}`);
        }
        try {
          const issueCommenter = new GitHubIssueCommenter(deps.token);
          await issueCommenter.postComment(repoFullName, issueNumber, args.commentBody);
        } catch (commentErr: any) {
          log(`[repro] issue comment failed: ${commentErr?.message ?? commentErr}`);
        }
        try {
          await ghClient.addLabelsToPR(repoFullName, issueNumber, [args.label]);
        } catch (labelErr: any) {
          log(`[repro] label add failed: ${labelErr?.message ?? labelErr}`);
        }
      } else {
        log(`[repro] (no live deps) would have emailed ${manifest.pm_email}: ${args.subject}`);
      }
      return args.result;
    };

    const renderEnvUrl = (): string | null =>
      process.env.RENDER_DASHBOARD_URL ??
      (process.env.RENDER_SERVICE_ID
        ? `https://dashboard.render.com/web/${process.env.RENDER_SERVICE_ID}/env`
        : null);

    const haltForCredentials = async (
      creds: ReadonlyArray<RequiredCredential>,
      detectionContext: string
    ): Promise<PipelineResult> => {
      const envNames = creds.map((c) => c.envVar);
      const issueUrl = `https://github.com/${repoFullName}/issues/${issueNumber}`;
      const renderUrl = renderEnvUrl();
      const credLines = creds.map((c) => {
        const where = c.whereToGet ? `\n    where: ${c.whereToGet}` : '';
        return `- ${c.envVar}\n    purpose: ${c.purpose}${where}`;
      });
      return haltAndEmail({
        label: 'awaiting-credentials',
        subject: `[oss-agent] credentials needed for ${repoFullName}#${issueNumber}`,
        bodyLines: [
          `The repro stage needs ${creds.length} credential(s) before it can prove the bug:`,
          ``,
          ...credLines,
          ``,
          `Detection: ${detectionContext}`,
          ``,
          renderUrl
            ? `Add them at: ${renderUrl}\nThen re-trigger this issue (e.g. by re-applying the trigger label) to resume.`
            : `Add them to the agent's runtime environment, then re-trigger this issue (e.g. by re-applying the trigger label) to resume.`,
          ``,
          `Issue: ${issueUrl}`,
          ``,
          `Run: ${runId}`,
        ],
        commentBody: `🔒 **Awaiting credentials.** The reproduction test needs ${envNames.length} env var(s) (${envNames.join(', ')}) that aren't set on the agent runtime. The maintainer has been emailed with instructions; the run will be resumed after they're added.`,
        result: {
          status: 'awaiting-credentials',
          reason: `missing env vars: ${envNames.join(', ')}`,
          missingEnvVars: envNames,
        },
        logTag: `missing credentials (${detectionContext}): ${envNames.join(', ')}`,
      });
    };

    const haltForReproNotRunnable = async (args: {
      reason: string;
      stderrTail?: string;
      stdoutTail?: string;
      attemptedCommands: string[];
      reproPath?: string;
    }): Promise<PipelineResult> => {
      const issueUrl = `https://github.com/${repoFullName}/issues/${issueNumber}`;
      const branchUrl = `https://github.com/${fork.forkFullName}/tree/${fork.branchName}`;
      const stderrBlock = (args.stderrTail ?? '').trim()
        ? ['stderr (tail):', '```', args.stderrTail!.trim().slice(-2000), '```']
        : [];
      const stdoutBlock = (args.stdoutTail ?? '').trim()
        ? ['stdout (tail):', '```', args.stdoutTail!.trim().slice(-2000), '```']
        : [];
      const cmdBlock =
        args.attemptedCommands.length > 0
          ? ['Commands executed (in order):', ...args.attemptedCommands.map((c) => `  $ ${c}`)]
          : [];
      const reproLine = args.reproPath
        ? `Generated repro file: \`${args.reproPath}\` (on branch ${fork.branchName} — not yet pushed)`
        : `No repro file was generated.`;
      return haltAndEmail({
        label: 'awaiting-repro-fix',
        subject: `[oss-agent] repro cannot run for ${repoFullName}#${issueNumber}`,
        bodyLines: [
          `The reproduction test could not be established for this issue, so no PR will be opened.`,
          ``,
          `Reason: ${args.reason}`,
          ``,
          reproLine,
          ``,
          ...cmdBlock,
          ``,
          ...stderrBlock,
          ...(stderrBlock.length && stdoutBlock.length ? [''] : []),
          ...stdoutBlock,
          ``,
          `What to do:`,
          `  1. Inspect the repro file on the agent branch: ${branchUrl}`,
          `  2. If a dependency is missing, either:`,
          `       - update the affected adapter to install it via getReproSetupCommands(), OR`,
          `       - re-trigger so the LLM can declare it in editableInstalls / pipPackages.`,
          `  3. If the repro is fundamentally wrong (asserts the wrong thing), close the issue or remove the agent label.`,
          `  4. Re-apply the trigger label to resume.`,
          ``,
          `Issue: ${issueUrl}`,
          ``,
          `Run: ${runId}`,
        ],
        commentBody: `⛔ **Repro could not run.** ${args.reason}\n\nNo PR has been opened — the maintainer has been emailed with details. Re-trigger after addressing the cause.`,
        result: {
          status: 'repro-not-runnable',
          reason: args.reason,
        },
        logTag: `repro-not-runnable: ${args.reason}`,
      });
    };

    try {
      log('[repro] generating reproduction test (iterative loop)');
      const adapterReproSetup = (await adapter.getReproSetupCommands?.()) ?? [];
      if (adapterReproSetup.length > 0) {
        log(`[repro] adapter setup commands: ${adapterReproSetup.length}`);
      }
      reproSetupCmds = [...adapterReproSetup];

      const sandboxServices = await adapter.getSandboxServices();

      const reproWorkspace = new LocalReproWorkspace(
        workspace,
        routing.result.affectedModule
      );

      // Captured by the baseline-runner callback so we can surface the exact
      // command list (adapter + final LLM-declared setup) on success or in
      // halt diagnostics. Updated on EVERY attempt — the LLM may change its
      // declared deps between iterations and the fix stage must use the
      // setup that actually proved the bug.
      let lastBaselineCmds: string[] = [];
      let lastValidatedSetup: { editableInstalls: string[]; pipPackages: string[] } | null = null;

      const baselineRunner: BaselineRunner = async (spec): Promise<BaselineRunResult> => {
        // ---- Per-attempt setup validation (semantic: must exist on disk) ----
        let validatedSetup: { editableInstalls: string[]; pipPackages: string[] };
        try {
          validatedSetup = validateReproSetup({
            editableInstalls: spec.editableInstalls,
            pipPackages: spec.pipPackages,
          });
        } catch (err: any) {
          // Reset and report — feedback so the LLM can fix the setup next turn.
          await safeReset(workspace, log);
          return {
            ok: false,
            stage: 'workspace_setup',
            reason:
              err instanceof ReproSetupValidationError
                ? `LLM-declared repro setup failed validation: ${err.message}`
                : err?.message ?? String(err),
            exitCode: null,
            stdout: '',
            stderr: '',
          };
        }

        for (const dir of validatedSetup.editableInstalls) {
          const reason = validateEditableInstallPath(workspace.dir, dir);
          if (reason) {
            await safeReset(workspace, log);
            return {
              ok: false,
              stage: 'workspace_setup',
              reason: `editable install path is invalid (${dir}): ${reason}`,
              exitCode: null,
              stdout: '',
              stderr: '',
            };
          }
        }

        // ---- Proactive credentials check ----
        const declaredCheck = findMissingDeclaredCredentials(
          spec.requiredCredentials,
          process.env
        );
        if (declaredCheck.missing.length > 0) {
          // TERMINAL — we will not retry around missing real-world API keys.
          await safeReset(workspace, log);
          return {
            ok: false,
            stage: 'baseline_failed_to_repro',
            reason: `repro requires undeclared credentials: ${declaredCheck.missing.map((c) => c.envVar).join(', ')}`,
            exitCode: null,
            stdout: '',
            stderr: '',
            credentialsTerminal: {
              inferredEnvVars: declaredCheck.missing.map((c) => c.envVar),
              matchedPattern: 'declared by repro generator',
            },
          };
        }

        const llmSetupCmds = buildPipInstallCommands(validatedSetup);
        const baselineCmds = [...adapterReproSetup, ...llmSetupCmds, spec.runCommand];
        lastBaselineCmds = baselineCmds;
        lastValidatedSetup = validatedSetup;

        log(`[repro] baseline attempt: ${baselineCmds.length} command(s) (path=${spec.path})`);

        // ---- AST pre-flight gate ----
        // A SyntaxError in the LLM-emitted Python burns ~80s + pip cost in
        // the sandbox. Catch it locally with `python -c "import ast; ast.parse(...)"`
        // first. Best-effort — falls through to the sandbox if no python is
        // available on this host.
        const ast = await pythonAstCheck(spec.content);
        if (!ast.ok) {
          await safeReset(workspace, log);
          log(`[repro] AST pre-flight rejected candidate: ${ast.reason}`);
          return {
            ok: false,
            stage: 'workspace_setup',
            reason: ast.reason,
            exitCode: null,
            stdout: '',
            stderr: ast.reason,
          };
        }

        // Write the candidate into the workspace.
        try {
          workspace.writeFile(spec.path, spec.content);
        } catch (err: any) {
          await safeReset(workspace, log);
          return {
            ok: false,
            stage: 'workspace_setup',
            reason: `failed to write repro file: ${err?.message ?? err}`,
            exitCode: null,
            stdout: '',
            stderr: '',
          };
        }

        let baselineArtifact;
        try {
          baselineArtifact = await runLocalSandbox({
            workspace,
            config: {
              repoFullName,
              forkFullName: fork.forkFullName,
              branchName: fork.branchName,
              workflowRepoFullName: '',
              testCommands: baselineCmds,
              sandboxServices,
              timeoutMinutes: manifest.sandbox_timeout_mins ?? 15,
            },
            services: sandboxServices.filter(
              (s): s is Exclude<typeof s, string> => typeof s !== 'string'
            ),
            options: { log },
          });
        } catch (err: any) {
          await safeReset(workspace, log);
          throw err; // bubble up to loop's outer catch
        }

        const reproRunResult =
          baselineArtifact.commands[baselineArtifact.commands.length - 1];
        const reproStdout = reproRunResult?.stdout ?? '';
        const reproStderr = reproRunResult?.stderr ?? '';

        const failedSetupCmd = baselineArtifact.commands
          .slice(0, -1)
          .find((c) => (c.exitCode ?? 1) !== 0);

        if (failedSetupCmd) {
          await safeReset(workspace, log);
          return {
            ok: false,
            stage: 'baseline_setup_command_failed',
            reason: `setup command failed: \`${failedSetupCmd.command}\` (exit ${failedSetupCmd.exitCode})`,
            exitCode: failedSetupCmd.exitCode ?? null,
            stdout: failedSetupCmd.stdout ?? '',
            stderr: failedSetupCmd.stderr ?? '',
            failedSetupCommand: failedSetupCmd.command,
          };
        }

        if (baselineArtifact.result.timedOut) {
          await safeReset(workspace, log);
          return {
            ok: false,
            stage: 'baseline_timeout',
            reason: 'repro timed out on baseline; cannot trust exit code as proof of bug',
            exitCode: reproRunResult?.exitCode ?? null,
            stdout: reproStdout,
            stderr: reproStderr,
          };
        }

        const validation = validateReproBaseline({
          exitCode: reproRunResult?.exitCode ?? null,
          stdout: reproStdout,
          stderr: reproStderr,
          failureSentinel: spec.failureSentinel,
        });

        // ---- Reactive credentials gate ----
        const sentinelPrinted =
          reproStdout.includes(spec.failureSentinel) ||
          reproStderr.includes(spec.failureSentinel);
        if (!validation.ok && !sentinelPrinted) {
          const detected = detectCredentialError(reproStdout, reproStderr);
          if (detected.isCredentialError) {
            const merged = mergeCredentialSources(
              spec.requiredCredentials ?? [],
              detected.inferredEnvVars
            );
            const recheck = findMissingDeclaredCredentials(merged, process.env);
            if (recheck.missing.length > 0) {
              await safeReset(workspace, log);
              return {
                ok: false,
                stage: 'baseline_failed_to_repro',
                reason: `repro stderr indicates missing credentials (${detected.matchedPattern ?? 'unknown'})`,
                exitCode: reproRunResult?.exitCode ?? null,
                stdout: reproStdout,
                stderr: reproStderr,
                credentialsTerminal: {
                  inferredEnvVars: recheck.missing.map((c) => c.envVar),
                  matchedPattern: detected.matchedPattern ?? null,
                },
              };
            }
          }
        }

        if (!validation.ok) {
          await safeReset(workspace, log);
          return {
            ok: false,
            stage: 'baseline_failed_to_repro',
            reason: validation.reason,
            exitCode: reproRunResult?.exitCode ?? null,
            stdout: reproStdout,
            stderr: reproStderr,
          };
        }

        // SUCCESS — leave the workspace as the runner found it. The outer
        // post-loop block re-resets, re-writes, and commits a clean repro.
        return {
          ok: true,
          exitCode: reproRunResult?.exitCode ?? null,
          stdout: reproStdout,
          stderr: reproStderr,
        };
      };

      let loopResult;
      try {
        loopResult = await runReproLoop(
          {
            confirmedIssues,
            affectedModule: routing.result.affectedModule,
            moduleSource: fixInputBase.moduleSource,
            language: 'python',
            preferredTestDir: 'tests',
          },
          new OpenRouterIterativeReproGenerator(),
          reproWorkspace,
          baselineRunner,
          { log }
        );
      } catch (err: any) {
        if (err instanceof ReproCredentialsRequiredError) {
          // Map to the existing awaiting-credentials gate. We need to
          // synthesise RequiredCredential entries from the env-var list.
          const creds: RequiredCredential[] = err.missingEnvVars.map((envVar) => ({
            envVar,
            purpose: 'inferred from repro baseline output',
          }));
          return await haltForCredentials(creds, err.detectionContext);
        }
        if (err instanceof ReproUnreproducibleError) {
          // Build a rich diagnostic from the attempt history.
          const last = err.attempts[err.attempts.length - 1];
          const summaryLines = err.attempts.map((a) => {
            const stage = a.stage;
            const ec = a.exitCode != null ? ` exit=${a.exitCode}` : '';
            const candPath = a.candidate?.path ? ` ${a.candidate.path}` : '';
            return `  - attempt ${a.attempt} [${stage}${ec}]${candPath}: ${a.reason}`;
          });
          const reason =
            `repro loop exhausted (${err.attempts.length} attempt(s)): ${err.lastReason}\n` +
            `History:\n${summaryLines.join('\n')}`;
          log(`[repro] ${reason.split('\n')[0]}`);
          return await haltForReproNotRunnable({
            reason,
            stderrTail: last?.stderrTail,
            stdoutTail: last?.stdoutTail,
            attemptedCommands: lastBaselineCmds,
            reproPath: last?.candidate?.path,
          });
        }
        throw err;
      }

      const generated = loopResult.spec;
      log(`[repro] generated at ${generated.path} (sentinel="${generated.failureSentinel}", attempts=${loopResult.attempts.length})`);
      if (generated.requiredCredentials && generated.requiredCredentials.length > 0) {
        log(
          `[repro] LLM declared ${generated.requiredCredentials.length} required credential(s): ${generated.requiredCredentials.map((c) => c.envVar).join(', ')}`
        );
      }

      // Effective setup the fix stage will inherit (adapter baseline + final
      // LLM-declared deps from the winning attempt).
      const finalSetup = lastValidatedSetup ?? { editableInstalls: [], pipPackages: [] };
      const finalLlmSetupCmds = buildPipInstallCommands(finalSetup);
      reproSetupCmds = [...adapterReproSetup, ...finalLlmSetupCmds];
      if (finalLlmSetupCmds.length > 0) {
        log(
          `[repro] final LLM-declared setup: ${finalSetup.pipPackages.length} pip package(s), ${finalSetup.editableInstalls.length} editable install(s)`
        );
      }

      log(`[repro] baseline FAILED with sentinel (exit=${loopResult.baseline.exitCode}) — bug confirmed`);
      // Reset any side-effect files the script may have written during the
      // baseline run, then re-write the canonical repro content and commit
      // ONLY that path. This guarantees the repro commit contains nothing
      // unexpected.
      await workspace.resetWorkingTree();
      workspace.writeFile(generated.path, generated.content);
      reproBaselineContent = generated.content;
      await workspace.commitPaths([generated.path], `test: add repro for #${issueNumber}`);
      await workspace.push();
      log(`[repro] committed and pushed (single path: ${generated.path})`);
      reproSpec = generated;
      fixInputBase = {
        ...fixInputBase,
        reproTest: { path: generated.path, content: reproBaselineContent },
      };
      reproPRSection = [
        `## Reproduction Verification`,
        `A reproduction test was generated and run before applying the fix:`,
        ``,
        `- **Path**: \`${generated.path}\``,
        `- **Run command**: \`${generated.runCommand}\``,
        `- **Baseline (pre-fix)**: failed with exit ${loopResult.baseline.exitCode ?? '?'} and printed sentinel \`${generated.failureSentinel}\` — bug reproduced.`,
        `- **Iterations**: produced after ${loopResult.attempts.length} repro-agent turn(s).`,
        `- **Post-fix**: this PR's sandbox run executes the same command and requires it to pass (the eval gate enforces this on every retry).`,
      ].join('\n');
    } catch (err: any) {
      // Anything that escapes the loop / runner that isn't already handled
      // above is treated as a halt — never open a PR without a verified repro.
      log(`[repro] generation failed: ${err?.message ?? err}`);
      return await haltForReproNotRunnable({
        reason: `repro generation failed: ${err?.message ?? String(err)}`,
        attemptedCommands: reproSetupCmds,
      });
    }

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
          reproSpec,
          reproSetupCmds,
          reproBaselineContent,
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
    ...(reproPRSection ? [reproPRSection, ``] : []),
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
