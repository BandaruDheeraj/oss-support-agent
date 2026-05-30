/**
 * Note + Meta tier tools.
 *
 * - note                       : free-form note (no dossier write)
 * - state_hypothesis           : structured hypothesis (hypothesis tracker)
 * - record_evidence            : Analyst-only dossier append
 * - write_investigation_notes  : Fix Investigator-only notes append
 * - commit_plan / revise_plan  : Planner state
 * - deepen_investigation       : signals orchestrator to re-enter Investigator
 * - done / abandon             : terminal markers (registry handles guard)
 */

import { z } from 'zod';
import type { ToolDef } from './types';
import { asHandles } from './handles';
import { EvidenceInputSchema, PreconditionInputSchema, ReproRecipeInputSchema, ReproTargetsInputSchema, SuspectSymbolSchema, normalizePreconditionInput, normalizeReproRecipeInput, normalizeReproTargetsInput, CandidateReproInputSchema, normalizeCandidateReproInput } from '../analyst/dossier';
import { HypothesisSchema } from '../fix-loop/hypotheses';
import {
  InvestigationFindingInputSchema,
} from '../fix-loop/investigation-notes';
import { ensureTestRootScoped } from './write-test';

const Note = z.object({ note: z.string().min(1) }).passthrough();
export const note: ToolDef<z.infer<typeof Note>, unknown> = {
  name: 'note',
  tier: 'note',
  description: 'Record a free-form note in the transcript. Use sparingly.',
  parameters: Note,
  async execute({ note }) {
    return { recorded: note };
  },
};

const StateHypothesisArgs = HypothesisSchema;
export const stateHypothesis: ToolDef<z.infer<typeof StateHypothesisArgs>, unknown> = {
  name: 'state_hypothesis',
  tier: 'note',
  description:
    'Record a structured hypothesis bound to a file. REQUIRED before apply_patch on that file. Must reference at least one observed evidence id from the dossier.',
  parameters: StateHypothesisArgs,
  async execute(input, ctx) {
    const tracker = asHandles(ctx.handles).hypotheses;
    if (!tracker) return { error: 'hypothesis tracker not available for this agent' };
    const turn = ctx.getTranscript().length > 0 ? ctx.getTranscript()[ctx.getTranscript().length - 1].turn : 1;
    const h = tracker.add(input, turn);
    return { hypothesis_id: h.id, created_at_turn: h.createdAtTurn };
  },
};

const RecordEvidence = z
  .object({
    evidence: z.array(EvidenceInputSchema).default([]),
    suspectSymbols: z.array(SuspectSymbolSchema).default([]),
    preconditions: z.array(PreconditionInputSchema).default([]),
    openQuestions: z.array(z.string()).default([]),
    summary: z.string().min(1).optional(),
    confidence: z.enum(['low', 'medium', 'high']).optional(),
    /**
     * Repro recipe — written by the Prober stage. Optional so the Analyst
     * (read-only) can keep calling record_evidence without supplying one;
     * the orchestrator enforces the execution-time invariant that a recipe
     * must exist before the deterministic Executor runs.
     */
    reproRecipe: ReproRecipeInputSchema.optional(),
    /**
     * Candidate repro — written by the Analyst when confident enough that
     * the deterministic Builder can author the test without an LLM tool
     * loop. The Builder validates this against the dossier (preconditions
     * exist, suspect symbols referenced) and renders test source from a
     * template. When absent or rejected, the orchestrator falls through
     * to the LLM Prober.
     */
    candidateRepro: CandidateReproInputSchema.optional(),
    /**
     * Repro targets — Analyst-only structured hints for downstream Repro
     * stages. Optional; absent on Prober/Investigator dossier writes.
     */
    reproTargets: ReproTargetsInputSchema.optional(),
  })
  .passthrough();
