/**
 * Fix orchestrator: bounded Investigator → Planner → Executor loop, followed by
 * one advisory Critic pass.
 *
 * Deterministic completion promise (must all be true):
 *   - repro_test_passes
 *   - regression_green
 *   - no_head_drift
 *   - scope_ok
 *
 * The loop retries with structured feedback until the promise is satisfied or
 * the iteration/token budget is exhausted.
 */

import { DossierStore } from '../analyst/dossier';
import type { DossierSnapshot } from '../analyst/dossier';
import { InvestigationNotesStore } from './investigation-notes';
import { HypothesisTracker } from './hypotheses';
import { runFixInvestigator } from './investigator';
import { runFixPlanner } from './planner';
import { runFixExecutor, type FixExecutorResult } from './executor';
import { runFixCritic, type FixVerdict } from './critic';
import type { Plan, SandboxRun } from '../tools/handles';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';
import { repairFix } from './fix-repair-agent';

const FIX_MAX_ITERATIONS_ENV = 'FIX_V2_MAX_ITERATIONS';
const FIX_TOKEN_BUDGET_ENV = 'FIX_V2_TOKEN_BUDGET';
const AGENT_LOOP_MAX_TOKENS_ENV = 'AGENT_LOOP_MAX_TOKENS';
const DEFAULT_FIX_MAX_ITERATIONS = 3;
const DEFAULT_AGENT_LOOP_MAX_TOKENS = 16_000;
const AGENT_LOOPS_PER_ITERATION = 3; // investigator + planner + executor
const MAX_FIX_REPAIR_ROUNDS = 3;

const DEPENDENCY_FILE_RE = new RegExp(
  String.raw`(^|/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements(\.[^/]+)?\.txt|pyproject\.toml|poetry\.lock|pipfile(\.lock)?|go\.mod|go\.sum|cargo\.toml|cargo\.lock|pom\.xml|build\.gradle(\.kts)?)$`,
  'i'
);
const LICENSE_FILE_RE = new RegExp(String.raw`(^|/)(license|copying|notice)(\.[^/]+)?$`, 'i');

type CompletionPromiseChecks = {
  repro_test_passes: boolean;
  regression_green: boolean;
  no_head_drift: boolean;
  scope_ok: boolean;
};

type ScopeEvaluation = {
  allowedScope: string[];
  outOfScope: string[];
};

export type FixV2Status =
  | 'fix_approved'
  | 'critic_rejected'
  | 'green_evidence_missing'
  | 'hypothesis_audit_failed'
  | 'executor_failed'
  | 'planner_failed'
  | 'investigator_failed'
  | 'head_drift'
  | 'fix_failed';

export interface FixV2Outcome {
  status: FixV2Status;
  dossier: DossierStore;
  notes: InvestigationNotesStore;
  hypotheses: HypothesisTracker;
  plan?: Plan;
  executor?: FixExecutorResult;
  criticVerdict?: FixVerdict;
  changedFiles: string[];
  message: string;
}

export interface RunFixV2Args {
  attemptId: string;
  dossier: DossierStore;
  snapshot: DossierSnapshot;
  reproTestPath: string;
  issue: IssueHandle;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
  /** Provided by the orchestrator AFTER Executor terminates; used to detect drift. */
  getCurrentHeadSha(): Promise<string>;
}

