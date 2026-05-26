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
import type { DossierSnapshot, Precondition } from '../analyst/dossier';
import {
  renderEditableInstallsBlock,
  renderIssueSnippetsBlock,
  type IssueCodeSnippet,
} from './repro-hints';

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
        /**
         * Precondition ids this step is responsible for satisfying. The
         * orchestrator validates that every dossier precondition is named
         * by at least one step (or substring-matched in some step.intent)
         * post-generation; planner is retried once on miss.
         */
        preconditionsAddressed: z.array(z.string()).default([]),
      })
    )
    .min(1),
  requiredEnv: z.array(z.string()).default([]),
  expectedFailureSignature: z.string().min(5),
  /**
   * Set to true ONLY when the verbatim issue snippet cannot satisfy a
   * named precondition (e.g. snippet runs a live agent step requiring
   * unavailable credentials). When true, Executor may skip the
   * verbatim-first invariant from commit 1ae5948 and proceed directly
   * to a satisfactionMode path. When false (default), verbatim-first
   * stays in force.
   */
  verbatimSnippetIncompatible: z.boolean().default(false),
});
export type ReproPlan = z.infer<typeof ReproPlanSchema>;

const SYSTEM = `You are the Repro Planner. Produce a structured plan the Repro Executor will follow to construct a failing test reproducing the issue. You output JSON only. Do not write the test yourself.`;

export interface RunReproPlannerArgs {
  attemptId: string;
  dossier: DossierSnapshot;
  carryforwardSummary?: string;
  /** Repo-relative dirs the executor can `pip install -e` if needed. */
  editableInstallCandidates?: string[];
  /** Verbatim fenced code blocks lifted from the issue body. */
  issueSnippets?: IssueCodeSnippet[];
}

export async function runReproPlanner(args: RunReproPlannerArgs): Promise<ReproPlan> {
  return withAgentSpan(
    'REPRO_PLANNER',
    { attempt_id: args.attemptId, issue_number: args.dossier.body.issueNumber, dossier_snapshot_id: args.dossier.snapshotId },
    async () => {
      const basePrompt = buildPrompt(
        args.dossier,
        args.carryforwardSummary,
        args.editableInstallCandidates,
        args.issueSnippets
      );
      const first = await generateObject({
        model: getModel('REPRO_PLANNER'),
        schema: ReproPlanSchema,
        system: SYSTEM,
        prompt: basePrompt,
        experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
      });

      const preconditions = args.dossier.body.preconditions ?? [];

      // Deterministic override: if the issue's verbatim snippet imports a
      // heavy third-party framework AND the dossier already has a precondition
      // with a non-empty satisfactionMode, the verbatim path is essentially
      // guaranteed to fail in the sandbox (install-fatigue or env-mismatch).
      // Force verbatimSnippetIncompatible=true regardless of what the model
      // emitted. This rescues runs where the model defends the verbatim-first
      // invariant past its useful range.
      const forcedIncompatible = shouldForceVerbatimIncompatible(
        args.issueSnippets ?? [],
        preconditions
      );
      const applyForce = (plan: ReproPlan): ReproPlan =>
        forcedIncompatible && !plan.verbatimSnippetIncompatible
          ? { ...plan, verbatimSnippetIncompatible: true }
          : plan;

      const missed = findUnaddressedPreconditions(first.object, preconditions);
      if (missed.length === 0) return applyForce(first.object);

      // Forced retry: every precondition.id must appear in either
      // step.preconditionsAddressed or be substring-matched in step.intent.
      // This is the structural gate from the design — if the LLM ignored
      // preconditions, give it one explicit corrective turn before failing.
      const correctivePrompt = `${basePrompt}\n\n[PLANNER RETRY] Your previous plan did not address the following dossier preconditions: ${missed
        .map((p) => `${p.id} (${p.condition})`)
        .join('; ')}. Every precondition listed in the "Preconditions" block above MUST be named in at least one step's preconditionsAddressed array. If a precondition cannot be satisfied by the verbatim issue snippet (e.g. it needs credentials the sandbox lacks, OR the snippet imports a heavy third-party framework like smolagents/langchain/llama-index/autogen/crewai that requires network access or unsharded dependencies), set verbatimSnippetIncompatible:true AND name a satisfactionMode in a step intent.`;
      const retry = await generateObject({
        model: getModel('REPRO_PLANNER'),
        schema: ReproPlanSchema,
        system: SYSTEM,
        prompt: correctivePrompt,
        experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
      });
      const stillMissed = findUnaddressedPreconditions(retry.object, preconditions);
      if (stillMissed.length > 0) {
        throw new Error(
          `Repro Planner failed to address dossier preconditions after one retry: ${stillMissed
            .map((p) => p.id)
            .join(', ')}`
        );
      }
      return applyForce(retry.object);
    }
  );
}

const HEAVY_FRAMEWORK_IMPORTS = [
  'smolagents',
  'langchain',
  'llama_index',
  'llamaindex',
  'llama-index',
  'autogen',
  'crewai',
  'haystack',
  'guidance',
  'dspy',
];

/**
 * Decide whether to FORCE verbatimSnippetIncompatible=true regardless of
 * what the Planner LLM emitted. True when:
 *   1. There is at least one verbatim snippet, AND
 *   2. Some snippet imports a known heavy 3rd-party agent framework, AND
 *   3. The dossier has at least one precondition with a non-empty
 *      satisfactionMode (i.e. a direct-call fallback path exists).
 * Falling back is safe in this case because the verbatim path is
 * essentially guaranteed to fail in the sandbox.
 */
