/**
 * Fix Executor — full tool-using loop. Mutates source files via apply_patch
 * (each backed by an unconsumed structured hypothesis), verifies via
 * run_repro + run_tests, terminates with done.
 *
 * Registry guards enforce:
 *   - No parallel stateful calls per turn.
 *   - apply_patch requires read_file/grep + state_hypothesis on same file.
 *   - done forbidden in same turn as a mutation/sandbox/write-test.
 *
 * Post-loop the orchestrator (fix-loop/orchestrator) double-checks the
 * green-evidence rule and changed-file scope.
 */

import { runAgentLoop, type AgentLoopResult } from '../agent-loop';
import { makeFixExecutorRegistry } from '../tools';
import { InMemoryPlanState } from './planner';
import type { Plan } from '../tools/handles';
import type { DossierStore, DossierSnapshot } from '../analyst/dossier';
import type { InvestigationNotesStore } from './investigation-notes';
import type { HypothesisTracker } from './hypotheses';
import type {
  IssueHandle,
  RepoHandle,
  SandboxHandle,
  SandboxRun,
  WorkspaceReader,
  WorkspaceWriter,
} from '../tools/handles';

export interface RunFixExecutorArgs {
  attemptId: string;
  plan: Plan;
  dossier: DossierStore;
  snapshot: DossierSnapshot;
  notes: InvestigationNotesStore;
  hypotheses: HypothesisTracker;
  issue: IssueHandle;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
  retryFeedback?: string;
}

export interface GreenEvidence {
  lastMutationTurn: number | null;
  reproGreenAfterMutation: boolean;
  testsGreenAfterMutation: boolean;
  lastReproRun: SandboxRun | null;
  lastTestsRun: SandboxRun | null;
}

export interface FixExecutorResult extends AgentLoopResult {
  greenEvidence: GreenEvidence;
  changedFiles: string[];
  unconsumedHypothesisFiles: string[];
  /** SHAs the executor itself pushed via commit_and_push, in call order. */
  pushedShas: string[];
}

