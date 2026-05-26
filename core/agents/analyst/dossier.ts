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

/**
 * Input variant accepted from LLM tool calls. `recordedAt` and `source` are
 * both made optional because LLMs reliably forget to populate them, which
 * would otherwise reject the entire `record_evidence` call as an
 * InvalidToolArguments error inside the AI SDK (before our registry can
 * surface a friendly in-band error). The server stamps sensible defaults
 * inside `record_evidence.execute` so the canonical `EvidenceSchema`
 * remains strict.
 */
export const EvidenceInputSchema = EvidenceSchema.extend({
  recordedAt: z.string().optional(),
  source: z.string().optional(),
});
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;

export const SuspectSymbolSchema = z.object({
  file: z.string(),
  symbol: z.string(),
  reasoning: z.string(),
});

export type SuspectSymbol = z.infer<typeof SuspectSymbolSchema>;

/**
 * A "satisfaction mode" is one concrete way a repro test can enforce a
 * precondition. The `markers` array contains short substrings the Critic
 * can grep for in the candidate test source as a structural redundancy
 * check on the LLM's judgement.
 */
export const SatisfactionModeSchema = z.object({
  description: z.string().min(1),
  markers: z.array(z.string()).default([]),
});
export type SatisfactionMode = z.infer<typeof SatisfactionModeSchema>;

/**
 * Preconditions: the state of the world that must hold for the bug to
 * manifest. Written by the Analyst, consumed by Planner/Executor/Critic.
 *
 * NEGATIVE preconditions ("X must NOT be configured") are the common
 * failure mode for our agents — pytest fixtures often install the very
 * state the bug requires to be absent. `threats` enumerates those
 * fixtures/env-vars; `satisfactionModes` enumerates ways the test can
 * still enforce the precondition (global reset OR direct injection, etc.).
 */
export const PreconditionSchema = z.object({
  id: z.string().min(1),
  condition: z.string().min(1),
  kind: z.enum([
    'global_state',
    'config_absence',
    'env_var',
    'input_shape',
    'timing',
    'concurrency',
    'version_pin',
  ]),
  appliesTo: z
    .object({ file: z.string(), symbol: z.string().optional() })
    .optional(),
  /** Evidence ids from the dossier supporting this precondition. */
  evidenceRefs: z.array(z.string()).default([]),
  /** At least one mode must be enforced by the repro test. */
  satisfactionModes: z.array(SatisfactionModeSchema).default([]),
  /** Test-infrastructure items that may violate this precondition. */
  threats: z.array(z.string()).default([]),
});
export type Precondition = z.infer<typeof PreconditionSchema>;

/**
 * Input variant: `id` and `evidenceRefs` are optional because LLMs forget
 * them. Server stamps `id = pc-{idx}` and defaults arrays in
 * `record_evidence.execute`.
 */
export const PreconditionInputSchema = PreconditionSchema.extend({
  id: z.string().optional(),
  evidenceRefs: z.array(z.string()).optional(),
  satisfactionModes: z.array(SatisfactionModeSchema).optional(),
  threats: z.array(z.string()).optional(),
});
export type PreconditionInput = z.infer<typeof PreconditionInputSchema>;

export const DossierBodySchema = z.object({
  issueNumber: z.number(),
  attemptId: z.string(),
  parentSnapshotId: z.string().nullable(),
  evidence: z.array(EvidenceSchema),
  suspectSymbols: z.array(SuspectSymbolSchema),
  /**
   * Preconditions identified by the Analyst. Defaults to [] so legacy
   * dossier snapshots (pre-feature) deserialize successfully.
   */
  preconditions: z.array(PreconditionSchema).default([]),
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

/**
 * Compute the snapshot id. CRITICAL backward-compat invariant: when the
 * body has an empty `preconditions` array, we OMIT the key from the
 * canonical bytes before hashing. This means legacy snapshots (persisted
 * before the preconditions feature) rehydrate with the same snapshot id,
 * preserving investigation-notes links bound to `dossierSnapshotId`.
 *
 * New snapshots that actually use preconditions hash differently from
 * any legacy snapshot, which is correct: their content is distinct.
 */
export function snapshotIdFor(body: DossierBody): string {
  const forHash: Record<string, unknown> = { ...(body as unknown as Record<string, unknown>) };
  const pcs = (body as { preconditions?: unknown[] }).preconditions;
  if (!Array.isArray(pcs) || pcs.length === 0) {
    delete forHash.preconditions;
  }
  return createHash('sha1').update(canonicalize(forHash)).digest('hex').slice(0, 16);
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
      // Normalize body through schema so legacy snapshots gain the default
      // `preconditions: []` runtime field. snapshotIdFor omits empty
      // preconditions from the canonical hash, so the recomputed id still
      // matches the legacy stored id — preserving investigation-notes
      // links bound to dossierSnapshotId.
      const body = DossierBodySchema.parse(snap.body);
      const id = snapshotIdFor(body);
      store.snapshots.push({ ...snap, body, snapshotId: id });
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
   *
   * `preconditions` is optional on the input — the schema defaults to `[]`
   * when omitted, preserving backward-compatible call sites.
   */
  append(
    input: Omit<DossierBody, 'parentSnapshotId' | 'preconditions'> & {
      parentSnapshotId?: string | null;
      preconditions?: Precondition[];
    }
  ): DossierSnapshot {
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
