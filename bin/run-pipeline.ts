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
import { sanitizeFixCommit, SanitizeError } from '../core/agents/fix-sanitize';
import { runBuildAgent } from '../core/agents/build';
import { runDocsAgent } from '../core/agents/docs';
import type {
  ConfirmedIssue,
  ModuleCommit,
  ModuleFile,
} from '../core/agents/fix-types';
import type { BuildAgentInput, ReferenceModule } from '../core/agents/build-types';
import type { DocsAgentInput } from '../core/agents/docs-types';
import { OpenRouterScaffoldGenerator } from '../core/llm/openrouter-scaffold-generator';
import { createDefaultTriageClassifier } from '../core/llm/openrouter-triage-classifier';
import type { IssueEvent } from '../core/webhook/types';

import {
  runReproPipeline,
  runFixPipeline,
  type ReproPipelineOutcome,
} from '../core/agents/run-v2';
import { dispatchTypedHaltEmail, buildHaltContext, buildSuccessContext } from '../core/agents/email/dispatch';
import type { ReproCandidateEvaluation, ReproV2Outcome } from '../core/agents/repro-loop-v2/orchestrator';
import type { FixV2Outcome } from '../core/agents/fix-loop/orchestrator';

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
import { appendReplyToThread, detectApproval } from '../core/gmail-mcp';
import { extractFilePathsFromAll } from '../core/issue-file-extractor';
import type { RequiredCredential } from '../core/agents/repro-types';

import {
  runRetryLoop,
  injectRetryContextForBuildAgent,
} from '../core/retry-loop';
import type { RetryLoopConfig } from '../core/retry-loop-types';

import { GitHubRestClient, GitHubIssueCommenter } from './clients/github-rest';
import type { IssueCommenter } from '../core/agents/triage-types';
import { LocalWorkspace } from './clients/local-workspace';
import { LocalForkCommitter, LocalRepoFileReader } from './clients/local-fork-deps';
import { runLocalSandbox } from './clients/local-sandbox';
import type { LiveDeps } from './clients/live-deps';
import { SandboxSession, type GitClient } from '../core/sandbox-session';
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
import { emitOnlineEvaluation } from '../core/observability/evaluator';
import { activeBackend } from '../core/observability';
import { getEvalRecorder } from '../core/observability/eval-recorder';

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
  | {
      status: 'api-unavailable';
      reason: string;
    }
  | {
      status: 'already-fixed-on-main';
      reason: string;
    }
  | { status: 'pr-opened'; prUrl: string; prNumber: number };

const DEFAULT_REPRO_STAGE_TIMEOUT_MS = 20 * 60 * 1000;
const REPRO_STAGE_TIMEOUT_MS_ENV = 'OSA_REPRO_STAGE_TIMEOUT_MS';

export class ReproStageTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly attemptId: string;

  constructor(attemptId: string, timeoutMs: number) {
    super(`repro_stage_timeout: runReproPipeline exceeded ${timeoutMs}ms for attempt ${attemptId}`);
    this.name = 'ReproStageTimeoutError';
    this.timeoutMs = timeoutMs;
    this.attemptId = attemptId;
  }
}

export function resolveReproStageTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[REPRO_STAGE_TIMEOUT_MS_ENV];
  if (!raw) return DEFAULT_REPRO_STAGE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REPRO_STAGE_TIMEOUT_MS;
  return Math.floor(parsed);
}