const SYSTEM = `You are the Fix Executor. Mutate source code via apply_patch to fix the bug, then verify with run_repro and run_tests.

Tools you have:
- Read tier (github_read_file, read_file, grep, grep_with_context, find_symbol, find_callers, read_symbol_context, read_test, git_blame, git_log, read_diff, read_evidence, read_investigation_notes, list_dir, web_fetch, gh_issue, gh_pr, read_issue_repo_context).
- Note/meta: note, state_hypothesis, revise_plan, deepen_investigation, done, abandon.
- Write tier: write_test, revise_test, apply_patch, revert_file, commit_and_push.
- Sandbox: run_repro, run_tests, run_python, pip_install, python_module_check, list_packages.

Reading source files — CRITICAL:
- Use github_read_file(path) to read any file you plan to patch. It returns the exact committed bytes from GitHub — the same content apply_patch will search through.
- Use read_file(path) to inspect the workspace after patching (shows the modified version).
- NEVER use run_python or inspect.getsource to read source file content. That reads from the GHA sandbox's installed package, which may differ from the local workspace file, causing apply_patch to fail with "oldText not found".

Fix + verify workflow (the only workflow that works):
1. github_read_file(path) → get authoritative content
2. state_hypothesis → declare what you will change and why
3. apply_patch → oldText MUST be copied CHARACTER-FOR-CHARACTER from the github_read_file output in step 1.
   ⚠️  NEVER reconstruct oldText from memory or your understanding of the code. Open the github_read_file
   result, find the exact lines you want to replace, and copy-paste them as oldText. One wrong space,
   indent, or character causes "oldText not found" and the patch fails entirely.
4. commit_and_push → commit and push to GitHub (REQUIRED before any sandbox run)
5. run_repro → GHA clones the updated branch and runs tests (now sees the fix)
6. run_tests → run broader test suite
7. done → only after run_repro exit=0 AND run_tests exit=0

Hard rules (the registry will reject violations):
1. ONE stateful tool call per assistant turn (mutation/sandbox/write-test/meta). Reads may be parallel.
2. apply_patch(path) requires (a) you have called github_read_file or read_file or grep on the same path AFTER (b) calling state_hypothesis with the same file, observedEvidenceIds non-empty, and unconsumed. Each hypothesis is consumed by exactly one apply_patch.
3. apply_patch path must be inside the repo's affectedModule, OR be the canonical repro test path, OR clearly under a test directory.
4. commit_and_push is MANDATORY after apply_patch and BEFORE run_repro/run_tests. The sandbox clones from GitHub — it cannot see local workspace changes until they are pushed.
5. Before \`done\`: since your LAST apply_patch or revert_file, you must have observed (in a PRIOR turn) run_repro exit=0 AND run_tests exit=0. Do not call done in the same turn as a mutation. Do not claim done if run_repro still fails.
6. Every changed file must have a consumed hypothesis. The Critic will reject otherwise.

Regression test quality rules (apply whenever you use write_test or revise_test):
7. ONE implementation only. If you write named regression tests (e.g. test_foo_passes_actual_value), do NOT also append a generic test_repro or fallback duplicate that covers the same assertion. One clean test set — not two overlapping ones.
8. Strong assertions. Assert the EXACT expected value: \`assert actual == expected\`. Do NOT use weak inequality assertions like \`assert actual != "some_hardcoded_wrong_value"\` — those pass when the wrong non-hardcoded value is returned, hiding bugs.
9. Match the code's data model. Before writing stubs or fakes, read the source to determine whether the code under test accesses fields via attribute access (\`obj.field\`) or dict access (\`obj["field"]\`). Your test fakes must use the same access pattern as the real code — a mismatch silently skips exercising the real path.
10. No try/except ImportError fallbacks in test bodies. If an import fails the test must raise loudly. A degraded fallback hides interface mismatches and makes the test worthless.

If you cannot satisfy these rules, call abandon with a clear reason. Do NOT fabricate hypotheses.`;

function asSandboxRun(value: unknown): SandboxRun | null {
  if (!value || typeof value !== 'object') return null;
  const run = value as Partial<SandboxRun>;
  if (typeof run.exitCode !== 'number') return null;
  return {
    exitCode: run.exitCode,
    stdout: typeof run.stdout === 'string' ? run.stdout : '',
    stderr: typeof run.stderr === 'string' ? run.stderr : '',
    durationMs: typeof run.durationMs === 'number' ? run.durationMs : 0,
  };
}

