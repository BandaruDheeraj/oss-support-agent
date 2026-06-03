/**
 * CandidateRepro — structured, schema-validated repro spec emitted by the
 * Analyst. Consumed by the deterministic Builder (no LLM at build time) to
 * produce a `ReproRecipe` without an LLM tool loop.
 *
 * Compared to the LLM Prober, the Builder requires the Analyst to commit
 * up-front to a very small set of inputs (imports, setup, exerciseCall,
 * sentinel, failureMode). The template engine renders test source from
 * these inputs deterministically and the Builder verifies it runs against
 * the live sandbox.
 *
 * Storage contract: persisted on the dossier body, OPTIONAL at the schema
 * layer for back-compat with snapshots predating this feature.
 */

import { z } from 'zod';

/**
 * Pip install spec — duplicated here (not imported from ./dossier) to break
 * a circular import: dossier.ts imports CandidateReproSchema from this file
 * for its body schema. The duplicate is 4 lines and structurally identical
 * to dossier's ReproRecipePipInstallSchema; a dossier.test asserts they
 * remain compatible.
 */
const PipInstallSchema = z.object({
  package: z.string().min(1),
  editable: z.boolean().default(false),
});
type PipInstall = z.infer<typeof PipInstallSchema>;
export type ReproRecipePipInstall = PipInstall;

/** Hard caps to bound prompt + serialized payload size. */
export const CANDIDATE_REPRO_IMPORT_MAX_LEN = 240;
export const CANDIDATE_REPRO_IMPORTS_MAX = 12;
export const CANDIDATE_REPRO_SETUP_MAX_LEN = 1024;
export const CANDIDATE_REPRO_EXERCISE_MAX_LEN = 512;
export const CANDIDATE_REPRO_SENTINEL_MAX_LEN = 120;
export const CANDIDATE_REPRO_SIGNATURE_MAX_LEN = 240;
export const CANDIDATE_REPRO_EXPECTED_VALUE_MAX_LEN = 512;
export const CANDIDATE_REPRO_RATIONALE_MAX_LEN = 2000;

export const CandidateReproFailureMode = z.enum([
  'unexpected_exception',
  'wrong_return',
]);
export type CandidateReproFailureMode = z.infer<typeof CandidateReproFailureMode>;

export const CandidateReproSource = z.enum([
  'direct_call',
  'issue_snippet',
  'derived',
]);
export type CandidateReproSource = z.infer<typeof CandidateReproSource>;

/**
 * Strict schema. Used on round-trip (after normalization). All defaults
 * are explicit so the snapshot canonical-hash is stable.
 */
export const CANDIDATE_REPRO_TEST_SOURCE_MAX_LEN = 16_000;

