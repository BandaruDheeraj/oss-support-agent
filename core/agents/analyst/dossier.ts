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
export const SuspectFileSchema = z.string();
export type SuspectFile = z.infer<typeof SuspectFileSchema>;

/**
 * Structured oracle spec consumed by downstream deterministic gates.
 *
 * - suspect_path_assertions: symbols / stack frames / span attributes that
 *   MUST appear in failing repro output.
 * - precondition_assertions: markers that MUST appear in the candidate test
 *   source to prove the required world-state setup is present.
 *
 * Storage contract: optional for back-compat. snapshotIdFor omits absent or
 * all-empty specs so legacy snapshot ids stay stable.
 */
export const ReproOracleSuspectPathKindSchema = z.enum([
  'symbol',
  'stack_frame',
  'span_attribute',
]);
export type ReproOracleSuspectPathKind = z.infer<typeof ReproOracleSuspectPathKindSchema>;

export const ReproOracleSuspectPathAssertionSchema = z.object({
  kind: ReproOracleSuspectPathKindSchema,
  needle: z.string().min(1).max(512),
  file: z.string().min(1).max(240).optional(),
});
export type ReproOracleSuspectPathAssertion = z.infer<typeof ReproOracleSuspectPathAssertionSchema>;

export const ReproOraclePreconditionAssertionSchema = z.object({
  condition: z.string().min(1).max(512),
  markers: z.array(z.string().min(1).max(240)).default([]),
});
export type ReproOraclePreconditionAssertion = z.infer<typeof ReproOraclePreconditionAssertionSchema>;

export const ReproOracleSpecSchema = z.object({
  suspect_path_assertions: z.array(ReproOracleSuspectPathAssertionSchema).default([]),
  precondition_assertions: z.array(ReproOraclePreconditionAssertionSchema).default([]),
});
export type ReproOracleSpec = z.infer<typeof ReproOracleSpecSchema>;

/**
 * Loose input shape accepted from Analyst/Prober tool calls.
 */
export const ReproOracleSpecInputSchema = z
  .object({
    suspect_path_assertions: z.array(z.unknown()).optional(),
    precondition_assertions: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type ReproOracleSpecInput = z.infer<typeof ReproOracleSpecInputSchema>;

function cleanOracleText(raw: unknown, maxLen = 512): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function normalizeOracleSuspectKind(raw: unknown): ReproOracleSuspectPathKind {
  if (typeof raw !== 'string') return 'symbol';
  const k = raw.toLowerCase().replace(/[\s-]+/g, '_');
  return k === 'stack_frame' || k === 'span_attribute' ? k : 'symbol';
}

function normalizeOraclePreconditionMarkers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const marker of raw) {
    const cleaned = cleanOracleText(marker, 240);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/**
 * Normalize an LLM-emitted oracle spec into strict schema shape. Returns null
 * when both arrays are empty after cleaning.
 */
export function normalizeReproOracleSpecInput(raw: unknown): ReproOracleSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const suspect_path_assertions: ReproOracleSuspectPathAssertion[] = [];
  const seenSuspects = new Set<string>();
  if (Array.isArray(r.suspect_path_assertions)) {
    for (const entry of r.suspect_path_assertions) {
      let kind: ReproOracleSuspectPathKind = 'symbol';
      let needle: string | null = null;
      let file: string | undefined;

      if (typeof entry === 'string') {
        needle = cleanOracleText(entry, 512);
      } else if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        kind = normalizeOracleSuspectKind(e.kind ?? e.type);
        needle =
          cleanOracleText(
            e.needle ??
              e.match ??
              e.symbol ??
              e.stack_frame ??
              e.span_attribute ??
              e.value,
            512
          ) ?? null;
        file = cleanOracleText(e.file ?? e.path, 240) ?? undefined;
      }
      if (!needle) continue;
      const dedupe = `${kind}|${needle}|${file ?? ''}`;
      if (seenSuspects.has(dedupe)) continue;
      seenSuspects.add(dedupe);
      suspect_path_assertions.push(
        file ? { kind, needle, file } : { kind, needle }
      );
    }
  }

  const precondition_assertions: ReproOraclePreconditionAssertion[] = [];
  const seenPreconditions = new Set<string>();
  if (Array.isArray(r.precondition_assertions)) {
    for (const entry of r.precondition_assertions) {
      let condition: string | null = null;
      let markers: string[] = [];

      if (typeof entry === 'string') {
        condition = cleanOracleText(entry, 512);
      } else if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        condition = cleanOracleText(e.condition ?? e.description ?? e.id, 512);
        markers = normalizeOraclePreconditionMarkers(
          Array.isArray(e.markers)
            ? e.markers
            : e.marker != null
              ? [e.marker]
              : []
        );
        if (!condition && markers.length > 0) {
          condition = markers[0]!;
        }
      }

      if (!condition) continue;
      const markerSet = Array.from(new Set(markers));
      const dedupe = `${condition}|${markerSet.join('|')}`;
      if (seenPreconditions.has(dedupe)) continue;
      seenPreconditions.add(dedupe);
      precondition_assertions.push({ condition, markers: markerSet });
    }
  }

  if (suspect_path_assertions.length === 0 && precondition_assertions.length === 0) {
    return null;
  }
  return {
    suspect_path_assertions,
    precondition_assertions,
  };
}

