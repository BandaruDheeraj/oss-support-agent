/**
 * Fix orchestrator: Investigator → Planner → Executor → Critic.
 *
 * Final orchestrator-level gate:
 *   - Executor terminated with done.
 *   - Green-evidence audit passed (run_repro + run_tests green after last mutation).
 *   - All changed files have a consumed hypothesis.
 *   - Critic approved AND approvedDiffSha matches the current HEAD.
 *
 * Anything short of all four → no PR. Returns a FixV2Outcome the email
 * composer can map to one of the eight email kinds.
 */

import { DossierStore } from '../analyst/dossier';
import type { DossierSnapshot } from '../analyst/dossier';
import { InvestigationNotesStore } from './investigation-notes';
import { HypothesisTracker } from './hypotheses';
import { runFixInvestigator } from './investigator';
import { runFixPlanner } from './planner';
import { runFixExecutor, type FixExecutorResult } from './executor';
import { runFixCritic, type FixVerdict } from './critic';
import type { Plan } from '../tools/handles';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';

export type FixV2Status =
  | 'fix_approved'
  | 'critic_rejected'
  | 'green_evidence_missing'
  | 'hypothesis_audit_failed'
  | 'executor_failed'
  | 'planner_failed'
  | 'investigator_failed'
  | 'head_drift';

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
  const notes = new InvestigationNotesStore();
  const hypotheses = new HypothesisTracker();

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
  });
  if (!investigator.notes) {
    return {
      status: 'investigator_failed',
      dossier: args.dossier,
      notes,
      hypotheses,
      changedFiles: [],
      message: `Fix Investigator terminated without notes (${investigator.terminated}${investigator.reason ? `: ${investigator.reason}` : ''})`,
    };
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
  });
  if (!planner.plan) {
    return {
      status: 'planner_failed',
      dossier: args.dossier,
      notes,
      hypotheses,
      changedFiles: [],
      message: `Fix Planner did not commit a plan (${planner.terminated}${planner.reason ? `: ${planner.reason}` : ''})`,
    };
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
  });

  if (executor.terminated !== 'done') {
    return {
      status: 'executor_failed',
      dossier: args.dossier,
      notes,
      hypotheses,
      plan: planner.plan,
      executor,
      changedFiles: executor.changedFiles,
      message: `Executor terminated ${executor.terminated}${executor.reason ? `: ${executor.reason}` : ''}`,
    };
  }

  if (!(executor.greenEvidence.reproGreenAfterMutation && executor.greenEvidence.testsGreenAfterMutation)) {
    return {
      status: 'green_evidence_missing',
      dossier: args.dossier,
      notes,
      hypotheses,
      plan: planner.plan,
      executor,
      changedFiles: executor.changedFiles,
      message: `Executor claimed done but green-evidence audit failed: repro=${executor.greenEvidence.reproGreenAfterMutation}, tests=${executor.greenEvidence.testsGreenAfterMutation}`,
    };
  }

  if (executor.unconsumedHypothesisFiles.length > 0) {
    return {
      status: 'hypothesis_audit_failed',
      dossier: args.dossier,
      notes,
      hypotheses,
      plan: planner.plan,
      executor,
      changedFiles: executor.changedFiles,
      message: `Files lacked a consumed structured hypothesis: ${executor.unconsumedHypothesisFiles.join(', ')}`,
    };
  }

  const headBefore = await args.getCurrentHeadSha();
  const critic = await runFixCritic({
    attemptId: args.attemptId,
    changedFiles: executor.changedFiles,
    reproTestPath: args.reproTestPath,
    dossier: args.dossier,
    snapshot: args.snapshot,
    notes,
    hypotheses,
    issue: args.issue,
    repo: args.repo,
    workspace: args.workspace,
    sandbox: args.sandbox,
    currentHeadSha: headBefore,
  });

  if (critic.verdict.verdict !== 'approve') {
    return {
      status: 'critic_rejected',
      dossier: args.dossier,
      notes,
      hypotheses,
      plan: planner.plan,
      executor,
      criticVerdict: critic.verdict,
      changedFiles: executor.changedFiles,
      message: `Critic ${critic.verdict.verdict}: ${critic.verdict.reason}`,
    };
  }

  const headAfter = await args.getCurrentHeadSha();
  if (critic.verdict.approvedDiffSha && critic.verdict.approvedDiffSha !== headAfter) {
    return {
      status: 'head_drift',
      dossier: args.dossier,
      notes,
      hypotheses,
      plan: planner.plan,
      executor,
      criticVerdict: critic.verdict,
      changedFiles: executor.changedFiles,
      message: `HEAD drift: critic approved ${critic.verdict.approvedDiffSha} but current HEAD is ${headAfter}`,
    };
  }

  return {
    status: 'fix_approved',
    dossier: args.dossier,
    notes,
    hypotheses,
    plan: planner.plan,
    executor,
    criticVerdict: critic.verdict,
    changedFiles: executor.changedFiles,
    message: 'Fix approved by Critic; orchestrator-level gates passed.',
  };
}
