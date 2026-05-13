/**
 * Repro Critic — mandatory second-opinion loop. Re-runs the candidate test
 * independently and checks structural guards before emitting a verdict.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '../../llm/v2/client';
import { withAgentSpan } from '../../observability/spans';
import { makeReproCriticRegistry } from '../tools';
import { runAgentLoop } from '../agent-loop';
import type { ReproPlan } from './planner';
import type { DossierStore, DossierSnapshot } from '../analyst/dossier';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';

export const ReproVerdictSchema = z.object({
  verdict: z.enum(['approve', 'reject', 'revise']),
  reason: z.string().min(5),
  reproducedReliably: z.boolean(),
  sentinelMatched: z.boolean(),
  suggestedRevision: z.string().optional(),
});
export type ReproVerdict = z.infer<typeof ReproVerdictSchema>;

const INVESTIGATE_SYSTEM = `You are the Repro Critic. Verify that the candidate test reliably reproduces the upstream issue. Re-run it twice independently via run_repro, read its source via read_file, and check the dossier. Use only read + sandbox + note tools.`;

const JUDGE_SYSTEM = `You are the Repro Critic judge. Given the investigation transcript, decide whether to approve, reject, or revise the repro test. Return JSON matching the schema.

approve: only if (a) you ran run_repro at least twice yourself, (b) both runs exited non-zero, (c) stderr contained the sentinel both times.
reject: the test does not reproduce, or it always passes, or it errors before exercising suspect code.
revise: the test almost reproduces but needs a small change (suggest one).`;

export interface RunReproCriticArgs {
  attemptId: string;
  plan: ReproPlan;
  dossier: DossierStore;
  dossierSnapshot: DossierSnapshot;
  issue: IssueHandle;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
}

export async function runReproCritic(args: RunReproCriticArgs): Promise<{ verdict: ReproVerdict; transcriptSummary: string }> {
  const registry = makeReproCriticRegistry({
    ctx: {
      agentName: 'REPRO_CRITIC',
      attemptId: args.attemptId,
      issueNumber: args.issue.number,
      dossierSnapshotId: args.dossierSnapshot.snapshotId,
      handles: {
        workspace: args.workspace,
        sandbox: args.sandbox,
        issue: args.issue,
        repo: args.repo,
        dossier: args.dossier,
      },
    },
  });

  const userPrompt = `Repro candidate at: ${args.plan.candidateTestPath}\nSentinel: "${args.plan.sentinelString}"\nExpected failure signature: ${args.plan.expectedFailureSignature}\n\nInvestigate: read the candidate test, run run_repro twice, then summarise your findings with note() calls. After that I will ask you for a verdict.`;

  const investigation = await runAgentLoop({
    agent: 'REPRO_CRITIC',
    registry,
    system: INVESTIGATE_SYSTEM,
    user: userPrompt,
    attemptId: args.attemptId,
    issueNumber: args.issue.number,
    dossierSnapshotId: args.dossierSnapshot.snapshotId,
  });

  // Structural pre-check: we need >=2 run_repro calls with exit != 0
  const transcript = registry.getTranscript();
  const reproRuns = transcript.filter((e) => e.tool === 'run_repro' && e.ok);
  const reliable = reproRuns.length >= 2 && reproRuns.every((r) => (r.result as any)?.exitCode !== 0);
  const sentinelHits = reproRuns.filter((r) => {
    const out = `${(r.result as any)?.stderr ?? ''}\n${(r.result as any)?.stdout ?? ''}`;
    return out.includes(args.plan.sentinelString);
  });
  const sentinelOk = sentinelHits.length >= 2;

  const verdict = await withAgentSpan(
    'REPRO_CRITIC',
    { attempt_id: args.attemptId, issue_number: args.issue.number, dossier_snapshot_id: args.dossierSnapshot.snapshotId, 'critic.phase': 'judge' },
    async () => {
      const judged = await generateObject({
        model: getModel('REPRO_CRITIC'),
        schema: ReproVerdictSchema,
        system: JUDGE_SYSTEM,
        prompt: `Repro run summaries:\n${reproRuns
          .map(
            (r) =>
              `- exit=${(r.result as any)?.exitCode}, stderr_head="${String((r.result as any)?.stderr ?? '').slice(0, 200)}"`
          )
          .join('\n')}\n\nInvestigation tool summary: ${investigation.transcriptSummary}\n\nPlan expected signature: ${args.plan.expectedFailureSignature}\nSentinel: ${args.plan.sentinelString}\n\nStructural pre-check: reliable=${reliable}, sentinelMatchedTwice=${sentinelOk}.`,
        experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
      });
      return judged.object;
    }
  );

  // Hard override: judge cannot approve if structural checks fail.
  if (verdict.verdict === 'approve' && !(reliable && sentinelOk)) {
    return {
      verdict: {
        verdict: 'reject',
        reason: 'Critic override: structural checks failed (need 2x non-zero run_repro with sentinel in stderr).',
        reproducedReliably: reliable,
        sentinelMatched: sentinelOk,
      },
      transcriptSummary: investigation.transcriptSummary,
    };
  }

  return {
    verdict: { ...verdict, reproducedReliably: reliable, sentinelMatched: sentinelOk },
    transcriptSummary: investigation.transcriptSummary,
  };
}
