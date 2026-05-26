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
import { EvidenceInputSchema, PreconditionInputSchema, SuspectSymbolSchema } from '../analyst/dossier';
import { HypothesisSchema } from '../fix-loop/hypotheses';
import {
  InvestigationFindingInputSchema,
} from '../fix-loop/investigation-notes';

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
    summary: z.string().min(1),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .passthrough();
export const recordEvidence: ToolDef<z.infer<typeof RecordEvidence>, unknown> = {
  name: 'record_evidence',
  tier: 'note',
  description:
    'Analyst-only: append a new EvidenceDossier snapshot summarising everything you have read so far. Call this to terminate the Analyst loop.',
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
    // Stamp precondition ids when the LLM omits them. The id must be
    // stable within the snapshot (used by Planner's `preconditionsAddressed`
    // links and Critic's structural checks), so we derive it from the
    // input index.
    const preconditions = args.preconditions.map((p, idx) => ({
      ...p,
      id: p.id ?? `pc-${idx}`,
      evidenceRefs: p.evidenceRefs ?? [],
      satisfactionModes: p.satisfactionModes ?? [],
      threats: p.threats ?? [],
    }));
    const snap = dossier.append({
      issueNumber: ctx.issueNumber,
      attemptId: ctx.attemptId,
      evidence,
      suspectSymbols: args.suspectSymbols,
      preconditions,
      openQuestions: args.openQuestions,
      summary: args.summary,
      confidence: args.confidence,
    });
    return { snapshot_id: snap.snapshotId };
  },
};

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
