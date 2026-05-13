/**
 * Fix Investigator — reads dossier + code, writes FixInvestigationNotes.
 */

import { runAgentLoop } from '../agent-loop';
import { makeFixInvestigatorRegistry } from '../tools';
import type { DossierStore, DossierSnapshot } from '../analyst/dossier';
import type { InvestigationNotesStore, InvestigationNotes } from './investigation-notes';
import type { HypothesisTracker } from './hypotheses';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';

export interface RunFixInvestigatorArgs {
  attemptId: string;
  dossier: DossierStore;
  snapshot: DossierSnapshot;
  notes: InvestigationNotesStore;
  hypotheses: HypothesisTracker;
  issue: IssueHandle;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
}

export interface FixInvestigatorResult {
  notes: InvestigationNotes | null;
  terminated: string;
  reason?: string;
  toolCalls: number;
  transcriptSummary: string;
}

const SYSTEM = `You are the Fix Investigator. You read the Analyst's EvidenceDossier and the codebase, deepen the understanding of the bug, and emit FixInvestigationNotes — including a rootCauseHypothesis, suggestedApproach, and structured hypotheses for each file you suspect needs changing.

Rules:
- You are read-only with respect to source files. apply_patch, run_repro, write_test are NOT registered for you.
- Use read_file / grep / find_symbol / find_callers / git_blame to confirm suspicions.
- Use state_hypothesis(file, observedEvidenceIds, expectedEffect, successCheck) for EACH file you believe the fix will touch. observedEvidenceIds MUST come from the dossier evidence ids.
- Terminate by calling write_investigation_notes with all findings. Without that call no downstream agent can proceed.
- If evidence is too thin, call abandon with a clear reason — do not invent root causes.`;

export async function runFixInvestigator(args: RunFixInvestigatorArgs): Promise<FixInvestigatorResult> {
  const registry = makeFixInvestigatorRegistry({
    ctx: {
      agentName: 'FIX_INVESTIGATOR',
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
      },
    },
  });

  const userPrompt = `Dossier snapshot ${args.snapshot.snapshotId} (issue #${args.issue.number}):\n${args.snapshot.body.summary}\n\nConfidence: ${args.snapshot.body.confidence}\nSuspect symbols:\n${args.snapshot.body.suspectSymbols
    .map((s) => `- ${s.file} :: ${s.symbol} (${s.reasoning})`)
    .join('\n')}\nOpen questions:\n${args.snapshot.body.openQuestions.map((q) => `- ${q}`).join('\n')}\n\nDeepen the investigation. State structured hypotheses for each file you believe the fix will touch. Terminate with write_investigation_notes.`;

  const result = await runAgentLoop({
    agent: 'FIX_INVESTIGATOR',
    registry,
    system: SYSTEM,
    user: userPrompt,
    attemptId: args.attemptId,
    issueNumber: args.issue.number,
    dossierSnapshotId: args.snapshot.snapshotId,
  });

  return {
    notes: args.notes.latest(),
    terminated: result.terminated,
    reason: result.reason,
    toolCalls: result.toolCalls,
    transcriptSummary: result.transcriptSummary,
  };
}