/**
 * ReproTargets — structured hints the Analyst supplies to downstream Repro
 * stages so they don't have to re-derive them via heuristics.
 *
 *   - `editableInstall`: repo-relative directory paths the Repro Executor
 *     should `pip install -e <dir>` BEFORE running the candidate test. Each
 *     dir must contain a Python package manifest (pyproject.toml /
 *     setup.py / setup.cfg). Replaces the BFS-top-5 + suspect-path-walk-up
 *     heuristic when the Analyst can identify the package directly.
 *   - `runtimeForbidden`: import names (e.g. "smolagents", "langchain")
 *     that the Prober should NOT try to install in the runtime sandbox;
 *     they're known to either explode the dep tree or require network/
 *     credentials. When non-empty, the Prober pivots to a direct-call
 *     exercise of the underlying primitive (sets
 *     `reproRecipe.verbatimSnippetIncompatible=true`).
 *
 * Both arrays default to []. The whole field is optional at the schema
 * layer for back-compat — legacy snapshots predate the field entirely and
 * must hash identically (see snapshotIdFor).
 */
export const ReproTargetsSchema = z.object({
  editableInstall: z.array(z.string()).default([]),
  runtimeForbidden: z.array(z.string()).default([]),
});
export type ReproTargets = z.infer<typeof ReproTargetsSchema>;

/**
 * Loose input variant. LLMs frequently emit either field with extraneous
 * shape (objects instead of strings, leading slashes, etc.); we coerce in
 * `normalizeReproTargetsInput`. Failing the whole `record_evidence` call
 * over a malformed reproTargets entry would discard the entire dossier —
 * reproTargets is a best-effort hint, not a load-bearing contract.
 */
export const ReproTargetsInputSchema = z
  .object({
    editableInstall: z.array(z.string()).optional(),
    runtimeForbidden: z.array(z.string()).optional(),
  })
  .passthrough();
export type ReproTargetsInput = z.infer<typeof ReproTargetsInputSchema>;

/**
 * Coerce a loose reproTargets input into a strict ReproTargets shape. Strips
 * non-string entries, leading/trailing slashes on dirs, and de-dupes.
 * Returns null when the input is absent or both fields end up empty — the
 * caller treats null as "no reproTargets supplied" so the back-compat
 * snapshot hash remains stable (snapshotIdFor omits the field when absent).
 */
export function normalizeReproTargetsInput(raw: unknown): ReproTargets | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const dedup = (arr: unknown, cleaner: (s: string) => string): string[] => {
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of arr) {
      if (typeof v !== 'string') continue;
      const cleaned = cleaner(v).trim();
      if (!cleaned) continue;
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
    }
    return out;
  };
  const editableInstall = dedup(r.editableInstall, (s) =>
    s.replace(/\\+/g, '/').replace(/^[/]+/, '').replace(/\/+$/, '')
  );
  const runtimeForbidden = dedup(r.runtimeForbidden, (s) => s.toLowerCase());
  if (editableInstall.length === 0 && runtimeForbidden.length === 0) return null;
  return { editableInstall, runtimeForbidden };
}

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
 * Deterministically derive an oracle spec from legacy dossier signals when
 * the Analyst omits `oracleSpec`.
 */
