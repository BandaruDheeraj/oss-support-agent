/**
 * Fix Critic — independent verifier. Must call read_diff, read_file on every
 * changed file, run_repro, and run_tests (outside the repro file) before
 * its judgement can be 'approve'. Hard override matches structural checks.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '../../llm/v2/client';
import { withAgentSpan } from '../../observability/spans';
import { makeFixCriticRegistry } from '../tools';
import { runAgentLoop } from '../agent-loop';
import type { DossierStore, DossierSnapshot } from '../analyst/dossier';
import type { InvestigationNotesStore } from './investigation-notes';
import type { HypothesisTracker } from './hypotheses';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';

export const FixVerdictSchema = z.object({
  verdict: z.enum(['approve', 'reject', 'revise', 'abandon']),
  reason: z.string().min(5),
  approvedDiffSha: z.string().optional(),
  suggestedRevision: z.string().optional(),
});
export type FixVerdict = z.infer<typeof FixVerdictSchema>;

export interface RunFixCriticArgs {
  attemptId: string;
  changedFiles: string[];
  reproTestPath: string;
  dossier: DossierStore;
  snapshot: DossierSnapshot;
  notes: InvestigationNotesStore;
  hypotheses: HypothesisTracker;
  issue: IssueHandle;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
  currentHeadSha: string;
}

const INVESTIGATE_SYSTEM = `You are the Fix Critic. Independently verify the diff produced by the Executor. Required actions before any verdict can be 'approve':
- Call read_diff once.
- Call read_file on EVERY changed file (the orchestrator lists them).
- Call run_repro once (must be green after the patch).
- Call run_tests with a scopePath OUTSIDE the repro test (to check for regressions).
- Note() your observations.

You cannot call apply_patch/revert_file/write_test — only read + sandbox + note.`;

const JUDGE_SYSTEM = `You are the Fix Critic judge. Given the investigation transcript, return a FixVerdict JSON.

approve: only if (a) read_diff was called, (b) every changed file was read, (c) run_repro is green, (d) run_tests outside the repro is green, (e) the diff is minimal and addresses the root cause.
reject: the diff is wrong / unsafe / off-scope.
revise: the diff is mostly right but needs a small change (give a specific suggestion).
abandon: not fixable with current evidence; escalate to human.`;

export async function runFixCritic(args: RunFixCriticArgs): Promise<{ verdict: FixVerdict; transcriptSummary: string }> {
  const registry = makeFixCriticRegistry({
    ctx: {
      agentName: 'FIX_CRITIC',
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

  const userPrompt = `Changed files (you MUST read each one): ${args.changedFiles.join(', ') || '(none — that itself is a problem)'}\nRepro test path: ${args.reproTestPath}\nDossier summary: ${args.snapshot.body.summary}\n\nInvestigate independently. Call read_diff, read_file on each changed file, run_repro, run_tests (scopePath OUTSIDE the repro test).`;

  const investigation = await runAgentLoop({
    agent: 'FIX_CRITIC',
    registry,
    system: INVESTIGATE_SYSTEM,
    user: userPrompt,
    attemptId: args.attemptId,
    issueNumber: args.issue.number,
    dossierSnapshotId: args.snapshot.snapshotId,
  });

  // eslint-disable-next-line no-console
  console.log(
    `[v2-fix-critic] attempt=${args.attemptId} phase=investigate terminated=${investigation.terminated}` +
      ` turns=${investigation.turns} toolCalls=${investigation.toolCalls}` +
      (investigation.reason ? ` reason=${JSON.stringify(investigation.reason).slice(0, 240)}` : '') +
      ` tools=${investigation.transcriptSummary}`
  );

  // Structural pre-check
  const transcript = registry.getTranscript();
  const sawDiff = transcript.some((e) => e.tool === 'read_diff' && e.ok);
  const filesRead = new Set(
    transcript
      .filter((e) => e.tool === 'read_file' && e.ok)
      .map((e) => (e.args as any)?.path)
  );
  const allChangedRead = args.changedFiles.every((f) => filesRead.has(f));
  const reproRuns = transcript.filter((e) => e.tool === 'run_repro' && e.ok);
  const reproGreen = reproRuns.length >= 1 && (reproRuns[reproRuns.length - 1].result as any)?.exitCode === 0;
  const testRuns = transcript.filter(
    (e) =>
      e.tool === 'run_tests' &&
      e.ok &&
      typeof (e.args as any)?.scopePath === 'string' &&
      (e.args as any).scopePath !== args.reproTestPath
  );
  const testsGreenOutsideRepro = testRuns.length >= 1 && (testRuns[testRuns.length - 1].result as any)?.exitCode === 0;

  const verdict = await withAgentSpan(
    'FIX_CRITIC',
    {
      attempt_id: args.attemptId,
      issue_number: args.issue.number,
      dossier_snapshot_id: args.snapshot.snapshotId,
      'critic.phase': 'judge',
    },
    async () => {
      const judged = await generateObject({
        model: getModel('FIX_CRITIC'),
        schema: FixVerdictSchema,
        system: JUDGE_SYSTEM,
        prompt: `Investigation summary: ${investigation.transcriptSummary}\n\nStructural checks:\n- read_diff called: ${sawDiff}\n- all changed files read: ${allChangedRead} (read: ${Array.from(filesRead).join(', ')})\n- repro green: ${reproGreen}\n- tests green outside repro: ${testsGreenOutsideRepro}\n\nCurrent HEAD sha: ${args.currentHeadSha}\nDossier root cause hypothesis: ${args.notes.latest()?.body.rootCauseHypothesis ?? '(unset)'}\nChanged files: ${args.changedFiles.join(', ')}`,
        experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
      });
      return judged.object;
    }
  );

  // Hard override: structural failure → cannot approve
  if (verdict.verdict === 'approve' && !(sawDiff && allChangedRead && reproGreen && testsGreenOutsideRepro)) {
    return {
      verdict: {
        verdict: 'reject',
        reason: `Critic override: structural checks failed (read_diff=${sawDiff}, allChangedRead=${allChangedRead}, reproGreen=${reproGreen}, testsGreenOutsideRepro=${testsGreenOutsideRepro}).`,
      },
      transcriptSummary: investigation.transcriptSummary,
    };
  }

  // Bind approval to the diff sha if approving
  if (verdict.verdict === 'approve') {
    verdict.approvedDiffSha = args.currentHeadSha;
  }

  return { verdict, transcriptSummary: investigation.transcriptSummary };
}
