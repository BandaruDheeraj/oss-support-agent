/**
 * LLM-based fix repair agent.
 *
 * Called by the fix orchestrator when the executor's patch fails the repro test.
 * Given the current changed file contents and the repro failure output, it
 * generates revised file contents to apply. Mirrors repro-loop-v2/repair-agent.ts.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel, MissingLlmApiKeyError } from '../../llm/v2/client';
import { withAgentSpan } from '../../observability/spans';
import type { DossierSnapshot } from '../analyst/dossier';

const FixRepairOutputSchema = z.object({
  explanation: z.string().describe('What you changed and why, in 1-3 sentences'),
  fileUpdates: z
    .array(
      z.object({
        path: z.string().describe('File path relative to repo root'),
        content: z.string().describe('Full new content for this file'),
      })
    )
    .describe('Source files to rewrite. Omit files that do not need to change.'),
  abandon: z
    .boolean()
    .describe(
      'Set true if the root cause cannot be fixed with a targeted patch (e.g. requires architectural changes beyond scope, or the failure is unrelated to the executor\'s patch)'
    ),
  abandonReason: z.string().optional(),
});

export type FixRepairOutput = z.infer<typeof FixRepairOutputSchema>;

export interface FixRepairContext {
  attemptId: string;
  snapshot: DossierSnapshot;
  changedFiles: ReadonlyArray<{ path: string; content: string }>;
  reproFailureOutput: string;
  issueTitle?: string;
  issueBody?: string;
  roundNumber: number;
  maxRounds: number;
  repairHistory: string[];
}

export async function repairFix(ctx: FixRepairContext): Promise<FixRepairOutput | null> {
  let model;
  try {
    const modelOverride = process.env.FIX_REPAIR_MODEL;
    model = getModel('FIX_REPAIR', modelOverride);
  } catch (err) {
    if (err instanceof MissingLlmApiKeyError) return null;
    throw err;
  }

  const filesSummary = ctx.changedFiles
    .map((f) => `=== ${f.path} ===\n${f.content}`)
    .join('\n\n');

  const historySection =
    ctx.repairHistory.length > 0
      ? `\nPrevious repair rounds (${ctx.repairHistory.length}):\n${ctx.repairHistory.map((h, i) => `  Round ${i + 1}: ${h}`).join('\n')}`
      : '';

  const issueSection = ctx.issueTitle
    ? `\nIssue: ${ctx.issueTitle}\n${ctx.issueBody ? `Body (truncated):\n${ctx.issueBody.slice(0, 600)}` : ''}`
    : '';

  const suspectSummary = ctx.snapshot.body.suspectSymbols
    .map((s) => `- ${s.file} :: ${s.symbol}`)
    .join('\n');

  const prompt = `You are a fix repair agent. A previous executor attempted to fix a bug but the repro test still fails.
Your job: revise the changed source files so the repro test passes.${issueSection}

━━━ SUSPECT SYMBOLS ━━━
${suspectSummary}

━━━ ROOT CAUSE HYPOTHESIS ━━━
${ctx.snapshot.body.summary}

━━━ REPRO FAILURE (round ${ctx.roundNumber + 1} of ${ctx.maxRounds}) ━━━
\`\`\`
${ctx.reproFailureOutput.slice(0, 3000)}
\`\`\`

━━━ CURRENT CHANGED FILES ━━━
${filesSummary}${historySection}

━━━ REPAIR RULES ━━━
1. Read the failure output carefully — is the test reaching the buggy code path?
2. If the fix logic is wrong, revise it. If the fix is partially right, extend it.
3. Only return files you actually change. Return complete file contents.
4. Do not change the repro test itself — fix the source code under test.
5. Keep changes minimal and targeted. Prefer fixing one thing at a time.
6. Set abandon=true only if the failure is caused by something outside the scope of these files.`;

  let result;
  try {
    result = await withAgentSpan(
      'FIX_REPAIR',
      {
        attempt_id: ctx.attemptId,
        'fix.repair.round': ctx.roundNumber,
      },
      async () =>
        generateObject({
          model,
          schema: FixRepairOutputSchema,
          prompt,
          abortSignal: AbortSignal.timeout(5 * 60 * 1000),
          experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
        })
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[v2-fix-repair] attempt=${ctx.attemptId} round=${ctx.roundNumber} LLM_ERROR=${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[v2-fix-repair] attempt=${ctx.attemptId} round=${ctx.roundNumber} abandon=${result.object.abandon} files=${result.object.fileUpdates.length} explanation=${JSON.stringify(result.object.explanation).slice(0, 200)}`
  );

  return result.object;
}
