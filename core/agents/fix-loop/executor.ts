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
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';

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
}

export interface FixExecutorResult extends AgentLoopResult {
  greenEvidence: {
    lastMutationTurn: number | null;
    reproGreenAfterMutation: boolean;
    testsGreenAfterMutation: boolean;
  };
  changedFiles: string[];
  unconsumedHypothesisFiles: string[];
}

const SYSTEM = `You are the Fix Executor. Mutate source code via apply_patch to fix the bug, then verify with run_repro and run_tests.

Tools you have:
- Read tier (read_file, grep, find_symbol, find_callers, read_test, git_blame, git_log, read_diff, read_evidence, read_investigation_notes, list_dir, web_fetch, gh_issue, gh_pr).
- Note/meta: note, state_hypothesis, revise_plan, deepen_investigation, done, abandon.
- Write tier: write_test, revise_test, apply_patch, revert_file.
- Sandbox: run_repro, run_tests, run_python, pip_install, python_module_check, list_packages.

Hard rules (the registry will reject violations):
1. ONE stateful tool call per assistant turn (mutation/sandbox/write-test/meta). Reads may be parallel.
2. apply_patch(path) requires (a) you have called read_file or grep on the same path AFTER (b) calling state_hypothesis with the same file, observedEvidenceIds non-empty, and unconsumed. Each hypothesis is consumed by exactly one apply_patch.
3. apply_patch path must be inside the repo's affectedModule, OR be the canonical repro test path, OR clearly under a test directory.
4. Before \`done\`: since your LAST apply_patch or revert_file, you must have observed (in a PRIOR turn) run_repro exit=0 AND run_tests exit=0. Do not call done in the same turn as a mutation. Do not claim done if run_repro still fails.
5. Every changed file must have a consumed hypothesis. The Critic will reject otherwise.

If you cannot satisfy these rules, call abandon with a clear reason. Do NOT fabricate hypotheses.`;

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
    .join('\n')}\n\nIssue #${args.issue.number}: ${args.issue.title}\nAffected module: ${args.repo.affectedModule}\n\nImplement the plan step-by-step. Remember the hard rules.`;

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

  // Green-evidence audit: find the last mutation, then check that a green run_repro and run_tests occurred AFTER it.
  let lastMutationTurn: number | null = null;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const e = transcript[i];
    if (e.ok && (e.tool === 'apply_patch' || e.tool === 'revert_file' || e.tool === 'write_test' || e.tool === 'revise_test')) {
      lastMutationTurn = e.turn;
      break;
    }
  }
  let reproGreen = false;
  let testsGreen = false;
  if (lastMutationTurn !== null) {
    for (const e of transcript) {
      if (e.turn <= lastMutationTurn) continue;
      if (e.tool === 'run_repro' && e.ok && (e.result as any)?.exitCode === 0) reproGreen = true;
      if (e.tool === 'run_tests' && e.ok && (e.result as any)?.exitCode === 0) testsGreen = true;
    }
  }

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
    greenEvidence: {
      lastMutationTurn,
      reproGreenAfterMutation: reproGreen,
      testsGreenAfterMutation: testsGreen,
    },
    changedFiles: changed,
    unconsumedHypothesisFiles: hypothesisAudit.missing,
  };
}
