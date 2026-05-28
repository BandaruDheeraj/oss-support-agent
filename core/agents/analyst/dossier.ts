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
import { CandidateReproSchema, type CandidateRepro } from './candidate-repro';
export { CandidateReproSchema, CandidateReproInputSchema, normalizeCandidateReproInput, renderTestSource } from './candidate-repro';
export type { CandidateRepro, CandidateReproInput, CandidateReproFailureMode, CandidateReproSource } from './candidate-repro';

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
 * Input variant: deliberately LOOSE. LLMs frequently mis-spell the kind
 * enum, drop required fields, or invent shapes. We accept any object with
 * a non-empty `condition` string and coerce the rest in
 * `record_evidence.execute`. Failing the whole tool call over a malformed
 * precondition would discard the entire investigation — preconditions are
 * best-effort metadata, not a load-bearing contract.
 */
export const PreconditionInputSchema = z
  .object({
    id: z.string().optional(),
    condition: z.string().min(1),
    kind: z.string().optional(),
    appliesTo: z
      .object({ file: z.string().optional(), symbol: z.string().optional() })
      .passthrough()
      .optional(),
    evidenceRefs: z.array(z.string()).optional(),
    satisfactionModes: z
      .array(
        z
          .object({
            description: z.string().optional(),
            markers: z.array(z.string()).optional(),
          })
          .passthrough()
      )
      .optional(),
    threats: z.array(z.string()).optional(),
  })
  .passthrough();

const KNOWN_PRECONDITION_KINDS = [
  'global_state',
  'config_absence',
  'env_var',
  'input_shape',
  'timing',
  'concurrency',
  'version_pin',
] as const;

/**
 * Coerce a loose LLM-supplied precondition into a strict PreconditionSchema
 * shape. Anything unrecognisable is dropped silently — caller is expected
 * to map this over LLM-supplied entries and ignore nulls.
 */
export function normalizePreconditionInput(
  raw: unknown,
  idx: number
): Precondition | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const condition = typeof r.condition === 'string' && r.condition.trim() ? r.condition : null;
  if (!condition) return null;
  const rawKind = typeof r.kind === 'string' ? r.kind.toLowerCase().replace(/[\s-]+/g, '_') : '';
  const kind = (KNOWN_PRECONDITION_KINDS as readonly string[]).includes(rawKind)
    ? (rawKind as Precondition['kind'])
    : 'global_state';
  const id = typeof r.id === 'string' && r.id.trim() ? r.id : `pc-${idx}`;
  const appliesTo =
    r.appliesTo && typeof r.appliesTo === 'object'
      ? (() => {
          const a = r.appliesTo as Record<string, unknown>;
          const file = typeof a.file === 'string' ? a.file : undefined;
          if (!file) return undefined;
          const symbol = typeof a.symbol === 'string' ? a.symbol : undefined;
          return symbol ? { file, symbol } : { file };
        })()
      : undefined;
  const evidenceRefs = Array.isArray(r.evidenceRefs)
    ? r.evidenceRefs.filter((x): x is string => typeof x === 'string')
    : [];
  const satisfactionModes = Array.isArray(r.satisfactionModes)
    ? r.satisfactionModes
        .map((m): SatisfactionMode | null => {
          if (!m || typeof m !== 'object') return null;
          const mm = m as Record<string, unknown>;
          const description = typeof mm.description === 'string' && mm.description.trim() ? mm.description : null;
          if (!description) return null;
          const markers = Array.isArray(mm.markers)
            ? mm.markers.filter((x): x is string => typeof x === 'string')
            : [];
          return { description, markers };
        })
        .filter((m): m is SatisfactionMode => m !== null)
    : [];
  const threats = Array.isArray(r.threats)
    ? r.threats.filter((x): x is string => typeof x === 'string')
    : [];
  return { id, condition, kind, appliesTo, evidenceRefs, satisfactionModes, threats };
}
export type PreconditionInput = z.infer<typeof PreconditionInputSchema>;

/**
 * ReproRecipe — the structured plan + observed proof emitted by the Prober
 * stage. The deterministic Executor consumes this object to write the test
 * and run it; it carries no LLM-authored side effects beyond what's in here.
 *
 * Storage contract: OPTIONAL at the schema layer so legacy snapshots (pre-
 * recipe) deserialize successfully. The orchestrator enforces the
 * execution-time invariant that a recipe MUST be present before the
 * deterministic Executor runs.
 *
 * Size contract: `testSource` is capped at 4096 chars. Anything longer is
 * almost certainly off-task scaffolding — the goal is a focused failing
 * test, not a vendored module.
 */
export const REPRO_RECIPE_TEST_SOURCE_MAX = 4096;
export const REPRO_RECIPE_OBSERVED_TAIL_MAX = 2048;