export const CandidateReproSchema = z.object({
  version: z.literal(1),
  source: CandidateReproSource,
  /**
   * When present, the analyst wrote the full Python test source directly.
   * The Builder writes it verbatim to candidateTestPath and runs it.
   * failureMode / exerciseCall / sentinel are unused in this path.
   */
  testSource: z.string().min(1).max(CANDIDATE_REPRO_TEST_SOURCE_MAX_LEN).optional(),
  failureMode: CandidateReproFailureMode,
  /**
   * For failureMode==='unexpected_exception', the Python exception class
   * the Analyst predicts will be raised (e.g. "AttributeError"). The
   * Builder uses this purely in the assertion message; behavior is the
   * same regardless of the actual exception class raised at runtime.
   */
  expectedExceptionType: z.string().max(80).optional(),
  /**
   * For failureMode==='wrong_return', a literal Python expression
   * representing the expected (correct) value. Compared with `==`.
   */
  expectedValueExpression: z.string().max(CANDIDATE_REPRO_EXPECTED_VALUE_MAX_LEN).optional(),
  /** Repo-relative test path (must live under one of workspace.testRoots()). */
  candidateTestPath: z.string().min(1).max(240),
  /**
   * Each import is a single Python import statement
   * ("from x import y" or "import z [as w]"). Validated via AST in the
   * Builder so smuggled side-effects like `import os; os.system(...)` are
   * rejected.
   */
  imports: z
    .array(z.string().min(1).max(CANDIDATE_REPRO_IMPORT_MAX_LEN))
    .max(CANDIDATE_REPRO_IMPORTS_MAX)
    .default([]),
  /**
   * Top-of-function body executed before exerciseCall. Multiline allowed.
   * Must NOT itself raise the bug — that's the exerciseCall's job.
   */
  setup: z.string().max(CANDIDATE_REPRO_SETUP_MAX_LEN).default(''),
  /**
   * The single Python expression (or statement) whose execution triggers
   * the bug. For unexpected_exception: must raise. For wrong_return: must
   * return a value that compares != expectedValueExpression.
   */
  exerciseCall: z.string().min(1).max(CANDIDATE_REPRO_EXERCISE_MAX_LEN).optional(),
  /**
   * Unique substring the Builder will look for in run_repro stderr to
   * confirm the rendered test was actually executed (not a different
   * pre-existing failure). Templates embed it inside an AssertionError
   * message that travels to pytest's output.
   */
  sentinel: z.string().min(8).max(CANDIDATE_REPRO_SENTINEL_MAX_LEN).optional(),
  /** Optional human-readable failure signature for the Critic. */
  expectedFailureSignature: z.string().max(CANDIDATE_REPRO_SIGNATURE_MAX_LEN).optional(),
  /** Reuses the recipe schema verbatim — { package, editable }. */
  pipInstalls: z.array(PipInstallSchema).default([]),
  /** Env-var names required at runtime (e.g. ["OPENAI_API_KEY"]). */
  requiresCredentials: z.array(z.string().min(1)).default([]),
  /**
   * Dossier precondition IDs this candidate enforces. The Builder
   * validates each ID exists in dossier.preconditions, then echoes the
   * list to recipe.provenance.preconditionsSatisfied so the Critic
   * doesn't reject the recipe for missing precondition coverage.
   */
  preconditionsSatisfied: z.array(z.string().min(1)).default([]),
  /** Free-form 1-2 sentence justification surfaced in telemetry. */
  rationale: z.string().max(CANDIDATE_REPRO_RATIONALE_MAX_LEN).default(''),
});
export type CandidateRepro = z.infer<typeof CandidateReproSchema>;

/**
 * Loose input shape accepted from the Analyst's record_evidence call. All
 * defaultable / optional fields are loosened so LLM emissions that omit
 * them don't reject the whole call. `normalizeCandidateReproInput` coerces
 * to strict.
 */
export const CandidateReproInputSchema = z
  .object({
    version: z.literal(1).optional(),
    source: z.string().optional(),
    testSource: z.string().optional(),
    failureMode: z.string().optional(),
    expectedExceptionType: z.string().optional(),
    expectedValueExpression: z.string().optional(),
    candidateTestPath: z.string().optional(),
    imports: z.array(z.string()).optional(),
    setup: z.string().optional(),
    exerciseCall: z.string().optional(),
    sentinel: z.string().optional(),
    expectedFailureSignature: z.string().optional(),
    pipInstalls: z
      .array(
        z
          .object({ package: z.string().min(1), editable: z.boolean().optional() })
          .passthrough()
      )
      .optional(),
    requiresCredentials: z.array(z.string()).optional(),
    preconditionsSatisfied: z.array(z.string()).optional(),
    rationale: z.string().optional(),
  })
  .passthrough();
export type CandidateReproInput = z.infer<typeof CandidateReproInputSchema>;

const KNOWN_FAILURE_MODES = ['unexpected_exception', 'wrong_return'] as const;
const KNOWN_SOURCES = ['direct_call', 'issue_snippet', 'derived'] as const;

