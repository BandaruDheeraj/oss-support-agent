/**
 * Repro Planner — one-shot generateObject producing a ReproPlan.
 *
 * The plan is a list of steps for the Repro Executor. It is NOT a final
 * test; it is the agent's outline of how to construct one.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '../../llm/v2/client';
import { withAgentSpan } from '../../observability/spans';
import type { DossierSnapshot } from '../analyst/dossier';

export const ReproPlanSchema = z.object({
  approach: z.string().min(20),
  candidateTestPath: z.string().min(1),
  sentinelString: z.string().min(4),
  steps: z
    .array(
      z.object({
        stepId: z.string().min(1),
        intent: z.string().min(5),
        toolHint: z.string().min(2),
      })
    )
    .min(1),
  requiredEnv: z.array(z.string()).default([]),
  expectedFailureSignature: z.string().min(5),
});
export type ReproPlan = z.infer<typeof ReproPlanSchema>;

const SYSTEM = `You are the Repro Planner. Produce a structured plan the Repro Executor will follow to construct a failing test reproducing the issue. You output JSON only. Do not write the test yourself.`;

export interface RunReproPlannerArgs {
  attemptId: string;
  dossier: DossierSnapshot;
  carryforwardSummary?: string;
}

export async function runReproPlanner(args: RunReproPlannerArgs): Promise<ReproPlan> {
  return withAgentSpan(
    'REPRO_PLANNER',
    { attempt_id: args.attemptId, issue_number: args.dossier.body.issueNumber, dossier_snapshot_id: args.dossier.snapshotId },
    async () => {
      const result = await generateObject({
        model: getModel('REPRO_PLANNER'),
        schema: ReproPlanSchema,
        system: SYSTEM,
        prompt: buildPrompt(args.dossier, args.carryforwardSummary),
        experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
      });
      return result.object;
    }
  );
}

function buildPrompt(d: DossierSnapshot, carry?: string): string {
  const evidence = d.body.evidence
    .slice(0, 12)
    .map((e) => `- [${e.kind}] ${e.source}: ${e.summary}`)
    .join('\n');
  const suspects = d.body.suspectSymbols.map((s) => `- ${s.file} :: ${s.symbol} (${s.reasoning})`).join('\n');
  const carryBlock = carry ? `\n\nCarry-forward from prior attempt:\n${carry}` : '';
  return `Issue: #${d.body.issueNumber}\nDossier summary: ${d.body.summary}\nConfidence: ${d.body.confidence}\n\nEvidence (top 12):\n${evidence}\n\nSuspect symbols:\n${suspects}\n\nOpen questions:\n${d.body.openQuestions.map((q) => `- ${q}`).join('\n')}${carryBlock}\n\nProduce a ReproPlan. candidateTestPath should be under tests/ or __tests__ or similar. sentinelString is a unique substring the failing test should print/raise so we can verify it later. expectedFailureSignature is a short string the test runner output will contain when the bug is reproduced.`;
}