export const ReproRecipePipInstallSchema = z.object({
  package: z.string().min(1),
  editable: z.boolean().default(false),
});
export type ReproRecipePipInstall = z.infer<typeof ReproRecipePipInstallSchema>;

/**
 * Observed-probe block: when the Prober actually ran the candidate test in
 * its own sandbox, it records what it saw. The Critic uses these flags to
 * decide whether `expectedFailureSignature` is a hard gate (when observed)
 * or a soft signal (when not). `null` means the recipe was never probed —
 * the orchestrator treats this as a Prober failure unless explicitly
 * allowed.
 */
export const ReproRecipeObservedProbeSchema = z.object({
  sentinelObserved: z.boolean(),
  signatureObserved: z.boolean(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  stderrTail: z.string().max(REPRO_RECIPE_OBSERVED_TAIL_MAX),
  stdoutTail: z.string().max(REPRO_RECIPE_OBSERVED_TAIL_MAX),
});
export type ReproRecipeObservedProbe = z.infer<typeof ReproRecipeObservedProbeSchema>;

export const ReproRecipeSchema = z.object({
  version: z.literal(1),
  candidateTestPath: z.string().min(1),
  testSource: z.string().min(1).max(REPRO_RECIPE_TEST_SOURCE_MAX),
  sentinelString: z.string().min(1),
  expectedFailureSignature: z.string().min(1).optional(),
  pipInstalls: z.array(ReproRecipePipInstallSchema).default([]),
  requiresCredentials: z.array(z.string().min(1)).default([]),
  verbatimSnippetIncompatible: z.boolean().default(false),
  approach: z.string().max(2000).default(''),
  provenance: z.object({
    exerciseImports: z.array(z.string()).default([]),
    preconditionsSatisfied: z.array(z.string()).default([]),
    observedProbe: ReproRecipeObservedProbeSchema.nullable().default(null),
    proberAttempts: z.number().int().nonnegative().default(0),
    recordedAt: z.string().min(1),
  }),
});
export type ReproRecipe = z.infer<typeof ReproRecipeSchema>;

/**
 * Loose input shape accepted by the Prober's record_evidence call. LLM
 * tooling reliably forgets defaultable fields; we coerce in the executor.
 */
export const ReproRecipeInputSchema = z
  .object({
    version: z.literal(1).optional(),
    candidateTestPath: z.string().min(1),
    testSource: z.string().min(1),
    sentinelString: z.string().min(1),
    expectedFailureSignature: z.string().optional(),
    pipInstalls: z
      .array(
        z
          .object({ package: z.string().min(1), editable: z.boolean().optional() })
          .passthrough()
      )
      .optional(),
    requiresCredentials: z.array(z.string()).optional(),
    verbatimSnippetIncompatible: z.boolean().optional(),
    approach: z.string().optional(),
    provenance: z
      .object({
        exerciseImports: z.array(z.string()).optional(),
        preconditionsSatisfied: z.array(z.string()).optional(),
        observedProbe: z
          .object({
            sentinelObserved: z.boolean(),
            signatureObserved: z.boolean(),
            exitCode: z.number().int(),
            durationMs: z.number().int().nonnegative(),
            stderrTail: z.string(),
            stdoutTail: z.string(),
          })
          .nullable()
          .optional(),
        proberAttempts: z.number().int().nonnegative().optional(),
        recordedAt: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ReproRecipeInput = z.infer<typeof ReproRecipeInputSchema>;

/**
 * Coerce a loose recipe input into a strict ReproRecipe, applying defaults
 * + clipping testSource/stderrTail/stdoutTail to schema caps. Returns null
 * if the input lacks the minimum required fields (path, source, sentinel).
 */
export function normalizeReproRecipeInput(raw: unknown): ReproRecipe | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const candidateTestPath = typeof r.candidateTestPath === 'string' && r.candidateTestPath.trim()
    ? r.candidateTestPath.trim()
    : null;
  const testSourceRaw = typeof r.testSource === 'string' ? r.testSource : null;
  const sentinelString = typeof r.sentinelString === 'string' && r.sentinelString.trim()
    ? r.sentinelString
    : null;
  if (!candidateTestPath || !testSourceRaw || !sentinelString) return null;
  const testSource = testSourceRaw.length > REPRO_RECIPE_TEST_SOURCE_MAX
    ? testSourceRaw.slice(0, REPRO_RECIPE_TEST_SOURCE_MAX)
    : testSourceRaw;
  const expectedFailureSignature =
    typeof r.expectedFailureSignature === 'string' && r.expectedFailureSignature.trim()
      ? r.expectedFailureSignature
      : undefined;
  const pipInstalls = Array.isArray(r.pipInstalls)
    ? r.pipInstalls
        .map((p): ReproRecipePipInstall | null => {
          if (!p || typeof p !== 'object') return null;
          const pp = p as Record<string, unknown>;
          const pkg = typeof pp.package === 'string' && pp.package.trim() ? pp.package : null;
          if (!pkg) return null;
          return { package: pkg, editable: pp.editable === true };
        })
        .filter((p): p is ReproRecipePipInstall => p !== null)
    : [];
  const requiresCredentials = Array.isArray(r.requiresCredentials)
    ? r.requiresCredentials.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  const verbatimSnippetIncompatible = r.verbatimSnippetIncompatible === true;
  const approach = typeof r.approach === 'string' ? r.approach.slice(0, 2000) : '';
  const provRaw = (r.provenance && typeof r.provenance === 'object'
    ? (r.provenance as Record<string, unknown>)
    : {});
  const exerciseImports = Array.isArray(provRaw.exerciseImports)
    ? provRaw.exerciseImports.filter((x): x is string => typeof x === 'string')
    : [];
  const preconditionsSatisfied = Array.isArray(provRaw.preconditionsSatisfied)
    ? provRaw.preconditionsSatisfied.filter((x): x is string => typeof x === 'string')
    : [];
  let observedProbe: ReproRecipeObservedProbe | null = null;
  if (provRaw.observedProbe && typeof provRaw.observedProbe === 'object') {
    const op = provRaw.observedProbe as Record<string, unknown>;
    const exitCode = typeof op.exitCode === 'number' ? Math.trunc(op.exitCode) : null;
    const durationMs = typeof op.durationMs === 'number' ? Math.max(0, Math.trunc(op.durationMs)) : null;
    if (exitCode !== null && durationMs !== null) {
      const stderrTail = typeof op.stderrTail === 'string'
        ? op.stderrTail.slice(0, REPRO_RECIPE_OBSERVED_TAIL_MAX)
        : '';
      const stdoutTail = typeof op.stdoutTail === 'string'
        ? op.stdoutTail.slice(0, REPRO_RECIPE_OBSERVED_TAIL_MAX)
        : '';
      observedProbe = {
        sentinelObserved: op.sentinelObserved === true,
        signatureObserved: op.signatureObserved === true,
        exitCode,
        durationMs,
        stderrTail,
        stdoutTail,
      };
    }
  }
  const proberAttempts = typeof provRaw.proberAttempts === 'number' && provRaw.proberAttempts >= 0
    ? Math.trunc(provRaw.proberAttempts)
    : 0;
  const recordedAt = typeof provRaw.recordedAt === 'string' && provRaw.recordedAt
    ? provRaw.recordedAt
    : new Date().toISOString();
  return {
    version: 1,
    candidateTestPath,
    testSource,
    sentinelString,
    ...(expectedFailureSignature ? { expectedFailureSignature } : {}),
    pipInstalls,
    requiresCredentials,
    verbatimSnippetIncompatible,
    approach,
    provenance: {
      exerciseImports,
      preconditionsSatisfied,
      observedProbe,
      proberAttempts,
      recordedAt,
    },
  };
}

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
  /**
   * Repro recipe written by the Prober stage. OPTIONAL at the schema
   * layer to preserve back-compat with legacy snapshots (pre-Prober
   * pipeline). The orchestrator enforces the execution-time invariant
   * that a recipe MUST be present before the deterministic Executor runs.
   */
  reproRecipe: ReproRecipeSchema.optional(),
  /**
   * Structured repro spec authored by the Analyst (when confident enough)
   * for the deterministic Builder to consume. OPTIONAL — the orchestrator
   * falls through to the LLM Prober when absent or when the Builder
   * rejects the candidate. Back-compat: snapshots predating this field
   * deserialize without it; `snapshotIdFor` strips it from the canonical
   * hash when absent so legacy snapshot ids remain stable.
   */
  candidateRepro: CandidateReproSchema.optional(),
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
  // Same trick for reproRecipe: legacy snapshots predate the field
  // entirely, so omit it from the canonical bytes when absent. This
  // preserves stored snapshot ids and any investigation-notes / orchestrator
  // links bound to dossierSnapshotId.
  const recipe = (body as { reproRecipe?: unknown }).reproRecipe;
  if (recipe == null) {
    delete forHash.reproRecipe;
  }
  // Same for candidateRepro (added with the deterministic Builder).
  // Legacy snapshots have neither field, so absence MUST canonicalize-out
  // identically.
  const candidate = (body as { candidateRepro?: unknown }).candidateRepro;
  if (candidate == null) {
    delete forHash.candidateRepro;
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
    input: Omit<DossierBody, 'parentSnapshotId' | 'preconditions' | 'reproRecipe' | 'candidateRepro'> & {
      parentSnapshotId?: string | null;
      preconditions?: Precondition[];
      reproRecipe?: ReproRecipe;
      candidateRepro?: CandidateRepro;
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
