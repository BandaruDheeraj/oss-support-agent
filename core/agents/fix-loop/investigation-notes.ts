/**
 * FixInvestigationNotes — separate append-only store written ONLY by the
 * Fix Investigator agent. Each notes-set is bound to a specific dossier
 * snapshot id (the snapshot the Investigator read), so downstream agents
 * can audit which evidence the investigation built on.
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import { canonicalize } from '../analyst/dossier';

export const InvestigationFindingSchema = z.object({
  id: z.string(),
  file: z.string().optional(),
  symbol: z.string().optional(),
  observation: z.string(),
  references: z.array(z.string()).default([]), // evidence ids from the dossier
  recordedAt: z.string(),
});
export type InvestigationFinding = z.infer<typeof InvestigationFindingSchema>;

/**
 * Input variant accepted from LLM tool calls. `recordedAt` is stamped
 * server-side because LLMs reliably forget to populate it. Matches the
 * `EvidenceInputSchema` pattern.
 */
export const InvestigationFindingInputSchema = InvestigationFindingSchema.extend({
  recordedAt: z.string().optional(),
});
export type InvestigationFindingInput = z.infer<typeof InvestigationFindingInputSchema>;

export const InvestigationNotesBodySchema = z.object({
  issueNumber: z.number(),
  attemptId: z.string(),
  dossierSnapshotId: z.string(),
  findings: z.array(InvestigationFindingSchema),
  rootCauseHypothesis: z.string(),
  suggestedApproach: z.string(),
  risks: z.array(z.string()).default([]),
  confidence: z.enum(['low', 'medium', 'high']),
});
export type InvestigationNotesBody = z.infer<typeof InvestigationNotesBodySchema>;

export interface InvestigationNotes {
  notesId: string;
  createdAt: string;
  body: InvestigationNotesBody;
}

export function notesIdFor(body: InvestigationNotesBody): string {
  return createHash('sha1').update(canonicalize(body)).digest('hex').slice(0, 16);
}

export class InvestigationNotesStore {
  private readonly notes: InvestigationNotes[] = [];

  static deserialize(json: string): InvestigationNotesStore {
    const arr = JSON.parse(json) as InvestigationNotes[];
    const store = new InvestigationNotesStore();
    for (const n of arr) {
      const id = notesIdFor(n.body);
      store.notes.push({ ...n, notesId: id });
    }
    return store;
  }

  serialize(): string {
    return JSON.stringify(this.notes);
  }

  latest(): InvestigationNotes | null {
    return this.notes[this.notes.length - 1] ?? null;
  }

  forSnapshot(snapshotId: string): InvestigationNotes[] {
    return this.notes.filter((n) => n.body.dossierSnapshotId === snapshotId);
  }

  list(): InvestigationNotes[] {
    return this.notes.slice();
  }

  append(body: InvestigationNotesBody): InvestigationNotes {
    const parsed = InvestigationNotesBodySchema.parse(body);
    const id = notesIdFor(parsed);
    const note: InvestigationNotes = { notesId: id, createdAt: new Date().toISOString(), body: parsed };
    this.notes.push(note);
    return note;
  }
}