export async function runFixExecutor(args: RunFixExecutorArgs): Promise<FixExecutorResult> {
  const planState = new InMemoryPlanState();
  planState.commitPlan(args.plan);

  const registry = makeFixExecutorRegistry({
    ctx: {
      agentName: 'FIX_EXECUTOR',
      attemptId: args.attemptId,
      issueNumber: args.issue.number,
      dossierSnapshotId: args.snapshot.snapshotId,
      handles: {
        workspace: args.workspace,
        sandbox: args.sandbox,
        issue: args.issue,
        repo: args.repo,
        dossier: args.dossier,
        notes: args.notes,
        hypotheses: args.hypotheses,
        plan: planState,
      },
    },
  });

  const userPrompt = `Plan: ${args.plan.summary}\nSteps:\n${args.plan.steps
    .map(
      (s) =>
        `- [${s.stepId}] (${s.risk}) ${s.goal}\n   hypothesis: ${s.hypothesisSummary}\n   files: ${s.files.join(', ')}\n   successCheck: ${s.successCheck}`
    )
    .join('\n')}\n\nIssue #${args.issue.number}: ${args.issue.title}\nAffected module: ${args.repo.affectedModule}${
    args.retryFeedback ? `\n\nPrevious iteration feedback (must be addressed):\n${args.retryFeedback}` : ''
  }\n\nImplement the plan step-by-step. Remember the hard rules.`;

  const loop = await runAgentLoop({
    agent: 'FIX_EXECUTOR',
    registry,
    system: SYSTEM,
    user: userPrompt,
    attemptId: args.attemptId,
    issueNumber: args.issue.number,
    dossierSnapshotId: args.snapshot.snapshotId,
  });

  const transcript = registry.getTranscript();
  // Compute changed files from transcript (apply_patch + write_test entries that succeeded)
  const changed = Array.from(
    new Set(
      transcript
        .filter((e) => e.ok && (e.tool === 'apply_patch' || e.tool === 'write_test' || e.tool === 'revise_test'))
        .map((e) => (e.args as any)?.path)
        .filter((p): p is string => typeof p === 'string')
    )
  );

  const greenEvidence = computeGreenEvidence(transcript);
  const { reproGreenAfterMutation: reproGreen, testsGreenAfterMutation: testsGreen } = greenEvidence;

  // SHAs the executor pushed itself — the orchestrator's head-drift check
  // treats these as legitimate movement (the executor saving its own work).
  const pushedShas = transcript
    .filter((e) => e.ok && e.tool === 'commit_and_push')
    .map((e) => (e.result as { sha?: unknown } | undefined)?.sha)
    .filter((s): s is string => typeof s === 'string');

  const hypothesisAudit = args.hypotheses.allChangedFilesConsumed(changed);

  // eslint-disable-next-line no-console
  console.log(
    `[v2-fix-executor] attempt=${args.attemptId} terminated=${loop.terminated}` +
      ` turns=${loop.turns} toolCalls=${loop.toolCalls}` +
      ` changedFiles=${changed.length} reproGreen=${reproGreen} testsGreen=${testsGreen}` +
      ` unconsumedHypothesisFiles=${hypothesisAudit.missing.length}` +
      (loop.reason ? ` reason=${JSON.stringify(loop.reason).slice(0, 240)}` : '') +
      ` tools=${loop.transcriptSummary}`
  );

  return {
    ...loop,
    greenEvidence,
    changedFiles: changed,
    unconsumedHypothesisFiles: hypothesisAudit.missing,
    pushedShas,
  };
}

/**
 * Green-evidence audit. After the LAST mutation in the run, a green run_repro
 * and run_tests must have occurred — this proves the finished code is what
 * passed, not an earlier state.
 *
 * A verify-only run (no mutations at all) never changes the code state, so
 * any green run during it is valid evidence about the final state. This is
 * the normal shape when a previous iteration already committed the fix and
 * the current iteration only re-verifies.
 */
export function computeGreenEvidence(
  transcript: Array<{ turn: number; tool: string; ok: boolean; result?: unknown }>
): GreenEvidence {
  let lastMutationTurn: number | null = null;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const e = transcript[i];
    if (e.ok && (e.tool === 'apply_patch' || e.tool === 'revert_file' || e.tool === 'write_test' || e.tool === 'revise_test')) {
      lastMutationTurn = e.turn;
      break;
    }
  }

  const evidenceAfterTurn = lastMutationTurn ?? -1;
  let reproGreen = false;
  let testsGreen = false;
  let lastReproRun: SandboxRun | null = null;
  let lastTestsRun: SandboxRun | null = null;
  for (const e of transcript) {
    if (e.turn <= evidenceAfterTurn) continue;
    if (e.tool === 'run_repro' && e.ok) {
      const run = asSandboxRun(e.result);
      if (run) {
        lastReproRun = run;
        if (run.exitCode === 0) reproGreen = true;
      }
    }
    if (e.tool === 'run_tests' && e.ok) {
      const run = asSandboxRun(e.result);
      if (run) {
        lastTestsRun = run;
        if (run.exitCode === 0) testsGreen = true;
      }
    }
  }

  return {
    lastMutationTurn,
    reproGreenAfterMutation: reproGreen,
    testsGreenAfterMutation: testsGreen,
    lastReproRun,
    lastTestsRun,
  };
}