export const recordEvidence: ToolDef<z.infer<typeof RecordEvidence>, unknown> = {
  name: 'record_evidence',
  tier: 'note',
  description:
    'Analyst- and Prober-only: append a new EvidenceDossier snapshot summarising everything you have read so far. Call this to terminate the loop. Prober additionally supplies `reproRecipe` carrying the executable test + observed probe results.',
  parameters: RecordEvidence,
  async execute(args, ctx) {
    const dossier = asHandles(ctx.handles).dossier;
    if (!dossier) return { error: 'dossier writer not available — caller is not the Analyst' };
    const now = new Date().toISOString();
    const evidence = args.evidence.map((e) => ({
      ...e,
      source: e.source ?? defaultEvidenceSource(e, ctx.issueNumber),
      recordedAt: e.recordedAt ?? now,
    }));
    const summary = normalizeEvidenceSummary(args.summary, evidence, args.suspectSymbols);
    const confidence = normalizeEvidenceConfidence(args.confidence, evidence, args.suspectSymbols);
    // Stamp precondition ids when the LLM omits them, drop entries that
    // even the loose normalizer can't make sense of. Preconditions are
    // best-effort metadata; we MUST NOT fail the entire record_evidence
    // call (and discard the dossier) just because the LLM mis-emitted a
    // precondition field.
    const preconditions = (args.preconditions ?? [])
      .map((p, idx) => normalizePreconditionInput(p, idx))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const reproRecipe = args.reproRecipe ? normalizeReproRecipeInput(args.reproRecipe) ?? undefined : undefined;
    if (reproRecipe) {
      // Scope candidateTestPath against the same test roots write_test uses,
      // so a recipe cannot trick the deterministic Executor into writing the
      // recipe.testSource outside the configured test directories.
      const workspace = asHandles(ctx.handles).workspace;
      if (workspace && typeof workspace.testRoots === 'function') {
        ensureTestRootScoped(reproRecipe.candidateTestPath, workspace.testRoots(), 'reproRecipe.candidateTestPath');
      }
    }
    // Same path-scope guard for the Analyst-emitted candidateRepro. Bad
    // candidates (unparseable, missing fields) are silently dropped — the
    // Builder fallback path handles "no candidate" gracefully, but a
    // record_evidence call should never be rejected just because the LLM
    // garbled the optional field.
    let candidateRepro = args.candidateRepro
      ? normalizeCandidateReproInput(args.candidateRepro) ?? undefined
      : undefined;
    if (candidateRepro) {
      try {
        const workspace = asHandles(ctx.handles).workspace;
        if (workspace && typeof workspace.testRoots === 'function') {
          ensureTestRootScoped(
            candidateRepro.candidateTestPath,
            workspace.testRoots(),
            'candidateRepro.candidateTestPath'
          );
        }
      } catch {
        // Drop the candidate but keep the rest of the dossier — Builder
        // will skip and Prober fallback will take over.
        candidateRepro = undefined;
      }
    }
    // Normalize reproTargets via the loose-input coercer. Returns null when
    // both arrays are empty after cleaning — in that case omit the field so
    // the snapshot hash matches a legacy body literally lacking it.
    const reproTargets = args.reproTargets
      ? normalizeReproTargetsInput(args.reproTargets) ?? undefined
      : undefined;
    const snap = dossier.append({
      issueNumber: ctx.issueNumber,
      attemptId: ctx.attemptId,
      evidence,
      suspectSymbols: args.suspectSymbols,
      preconditions,
      openQuestions: args.openQuestions,
      summary,
      confidence,
      ...(reproRecipe ? { reproRecipe } : {}),
      ...(candidateRepro ? { candidateRepro } : {}),
      ...(reproTargets ? { reproTargets } : {}),
    });
    return {
      snapshot_id: snap.snapshotId,
      recipe_recorded: reproRecipe ? true : false,
      candidate_recorded: candidateRepro ? true : false,
      repro_targets_recorded: reproTargets ? true : false,
    };
  },
};

function normalizeEvidenceSummary(
  summary: string | undefined,
  evidence: Array<{ kind: string; summary: string }>,
  suspectSymbols: Array<{ symbol: string }>,
): string {
  const trimmed = summary?.trim();
  if (trimmed && trimmed.length > 0) return trimmed;
  if (evidence.length > 0) {
    const first = evidence[0];
    return `Recorded ${evidence.length} evidence item(s); first signal (${first.kind}): ${first.summary}`;
  }
  if (suspectSymbols.length > 0) {
    const names = suspectSymbols
      .slice(0, 3)
      .map((s) => s.symbol)
      .join(', ');
    const suffix = suspectSymbols.length > 3 ? ', ...' : '';
    return `Suspect symbols identified: ${names}${suffix}`;
  }
  return 'Investigation snapshot recorded without concrete evidence yet.';
}

function normalizeEvidenceConfidence(
  confidence: 'low' | 'medium' | 'high' | undefined,
  evidence: unknown[],
  suspectSymbols: unknown[],
): 'low' | 'medium' | 'high' {
  if (confidence) return confidence;
  if (evidence.length >= 3 && suspectSymbols.length >= 1) return 'medium';
  return 'low';
}

/**
 * Stamp a meaningful `source` when the LLM omits it. We avoid a bare
 * "unknown" string because consumers (e.g. planner.ts) render `source` in
 * the evidence list — a generic value degrades planner context. Prefer
 * structured fallbacks derived from `kind` + `attrs`.
 */
function defaultEvidenceSource(
  e: { kind: string; source?: string; attrs?: Record<string, unknown> | undefined },
  issueNumber: number
): string {
  if (e.source && e.source.trim().length > 0) return e.source;
  const attr = (k: string): string | undefined => {
    const v = e.attrs?.[k];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };
  switch (e.kind) {
    case 'issue_excerpt':
      return `issue#${issueNumber}`;
    case 'file_excerpt':
    case 'symbol_definition':
    case 'symbol_caller':
      return attr('file') ?? attr('path') ?? `unknown:${e.kind}`;
    case 'recent_commit':
      return attr('sha') ?? attr('commit') ?? `unknown:commit`;
    case 'web_reference':
      return attr('url') ?? `unknown:web`;
    case 'human_input':
      return attr('source') ?? 'human';
    case 'critic_finding':
      return attr('agent') ?? 'critic';
    case 'tool_observation':
      return attr('tool') ?? 'tool';
    case 'note':
      return 'analyst-note';
    default:
      return `unknown:${e.kind}`;
  }
}