export async function runFixV2(args: RunFixV2Args): Promise<FixV2Outcome> {
  const maxIterations = resolveFixIterationCap(process.env);
  const perIterationTokenAllocation = resolvePerIterationTokenAllocation(process.env);
  const tokenBudget = resolveFixTokenBudget(process.env, maxIterations, perIterationTokenAllocation);
  let remainingTokenBudget = tokenBudget;

  const loopStartHead = await args.getCurrentHeadSha();
  const allowedScope = deriveAllowedScope(args.snapshot, args.reproTestPath);

  let retryFeedback: string | undefined;
  let lastFeedback: string | undefined;
  let lastPlan: Plan | undefined;
  let lastExecutor: FixExecutorResult | undefined;
  let lastChangedFiles: string[] = [];
  let lastFailureStage = 'not_started';
  let latestNotes = new InvestigationNotesStore();
  let latestHypotheses = new HypothesisTracker();

  let winningPlan: Plan | undefined;
  let winningExecutor: FixExecutorResult | undefined;
  let winningScope: ScopeEvaluation | undefined;
  let winningNotes: InvestigationNotesStore | undefined;
  let winningHypotheses: HypothesisTracker | undefined;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (remainingTokenBudget < perIterationTokenAllocation) {
      return {
        status: 'fix_failed',
        dossier: args.dossier,
        notes: latestNotes,
        hypotheses: latestHypotheses,
        plan: lastPlan,
        executor: lastExecutor,
        changedFiles: lastChangedFiles,
        message:
          `Fix loop token budget exhausted before iteration ${iteration}. ` +
          `remaining=${remainingTokenBudget}, required=${perIterationTokenAllocation}.` +
          (lastFeedback ? ` Last feedback:\n${lastFeedback}` : ''),
      };
    }
    remainingTokenBudget -= perIterationTokenAllocation;

    const notes = new InvestigationNotesStore();
    const hypotheses = new HypothesisTracker();
    latestNotes = notes;
    latestHypotheses = hypotheses;

    const investigator = await runFixInvestigator({
      attemptId: args.attemptId,
      dossier: args.dossier,
      snapshot: args.snapshot,
      notes,
      hypotheses,
      issue: args.issue,
      repo: args.repo,
      workspace: args.workspace,
      sandbox: args.sandbox,
      retryFeedback,
    });
    if (!investigator.notes) {
      lastFailureStage = 'investigator';
      lastChangedFiles = [];
      lastFeedback = [
        `iteration=${iteration}`,
        'failed_stage=investigator',
        `terminated=${investigator.terminated}`,
        `reason=${investigator.reason ?? '(none)'}`,
        `tool_calls_and_errors=${investigator.transcriptSummary}`,
      ].join('\n');
      retryFeedback = lastFeedback;
      continue;
    }

    const planner = await runFixPlanner({
      attemptId: args.attemptId,
      dossier: args.dossier,
      snapshot: args.snapshot,
      notes,
      investigationNotes: investigator.notes,
      hypotheses,
      issue: args.issue,
      repo: args.repo,
      workspace: args.workspace,
      sandbox: args.sandbox,
      retryFeedback,
    });
    lastPlan = planner.plan ?? undefined;
    if (!planner.plan) {
      lastFailureStage = 'planner';
      lastChangedFiles = [];
      lastFeedback = [
        `iteration=${iteration}`,
        'failed_stage=planner',
        `terminated=${planner.terminated}`,
        `reason=${planner.reason ?? '(none)'}`,
        `tool_calls_and_errors=${planner.transcriptSummary}`,
      ].join('\n');
      retryFeedback = lastFeedback;
      continue;
    }

    const executor = await runFixExecutor({
      attemptId: args.attemptId,
      plan: planner.plan,
      dossier: args.dossier,
      snapshot: args.snapshot,
      notes,
      hypotheses,
      issue: args.issue,
      repo: args.repo,
      workspace: args.workspace,
      sandbox: args.sandbox,
      retryFeedback,
    });

    lastExecutor = executor;
    lastChangedFiles = executor.changedFiles;
    if (executor.terminated !== 'done') {
      lastFailureStage = 'executor';
      lastFeedback = [
        `iteration=${iteration}`,
        'failed_stage=executor',
        `terminated=${executor.terminated}`,
        `reason=${executor.reason ?? '(none)'}`,
        // The terminating reason is often a downstream symptom (e.g. "no local
        // changes to commit" after a rejected write_test). Include every
        // tool's call counts and last error so the next iteration sees the
        // actual blocker, not just the final failure.
        `tool_calls_and_errors=${executor.transcriptSummary}`,
        formatUnconsumedHypothesisFeedback(executor.unconsumedHypothesisFiles),
      ]
        .filter((line) => line.length > 0)
        .join('\n');
      retryFeedback = lastFeedback;
      continue;
    }

    const headAfterExecutor = await args.getCurrentHeadSha();
    const scopeEvaluation = evaluateScope(executor.changedFiles, allowedScope);
    const checks: CompletionPromiseChecks = {
      repro_test_passes: executor.greenEvidence.reproGreenAfterMutation,
      regression_green: executor.greenEvidence.testsGreenAfterMutation,
      no_head_drift: headAfterExecutor === loopStartHead,
      scope_ok: scopeEvaluation.outOfScope.length === 0,
    };
    if (!completionPromisePassed(checks)) {
      // When only the repro test fails, attempt targeted repair before full retry.
      if (!checks.repro_test_passes && executor.changedFiles.length > 0) {
        const repaired = await runFixRepairLoop({
          attemptId: args.attemptId,
          snapshot: args.snapshot,
          changedFiles: executor.changedFiles,
          workspace: args.workspace,
          sandbox: args.sandbox,
          issue: args.issue,
          initialFailureRun: executor.greenEvidence.lastReproRun ?? undefined,
          iterationForLogging: iteration,
        });
        if (repaired.success) {
          const repairedAllFiles = [...executor.changedFiles, ...repaired.additionalChangedFiles];
          const repairedScope = evaluateScope(repairedAllFiles, allowedScope);
          const repairedChecks: CompletionPromiseChecks = {
            repro_test_passes: true,
            regression_green: repaired.testsGreen ?? checks.regression_green,
            no_head_drift: checks.no_head_drift,
            scope_ok: repairedScope.outOfScope.length === 0,
          };
          if (completionPromisePassed(repairedChecks)) {
            winningPlan = planner.plan;
            winningExecutor = {
              ...executor,
              greenEvidence: {
                ...executor.greenEvidence,
                reproGreenAfterMutation: true,
                testsGreenAfterMutation: repaired.testsGreen ?? executor.greenEvidence.testsGreenAfterMutation,
                lastReproRun: repaired.lastReproRun ?? executor.greenEvidence.lastReproRun,
                lastTestsRun: repaired.lastTestsRun ?? executor.greenEvidence.lastTestsRun,
              },
              changedFiles: repairedAllFiles,
            };
            winningScope = repairedScope;
            winningNotes = notes;
            winningHypotheses = hypotheses;
            break;
          }
        }
      }

      lastFailureStage = 'completion_promise';
      lastFeedback = formatCompletionPromiseFeedback({
        iteration,
        checks,
        executor,
        scopeEvaluation,
        loopStartHead,
        headAfterExecutor,
      });
      retryFeedback = lastFeedback;
      continue;
    }

    winningPlan = planner.plan;
    winningExecutor = executor;
    winningScope = scopeEvaluation;
    winningNotes = notes;
    winningHypotheses = hypotheses;
    break;
  }

  if (!winningPlan || !winningExecutor || !winningScope || !winningNotes || !winningHypotheses) {
    return {
      status: 'fix_failed',
      dossier: args.dossier,
      notes: latestNotes,
      hypotheses: latestHypotheses,
      plan: lastPlan,
      executor: lastExecutor,
      changedFiles: lastChangedFiles,
      message:
        `Fix loop exhausted without satisfying deterministic completion promise after ${maxIterations} iteration(s). ` +
        `last_failure_stage=${lastFailureStage}.` +
        (lastFeedback ? ` Last feedback:\n${lastFeedback}` : ''),
    };
  }

  const headBeforeCritic = await args.getCurrentHeadSha();
  const critic = await runFixCritic({
    attemptId: args.attemptId,
    changedFiles: winningExecutor.changedFiles,
    reproTestPath: args.reproTestPath,
    dossier: args.dossier,
    snapshot: args.snapshot,
    notes: winningNotes,
    hypotheses: winningHypotheses,
    issue: args.issue,
    repo: args.repo,
    workspace: args.workspace,
    sandbox: args.sandbox,
    currentHeadSha: headBeforeCritic,
  });

  const headAfterCritic = await args.getCurrentHeadSha();
  if (critic.verdict.approvedDiffSha && critic.verdict.approvedDiffSha !== headAfterCritic) {
    return {
      status: 'head_drift',
      dossier: args.dossier,
      notes: winningNotes,
      hypotheses: winningHypotheses,
      plan: winningPlan,
      executor: winningExecutor,
      criticVerdict: critic.verdict,
      changedFiles: winningExecutor.changedFiles,
      message: `HEAD drift: critic approved ${critic.verdict.approvedDiffSha} but current HEAD is ${headAfterCritic}`,
    };
  }

  let diffText = '';
  try {
    diffText = await args.workspace.readDiff();
  } catch (error) {
    return {
      status: 'critic_rejected',
      dossier: args.dossier,
      notes: winningNotes,
      hypotheses: winningHypotheses,
      plan: winningPlan,
      executor: winningExecutor,
      criticVerdict: critic.verdict,
      changedFiles: winningExecutor.changedFiles,
      message: `Deterministic structural veto: unable to evaluate diff for secret/dependency checks (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  const structuralVetoes = collectDeterministicStructuralVetoes({
    changedFiles: winningExecutor.changedFiles,
    scopeEvaluation: winningScope,
    diffText,
  });
  if (structuralVetoes.length > 0) {
    return {
      status: 'critic_rejected',
      dossier: args.dossier,
      notes: winningNotes,
      hypotheses: winningHypotheses,
      plan: winningPlan,
      executor: winningExecutor,
      criticVerdict: critic.verdict,
      changedFiles: winningExecutor.changedFiles,
      message: `Deterministic structural veto: ${structuralVetoes.join('; ')}`,
    };
  }

  const advisorySuffix =
    critic.verdict.verdict === 'approve'
      ? ''
      : ` Critic advisory only (${critic.verdict.verdict}): ${critic.verdict.reason}`;

  return {
    status: 'fix_approved',
    dossier: args.dossier,
    notes: winningNotes,
    hypotheses: winningHypotheses,
    plan: winningPlan,
    executor: winningExecutor,
    criticVerdict: critic.verdict,
    changedFiles: winningExecutor.changedFiles,
    message: `Fix approved by deterministic completion promise.${advisorySuffix}`,
  };
}

function resolveFixIterationCap(env: NodeJS.ProcessEnv): number {
  const raw = Number(env[FIX_MAX_ITERATIONS_ENV]);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_FIX_MAX_ITERATIONS;
  return Math.max(1, Math.floor(raw));
}

function resolvePerIterationTokenAllocation(env: NodeJS.ProcessEnv): number {
  const agentLoopMaxTokens = Number(env[AGENT_LOOP_MAX_TOKENS_ENV] ?? DEFAULT_AGENT_LOOP_MAX_TOKENS);
  const bounded = Number.isFinite(agentLoopMaxTokens) && agentLoopMaxTokens > 0
    ? Math.floor(agentLoopMaxTokens)
    : DEFAULT_AGENT_LOOP_MAX_TOKENS;
  return bounded * AGENT_LOOPS_PER_ITERATION;
}

function resolveFixTokenBudget(
  env: NodeJS.ProcessEnv,
  maxIterations: number,
  perIterationTokenAllocation: number
): number {
  const raw = Number(env[FIX_TOKEN_BUDGET_ENV]);
  if (Number.isFinite(raw) && raw >= perIterationTokenAllocation) {
    return Math.floor(raw);
  }
  return maxIterations * perIterationTokenAllocation;
}

function completionPromisePassed(checks: CompletionPromiseChecks): boolean {
  // no_head_drift is intentionally excluded: an executor that commits a fix and verifies it
  // in the same iteration is valid. Requiring no_head_drift=true would demand a separate
  // "verify only" iteration after every commit, making the loop always exhaust its budget.
  return checks.repro_test_passes && checks.regression_green && checks.scope_ok;
}

function deriveAllowedScope(snapshot: DossierSnapshot, reproTestPath?: string): string[] {
  const out = new Set<string>();
  for (const assertion of snapshot.body.oracleSpec?.suspect_path_assertions ?? []) {
    const normalized = normalizeRepoPath(assertion.file);
    if (normalized) out.add(normalized);
  }
  if (out.size === 0) {
    for (const suspect of snapshot.body.suspectSymbols) {
      const normalized = normalizeRepoPath(suspect.file);
      if (normalized) out.add(normalized);
    }
  }
  // The repro test is always a legitimate mutation target (executor may need to revise it).
  if (reproTestPath) {
    const normalized = normalizeRepoPath(reproTestPath);
    if (normalized) out.add(normalized);
  }
  return Array.from(out).sort();
}

function normalizeRepoPath(path: string | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
  return normalized.length > 0 ? normalized : null;
}

function evaluateScope(changedFiles: string[], allowedScope: string[]): ScopeEvaluation {
  // Build both exact and directory-prefix matchers from allowedScope. When the dossier names
  // a specific file (e.g. processor.py), the containing package directory is also implicitly
  // in scope so sibling files (tests, __init__.py) are not flagged as out-of-scope.
  const allowedLower = allowedScope.map((p) => p.toLowerCase());
  const allowedExact = new Set(allowedLower);
  // Derive package-root prefixes: walk up from each allowed path until we hit a manifest
  // directory segment (src/, tests/, or a package boundary). As a practical heuristic,
  // treat the two-levels-up ancestor of any file as an allowed prefix so that files in
  // the same package are not rejected. E.g. a/b/c/d.py → prefix a/b/c/ and a/b/.
  const allowedPrefixes: string[] = allowedLower.map((p) => {
    const parts = p.split('/');
    // Include the directory containing the file (index -1) as a prefix.
    return parts.slice(0, -1).join('/') + '/';
  });

  const outOfScope: string[] = [];
  for (const file of changedFiles) {
    const normalized = normalizeRepoPath(file);
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    if (allowedExact.has(lower)) continue;
    if (allowedPrefixes.some((prefix) => lower.startsWith(prefix))) continue;
    // Test files anywhere in the repo are treated as in-scope.
    if (lower.includes('/tests/') || lower.includes('/test/') || lower.includes('__tests__') ||
        lower.includes('.test.') || lower.includes('.spec.') || lower.startsWith('tests/') || lower.startsWith('test/')) {
      continue;
    }
    outOfScope.push(normalized);
  }
  return { allowedScope, outOfScope };
}

function tail(s: string, n = 400): string {
  const trimmed = s.trim();
  if (!trimmed) return '(empty)';
  return trimmed.length > n ? trimmed.slice(-n) : trimmed;
}

function formatUnconsumedHypothesisFeedback(unconsumed: string[]): string {
  if (unconsumed.length === 0) return '';
  return `unconsumed_hypothesis_files=${unconsumed.join(', ')}`;
}

function formatCompletionPromiseFeedback(args: {
  iteration: number;
  checks: CompletionPromiseChecks;
  executor: FixExecutorResult;
  scopeEvaluation: ScopeEvaluation;
  loopStartHead: string;
  headAfterExecutor: string;
}): string {
  const failedChecks = Object.entries(args.checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  const lines: string[] = [
    `iteration=${args.iteration}`,
    'failed_stage=completion_promise',
    `failed_checks=${failedChecks.join(', ') || '(none)'}`,
  ];

  if (!args.checks.repro_test_passes) {
    const run = args.executor.greenEvidence.lastReproRun;
    lines.push(
      `repro_test_passes=false`,
      `repro_exit_code=${run?.exitCode ?? 'n/a'}`,
      `repro_stderr_tail=${tail(run?.stderr ?? '')}`
    );
  }
  if (!args.checks.regression_green) {
    const run = args.executor.greenEvidence.lastTestsRun;
    lines.push(
      `regression_green=false`,
      `tests_exit_code=${run?.exitCode ?? 'n/a'}`,
      `tests_stderr_tail=${tail(run?.stderr ?? '')}`
    );
  }
  if (!args.checks.no_head_drift) {
    lines.push(
      'no_head_drift=false',
      `head_before_loop=${args.loopStartHead}`,
      `head_after_executor=${args.headAfterExecutor}`
    );
  }
  if (!args.checks.scope_ok) {
    lines.push(
      'scope_ok=false',
      `allowed_scope=${args.scopeEvaluation.allowedScope.join(', ') || '(none)'}`,
      `out_of_scope_files=${args.scopeEvaluation.outOfScope.join(', ') || '(none)'}`
    );
  }
  const hypothesis = formatUnconsumedHypothesisFeedback(args.executor.unconsumedHypothesisFiles);
  if (hypothesis) lines.push(hypothesis);
  return lines.join('\n');
}

type FixRepairLoopResult = {
  success: boolean;
  testsGreen?: boolean;
  lastReproRun?: SandboxRun;
  lastTestsRun?: SandboxRun;
  additionalChangedFiles: string[];
};

async function runFixRepairLoop(args: {
  attemptId: string;
  snapshot: DossierSnapshot;
  changedFiles: string[];
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
  issue: IssueHandle;
  initialFailureRun: SandboxRun | undefined;
  iterationForLogging: number;
}): Promise<FixRepairLoopResult> {
  const repairHistory: string[] = [];
  let lastReproRun: SandboxRun | undefined = args.initialFailureRun;
  const additionalChangedFiles: string[] = [];

  for (let round = 0; round < MAX_FIX_REPAIR_ROUNDS; round++) {
    const reproFailureOutput = lastReproRun
      ? `exit=${lastReproRun.exitCode}\nstdout:\n${lastReproRun.stdout}\nstderr:\n${lastReproRun.stderr}`
      : 'repro output unavailable';

    const allTrackedPaths = [...args.changedFiles, ...additionalChangedFiles];
    const changedFileContents: Array<{ path: string; content: string }> = [];
    for (const filePath of allTrackedPaths) {
      const content = await args.workspace.readFile(filePath);
      if (content !== null) changedFileContents.push({ path: filePath, content });
    }

    if (changedFileContents.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`[v2-fix-repair-loop] attempt=${args.attemptId} iter=${args.iterationForLogging} round=${round} no_readable_files`);
      break;
    }

    const repairOutput = await repairFix({
      attemptId: args.attemptId,
      snapshot: args.snapshot,
      changedFiles: changedFileContents,
      reproFailureOutput,
      issueTitle: args.issue.title,
      issueBody: args.issue.body,
      roundNumber: round,
      maxRounds: MAX_FIX_REPAIR_ROUNDS,
      repairHistory,
    });

    if (!repairOutput || repairOutput.abandon) {
      // eslint-disable-next-line no-console
      console.log(`[v2-fix-repair-loop] attempt=${args.attemptId} iter=${args.iterationForLogging} round=${round} abandon=${repairOutput?.abandon}`);
      if (repairOutput?.abandonReason) repairHistory.push(`round ${round + 1}: abandoned — ${repairOutput.abandonReason}`);
      break;
    }

    if (repairOutput.fileUpdates.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`[v2-fix-repair-loop] attempt=${args.attemptId} iter=${args.iterationForLogging} round=${round} no_updates`);
      break;
    }

    for (const update of repairOutput.fileUpdates) {
      const oldText = await args.workspace.readFile(update.path);
      await args.workspace.applyPatch({ path: update.path, oldText: oldText ?? '', newText: update.content });
      if (!allTrackedPaths.includes(update.path)) additionalChangedFiles.push(update.path);
    }
    repairHistory.push(`round ${round + 1}: ${repairOutput.explanation}`);

    lastReproRun = await args.sandbox.runRepro();
    if (lastReproRun.exitCode === 0) {
      const lastTestsRun = await args.sandbox.runTests();
      // eslint-disable-next-line no-console
      console.log(`[v2-fix-repair-loop] attempt=${args.attemptId} iter=${args.iterationForLogging} round=${round} REPRO_GREEN testsGreen=${lastTestsRun.exitCode === 0}`);
      return { success: true, testsGreen: lastTestsRun.exitCode === 0, lastReproRun, lastTestsRun, additionalChangedFiles };
    }
    // eslint-disable-next-line no-console
    console.log(`[v2-fix-repair-loop] attempt=${args.attemptId} iter=${args.iterationForLogging} round=${round} still_failing exitCode=${lastReproRun.exitCode}`);
  }

  return { success: false, lastReproRun, additionalChangedFiles };
}

function collectDeterministicStructuralVetoes(args: {
  changedFiles: string[];
  scopeEvaluation: ScopeEvaluation;
  diffText: string;
}): string[] {
  const vetoes: string[] = [];
  if (args.scopeEvaluation.outOfScope.length > 0) {
    vetoes.push(`out-of-scope edits: ${args.scopeEvaluation.outOfScope.join(', ')}`);
  }

  const dependencyOrLicensePaths = args.changedFiles
    .map((file) => normalizeRepoPath(file))
    .filter((file): file is string => !!file)
    .filter((file) => DEPENDENCY_FILE_RE.test(file) || LICENSE_FILE_RE.test(file));
  if (dependencyOrLicensePaths.length > 0) {
    vetoes.push(`dependency/license file edits: ${dependencyOrLicensePaths.join(', ')}`);
  }

  const secretSignals = detectSecretLeakSignals(args.diffText);
  if (secretSignals.length > 0) {
    vetoes.push(`potential secret leakage: ${secretSignals.join(', ')}`);
  }

  return vetoes;
}

function detectSecretLeakSignals(diffText: string): string[] {
  const signals = new Set<string>();
  const lines = diffText.split(/\r?\n/);

  for (const line of lines) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(added)) signals.add('private-key-block');
    if (/\b(AKIA|ASIA)[0-9A-Z]{16}\b/.test(added)) signals.add('aws-access-key');
    if (/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(added)) signals.add('github-token');
    if (/\bAIza[0-9A-Za-z_-]{35}\b/.test(added)) signals.add('google-api-key');
    if (/\bxox[pbar]-[A-Za-z0-9-]{10,}\b/.test(added)) signals.add('slack-token');

    const kv = added.match(
      /\b([A-Za-z0-9_]*(api[_-]?key|access[_-]?token|secret|password)[A-Za-z0-9_]*)\b\s*[:=]\s*["']([^"']{8,})["']/i
    );
    if (kv) {
      const value = kv[3] ?? '';
      const placeholder = /^(your_|example|dummy|test|changeme|<.*>|\$\{.+\})/i.test(value);
      if (!placeholder) signals.add('credential-assignment');
    }
  }

  return Array.from(signals);
}