export async function runReproPipelineWithTimeout(args: {
  attemptId: string;
  timeoutMs: number;
  run: () => Promise<ReproPipelineOutcome>;
  log: (msg: string) => void;
}): Promise<ReproPipelineOutcome> {
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | null = null;

  const reproPromise = args.run();
  const guardedReproPromise = reproPromise.catch((err) => {
    if (!timedOut) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    args.log(`[v2-repro-timeout] repro pipeline rejected after timeout: ${detail}`);
    return new Promise<ReproPipelineOutcome>(() => {});
  });

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(new ReproStageTimeoutError(args.attemptId, args.timeoutMs));
    }, args.timeoutMs);
  });

  try {
    return await Promise.race([guardedReproPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (timedOut) {
      args.log(`[v2-repro-timeout] timed out after ${args.timeoutMs}ms (attempt=${args.attemptId})`);
    }
  }
}

function buildTerminalLogDetail(result: PipelineResult): string {
  switch (result.status) {
    case 'pr-opened':
      return `pr=${result.prUrl}`;
    case 'awaiting-credentials':
      return `reason=${result.reason} missingEnvVars=${result.missingEnvVars.join(',')}`;
    case 'sandbox-failed':
      return `reason=${result.reason}${result.logsPath ? ` logsPath=${result.logsPath}` : ''}`;
    case 'skipped':
    case 'commented':
    case 'fix-failed':
    case 'max-retries-exceeded':
    case 'repro-not-runnable':
    case 'api-unavailable':
    case 'already-fixed-on-main':
      return `reason=${result.reason}`;
    default:
      return '';
  }
}

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
 * Compute a single-line, ACTIONABLE directive from the previous fix attempt's
 * retry context. Mirrors the failureDirective pattern from the repro loop —
 * the corrective signal is otherwise buried in `designSummary`'s "Latest
 * Failure" section, which the LLM empirically does not internalize when it
 * conflicts with its urge to "fix" the failing test by rewriting it.
 *
 * Returns undefined when the failure doesn't map to a known recoverable
 * pattern. The OpenRouterFixGenerator handles undefined by skipping the
 * preamble entirely.
 *
 * Exported for testing.
 */
export function computeFixFailureDirective(
  retryContext: string,
  reproTestPath: string | undefined,
  affectedModule: string
): string | undefined {
  if (!retryContext) return undefined;

  // Protected path — the LLM tried to modify the read-only repro test.
  // Surface the exact path it must NOT include and remind it where the fix
  // actually belongs. This is the most common fix-retry failure.
  const protMatch = /attempted to modify the repro test \(([^)]+)\)/.exec(retryContext);
  if (protMatch || /repro test is read-only/.test(retryContext)) {
    const reproPath = protMatch?.[1] ?? reproTestPath ?? '<the reproTest path>';
    return (
      `Your previous attempt tried to include "${reproPath}" in testChanges. ` +
      `That file is READ-ONLY and was rejected. DO NOT list "${reproPath}" in either ` +
      `sourceChanges or testChanges this turn — listing it WILL cause another rejection. ` +
      `The bug is in the source files under "${affectedModule}" — modify those so the ` +
      `existing repro test's assertions pass as-is. If you must add tests, add them to ` +
      `a DIFFERENT path (e.g. ${affectedModule.replace(/\/$/, '')}/tests/test_fix.py), ` +
      `not the repro path.`
    );
  }

  // Out-of-scope changes.
  if (/produced out-of-scope changes/.test(retryContext)) {
    const m = /out-of-scope changes:\s*([^.]+)/.exec(retryContext);
    const offending = m?.[1]?.trim() ?? '<see retry context>';
    return (
      `Your previous attempt was rejected for out-of-scope changes: ${offending}. ` +
      `Every change MUST be inside "${affectedModule}" or inside the matching tests ` +
      `directory. Remove any file outside that scope from sourceChanges/testChanges.`
    );
  }

  // Destructive whole-file rewrite — the destroyed files are added back to
  // moduleSource by augmentModuleSourceWithFiles, but the LLM still needs to
  // know not to truncate.
  if (/destructive whole-file rewrite/.test(retryContext)) {
    return (
      `Your previous attempt was rejected for whole-file truncation: you replaced ` +
      `existing code with placeholder comments like "# ...existing code...". This ` +
      `turn, re-read the moduleSource entries (now expanded with the destroyed ` +
      `files' full content) and emit the COMPLETE post-edit file content for every ` +
      `modify entry — no ellipses, no "(unchanged)" markers.`
    );
  }

  // Empty changes — generator returned nothing.
  if (/No changes generated/.test(retryContext)) {
    return (
      `Your previous attempt returned zero changes. Re-read the reproTest content ` +
      `and the moduleSource: identify the EXACT line in the source that produces the ` +
      `error the repro asserts on, and emit a targeted modify for that file.`
    );
  }

  // No-op content — generator returned a sourceChanges entry whose `content`
  // is byte-identical to the file already on disk, so git found nothing to
  // commit. This is the LLM "describing" a fix in `summary` while reproducing
  // the file verbatim in `content`. Empirically Claude fails this on large
  // files (>20KB) when asked to reproduce-with-edit; the corrective signal
  // must be loud and at the top of the prompt — and the path forward is to
  // switch to a sourcePatches entry.
  if (/No changes to commit/i.test(retryContext) || /BYTE-FOR-BYTE IDENTICAL/.test(retryContext)) {
    const reproPath = reproTestPath ?? '<the reproTest path>';
    return (
      `Your previous attempt returned a sourceChanges entry, but the "content" you ` +
      `wrote was BYTE-FOR-BYTE IDENTICAL to the file already on the branch — git found ` +
      `nothing to commit. Your summary described an edit that you did NOT actually make ` +
      `in the content you emitted. This is a known failure mode on long files where ` +
      `verbatim reproduction silently drops the targeted edit.\n` +
      `THIS TURN, USE A PATCH INSTEAD OF FULL FILE CONTENT:\n` +
      `  • Empty out sourceChanges (move that entry's path out of sourceChanges).\n` +
      `  • Add a "sourcePatches" entry: {"path": "<same path>", "oldText": "<3-10 line ` +
      `block from the file, copied byte-for-byte>", "newText": "<the same block with ` +
      `your fix applied>"}.\n` +
      `  • The oldText must appear EXACTLY ONCE in the file. Pick a window that uniquely ` +
      `identifies the location (e.g. include the function signature line plus the lines ` +
      `you are editing).\n` +
      `  • Copy oldText character-for-character from moduleSource (same indentation, same ` +
      `whitespace, same newlines). One mismatch and the patch is rejected.\n` +
      `DO NOT modify the repro test "${reproPath}" — it is read-only.`
    );
  }

  // Patch search/replace failed — oldText didn't match (0 occurrences) or
  // matched ambiguously (>1 occurrences). Tell the LLM exactly which case.
  if (/Patch oldText for .* was not found/.test(retryContext)) {
    const m = /Patch oldText for ([^\s]+) was not found/.exec(retryContext);
    const target = m?.[1] ?? '<the patch path>';
    return (
      `Your previous sourcePatches entry for ${target} was rejected: the "oldText" you ` +
      `supplied does not appear anywhere in that file on the branch. The most common ` +
      `cause is that you paraphrased or reformatted the existing code instead of copying ` +
      `it byte-for-byte. This turn, OPEN ${target} from moduleSource, copy a 3-10 line ` +
      `contiguous block EXACTLY (same indentation, same whitespace, same blank lines, ` +
      `same comments) into oldText, then write the replacement in newText. Do not retype ` +
      `from memory — copy from moduleSource verbatim.`
    );
  }
  if (/Patch oldText for .* matched \d+ times/.test(retryContext)) {
    const m = /Patch oldText for ([^\s]+) matched (\d+) times/.exec(retryContext);
    const target = m?.[1] ?? '<the patch path>';
    const count = m?.[2] ?? 'multiple';
    return (
      `Your previous sourcePatches entry for ${target} was rejected: "oldText" matched ` +
      `${count} places in the file (must match exactly once). This turn, EXPAND oldText ` +
      `to include MORE surrounding lines — typically the function signature, a ` +
      `distinctive variable name, or a unique comment near your target line — until the ` +
      `block uniquely identifies the edit location. Then re-emit the patch.`
    );
  }
  if (/Patch target .* could not be read/.test(retryContext)) {
    const m = /Patch target ([^\s]+) could not be read/.exec(retryContext);
    const target = m?.[1] ?? '<the patch path>';
    return (
      `Your previous sourcePatches entry for ${target} was rejected: that path does not ` +
      `exist on the branch. If you intended to create a new file, use sourceChanges with ` +
      `action="create" and full file content instead of a patch. If you intended to edit ` +
      `an existing file, double-check the path against moduleSource (paths must be ` +
      `repo-relative, exactly as they appear in moduleSource entries).`
    );
  }


  // Eval failed after a committed fix — patch was accepted by validation but
  // running the repro/tests in the sandbox still produces a failure. The raw
  // stderr is in retryContext but the LLM empirically doesn't internalize it
  // when it's buried in ## Latest Failure; it regresses to modifying the
  // protected repro test. Promote the actionable signal to top-of-prompt and
  // detect common Python patch bugs the model can correct without re-running.
  if (/^Eval failed:/.test(retryContext)) {
    const reproPath = reproTestPath ?? '<the reproTest path>';
    const hints = retryContext.slice(0, 2000); // cap to keep prompt small

    // Most common bug: model added a guard like `isinstance(x, SomeName)` but
    // forgot to import SomeName. Surface it precisely.
    const nameErr = /NameError: name ['"]([^'"]+)['"] is not defined/.exec(retryContext);
    if (nameErr) {
      const sym = nameErr[1];
      return (
        `Your previous fix referenced "${sym}" in the source but did NOT import it, so ` +
        `running the repro raised "NameError: name '${sym}' is not defined". This turn, ` +
        `add the missing import to the SAME modify entry (e.g. an "from ... import ${sym}" ` +
        `line at the top of the file) alongside your existing change. DO NOT modify the ` +
        `repro test "${reproPath}" — it is read-only. Sandbox output:\n${hints}`
      );
    }

    // ImportError / ModuleNotFoundError — likely wrong import path.
    const importErr = /(ImportError|ModuleNotFoundError):\s*([^\n]+)/.exec(retryContext);
    if (importErr) {
      return (
        `Your previous fix introduced an import that failed at runtime: ` +
        `"${importErr[1]}: ${importErr[2]}". Correct the import path in the SAME source ` +
        `file (check how neighboring imports in moduleSource are written). DO NOT modify ` +
        `the repro test "${reproPath}" — it is read-only. Sandbox output:\n${hints}`
      );
    }

    // Generic fallback — fix committed but the repro/eval still red. The
    // critical signal is "don't touch the repro; adjust YOUR source patch".
    return (
      `Your previous fix was committed but the sandbox eval still failed. Read the ` +
      `sandbox output below and adjust the SAME source file(s) accordingly. DO NOT ` +
      `modify the repro test "${reproPath}" — it is read-only and rewriting it will be ` +
      `rejected. Sandbox output:\n${hints}`
    );
  }

  return undefined;
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

  const issueMentionedPaths = extractFilePathsFromAll([
    payload.issue.title ?? '',
    payload.issue.body ?? '',
  ]).slice(0, 10);

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
    issueMentionedPaths,
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
    thread = appendReplyToThread(thread, reply);
    live.watcher.registerThread(thread);

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
    const persisted = live.pmEmailStateStore.loadThreadState(runId);
    if (persisted) {
      resolvedDecisions = persisted.resolvedDecisions;
      unresolvedQuestions = persisted.unresolvedQuestions;
    } else {
      const newDecisions = extractDecisions(reply.body);
      resolvedDecisions = [...resolvedDecisions, ...newDecisions];
      // best-effort fallback if persistence unexpectedly fails
      const replyLower = reply.body.toLowerCase();
      unresolvedQuestions = unresolvedQuestions.filter(
        (q) => !replyLower.includes(q.toLowerCase().split(' ').slice(0, 3).join(' '))
      );
    }
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

/**
 * Detects terminal repro outcomes that indicate the reported failure is no
 * longer reproducible on the current default branch.
 */
export function classifyAlreadyFixedOnMain(outcome: ReproPipelineOutcome): {
  alreadyFixedOnMain: boolean;
  reason?: string;
} {
  if (outcome.status !== 'not_reproduced') return { alreadyFixedOnMain: false };

  const candidateWithUnexpectedPass = outcome.v2.candidates.find(
    (candidate) =>
      candidate.executor?.outcome === 'unexpected_pass' ||
      candidate.oracle?.criteria.baseline_head_fails === false
  );
  if (candidateWithUnexpectedPass) {
    return {
      alreadyFixedOnMain: true,
      reason:
        candidateWithUnexpectedPass.executor?.reason ||
        candidateWithUnexpectedPass.message ||
        'deterministic replay passed unexpectedly (candidate repro no longer fails)',
    };
  }

  const builderRunPassed = outcome.v2.candidates.find(
    (candidate) => candidate.source === 'builder' && candidate.builderRejectStage === 'run_repro_pass'
  );
  if (builderRunPassed) {
    return {
      alreadyFixedOnMain: true,
      reason:
        builderRunPassed.message ||
        outcome.message ||
        'candidate repro passed during builder validation and no failing recipe could be established',
    };
  }

  return { alreadyFixedOnMain: false };
}

export function classifyNotReproducedAsApiUnavailable(
  outcome: ReproPipelineOutcome
): { reason: string; failureReason: string } | null {
  if (outcome.status !== 'not_reproduced') return null;
  const diagnostics = buildNotReproducedRunDiagnostics(outcome);
  const quotaFailure = diagnostics?.llm_quota_failure;
  if (!quotaFailure) return null;
  if (diagnostics.run_repro.any_executed) return null;
  const stage =
    quotaFailure.stage + (quotaFailure.candidate_id ? `/${quotaFailure.candidate_id}` : '');
  return {
    reason: `LLM provider unavailable before repro execution (${stage}): ${quotaFailure.reason}`,
    failureReason: quotaFailure.reason,
  };
}

export interface NotReproducedRunDiagnostics {
  reason: string;
  semantic_confidence: {
    top_score: number | null;
    low_confidence: boolean;
    diagnostics: string;
    files_returned: string[];
  };
  analyst: {
    has_suspect_symbols: boolean;
    suspect_symbol_count: number;
  };
  run_repro: {
    any_executed: boolean;
    total_calls: number;
    by_candidate: Array<{
      candidate_id: string;
      source: ReproCandidateEvaluation['source'];
      status: ReproCandidateEvaluation['status'];
      calls: number;
    }>;
    errored_before_execution: Array<{
      candidate_id: string;
      status: ReproCandidateEvaluation['status'];
      message: string;
    }>;
  };
  oracle: {
    by_candidate: Array<{
      candidate_id: string;
      source: ReproCandidateEvaluation['source'];
      status: ReproCandidateEvaluation['status'];
      oracle_executed: boolean;
      verdict: 'valid' | 'invalid' | 'credentials_required' | null;
      failed_criteria: string[];
      criteria: Record<string, boolean> | null;
      suspect_path_evidence_present: boolean | null;
      missing_suspect_needles: string[];
      missing_precondition_markers: string[];
      message: string;
    }>;
  };
  llm_quota_failure: {
    stage: 'analyst' | 'prober' | 'builder' | 'orchestrator';
    candidate_id?: string;
    reason: string;
  } | null;
}

export interface ApiUnavailableRunDiagnostics {
  reason: string;
  api_preflight: {
    stage: 'analyst_preflight' | 'unknown';
    route_id: string | null;
    model_id: string | null;
    failure_reason: string;
  };
}

const LLM_QUOTA_FAILURE_PATTERN =
  /\[credits-exhausted\]|\[rate-limited\]|insufficient credit|quota exceeded|payment required|key limit exceeded|\b(?:402|429)\b/i;

function isLlmQuotaFailure(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return LLM_QUOTA_FAILURE_PATTERN.test(reason);
}

function summarizeOracleCandidate(
  candidate: ReproCandidateEvaluation
): NotReproducedRunDiagnostics['oracle']['by_candidate'][number] {
  const oracle = candidate.oracle;
  if (!oracle) {
    return {
      candidate_id: candidate.candidateId,
      source: candidate.source,
      status: candidate.status,
      oracle_executed: false,
      verdict: null,
      failed_criteria: ['oracle_not_executed'],
      criteria: null,
      suspect_path_evidence_present: null,
      missing_suspect_needles: [],
      missing_precondition_markers: [],
      message: candidate.message,
    };
  }
  const failedCriteria = Object.entries(oracle.criteria)
    .filter(([, passed]) => !passed)
    .map(([criterion]) => criterion);
  return {
    candidate_id: candidate.candidateId,
    source: candidate.source,
    status: candidate.status,
    oracle_executed: true,
    verdict: oracle.verdict,
    failed_criteria: failedCriteria,
    criteria: { ...oracle.criteria },
    suspect_path_evidence_present: oracle.suspectPathAssertionResult.passed,
    missing_suspect_needles: oracle.suspectPathAssertionResult.missing.map((m) => m.needle),
    missing_precondition_markers: oracle.preconditionAssertionResult.missingMarkers,
    message: oracle.message,
  };
}

function detectLlmQuotaFailure(v2: ReproV2Outcome): NotReproducedRunDiagnostics['llm_quota_failure'] {
  if (isLlmQuotaFailure(v2.message)) {
    return {
      stage: v2.message.toLowerCase().includes('analyst terminated') ? 'analyst' : 'orchestrator',
      reason: v2.message,
    };
  }
  for (const candidate of v2.candidates) {
    const candidateReason = candidate.prober?.reason ?? candidate.message;
    if (!isLlmQuotaFailure(candidateReason)) continue;
    return {
      stage: candidate.source === 'prober' ? 'prober' : candidate.source === 'builder' ? 'builder' : 'orchestrator',
      candidate_id: candidate.candidateId,
      reason: candidateReason,
    };
  }
  return null;
}

export function buildNotReproducedRunDiagnostics(
  outcome: ReproPipelineOutcome
): NotReproducedRunDiagnostics | null {
  if (outcome.status !== 'not_reproduced') return null;
  const latest = outcome.v2.dossier.latest();
  const semanticConfidence = latest?.body.semanticConfidence;
  const suspectFiles = latest?.body.suspectFiles ?? [];
  const suspectSymbols = latest?.body.suspectSymbols ?? [];

  const runReproByCandidate = outcome.v2.candidates.map((candidate) => {
    const deterministicCalls = candidate.executor?.runs.length ?? 0;
    const proberCalls = candidate.prober?.ranReproCount ?? 0;
    return {
      candidate_id: candidate.candidateId,
      source: candidate.source,
      status: candidate.status,
      calls: deterministicCalls + proberCalls,
      message: candidate.message,
    };
  });
  const totalRunReproCalls = runReproByCandidate.reduce((sum, candidate) => sum + candidate.calls, 0);
  const erroredBeforeExecution = runReproByCandidate
    .filter((candidate) => candidate.calls === 0)
    .map((candidate) => ({
      candidate_id: candidate.candidate_id,
      status: candidate.status,
      message: candidate.message,
    }));

  return {
    reason: outcome.message,
    semantic_confidence: {
      top_score: semanticConfidence?.top_score ?? null,
      low_confidence: semanticConfidence?.low_confidence ?? false,
      diagnostics: semanticConfidence?.diagnostics ?? 'semantic confidence unavailable',
      files_returned: suspectFiles,
    },
    analyst: {
      has_suspect_symbols: suspectSymbols.length > 0,
      suspect_symbol_count: suspectSymbols.length,
    },
    run_repro: {
      any_executed: totalRunReproCalls > 0,
      total_calls: totalRunReproCalls,
      by_candidate: runReproByCandidate.map(({ candidate_id, source, status, calls }) => ({
        candidate_id,
        source,
        status,
        calls,
      })),
      errored_before_execution: erroredBeforeExecution,
    },
    oracle: {
      by_candidate: outcome.v2.candidates.map(summarizeOracleCandidate),
    },
    llm_quota_failure: detectLlmQuotaFailure(outcome.v2),
  };
}

export function buildApiUnavailableRunDiagnostics(
  outcome: ReproPipelineOutcome
): ApiUnavailableRunDiagnostics | null {
  if (outcome.status !== 'api_unavailable') return null;
  const unavailable = outcome.v2.apiUnavailable;
  return {
    reason: outcome.message,
    api_preflight: {
      stage: unavailable?.stage ?? 'unknown',
      route_id: unavailable?.routeId ?? null,
      model_id: unavailable?.modelId ?? null,
      failure_reason: unavailable?.reason ?? outcome.message,
    },
  };
}

interface VerificationResult {
  /** Aggregate gate outcome. ok=false means feed retryContext back to the fix agent. */
  outcome: { ok: boolean; retryContext: string };
  /** True when verification was intentionally skipped (for example, non-GHA runs). */
  verificationSkipped: boolean;
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
  issueNumber: number;
  runId: string;
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
    issueNumber,
    runId,
    workspace,
    affectedModule,
    confirmedIssues,
    log,
  } = args;

  // Verification is GHA-only; in local sandbox mode skip silently with ok=true.
  if (manifest.sandbox_runner !== 'gha') {
    await emitOnlineEvaluation({
      metric: 'verification_gate_passed',
      stage: 'verification',
      score: 0,
      label: 'skipped',
      issueNumber,
      runId,
      repo: upstreamRepo,
      status: 'skipped_non_gha',
      input: {
        issue_number: issueNumber,
        run_id: runId,
        repo: upstreamRepo,
        sandbox_runner: manifest.sandbox_runner,
      },
      output: {
        ok: null,
        retry_context: '',
        skipped: true,
      },
    });
    return {
      outcome: { ok: true, retryContext: '' },
      verificationSkipped: true,
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
    const useRegression = typeof adapter.getRegressionCommands === 'function';
    const testCommands = useRegression
      ? await adapter.getRegressionCommands!()
      : await adapter.getTestCommands();
    log(
      `[verify/regression-guard] source=${useRegression ? 'getRegressionCommands' : 'getTestCommands'} commands=${testCommands.length}`
    );
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

  await emitOnlineEvaluation({
    metric: 'verification_gate_passed',
    stage: 'verification',
    score: outcome.ok ? 1 : 0,
    issueNumber,
    runId,
    repo: upstreamRepo,
    status: outcome.ok ? 'passed' : 'failed',
    input: {
      issue_number: issueNumber,
      run_id: runId,
      repo: upstreamRepo,
      branch: branchName,
    },
    output: {
      ok: outcome.ok,
      regression_detected: regressionDetected,
      regression_diff_count: regressionDiffs.length,
      usability_blocker_count: usabilityBlockers.length,
      retry_context: outcome.retryContext,
    },
  });

  return {
    outcome,
    verificationSkipped: false,
    regressionSection,
    regressionLabels,
    usabilitySection,
    usabilityLabels,
  };
}

function resolveRecordedBackend(): string {
  const active = activeBackend();
  if (active) return active;
  const configured = (process.env.OBSERVABILITY_BACKEND ?? 'none').trim().toLowerCase();
  return configured || 'none';
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
 * Run a single build → sandbox → eval attempt for new_feature issues.
 * Mirrors runFixAttempt but uses the scaffold generator + build agent.
 */
async function runBuildAttempt(args: {
  buildInput: BuildAgentInput;
  workspace: LocalWorkspace;
  adapter: RepoAdapter;
  manifest: Manifest;
  payload: IssueEvent;
  runId: string;
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
  await emitOnlineEvaluation({
    metric: 'build_eval_passed',
    stage: 'build',
    score: evalResult.passed ? 1 : 0,
    issueNumber: payload.issue.number,
    runId: args.runId,
    repo: payload.repository.full_name,
    status: evalResult.passed ? 'passed' : 'failed',
    input: {
      issue_number: payload.issue.number,
      run_id: args.runId,
      repo: payload.repository.full_name,
      module: buildInput.affectedModule,
      test_command_count: testCommands.length,
      sandbox_service_count: sandboxServices.length,
    },
    output: {
      passed: evalResult.passed,
      summary: evalResult.summary,
      retry_context_count: evalResult.retryContext.length,
    },
  });

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
  const evalRecorder = getEvalRecorder();
  const recordedBackend = resolveRecordedBackend();
  let reproPassed: boolean | null = null;
  let fixPassed: boolean | null = null;
  let verificationGatePassed: boolean | null = null;
  let verificationStage: 'pass' | 'fail' | 'skipped_non_gha' | 'not_reached' = 'not_reached';
  let finalDisposition: string = 'runtime-error';
  let errorKind: string | null = null;
  let runDiagnostics: NotReproducedRunDiagnostics | ApiUnavailableRunDiagnostics | null = null;

  const finish = (result: PipelineResult): PipelineResult => {
    finalDisposition = result.status;
    const terminalTag = result.status === 'pr-opened' ? '[v2-done] DONE' : '[v2-halt] HALT';
    const detail = buildTerminalLogDetail(result);
    log(`${terminalTag} status=${result.status}${detail ? ` ${detail}` : ''}`);
    return result;
  };

  try {

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
    return finish({ status: 'commented', reason: 'not-applicable-emailed-maintainer' });
  }

  if (routing.action === 'clarify') {
    return finish({ status: 'commented', reason: 'low-confidence-emailed-maintainer' });
  }

  // route_pm requires live deps for the Gmail design loop.
  if (routing.action === 'route_pm' && !deps.live) {
    log(
      `[skip] issue routed to PM design loop but Gmail/PM deps not configured. ` +
        `Add the manifest skip_pm_gate label to bypass, or set Gmail env vars.`
    );
    return finish({ status: 'skipped', reason: 'pm-design-loop-deps-missing' });
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
  let agentInvestigationSection: string | null = null;
  let v2ReproOutcomeForEmail: ReproPipelineOutcome | null = null;
  let v2FixOutcomeForEmail: import('../core/agents/run-v2').FixPipelineOutcome | null = null;
  let reproDossier: import('../core/agents/analyst/dossier').DossierSnapshot | null = null;
  let fixDossier: import('../core/agents/analyst/dossier').DossierSnapshot | null = null;

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
          runId,
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
        fixPassed = true;
        log(`[build] attempt passed eval; running verification (regression + usability)`);
        const verify = await runVerification({
          manifest,
          adapter,
          token: deps.token,
          forkFullName: fork.forkFullName,
          branchName: fork.branchName,
          upstreamRepo: repoFullName,
          upstreamDefaultBranch: baseBranch,
          issueNumber,
          runId,
          workspace,
          affectedModule: routing.result.affectedModule,
          confirmedIssues,
          log,
        });
        regressionSection = verify.regressionSection;
        regressionLabels = verify.regressionLabels;
        usabilitySection = verify.usabilitySection;
        usabilityLabels = verify.usabilityLabels;
        verificationGatePassed = verify.verificationSkipped ? null : verify.outcome.ok;
        verificationStage = verify.verificationSkipped
          ? 'skipped_non_gha'
          : verify.outcome.ok
            ? 'pass'
            : 'fail';

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
          fixPassed = false;
          return finish({ status: 'max-retries-exceeded', reason: attempt.evalSummary });
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
          fixPassed = false;
          return finish({ status: 'max-retries-exceeded', reason: attempt.evalSummary });
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
    // ---------- v2 cutover: Analyst → Investigator → Planner → Executor → Critic ----------
    // The legacy one-shot fix agent + iterative repro loop have been retired.
    // The v2 driver internally manages retry (Planner can replan, Critic gates
    // approval). The outer retry-loop / RetryStateStore are no longer used on
    // this path; only the verification gate (regression + usability) runs
    // afterwards as a final safety check.

    let baselineSha = '';
    try {
      baselineSha = await workspace.headSha();
      log("[v2] baselineSha=" + baselineSha.slice(0, 12));
    } catch (err: any) {
      log("[v2] could not capture baselineSha (" + (err?.message ?? err) + "); continuing");
    }

    // Captured after runReproPipeline / runFixPipeline run; threaded into
    // typed halt/success emails so the recipient sees the agent's hypothesis,
    // suspect symbols, and root-cause analysis without opening the PR.
    // (Declared at function scope above so the success-email block can read them.)

    // ---- Halt helpers (used by repro stage on credentials / non-ok) -----
    const haltAndEmail = async (args: {
      label?: string;
      kind: 'need_credentials' | 'repro_unreachable';
      context: import('../core/agents/email/context').EmailContext;
      appendBody: string;
      commentBody: string;
      result: PipelineResult;
      logTag: string;
    }): Promise<PipelineResult> => {
      try {
        await workspace.resetWorkingTree();
      } catch {
        /* best-effort */
      }
      log("[v2-halt] HALT (" + args.logTag + ")");
      if (deps.live) {
        await dispatchTypedHaltEmail({
          kind: args.kind,
          context: args.context,
          notifier: deps.live.failureNotifier,
          appendBody: args.appendBody,
          log,
        });
        try {
          const issueCommenter = new GitHubIssueCommenter(deps.token);
          await issueCommenter.postComment(repoFullName, issueNumber, args.commentBody);
        } catch (commentErr: any) {
          log("[v2-halt] issue comment failed: " + (commentErr?.message ?? commentErr));
        }
        if (args.label) {
          try {
            await ghClient.addLabelsToPR(repoFullName, issueNumber, [args.label]);
          } catch (labelErr: any) {
            log("[v2-halt] label add failed: " + (labelErr?.message ?? labelErr));
          }
        }
      } else {
        log("[v2-halt] (no live deps) would have dispatched kind=" + args.kind + " to " + manifest.pm_email);
      }
      return args.result;
    };

    const renderEnvUrl = (): string | null =>
      process.env.RENDER_DASHBOARD_URL ??
      (process.env.RENDER_SERVICE_ID
        ? "https://dashboard.render.com/web/" + process.env.RENDER_SERVICE_ID + "/env"
        : null);

    const haltForCredentials = async (
      creds: ReadonlyArray<RequiredCredential>,
      detectionContext: string
    ): Promise<PipelineResult> => {
      const envNames = creds.map((c) => c.envVar);
      const issueUrl = "https://github.com/" + repoFullName + "/issues/" + issueNumber;
      const renderUrl = renderEnvUrl();
      const credLines = creds.map((c) => {
        const where = c.whereToGet ? "\n    where: " + c.whereToGet : '';
        return "- " + c.envVar + "\n    purpose: " + c.purpose + where;
      });
      const appendBody = [
        "The repro stage needs " + creds.length + " credential(s) before it can prove the bug:",
        '',
        ...credLines,
        '',
        "Detection: " + detectionContext,
        '',
        renderUrl
          ? "Add them at: " + renderUrl + "\nThen re-trigger this issue (e.g. by re-applying the trigger label) to resume."
          : "Add them to the agent's runtime environment, then re-trigger this issue (e.g. by re-applying the trigger label) to resume.",
        '',
        "Issue: " + issueUrl,
        '',
        "Run: " + runId,
      ].join('\n');
      return haltAndEmail({
        label: 'awaiting-credentials',
        kind: 'need_credentials',
        context: buildHaltContext({
          attemptId: runId,
          recipient: manifest.pm_email,
          issueNumber,
          issueUrl,
          missingCredential: envNames.join(', '),
          dossier: reproDossier,
        }),
        appendBody,
        commentBody: "\uD83D\uDD12 **Awaiting credentials.** The reproduction test needs " + envNames.length + " env var(s) (" + envNames.join(', ') + ") that aren't set on the agent runtime. The maintainer has been emailed with instructions; the run will be resumed after they're added.",
        result: {
          status: 'awaiting-credentials',
          reason: "missing env vars: " + envNames.join(', '),
          missingEnvVars: envNames,
        },
        logTag: "missing credentials (" + detectionContext + "): " + envNames.join(', '),
      });
    };

    const haltForReproNotRunnable = async (args: {
      reason: string;
    }): Promise<PipelineResult> => {
      const issueUrl = "https://github.com/" + repoFullName + "/issues/" + issueNumber;
      const branchUrl = "https://github.com/" + fork.forkFullName + "/tree/" + fork.branchName;
      const appendBody = [
        "The reproduction test could not be established for this issue, so no PR will be opened.",
        '',
        "Reason: " + args.reason,
        '',
        "Inspect the agent branch: " + branchUrl,
        '',
        "What to do:",
        "  1. If the repro is fundamentally wrong (asserts the wrong thing), close the issue or remove the agent label.",
        "  2. Re-apply the trigger label to resume.",
        '',
        "Issue: " + issueUrl,
        '',
        "Run: " + runId,
      ].join('\n');
      return haltAndEmail({
        label: 'awaiting-repro-fix',
        kind: 'repro_unreachable',
        context: buildHaltContext({
          attemptId: runId,
          recipient: manifest.pm_email,
          issueNumber,
          issueUrl,
          failureSnippet: args.reason,
          dossier: reproDossier,
        }),
        appendBody,
        commentBody: "\u26D4 **Repro could not run.** " + args.reason + "\n\nNo PR has been opened \u2014 the maintainer has been emailed with details. Re-trigger after addressing the cause.",
        result: {
          status: 'repro-not-runnable',
          reason: args.reason,
        },
        logTag: "repro-not-runnable: " + args.reason,
      });
    };

    const haltForApiUnavailable = async (args: { reason: string }): Promise<PipelineResult> => {
      const issueUrl = "https://github.com/" + repoFullName + "/issues/" + issueNumber;
      const appendBody = [
        "The Analyst API preflight failed before dossier generation, so this run halted early.",
        '',
        "Reason: " + args.reason,
        '',
        "Interpretation: this is an LLM provider/runtime availability problem (not a repro verdict).",
        "Action: restore API access/credits and re-trigger the issue.",
        '',
        "Issue: " + issueUrl,
        '',
        "Run: " + runId,
      ].join('\n');
      return haltAndEmail({
        kind: 'repro_unreachable',
        context: buildHaltContext({
          attemptId: runId,
          recipient: manifest.pm_email,
          issueNumber,
          issueUrl,
          failureSnippet: args.reason,
          dossier: reproDossier,
        }),
        appendBody,
        commentBody:
          "⚠️ **Analyst API unavailable.** " +
          args.reason +
          "\n\nThe run halted before dossier/repro execution. Restore API access and re-trigger.",
        result: {
          status: 'api-unavailable',
          reason: args.reason,
        },
        logTag: "api-unavailable: " + args.reason,
      });
    };

    const haltForAlreadyFixedOnMain = async (args: {
      reason: string;
    }): Promise<PipelineResult> => {
      const issueUrl = "https://github.com/" + repoFullName + "/issues/" + issueNumber;
      const appendBody = [
        "The repro stage did not produce a failing test on the current default branch.",
        '',
        "Signal: deterministic/prober replay passed where a failure was expected.",
        "Reason: " + args.reason,
        '',
        "Interpretation: this issue appears to already be fixed on main (or the issue repro steps have drifted).",
        '',
        "What to do:",
        "  1. If the bug still reproduces, update the issue with exact current commands and a commit SHA.",
        "  2. Re-apply the trigger label to run the pipeline again.",
        '',
        "Issue: " + issueUrl,
        '',
        "Run: " + runId,
      ].join('\n');

      return haltAndEmail({
        kind: 'repro_unreachable',
        context: buildHaltContext({
          attemptId: runId,
          recipient: manifest.pm_email,
          issueNumber,
          issueUrl,
          failureSnippet: args.reason,
          dossier: reproDossier,
        }),
        appendBody,
        commentBody: "✅ **Not reproducible on current main.** " + args.reason + "\n\nNo PR was opened because the generated repro test passed consistently. If this still reproduces for you, please share updated repro steps and re-trigger the pipeline.",
        result: {
          status: 'already-fixed-on-main',
          reason: args.reason,
        },
        logTag: "already-fixed-on-main: " + args.reason,
      });
    };

    // ---- Repro stage (v2) -----------------------------------------------
    const v2SandboxDriver = manifest.sandbox_runner ?? 'local';
    const v2GhActionsSandboxOptions =
      v2SandboxDriver === 'gha'
        ? await (async () => {
            const [testCommands, sandboxServices] = await Promise.all([
              adapter.getTestCommands(),
              adapter.getSandboxServices(),
            ]);
            const actionsClient = new GitHubActionsClient(deps.token);
            const sandboxWorkflowRepo =
              manifest.sandbox_workflow_repo?.trim() ||
              process.env.HARNESS_REPO_FULL_NAME?.trim() ||
              process.env.GITHUB_REPOSITORY?.trim();
            if (!sandboxWorkflowRepo) {
              throw new Error(
                'sandbox_workflow_repo is required for gha sandbox dispatch and could not be inferred from HARNESS_REPO_FULL_NAME/GITHUB_REPOSITORY.'
              );
            }
            const sandboxWorkflowRef =
              manifest.sandbox_workflow_ref?.trim() ||
              process.env.HARNESS_WORKFLOW_REF?.trim() ||
              'main';

            const gitClient: GitClient = {
              getDefaultBranch: (repoName) => ghClient.getDefaultBranch(repoName),
              getBranchSha: (repoName, branchName) => ghClient.getBranchSha(repoName, branchName),
              createBranch: (repoName, branchName, sha) =>
                ghClient.createBranch(repoName, branchName, sha),
              pushPendingChanges: async (repoName, branchName) => {
                if (repoName !== fork.forkFullName || branchName !== fork.branchName) {
                  throw new Error(
                    `SandboxSession pushPendingChanges target mismatch: expected ${fork.forkFullName}@${fork.branchName}, got ${repoName}@${branchName}`
                  );
                }
                await workspace.push();
              },
              getFileContents: (repoName, filePath, ref) =>
                ghClient.getFileContents(repoName, filePath, ref),
            };
            const sandboxSession = new SandboxSession({
              manifest,
              targetRepo: fork.forkFullName,
              sandboxWorkflowRepo,
              sandboxWorkflowRef,
              branch: fork.branchName,
              issueNumber,
              timeoutMins: manifest.sandbox_timeout_mins,
              actionsClient,
              gitClient,
            });

            return {
              actionsClient,
              baseConfig: {
                repoFullName,
                forkFullName: fork.forkFullName,
                branchName: fork.branchName,
                workflowRepoFullName: sandboxWorkflowRepo,
                forkCloneUrl: `https://github.com/${fork.forkFullName}.git`,
                sandboxServices,
                timeoutMinutes: manifest.sandbox_timeout_mins,
              },
              testCommand: testCommands[0],
              sandboxSession,
              log,
            };
          })()
        : undefined;

    log(
      `[v2-driver] sandbox_runner=${v2SandboxDriver} adapter=${v2SandboxDriver === 'gha' ? 'gh-actions' : 'local'}`
    );

    const reproAttemptId = runId + "-repro";
    const reproStageTimeoutMs = resolveReproStageTimeoutMs(process.env);
    let reproOutcome: ReproPipelineOutcome;
    try {
      reproOutcome = await runReproPipelineWithTimeout({
        attemptId: reproAttemptId,
        timeoutMs: reproStageTimeoutMs,
        log,
        run: () =>
          runReproPipeline({
            attemptId: reproAttemptId,
            payload,
            workspace,
            forkFullName: fork.forkFullName,
            branch: fork.branchName,
            baselineSha,
            affectedModule: routing.result.affectedModule,
            language: 'python',
            sandboxDriver: v2SandboxDriver,
            ghActionsSandboxOptions: v2GhActionsSandboxOptions,
            log,
          }),
      });
    } catch (err) {
      if (err instanceof ReproStageTimeoutError) {
        return finish(
          await haltForReproNotRunnable({
            reason: err.message,
          })
        );
      }
      throw err;
    }

    // Capture for typed halt/success emails (before any halt return path).
    reproDossier = reproOutcome.v2.dossier.latest() ?? null;
    v2ReproOutcomeForEmail = reproOutcome;
    reproPassed = reproOutcome.ok;

    if (reproOutcome.status === 'credentials_required') {
      const term = reproOutcome.v2.credentialsTerminal;
      const envVars = term?.inferredEnvVars ?? [];
      const creds: RequiredCredential[] = envVars.map((envVar) => ({
        envVar,
        purpose: 'inferred from repro baseline output',
      }));
      return finish(
        await haltForCredentials(
          creds,
          term?.matchedPattern ?? 'credentials terminal'
        )
      );
    }

    if (reproOutcome.status === 'api_unavailable') {
      runDiagnostics = buildApiUnavailableRunDiagnostics(reproOutcome);
      return finish(
        await haltForApiUnavailable({
          reason: reproOutcome.message,
        })
      );
    }

    const alreadyFixed = classifyAlreadyFixedOnMain(reproOutcome);
    if (alreadyFixed.alreadyFixedOnMain) {
      return finish(
        await haltForAlreadyFixedOnMain({
          reason: alreadyFixed.reason ?? reproOutcome.message,
        })
      );
    }

    const apiUnavailableFromNotReproduced = classifyNotReproducedAsApiUnavailable(reproOutcome);
    if (apiUnavailableFromNotReproduced) {
      runDiagnostics = {
        reason: apiUnavailableFromNotReproduced.reason,
        api_preflight: {
          stage: 'unknown',
          route_id: null,
          model_id: null,
          failure_reason: apiUnavailableFromNotReproduced.failureReason,
        },
      };
      return finish(
        await haltForApiUnavailable({
          reason: apiUnavailableFromNotReproduced.reason,
        })
      );
    }

    if (!reproOutcome.ok || !reproOutcome.candidateTestPath || !reproOutcome.candidateTestContent) {
      if (reproOutcome.status === 'not_reproduced') {
        runDiagnostics = buildNotReproducedRunDiagnostics(reproOutcome);
      }
      return finish(
        await haltForReproNotRunnable({
          reason: reproOutcome.message,
        })
      );
    }

    // Commit ONLY the verified repro file (clean) and push.
    const reproPath = reproOutcome.candidateTestPath;
    await workspace.resetWorkingTree();
    workspace.writeFile(reproPath, reproOutcome.candidateTestContent);
    await workspace.commitPaths([reproPath], "test: add repro for #" + issueNumber);
    await workspace.push();
    log("[v2-repro] committed and pushed " + reproPath);

    reproPRSection = buildReproPRSectionFromV2(reproOutcome.v2);

    // Capture branch SHA AFTER the repro commit \u2014 the fix pipeline runs on
    // top of this baseline.
    let fixBaselineSha = baselineSha;
    try {
      fixBaselineSha = await workspace.headSha();
    } catch {
      /* best-effort */
    }

    // ---- Fix stage (v2) -------------------------------------------------
    const fixAttemptId = runId + "-fix";
    const fixOutcome = await runFixPipeline({
      attemptId: fixAttemptId,
      payload,
      workspace,
      forkFullName: fork.forkFullName,
      branch: fork.branchName,
      baselineSha: fixBaselineSha,
      affectedModule: routing.result.affectedModule,
      language: 'python',
      dossier: reproOutcome.v2.dossier,
      reproTestPath: reproPath,
      sandboxDriver: v2SandboxDriver,
      ghActionsSandboxOptions: v2GhActionsSandboxOptions,
      log,
    });

    fixDossier = fixOutcome.v2.dossier.latest() ?? reproDossier;
    v2FixOutcomeForEmail = fixOutcome;
    fixPassed = fixOutcome.ok;

    if (!fixOutcome.ok) {
      log("[v2-fix] not approved: " + fixOutcome.status + " \u2014 " + fixOutcome.message);
      if (deps.live) {
        const criticReason = fixOutcome.v2.criticVerdict?.reason;
        const criticVerdict = fixOutcome.v2.criticVerdict?.verdict;
        const suggestedRevision = fixOutcome.v2.criticVerdict?.suggestedRevision;
        const planSummary = fixOutcome.v2.plan?.summary;
        const planSteps = fixOutcome.v2.plan?.steps ?? [];
        const appendLines = [
          "The v2 fix pipeline terminated without an approved diff.",
          '',
          "Status: " + fixOutcome.status,
          "Detail: " + fixOutcome.message,
        ];
        if (criticVerdict) appendLines.push('', "Critic verdict: " + criticVerdict + (criticReason ? " \u2014 " + criticReason : ''));
        if (suggestedRevision) appendLines.push('', "Suggested revision: " + suggestedRevision);
        if (planSummary) {
          appendLines.push('', "Planner approach: " + planSummary);
          if (planSteps.length) {
            appendLines.push("Planner steps:");
            for (const s of planSteps) appendLines.push("  - [" + s.stepId + "] " + s.goal);
          }
        }
        if (fixOutcome.changedFiles.length) {
          appendLines.push('', "Files the executor touched before halting:");
          for (const f of fixOutcome.changedFiles) appendLines.push("  - " + f);
        }
        appendLines.push('', "Issue: https://github.com/" + repoFullName + "/issues/" + issueNumber, "Run: " + runId);
        await dispatchTypedHaltEmail({
          kind: 'fix_failed',
          context: buildHaltContext({
            attemptId: fixAttemptId,
            recipient: manifest.pm_email,
            issueNumber,
            issueUrl: "https://github.com/" + repoFullName + "/issues/" + issueNumber,
            failureSnippet: criticReason ?? fixOutcome.message,
            summary: "Status: " + fixOutcome.status,
            fixApproach: planSummary,
            changedFiles: fixOutcome.changedFiles,
            dossier: fixDossier,
          }),
          notifier: deps.live.failureNotifier,
          appendBody: appendLines.join('\n'),
          log,
        });
      }
      return finish({ status: 'max-retries-exceeded', reason: fixOutcome.message });
    }

    // ---- Verification gate (regression + usability) ---------------------
    const verify = await runVerification({
      manifest,
      adapter,
      token: deps.token,
      forkFullName: fork.forkFullName,
      branchName: fork.branchName,
      upstreamRepo: repoFullName,
      upstreamDefaultBranch: baseBranch,
      issueNumber,
      runId,
      workspace,
      affectedModule: routing.result.affectedModule,
      confirmedIssues,
      log,
    });
    regressionSection = verify.regressionSection;
    regressionLabels = verify.regressionLabels;
    usabilitySection = verify.usabilitySection;
    usabilityLabels = verify.usabilityLabels;
    verificationGatePassed = verify.verificationSkipped ? null : verify.outcome.ok;
    verificationStage = verify.verificationSkipped
      ? 'skipped_non_gha'
      : verify.outcome.ok
        ? 'pass'
        : 'fail';

    if (!verify.outcome.ok) {
      log("[v2-fix] verification gate FAILED \u2014 halting (no outer retry on v2 path)");
      if (deps.live) {
        const appendLines = [
          "The v2 pipeline produced an approved fix but the verification gate failed.",
          '',
          "Retry context:",
          verify.outcome.retryContext,
        ];
        if (fixOutcome.v2.plan?.summary) {
          appendLines.push('', "Planner approach: " + fixOutcome.v2.plan.summary);
        }
        if (fixOutcome.changedFiles.length) {
          appendLines.push('', "Changed files:");
          for (const f of fixOutcome.changedFiles) appendLines.push("  - " + f);
        }
        appendLines.push('', "Issue: https://github.com/" + repoFullName + "/issues/" + issueNumber, "Run: " + runId);
        await dispatchTypedHaltEmail({
          kind: 'regression_blocker',
          context: buildHaltContext({
            attemptId: fixAttemptId,
            recipient: manifest.pm_email,
            issueNumber,
            issueUrl: "https://github.com/" + repoFullName + "/issues/" + issueNumber,
            failureSnippet: verify.outcome.retryContext,
            regressionStatus: 'red',
            failureKind: 'verification_gate',
            changedFiles: fixOutcome.changedFiles,
            fixApproach: fixOutcome.v2.plan?.summary,
            dossier: fixDossier,
          }),
          notifier: deps.live.failureNotifier,
          appendBody: appendLines.join('\n'),
          log,
        });
      }
      return finish({
        status: 'max-retries-exceeded',
        reason: summarizeVerificationFailure(verify.outcome.retryContext),
      });
    }

    prSummary = fixOutcome.v2.criticVerdict?.reason ?? fixOutcome.message;
    evalSummary = "v2: " + fixOutcome.status + " (" + fixOutcome.changedFiles.length + " file(s) changed)";
    agentInvestigationSection = buildAgentInvestigationSection(fixOutcome.v2);
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
    ...(agentInvestigationSection ? [agentInvestigationSection, ``] : []),
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

  // Informational success email — explains what was changed and why so the
  // recipient doesn't have to open the PR to understand the agent's work.
  if (deps.live && v2FixOutcomeForEmail) {
    const fxo = v2FixOutcomeForEmail;
    await dispatchTypedHaltEmail({
      kind: 'pr_opened',
      context: buildSuccessContext({
        attemptId: runId,
        recipient: manifest.pm_email,
        issueNumber,
        issueUrl: "https://github.com/" + repoFullName + "/issues/" + issueNumber,
        prNumber: pr.number,
        prUrl: pr.url,
        summary: prSummary,
        fixApproach: fxo.v2.plan?.summary,
        diffSummary: evalSummary,
        changedFiles: fxo.changedFiles,
        failureSnippet: v2ReproOutcomeForEmail?.v2.criticVerdict?.reason,
        dossier: fixDossier ?? reproDossier,
      }),
      notifier: deps.live.failureNotifier,
      appendBody: agentInvestigationSection
        ? agentInvestigationSection + "\n\nPR: " + pr.url
        : "PR: " + pr.url,
      log,
    });
  }

  return finish({ status: 'pr-opened', prUrl: pr.url, prNumber: pr.number });
  } catch (err) {
    errorKind = err instanceof Error ? err.name || 'Error' : typeof err;
    throw err;
  } finally {
    try {
      evalRecorder.record({
        issue_number: issueNumber,
        attempt_id: runId,
        mode: 'pipeline',
        backend: recordedBackend,
        agent: 'pipeline',
        repro_passed: reproPassed,
        fix_passed: fixPassed,
        verification_gate_passed: verificationGatePassed,
        verification_stage: verificationStage,
        regression_passed: null,
        tool_call_counts: {},
        total_cost_usd: null,
        final_disposition: finalDisposition,
        dossier_snapshot_id: null,
        notes_id: null,
        trace_id: runId,
        error_kind: errorKind,
        run_diagnostics: runDiagnostics,
      });
    } catch (recordErr) {
      log(
        `[eval-recorder] failed to persist pipeline outcome: ${
          recordErr instanceof Error ? recordErr.message : String(recordErr)
        }`
      );
    }
  }
}

export function defaultWorkspaceRoot(): string {
  return path.join(process.cwd(), 'data', 'workspaces');
}

// formatDesignBriefEmail is re-exported for tests / external callers.
export { formatDesignBriefEmail, summarizeAgreedDesign, detectApproval };

/**
 * Build the "## Reproduction Verification" PR-body section from the v2
 * ReproV2Outcome. Renders plan info, critic verdict, and the latest analyst
 * dossier summary.
 */
function buildReproPRSectionFromV2(v2: ReproV2Outcome): string {
  const plan = v2.plan;
  const verdict = v2.criticVerdict;
  const dossierLatest = v2.dossier.latest();
  const lines: string[] = ['## Reproduction Verification'];
  if (plan) {
    lines.push(
      `A reproduction test was generated and independently verified by the Repro Critic before applying the fix:`
    );
    lines.push('');
    lines.push(`- **Path**: \`${plan.candidateTestPath}\``);
    lines.push(`- **Sentinel**: \`${plan.sentinelString}\``);
    lines.push(`- **Approach**: ${plan.approach}`);
  }
  if (verdict) {
    lines.push(`- **Critic verdict**: ${verdict.verdict} — ${verdict.reason}`);
    lines.push(
      `- **Reproduced reliably**: ${verdict.reproducedReliably}, sentinel matched: ${verdict.sentinelMatched}`
    );
  }
  if (dossierLatest) {
    lines.push('');
    lines.push(`**Analyst summary**: ${dossierLatest.body.summary}`);
  }
  return lines.join('\n');
}

/**
 * Build the "## Agent Investigation" PR-body section from the v2
 * FixV2Outcome. Renders planner approach, plan steps, critic verdict,
 * changed files, and the analyst's hypothesis/suspect symbols so
 * reviewers can understand *why* the agent chose this fix without
 * needing to open the dossier store.
 */
function buildAgentInvestigationSection(v2: FixV2Outcome): string {
  const plan = v2.plan;
  const verdict = v2.criticVerdict;
  const dossierLatest = v2.dossier.latest();
  const notesLatest = v2.notes.latest?.() ?? null;
  const lines: string[] = ['## Agent Investigation'];

  if (dossierLatest) {
    lines.push(`**Hypothesis**: ${dossierLatest.body.summary}`);
    lines.push(`**Confidence**: ${dossierLatest.body.confidence}`);
    if (dossierLatest.body.suspectSymbols.length) {
      lines.push('');
      lines.push('**Suspect symbols:**');
      for (const s of dossierLatest.body.suspectSymbols) {
        lines.push(`- \`${s.file}::${s.symbol}\` — ${s.reasoning}`);
      }
    }
  }

  if (notesLatest) {
    lines.push('');
    lines.push(`**Root-cause hypothesis**: ${notesLatest.body.rootCauseHypothesis}`);
    lines.push(`**Suggested approach**: ${notesLatest.body.suggestedApproach}`);
    if (notesLatest.body.risks?.length) {
      lines.push(`**Risks**: ${notesLatest.body.risks.join('; ')}`);
    }
  }

  if (plan) {
    lines.push('');
    lines.push(`**Planner approach**: ${plan.summary}`);
    if (plan.steps.length) {
      lines.push('**Planner steps:**');
      for (const s of plan.steps) lines.push(`- [${s.stepId}] ${s.goal}`);
    }
  }

  if (verdict) {
    lines.push('');
    lines.push(`**Fix critic verdict**: \`${verdict.verdict}\` — ${verdict.reason}`);
    if (verdict.suggestedRevision) {
      lines.push(`**Critic suggested revision**: ${verdict.suggestedRevision}`);
    }
  }

  if (v2.changedFiles.length) {
    lines.push('');
    lines.push('**Files changed by the executor:**');
    for (const f of v2.changedFiles) lines.push(`- \`${f}\``);
  }

  return lines.join('\n');
}