/**
 * Coerce a loose input into a strict CandidateRepro. Returns null on
 * fundamental shape violations (missing exerciseCall / sentinel / path /
 * unknown failureMode). The Builder is responsible for richer validation
 * (path-scoped, import AST shape, preconditions exist in dossier).
 */
export function normalizeCandidateReproInput(raw: unknown): CandidateRepro | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // Accept common LLM-emitted alias field names. These are intentionally
  // narrow — the prompt asks for the canonical names; aliases are a
  // belt-and-suspenders second chance to recover something usable.
  const pick = (canonical: string, ...aliases: string[]): unknown => {
    if (r[canonical] !== undefined) return r[canonical];
    for (const a of aliases) if (r[a] !== undefined) return r[a];
    return undefined;
  };
  const candidateTestPathRaw = pick('candidateTestPath', 'candidate_test_path', 'testPath', 'path');
  const candidateTestPath = typeof candidateTestPathRaw === 'string' ? candidateTestPathRaw.trim() : '';
  if (!candidateTestPath) return null;

  // --- testSource path: analyst wrote the full test; no template needed ---
  const testSourceRaw = pick('testSource', 'test_source', 'testfile', 'test_file', 'fullTestSource');
  const testSource = typeof testSourceRaw === 'string' ? testSourceRaw.trim() : '';
  if (testSource) {
    const sourceRawTs = typeof r.source === 'string' ? r.source.toLowerCase().replace(/[\s-]+/g, '_') : '';
    const sourceParsed: CandidateReproSource = (KNOWN_SOURCES as readonly string[]).includes(sourceRawTs)
      ? (sourceRawTs as CandidateReproSource)
      : 'direct_call';
    const pipInstallsRawTs = pick('pipInstalls', 'pip_installs');
    const pipInstallsTs: ReproRecipePipInstall[] = Array.isArray(pipInstallsRawTs)
      ? pipInstallsRawTs
          .map((p): ReproRecipePipInstall | null => {
            if (!p || typeof p !== 'object') return null;
            const pp = p as Record<string, unknown>;
            const pkg = typeof pp.package === 'string' ? pp.package.trim() : '';
            if (!pkg || /^\s*-e\s/.test(pkg)) return null;
            return { package: pkg, editable: pp.editable === true };
          })
          .filter((p): p is ReproRecipePipInstall => p !== null)
      : [];
    const requiresCredRaw = pick('requiresCredentials', 'requires_credentials');
    const requiresCredentials = Array.isArray(requiresCredRaw)
      ? requiresCredRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    const precondRaw = pick('preconditionsSatisfied', 'preconditions_satisfied');
    const preconditionsSatisfied = Array.isArray(precondRaw)
      ? precondRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    const rationaleTs = typeof r.rationale === 'string' ? r.rationale.slice(0, CANDIDATE_REPRO_RATIONALE_MAX_LEN) : '';
    const sentinelRawTs = pick('sentinel', 'sentinelString', 'sentinel_string');
    const sentinelTs = typeof sentinelRawTs === 'string' ? sentinelRawTs.trim() : '';
    return {
      version: 1 as const,
      source: sourceParsed,
      testSource,
      failureMode: 'wrong_return' as CandidateReproFailureMode, // placeholder; unused in testSource path
      candidateTestPath,
      imports: [],
      setup: '',
      sentinel: sentinelTs.length >= 8 ? sentinelTs : undefined,
      pipInstalls: pipInstallsTs,
      requiresCredentials,
      preconditionsSatisfied,
      rationale: rationaleTs,
    };
  }

  // --- template path (legacy): failureMode + exerciseCall + sentinel ---
  const failureModeRaw = pick('failureMode', 'failure_mode', 'mode');
  const failureMode = typeof failureModeRaw === 'string' ? failureModeRaw.toLowerCase().replace(/[\s-]+/g, '_') : '';
  if (!(KNOWN_FAILURE_MODES as readonly string[]).includes(failureMode)) return null;

  const exerciseCallRaw = pick('exerciseCall', 'exercise_call', 'exerciseExpression', 'callExpression');
  const exerciseCall = typeof exerciseCallRaw === 'string' ? exerciseCallRaw.trim() : '';
  if (!exerciseCall) return null;
  const sentinelRaw = pick('sentinel', 'sentinelString', 'sentinel_string');
  const sentinel = typeof sentinelRaw === 'string' ? sentinelRaw.trim() : '';
  if (sentinel.length < 8) return null;

  const sourceRaw = typeof r.source === 'string' ? r.source.toLowerCase().replace(/[\s-]+/g, '_') : '';
  const source: CandidateReproSource = (KNOWN_SOURCES as readonly string[]).includes(sourceRaw)
    ? (sourceRaw as CandidateReproSource)
    : 'direct_call';

  // Allow imports to be either an array of strings (canonical) OR an array
  // of {module, names?} objects (a common LLM emission shape). Coerce
  // objects to `from <module> import <names...>` / `import <module>`.
  const importsRawValue = pick('imports', 'exerciseImports', 'exercise_imports');
  const imports = Array.isArray(importsRawValue)
    ? importsRawValue
        .map((x): string | null => {
          if (typeof x === 'string') return x.trim() || null;
          if (x && typeof x === 'object') {
            const xx = x as Record<string, unknown>;
            const mod = typeof xx.module === 'string' ? xx.module.trim() : '';
            if (!mod) return null;
            const names = Array.isArray(xx.names)
              ? xx.names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim())
              : [];
            return names.length > 0 ? `from ${mod} import ${names.join(', ')}` : `import ${mod}`;
          }
          return null;
        })
        .filter((s): s is string => !!s)
        .slice(0, CANDIDATE_REPRO_IMPORTS_MAX)
    : [];

  const setupRaw = pick('setup', 'setupCode', 'setup_code');
  const setup = typeof setupRaw === 'string' ? setupRaw : '';

  const pipInstallsRaw = pick('pipInstalls', 'pip_installs');
  const pipInstalls: ReproRecipePipInstall[] = Array.isArray(pipInstallsRaw)
    ? pipInstallsRaw
        .map((p): ReproRecipePipInstall | null => {
          if (!p || typeof p !== 'object') return null;
          const pp = p as Record<string, unknown>;
          const pkg = typeof pp.package === 'string' ? pp.package.trim() : '';
          if (!pkg) return null;
          // Defensive: reject specs that bake in `-e` — the recipe layer
          // adds that flag itself when editable===true, so a package
          // string of "-e python/foo" with editable===true would render
          // "pip install -e -e python/foo".
          if (/^\s*-e\s/.test(pkg)) return null;
          return { package: pkg, editable: pp.editable === true };
        })
        .filter((p): p is ReproRecipePipInstall => p !== null)
    : [];

  const requiresCredentialsRaw = pick('requiresCredentials', 'requires_credentials');
  const requiresCredentials = Array.isArray(requiresCredentialsRaw)
    ? requiresCredentialsRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  const preconditionsSatisfiedRaw = pick('preconditionsSatisfied', 'preconditions_satisfied');
  const preconditionsSatisfied = Array.isArray(preconditionsSatisfiedRaw)
    ? preconditionsSatisfiedRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];

  const expectedExceptionTypeRaw = pick('expectedExceptionType', 'expected_exception_type', 'expectedException');
  let expectedExceptionType =
    typeof expectedExceptionTypeRaw === 'string' && expectedExceptionTypeRaw.trim()
      ? expectedExceptionTypeRaw.trim().slice(0, 80)
      : undefined;
  // Treat literal "None" / "null" / "no exception" as absent — the
  // unexpected_exception template requires a real exception class name.
  if (expectedExceptionType && /^(none|null|no\s*exception|n\/a)$/i.test(expectedExceptionType)) {
    expectedExceptionType = undefined;
  }
  const expectedValueExpressionRaw = pick(
    'expectedValueExpression',
    'expected_value_expression',
    'expectedReturnRepr',
    'expected_return_repr',
    'expectedReturn'
  );
  const expectedValueExpression =
    typeof expectedValueExpressionRaw === 'string' && expectedValueExpressionRaw.trim()
      ? expectedValueExpressionRaw.trim().slice(0, CANDIDATE_REPRO_EXPECTED_VALUE_MAX_LEN)
      : undefined;
  const expectedFailureSignature =
    typeof r.expectedFailureSignature === 'string' && r.expectedFailureSignature.trim()
      ? r.expectedFailureSignature.trim().slice(0, CANDIDATE_REPRO_SIGNATURE_MAX_LEN)
      : undefined;

  const rationale = typeof r.rationale === 'string' ? r.rationale.slice(0, CANDIDATE_REPRO_RATIONALE_MAX_LEN) : '';

  // Surface contract: wrong_return REQUIRES expectedValueExpression — the
  // template can't render without it. unexpected_exception REQUIRES
  // expectedExceptionType — the template asserts that exception type is
  // raised; without it we can't render.
  if (failureMode === 'wrong_return' && !expectedValueExpression) return null;
  if (failureMode === 'unexpected_exception' && !expectedExceptionType) return null;

  return {
    version: 1,
    source,
    failureMode: failureMode as CandidateReproFailureMode,
    ...(expectedExceptionType ? { expectedExceptionType } : {}),
    ...(expectedValueExpression ? { expectedValueExpression } : {}),
    candidateTestPath,
    imports,
    setup,
    exerciseCall,
    sentinel,
    ...(expectedFailureSignature ? { expectedFailureSignature } : {}),
    pipInstalls,
    requiresCredentials,
    preconditionsSatisfied,
    rationale,
  };
}

