/**
 * EvidenceDossier — append-only, versioned, snapshot-addressed.
 *
 * Written ONLY by the Analyst agent. Every snapshot has a deterministic id
 * (sha1 of canonical JSON of its contents), so multiple agents reading
 * `dossier_snapshot_id=X` are guaranteed to see the same bytes.
 *
 * Wire format is JSON; the orchestrator persists snapshots on the
 * multi-repo-index row keyed by `(issue_number, attempt_id)`.
 */

import { createHash } from 'crypto';
import { z } from 'zod';

export const EvidenceSchema = z.object({
  id: z.string(),                          // stable id within the dossier
  kind: z.enum([
    'issue_excerpt',
    'file_excerpt',
    'symbol_definition',
    'symbol_caller',
    'recent_commit',
    'web_reference',
    'tool_observation',
    'human_input',
    'critic_finding',
    'note',
  ]),
  source: z.string(),                      // file path / url / commit sha / human
  summary: z.string(),                     // 1-3 sentence summary
  detail: z.string().optional(),           // full quote / code block
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  recordedAt: z.string(),                  // ISO timestamp
});

export type Evidence = z.infer<typeof EvidenceSchema>;

export const SuspectSymbolSchema = z.object({
  file: z.string(),
  symbol: z.string(),
  reasoning: z.string(),
});

export type SuspectSymbol = z.infer<typeof SuspectSymbolSchema>;

export const DossierBodySchema = z.object({
  issueNumber: z.number(),
  attemptId: z.string(),
  parentSnapshotId: z.string().nullable(),
  evidence: z.array(EvidenceSchema),
  suspectSymbols: z.array(SuspectSymbolSchema),
  openQuestions: z.array(z.string()),
  summary: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
});

export type DossierBody = z.infer<typeof DossierBodySchema>;

export interface DossierSnapshot {
  snapshotId: string;
  createdAt: string;
  body: DossierBody;
}

function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map((x) => canonicalize(x)).join(',')}]`;
  const entries = Object.entries(obj as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export function snapshotIdFor(body: DossierBody): string {
  return createHash('sha1').update(canonicalize(body)).digest('hex').slice(0, 16);
}

/**
 * In-memory dossier store. The orchestrator wraps an instance per
 * (issue, attempt) and persists serialized snapshots to the multi-repo-index
 * row in production.
 */
export class DossierStore {
  private readonly snapshots: DossierSnapshot[] = [];

  /** Restore from persisted JSON. */
  static deserialize(json: string): DossierStore {
    const arr = JSON.parse(json) as DossierSnapshot[];
    const store = new DossierStore();
    for (const snap of arr) {
      // Re-derive id to defend against tampering
      const id = snapshotIdFor(snap.body);
      store.snapshots.push({ ...snap, snapshotId: id });
    }
    return store;
  }

  serialize(): string {
    return JSON.stringify(this.snapshots);
  }

  latest(): DossierSnapshot | null {
    return this.snapshots[this.snapshots.length - 1] ?? null;
  }

  get(snapshotId: string): DossierSnapshot | null {
    return this.snapshots.find((s) => s.snapshotId === snapshotId) ?? null;
  }

  list(): DossierSnapshot[] {
    return this.snapshots.slice();
  }

  /**
   * Append a new snapshot. The body's parentSnapshotId is auto-set to the
   * current latest snapshot when not provided. Returns the new snapshot id.
   */
  append(input: Omit<DossierBody, 'parentSnapshotId'> & { parentSnapshotId?: string | null }): DossierSnapshot {
    const parent = input.parentSnapshotId ?? this.latest()?.snapshotId ?? null;
    const body: DossierBody = DossierBodySchema.parse({
      ...input,
      parentSnapshotId: parent,
    });
    const snapshotId = snapshotIdFor(body);
    const snap: DossierSnapshot = {
      snapshotId,
      createdAt: new Date().toISOString(),
      body,
    };
    this.snapshots.push(snap);
    return snap;
  }
}