const WriteInvestigationNotes = z
  .object({
    findings: z.array(InvestigationFindingInputSchema).default([]),
    rootCauseHypothesis: z.string().min(1),
    suggestedApproach: z.string().min(1),
    risks: z.array(z.string()).default([]),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .passthrough();
export const writeInvestigationNotes: ToolDef<z.infer<typeof WriteInvestigationNotes>, unknown> = {
  name: 'write_investigation_notes',
  tier: 'note',
  description:
    'Fix Investigator-only: append a FixInvestigationNotes record linked to the current dossier snapshot.',
  parameters: WriteInvestigationNotes,
  async execute(args, ctx) {
    const notes = asHandles(ctx.handles).notes;
    if (!notes) return { error: 'investigation notes writer not available — caller is not the Fix Investigator' };
    if (!ctx.dossierSnapshotId) return { error: 'no dossier_snapshot_id set on context' };
    const now = new Date().toISOString();
    const findings = args.findings.map((f) => ({ ...f, recordedAt: f.recordedAt ?? now }));
    const n = notes.append({
      issueNumber: ctx.issueNumber,
      attemptId: ctx.attemptId,
      dossierSnapshotId: ctx.dossierSnapshotId,
      findings,
      rootCauseHypothesis: args.rootCauseHypothesis,
      suggestedApproach: args.suggestedApproach,
      risks: args.risks,
      confidence: args.confidence,
    });
    return { notes_id: n.notesId };
  },
};

const PlanStepSchema = z.object({
  stepId: z.string().min(1),
  goal: z.string().min(1),
  hypothesisSummary: z.string().min(1),
  successCheck: z.string().min(1),
  files: z.array(z.string()).min(1),
  risk: z.enum(['low', 'medium', 'high']),
});
const CommitPlan = z.object({ summary: z.string().min(1), steps: z.array(PlanStepSchema).min(1) }).passthrough();
export const commitPlan: ToolDef<z.infer<typeof CommitPlan>, unknown> = {
  name: 'commit_plan',
  tier: 'meta',
  description: 'Planner-only: commit a structured plan. Once committed, the Executor takes over.',
  parameters: CommitPlan,
  async execute(plan, ctx) {
    const ps = asHandles(ctx.handles).plan;
    if (!ps) return { error: 'plan state not available for this agent' };
    ps.commitPlan(plan);
    return { committed: true, step_count: plan.steps.length };
  },
};

const RevisePlan = CommitPlan;
export const revisePlan: ToolDef<z.infer<typeof RevisePlan>, unknown> = {
  name: 'revise_plan',
  tier: 'meta',
  description: 'Replace the current plan after Critic feedback or budget changes.',
  parameters: RevisePlan,
  async execute(plan, ctx) {
    const ps = asHandles(ctx.handles).plan;
    if (!ps) return { error: 'plan state not available for this agent' };
    ps.commitPlan(plan);
    return { revised: true, step_count: plan.steps.length };
  },
};

const Deepen = z.object({ reason: z.string().min(1) }).passthrough();
export const deepenInvestigation: ToolDef<z.infer<typeof Deepen>, unknown> = {
  name: 'deepen_investigation',
  tier: 'meta',
  description:
    'Signal the orchestrator that more dossier evidence is needed. The pipeline re-enters Analyst (or Fix Investigator) before continuing.',
  parameters: Deepen,
  async execute({ reason }) {
    return { signal: 'deepen_investigation', reason };
  },
};

const Done = z
  .object({
    summary: z.string().min(1),
    changedFiles: z.array(z.string()).default([]),
    successCheckHits: z.array(z.string()).default([]),
  })
  .passthrough();
export const done: ToolDef<z.infer<typeof Done>, unknown> = {
  name: 'done',
  tier: 'meta',
  description:
    'Terminal: claim the work is complete. Only valid AFTER you have observed a green run_repro + run_tests (since the last mutation) in the prior turn. Registry rejects misplaced done calls.',
  parameters: Done,
  async execute(args) {
    return { terminated: 'done', summary: args.summary, changed_files: args.changedFiles };
  },
};

const Abandon = z.object({ reason: z.string().min(1) }).passthrough();
export const abandon: ToolDef<z.infer<typeof Abandon>, unknown> = {
  name: 'abandon',
  tier: 'meta',
  description: 'Terminal: give up on this attempt. Use when budgets are exhausted or evidence is contradictory.',
  parameters: Abandon,
  async execute({ reason }) {
    return { terminated: 'abandon', reason };
  },
};

export const NOTE_META_TOOLS = [
  note,
  stateHypothesis,
  recordEvidence,
  writeInvestigationNotes,
  commitPlan,
  revisePlan,
  deepenInvestigation,
  done,
  abandon,
] as const;