/** Output of a render attempt. */
export type RenderTestSourceResult =
  | { ok: true; source: string }
  | { ok: false; reason: 'failure_mode_unsupported' | 'too_large' | 'sentinel_unsafe' | 'exercise_empty' };

/**
 * Deterministic Python test renderer keyed on failureMode. Produces a
 * single `def test_repro():` body that either passes when the bug is
 * fixed or fails with an AssertionError carrying the sentinel.
 *
 * Design notes:
 *  - For `unexpected_exception`, the exerciseCall is wrapped in
 *    `try/except Exception as exc`. The except branch raises an
 *    AssertionError with the sentinel; the else branch raises an
 *    AssertionError saying "expected exception, none raised". Either way
 *    the sentinel ends up in pytest's stderr when the test fails.
 *  - For `wrong_return`, the exerciseCall is assigned to `_actual` and
 *    asserted equal to expectedValueExpression with the sentinel in the
 *    message.
 *  - Bare `assert False, "<sentinel>"` is NOT emitted — the existing
 *    `reproAstPreflight` would reject it AND for exception bugs the
 *    exerciseCall would raise before the assertion executed.
 */
export function renderTestSource(candidate: CandidateRepro): RenderTestSourceResult {
  if (!candidate.exerciseCall || !candidate.exerciseCall.trim()) {
    return { ok: false, reason: 'exercise_empty' };
  }
  // Sentinels are inlined into a Python string literal. Reject quotes and
  // newlines defensively; they would break the rendered source.
  if (/["'\n\r\\]/.test(candidate.sentinel ?? "")) {
    return { ok: false, reason: 'sentinel_unsafe' };
  }

  const importsBlock = candidate.imports.length === 0
    ? '# (no imports)'
    : candidate.imports.map((s) => s).join('\n');

  const setupBlock = candidate.setup.trim().length === 0
    ? '    pass  # (no setup)'
    : candidate.setup
        .split(/\r?\n/)
        .map((line) => (line.length === 0 ? '' : `    ${line}`))
        .join('\n');

  let source: string;
  if (candidate.failureMode === 'unexpected_exception') {
    const expected = candidate.expectedExceptionType?.trim() || 'an exception';
    source = [
      `# Auto-generated by Deterministic Repro Builder. Do not edit.`,
      importsBlock,
      ``,
      ``,
      `def test_repro():`,
      setupBlock,
      `    try:`,
      `        ${candidate.exerciseCall}`,
      `    except Exception as exc:`,
      `        assert False, "${candidate.sentinel}: " + type(exc).__name__ + ": " + str(exc)`,
      `    else:`,
      `        assert False, "${candidate.sentinel}: expected ${expected} but no exception raised"`,
      ``,
    ].join('\n');
  } else if (candidate.failureMode === 'wrong_return') {
    const expected = candidate.expectedValueExpression!;
    source = [
      `# Auto-generated by Deterministic Repro Builder. Do not edit.`,
      importsBlock,
      ``,
      ``,
      `def test_repro():`,
      setupBlock,
      `    _actual = ${candidate.exerciseCall}`,
      `    _expected = ${expected}`,
      `    assert _actual == _expected, "${candidate.sentinel}: expected " + repr(_expected) + " got " + repr(_actual)`,
      ``,
    ].join('\n');
  } else {
    return { ok: false, reason: 'failure_mode_unsupported' };
  }

  // Bounded — match REPRO_RECIPE_TEST_SOURCE_MAX. Importing the constant
  // would create a circular dep with dossier.ts (which imports from here
  // in a future refactor), so we duplicate the cap.
  if (source.length > 4096) return { ok: false, reason: 'too_large' };
  return { ok: true, source };
}

/**
 * Validate a single Python import statement by exact-string matching
 * permissible patterns. Used BEFORE running ast.parse in the sandbox to
 * give a fast, dependency-free first pass. The Builder then re-validates
 * with `ast.parse` in the sandbox for full safety.
 *
 * Accepts:
 *   import x[.y][ as z]
 *   from x[.y] import a[, b[, c]][ as q]
 *   from x[.y] import (a, b, c)         # trailing-comma tolerated
 *
 * Rejects anything containing `;` (statement chaining), backticks,
 * comments, or characters outside the safe set.
 */
export function looksLikeSafeImport(stmt: string): boolean {
  const s = stmt.trim();
  if (!s) return false;
  if (s.length > CANDIDATE_REPRO_IMPORT_MAX_LEN) return false;
  if (/[;`#]/.test(s)) return false;
  if (/[\r\n]/.test(s)) return false;
  // Allow only [A-Za-z0-9_. ,()] and the literal words `from`, `import`, `as`.
  if (!/^[A-Za-z0-9_.,()\s]+$/.test(s)) return false;
  // Must start with `from ` or `import `.
  if (!/^(from\s+[A-Za-z_][\w.]*\s+import\s+|import\s+)/.test(s)) return false;
  return true;
}

/**
 * Render an inline Python snippet that re-validates the supplied list of
 * imports via `ast.parse` and asserts each top-level node is a single
 * Import / ImportFrom statement. Returned snippet is meant to be run via
 * sandbox.runPython — a non-zero exit means an import was unsafe or
 * malformed.
 */
export function buildImportSafetyProbe(imports: string[]): string {
  const arrLiteral = JSON.stringify(imports);
  return [
    `import ast, json, sys`,
    `imports = json.loads(${JSON.stringify(arrLiteral)})`,
    `for stmt in imports:`,
    `    tree = ast.parse(stmt)`,
    `    if len(tree.body) != 1:`,
    `        print("BUILDER_IMPORT_UNSAFE: " + stmt, file=sys.stderr)`,
    `        sys.exit(2)`,
    `    node = tree.body[0]`,
    `    if not isinstance(node, (ast.Import, ast.ImportFrom)):`,
    `        print("BUILDER_IMPORT_UNSAFE: " + stmt, file=sys.stderr)`,
    `        sys.exit(2)`,
    `print("BUILDER_IMPORT_OK")`,
  ].join('\n');
}
