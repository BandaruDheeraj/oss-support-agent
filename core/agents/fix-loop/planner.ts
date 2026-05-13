/**
 * Fix Planner — reads dossier + notes, commits a structured Plan via commit_plan.
 */

import { runAgentLoop } from '../agent-loop';
import { makeFixPlannerRegistry } from '../tools';
import type { Plan, PlanState } from '../tools/handles';
import type { DossierStore, DossierSnapshot } from '../analyst/dossier';
import type { InvestigationNotesStore, InvestigationNotes } from './investigation-notes';
import type { HypothesisTracker } from './hypotheses';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';

export interface RunFixPlannerArgs {
  attemptId: string;
  dossier: DossierStore;
  snapshot: DossierSnapshot;
  notes: InvestigationNotesStore;
  investigationNotes: InvestigationNotes;
  hypotheses: HypothesisTracker;
  issue: IssueHandle;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
}

export interface FixPlannerResult {
  plan: Plan | null;
  terminated: string;
  reason?: string;
  transcriptSummary: string;
}

const SYSTEM = `You are the Fix Planner. Read the dossier + investigation notes, then commit a structured Plan via commit_plan. The Plan is a list of steps the Executor will follow.

Each plan step has stepId, goal, hypothesisSummary, successCheck (a runnable check, e.g. "run_repro green && run_tests core/ green"), files[], risk.

Rules:
- Plan steps should map roughly 1:1 to files the Executor will mutate.
- Do NOT mutate anything yourself.
- Terminate by calling commit_plan. Without that the Executor cannot start.`;

export class InMemoryPlanState implements PlanState {
  private plan: Plan | null = null;
  getPlan() {
    return this.plan;
  }
  commitPlan(p: Plan) {
    this.plan = p;
  }
}

export async function runFixPlanner(args: RunFixPlannerArgs): Promise<FixPlannerResult> {
  const planState = new InMemoryPlanState();
  const registry = makeFixPlannerRegistry({
    ctx: {
      agentName: 'FIX_PLANNER',
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

  const userPrompt = `Dossier ${args.snapshot.snapshotId} root-cause hypothesis: ${args.investigationNotes.body.rootCauseHypothesis}\nSuggested approach: ${args.investigationNotes.body.suggestedApproach}\nRisks: ${args.investigationNotes.body.risks.join('; ')}\nFindings:\n${args.investigationNotes.body.findings
    .map((f) => `- ${f.file ?? '?'}::${f.symbol ?? '?'} — ${f.observation}`)
    .join('\n')}\n\nCommit a Plan via commit_plan.`;

  const result = await runAgentLoop({
    agent: 'FIX_PLANNER',
    registry,
    system: SYSTEM,
    user: userPrompt,
    attemptId: args.attemptId,
    issueNumber: args.issue.number,
    dossierSnapshotId: args.snapshot.snapshotId,
  });

  return {
    plan: planState.getPlan(),
    terminated: result.terminated,
    reason: result.reason,
    transcriptSummary: result.transcriptSummary,
  };
}