export function buildReproOracleSpec(
  suspectSymbols: SuspectSymbol[],
  preconditions: Precondition[]
): ReproOracleSpec | null {
  const suspect_path_assertions: ReproOracleSuspectPathAssertion[] = [];
  const seenSuspects = new Set<string>();
  for (const s of suspectSymbols) {
    const needle = cleanOracleText(s.symbol, 512);
    const file = cleanOracleText(s.file, 240);
    if (!needle) continue;
    const dedupe = `symbol|${needle}|${file ?? ''}`;
    if (seenSuspects.has(dedupe)) continue;
    seenSuspects.add(dedupe);
    suspect_path_assertions.push(
      file
        ? { kind: 'symbol', needle, file }
        : { kind: 'symbol', needle }
    );
  }

  const precondition_assertions: ReproOraclePreconditionAssertion[] = [];
  const seenPreconditions = new Set<string>();
  for (const p of preconditions) {
    const condition = cleanOracleText(p.condition, 512);
    if (!condition) continue;
    const markers = Array.from(
      new Set(
        p.satisfactionModes
          .flatMap((m) => m.markers)
          .map((m) => cleanOracleText(m, 240))
          .filter((m): m is string => m !== null)
      )
    );
    const dedupe = `${condition}|${markers.join('|')}`;
    if (seenPreconditions.has(dedupe)) continue;
    seenPreconditions.add(dedupe);
    precondition_assertions.push({ condition, markers });
  }

  if (suspect_path_assertions.length === 0 && precondition_assertions.length === 0) {
    return null;
  }
  return {
    suspect_path_assertions,
    precondition_assertions,
  };
}

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
  /**
   * Primary suspect file shortlist surfaced by semantic retrieval and/or
   * Analyst refinement.
   */
  suspectFiles: z.array(SuspectFileSchema).optional(),
  suspectSymbols: z.array(SuspectSymbolSchema),
  /**
   * Preconditions identified by the Analyst. Defaults to [] so legacy
   * dossier snapshots (pre-feature) deserialize successfully.
   */
  preconditions: z.array(PreconditionSchema).default([]),
  /**
   * Structured repro oracle spec emitted by the Analyst and consumed by
   * downstream deterministic gates. Optional for snapshot-id backward compat;
   * empty specs canonicalize-out in snapshotIdFor.
   */
  oracleSpec: ReproOracleSpecSchema.optional(),
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
  /**
   * Repro targets authored by the Analyst — concrete package dirs to
   * `pip install -e` and import names the Prober must NOT install in the
   * runtime sandbox. OPTIONAL: when absent the orchestrator falls back to
   * the BFS+suspect-path heuristic in repro-hints.ts. Back-compat:
   * snapshots predating this field deserialize without it; `snapshotIdFor`
   * strips it from the canonical hash when absent so legacy snapshot ids
   * remain stable.
   */
  reproTargets: ReproTargetsSchema.optional(),
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
  // Same for suspectFiles (added with semantic retrieval). Both absent and
  // empty arrays canonicalize out for backward compatibility.
  const suspectFiles = (body as { suspectFiles?: string[] }).suspectFiles;
  if (!Array.isArray(suspectFiles) || suspectFiles.length === 0) {
    delete forHash.suspectFiles;
  }
  // Same for reproTargets (analyst-authored hints, added in Phase 8). Both
  // absent and "present but both arrays empty" MUST canonicalize-out
  // identically, otherwise a body that defaults the field through the
  // schema would hash differently from a legacy snapshot literally lacking
  // it.
  const reproTargets = (body as { reproTargets?: ReproTargets }).reproTargets;
  if (
    reproTargets == null ||
    ((reproTargets.editableInstall ?? []).length === 0 &&
      (reproTargets.runtimeForbidden ?? []).length === 0)
  ) {
    delete forHash.reproTargets;
  }
  // Same for oracleSpec (Stage 1 deterministic oracle assertions). Both
  // absent and all-empty arrays must canonicalize-out for legacy hash
  // stability.
  const oracleSpec = (body as { oracleSpec?: ReproOracleSpec }).oracleSpec;
  if (
    oracleSpec == null ||
    ((oracleSpec.suspect_path_assertions ?? []).length === 0 &&
      (oracleSpec.precondition_assertions ?? []).length === 0)
  ) {
    delete forHash.oracleSpec;
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
    input: Omit<
      DossierBody,
      | 'parentSnapshotId'
      | 'suspectFiles'
      | 'preconditions'
      | 'oracleSpec'
      | 'reproRecipe'
      | 'candidateRepro'
      | 'reproTargets'
    > & {
      parentSnapshotId?: string | null;
      suspectFiles?: SuspectFile[];
      preconditions?: Precondition[];
      oracleSpec?: ReproOracleSpec;
      reproRecipe?: ReproRecipe;
      candidateRepro?: CandidateRepro;
      reproTargets?: ReproTargets;
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