export function shouldForceVerbatimIncompatible(
  snippets: IssueCodeSnippet[],
  preconditions: Precondition[]
): boolean {
  if (snippets.length === 0) return false;
  if (preconditions.length === 0) return false;
  const hasFallback = preconditions.some(
    (pc) => Array.isArray(pc.satisfactionModes) && pc.satisfactionModes.length > 0
  );
  if (!hasFallback) return false;
  return snippets.some((s) => {
    const body = (s.code ?? '').toLowerCase();
    return HEAVY_FRAMEWORK_IMPORTS.some((fw) => {
      const tokens = [`import ${fw}`, `from ${fw}`];
      return tokens.some((t) => body.includes(t));
    });
  });
}

/**
 * Returns the subset of dossier preconditions that the plan does NOT
 * address. A precondition is considered addressed when its id appears
 * in some step's preconditionsAddressed array OR its id is
 * substring-matched in some step's intent (a graceful fallback for
 * models that put the link in prose instead of the structured field).
 */
export function findUnaddressedPreconditions(
  plan: ReproPlan,
  preconditions: Precondition[]
): Precondition[] {
  if (preconditions.length === 0) return [];
  const addressedIds = new Set<string>();
  for (const step of plan.steps) {
    for (const id of step.preconditionsAddressed ?? []) addressedIds.add(id);
  }
  const intents = plan.steps.map((s) => s.intent).join('\n');
  return preconditions.filter((pc) => !addressedIds.has(pc.id) && !intents.includes(pc.id));
}

function buildPrompt(
  d: DossierSnapshot,
  carry?: string,
  editableInstallCandidates?: string[],
  issueSnippets?: IssueCodeSnippet[]
): string {
  const evidence = d.body.evidence
    .slice(0, 12)
    .map((e) => `- [${e.kind}] ${e.source}: ${e.summary}`)
    .join('\n');
  const suspects = d.body.suspectSymbols.map((s) => `- ${s.file} :: ${s.symbol} (${s.reasoning})`).join('\n');
  const carryBlock = carry ? `\n\nCarry-forward from prior attempt:\n${carry}` : '';

  const snippetBlock = renderIssueSnippetsBlock(issueSnippets ?? []);
  const editableBlock = renderEditableInstallsBlock(editableInstallCandidates ?? []);
  const preconditionsBlock = renderPreconditionsBlock(d.body.preconditions ?? []);
  const hintsParts = [snippetBlock, editableBlock, preconditionsBlock].filter((s): s is string => Boolean(s));
  const hintsBlock = hintsParts.length > 0 ? `\n\n${hintsParts.join('\n\n')}` : '';

  const preconditionsDirective =
    (d.body.preconditions ?? []).length > 0
      ? `\n\nEvery precondition listed in the "Preconditions" block above MUST be addressed by at least one of your plan's steps. Link each precondition by its id via the step's "preconditionsAddressed" array. If a precondition's threats are non-empty, the step's intent must NAME the threat and describe how it will be neutralized (fixture reset, monkeypatch isolation, direct-call bypass, etc.). If the verbatim issue snippet (if any) cannot satisfy a precondition because it requires credentials/live services the sandbox lacks, set verbatimSnippetIncompatible:true AND choose a satisfactionMode from the precondition that the Executor can implement.`
      : '';

  return `Issue: #${d.body.issueNumber}\nDossier summary: ${d.body.summary}\nConfidence: ${d.body.confidence}\n\nEvidence (top 12):\n${evidence}\n\nSuspect symbols:\n${suspects}\n\nOpen questions:\n${d.body.openQuestions.map((q) => `- ${q}`).join('\n')}${carryBlock}${hintsBlock}\n\nProduce a ReproPlan. candidateTestPath should be under tests/ or __tests__ or similar. sentinelString is a unique substring the failing test should print/raise so we can verify it later. expectedFailureSignature is a short string the test runner output will contain when the bug is reproduced. If verbatim issue snippets are provided above, your plan's first step should be to translate that snippet into the test almost as-is, only adding the assertion / sentinel scaffolding around it.${preconditionsDirective}`;
}

/**
 * Render dossier preconditions for the Planner prompt. Kept terse — one
 * block per precondition, with satisfactionModes flattened to a single
 * line each.
 */
function renderPreconditionsBlock(preconditions: Precondition[]): string | null {
  if (preconditions.length === 0) return null;
  const lines: string[] = [`Preconditions (every one MUST be addressed by your plan):`];
  for (const pc of preconditions) {
    lines.push(`- [${pc.id}] ${pc.condition} (kind: ${pc.kind})`);
    if (pc.appliesTo) {
      lines.push(`    applies to: ${pc.appliesTo.file}${pc.appliesTo.symbol ? ` :: ${pc.appliesTo.symbol}` : ''}`);
    }
    if (pc.satisfactionModes && pc.satisfactionModes.length > 0) {
      lines.push(`    satisfaction modes:`);
      for (const mode of pc.satisfactionModes) {
        lines.push(`      • ${mode.description}${mode.markers.length > 0 ? ` [markers: ${mode.markers.join(', ')}]` : ''}`);
      }
    }
    if (pc.threats && pc.threats.length > 0) {
      lines.push(`    threats: ${pc.threats.join('; ')}`);
    }
  }
  return lines.join('\n');
}
