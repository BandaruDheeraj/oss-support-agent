/**
 * Deterministic Repro Builder.
 *
 * Replaces the LLM Prober when the Analyst supplies a structured
 * `candidateRepro` block. The Builder:
 *
 *   1. validates the candidate against the dossier (preconditions exist,
 *      suspect symbols referenced, path under testRoots).
 *   2. installs declared pip packages; ANY failure → reject.
 *   3. validates each import statement is a single ast.Import/ast.ImportFrom
 *      via `sandbox.runPython('ast.parse(...)')`; smuggled side effects
 *      reject.
 *   4. renders test source from the failureMode-keyed template
 *      (try/except sentinel for unexpected_exception; equality assertion
 *      for wrong_return).
 *   5. runs the orchestrator's `reproAstPreflight` on the rendered source.
 *   6. writes the test (path-scoped through ensureTestRootScoped).
 *   7. setReproTestPath + runRepro() twice; if disagreement, tiebreak with
 *      a third run.
 *   8. on success, emits a fully-formed `ReproRecipe` (with
 *      provenance.synthesizedBy === 'builder') that the existing executor
 *      can re-apply.
 *   9. on any rejection AFTER writeTest, calls `workspace.revertFile` so
 *      the Prober fallback inherits a clean tree.
 *
 * NO LLM tool loops. The Builder uses the sandbox + workspace handles
 * exactly the same way the deterministic Executor does — this means once
 * the recipe is emitted, the Executor's re-application is logically a
 * no-op (idempotent pip + same writeTest + same runRepro semantics).
 */

import type {
  CandidateRepro,
  DossierSnapshot,
  ReproRecipe,
  ReproRecipePipInstall,
} from '../analyst/dossier';
import {
  REPRO_RECIPE_OBSERVED_TAIL_MAX,
  REPRO_RECIPE_TEST_SOURCE_MAX,
} from '../analyst/dossier';
import {
  renderTestSource,
  looksLikeSafeImport,
  buildImportSafetyProbe,
} from '../analyst/candidate-repro';
import type {
  RepoHandle,
  SandboxHandle,
  SandboxRun,
  WorkspaceReader,
  WorkspaceWriter,
} from '../tools/handles';
import { ensureTestRootScoped } from '../tools/write-test';
import { reproAstPreflight } from './executor';

const STDOUT_TAIL = REPRO_RECIPE_OBSERVED_TAIL_MAX;
const STDERR_TAIL = REPRO_RECIPE_OBSERVED_TAIL_MAX;

/** Granular reject stages — every reject path gets its own histogram bucket. */
export type BuilderRejectStage =
  | 'no_candidate'
  | 'schema_invalid'
  | 'path_invalid'
  | 'precondition_unknown'
  | 'symbol_not_referenced'
  | 'pip_install_failed'
  | 'import_unsafe_static'
  | 'import_ast_parse_failed'
  | 'test_source_render_failed'
  | 'test_source_syntax_invalid'
  | 'ast_preflight_failed'
  | 'write_test_failed'
  | 'sandbox_error'
  | 'run_repro_pass'
  | 'run_repro_timeout'
  | 'sentinel_absent'
  | 'run_repro_flaky';

export interface BuilderRunObservation {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  sentinelObserved: boolean;
  signatureObserved: boolean;
}

export interface ReproBuilderArgs {
  attemptId: string;
  dossierSnapshot: DossierSnapshot;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
  /** Optional. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface ReproBuilderResult {
  ok: boolean;
  recipe?: ReproRecipe;
  /** Granular reject signal. Always present when ok===false. */
  rejectStage?: BuilderRejectStage;
  /** Human-readable detail. */
  reason: string;
  /** Per-run observations (Builder ran 2-3 sandbox runs). */
  runs: BuilderRunObservation[];
  /** When set, candidate test path that was written; revertFile called on reject. */
  candidateTestPath?: string;
  /** When set on credentials_required-like rejections, env var names. */
  missingCredentials?: string[];
  /** When set, pip install spec that failed. */
  pipInstallFailure?: { spec: string; exitCode: number; stderrTail: string };
}

/** Build a single recipe from a candidate. No retries. */
export async function runReproBuilder(args: ReproBuilderArgs): Promise<ReproBuilderResult> {
  const candidate = args.dossierSnapshot.body.candidateRepro;
  if (!candidate) {
    return rej('no_candidate', 'Dossier carries no candidateRepro; Builder bypassed.');
  }

  // (Pre-pip) — short-circuit on missing required credentials.
  const env = args.env ?? process.env;
  const missing = (candidate.requiresCredentials ?? []).filter(
    (n) => !env[n] || env[n]?.length === 0
  );
  if (missing.length > 0) {
    return {
      ok: false,
      rejectStage: 'sandbox_error',
      reason: `Required credentials not set: ${missing.join(', ')}`,
      runs: [],
      missingCredentials: missing,
    };
  }

  // ---------------------------------------------------------------
  // (1) Validate against dossier (cheap, do BEFORE installs)
  // ---------------------------------------------------------------

  const knownPreconditionIds = new Set<string>();
  const preconditionConditionToId = new Map<string, string>();
  for (const precondition of args.dossierSnapshot.body.preconditions) {
    knownPreconditionIds.add(precondition.id);
    preconditionConditionToId.set(precondition.condition, precondition.id);
  }
  const resolvedPreconditionsSatisfied: string[] = [];
  for (const idOrCondition of candidate.preconditionsSatisfied) {
    const resolved = knownPreconditionIds.has(idOrCondition)
      ? idOrCondition
      : preconditionConditionToId.get(idOrCondition);
    if (!resolved) {
      return rej(
        'precondition_unknown',
        `preconditionsSatisfied references unknown id or condition "${idOrCondition}". Known ids: ${Array.from(knownPreconditionIds).join(', ') || '(none)'}.`
      );
    }
    if (!resolvedPreconditionsSatisfied.includes(resolved)) {
      resolvedPreconditionsSatisfied.push(resolved);
    }
  }

  // exerciseCall must reference at least one suspect symbol — keeps the
  // Builder honest (no Builder-authored tests that exercise unrelated code).
  // Vacuously true when the dossier has no suspect symbols.
  const suspectSymbols = args.dossierSnapshot.body.suspectSymbols.map((s) => s.symbol);
  if (suspectSymbols.length > 0) {
    const referencesOne = suspectSymbols.some((sym) =>
      new RegExp(`\\b${escapeRegExp(sym)}\\b`).test(`${candidate.setup}\n${candidate.exerciseCall}`)
    );
    if (!referencesOne) {
      return rej(
        'symbol_not_referenced',
        `setup+exerciseCall references none of the dossier's suspect symbols: ${suspectSymbols.join(', ')}.`
      );
    }
  }

  // Path scope.
  try {
    ensureTestRootScoped(
      candidate.candidateTestPath,
      args.workspace.testRoots(),
      'candidateRepro.candidateTestPath'
    );
  } catch (err) {
    return rej('path_invalid', err instanceof Error ? err.message : String(err));
  }

  // Static import shape (fast, no sandbox round-trip).
  for (const imp of candidate.imports) {
    if (!looksLikeSafeImport(imp)) {
      return rej('import_unsafe_static', `Import statement failed static safety check: ${JSON.stringify(imp)}`);
    }
  }

  // ---------------------------------------------------------------
  // (2) pip installs (any failure → reject)
  // ---------------------------------------------------------------

  for (const inst of candidate.pipInstalls) {
    const spec = renderPipSpec(inst);
    const run = await safeSandbox(args.sandbox.pipInstall(spec));
    if (!run.ok) {
      return rej('sandbox_error', `pip install threw: ${run.error}`);
    }
    if (run.value.exitCode !== 0) {
      return {
        ok: false,
        rejectStage: 'pip_install_failed',
        reason: `pip install failed for ${spec} (exit ${run.value.exitCode})`,
        runs: [],
        pipInstallFailure: {
          spec,
          exitCode: run.value.exitCode,
          stderrTail: tail(run.value.stderr, STDERR_TAIL),
        },
      };
    }
  }

  // ---------------------------------------------------------------
  // (3) Probe import safety via ast.parse in the sandbox
  // ---------------------------------------------------------------

  if (candidate.imports.length > 0) {
    const probe = buildImportSafetyProbe(candidate.imports);
    const probeRun = await safeSandbox(args.sandbox.runPython(probe));
    if (!probeRun.ok) {
      return rej('sandbox_error', `runPython(import probe) threw: ${probeRun.error}`);
    }
    if (probeRun.value.exitCode !== 0) {
      return rej(
        'import_ast_parse_failed',
        `Import safety probe failed (exit ${probeRun.value.exitCode}): ${tail(probeRun.value.stderr, 400)}`
      );
    }
  }

  // Probe that the imports themselves actually resolve at runtime (catches
  // missing transitive deps that pip didn't surface).
  if (candidate.imports.length > 0) {
    const importExecutable = candidate.imports.join('\n');
    const exec = await safeSandbox(args.sandbox.runPython(importExecutable));
    if (!exec.ok) {
      return rej('sandbox_error', `runPython(imports) threw: ${exec.error}`);
    }
    if (exec.value.exitCode !== 0) {
      return rej(
        'import_ast_parse_failed',
        `Imports execute non-zero (exit ${exec.value.exitCode}): ${tail(exec.value.stderr, 400)}`
      );
    }
  }

  // ---------------------------------------------------------------
  // (4) Render the test source
  // ---------------------------------------------------------------

  const render = renderTestSource(candidate);
  if (!render.ok) {
    return rej('test_source_render_failed', `Template render rejected: ${render.reason}`);
  }
  const source = render.source;
  if (source.length > REPRO_RECIPE_TEST_SOURCE_MAX) {
    return rej('test_source_render_failed', `Rendered source exceeded cap (${source.length} > ${REPRO_RECIPE_TEST_SOURCE_MAX}).`);
  }

  // ---------------------------------------------------------------
  // (5) AST parse the rendered source (full Python syntax check)
  // ---------------------------------------------------------------

  const astParse = await safeSandbox(
    args.sandbox.runPython(`import ast, sys; ast.parse(${JSON.stringify(source)}); print("OK")`)
  );
  if (!astParse.ok) {
    return rej('sandbox_error', `ast.parse probe threw: ${astParse.error}`);
  }
  if (astParse.value.exitCode !== 0) {
    return rej(
      'test_source_syntax_invalid',
      `Rendered source failed ast.parse: ${tail(astParse.value.stderr, 400)}`
    );
  }

  // ---------------------------------------------------------------
  // (6) Run the orchestrator's reproAstPreflight (referential alignment
  // with the post-Executor check — Builder never emits a recipe that the
  // orchestrator would reject downstream).
  // ---------------------------------------------------------------

  const suspectFiles = args.dossierSnapshot.body.suspectSymbols.map((s) => s.file);
  const pre = reproAstPreflight(args.repo.language, source, suspectFiles, suspectSymbols);
  if (!pre.ok) {
    return rej('ast_preflight_failed', `reproAstPreflight rejected rendered source: ${pre.reason ?? '(no reason)'}`);
  }

  // ---------------------------------------------------------------
  // (7) Write the candidate test
  // ---------------------------------------------------------------

  try {
    await args.workspace.writeTest(candidate.candidateTestPath, source);
  } catch (err) {
    return rej(
      'write_test_failed',
      `workspace.writeTest threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Any rejection from here on must revert the file.
  const candidateTestPath = candidate.candidateTestPath;

  // ---------------------------------------------------------------
  // (8) Run repro × 2; tiebreak on disagreement
  // ---------------------------------------------------------------

  args.sandbox.setReproTestPath(candidateTestPath);

  const runs: BuilderRunObservation[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await safeSandbox(args.sandbox.runRepro());
    if (!r.ok) {
      await safeRevert(args.workspace, candidateTestPath);
      return {
        ok: false,
        rejectStage: 'sandbox_error',
        reason: `runRepro #${i + 1} threw: ${r.error}`,
        runs,
        candidateTestPath,
      };
    }
    runs.push(
      observe(r.value, candidate.sentinel, candidate.expectedFailureSignature ?? '')
    );
  }

  // Tiebreak on disagreement.
  const agree = (a: BuilderRunObservation, b: BuilderRunObservation) =>
    (a.exitCode === 0) === (b.exitCode === 0) &&
    a.sentinelObserved === b.sentinelObserved;

  if (!agree(runs[0], runs[1])) {
    const tie = await safeSandbox(args.sandbox.runRepro());
    if (!tie.ok) {
      await safeRevert(args.workspace, candidateTestPath);
      return {
        ok: false,
        rejectStage: 'sandbox_error',
        reason: `runRepro tiebreak threw: ${tie.error}`,
        runs,
        candidateTestPath,
      };
    }
    runs.push(observe(tie.value, candidate.sentinel, candidate.expectedFailureSignature ?? ''));
  }

  // ---------------------------------------------------------------
  // (9) Verdict
  // ---------------------------------------------------------------

  const failingWithSentinel = runs.filter(
    (r) => r.exitCode !== 0 && r.sentinelObserved
  ).length;
  const allPassed = runs.every((r) => r.exitCode === 0);
  const allFailedNoSentinel = runs.every((r) => r.exitCode !== 0 && !r.sentinelObserved);

  if (allPassed) {
    await safeRevert(args.workspace, candidateTestPath);
    return {
      ok: false,
      rejectStage: 'run_repro_pass',
      reason: 'Candidate test passed on every run; bug not triggered.',
      runs,
      candidateTestPath,
    };
  }

  if (failingWithSentinel < 2) {
    if (allFailedNoSentinel) {
      await safeRevert(args.workspace, candidateTestPath);
      return {
        ok: false,
        rejectStage: 'sentinel_absent',
        reason: 'Runs failed but sentinel was absent from stdout+stderr; likely a pre-existing failure unrelated to the bug.',
        runs,
        candidateTestPath,
      };
    }
    await safeRevert(args.workspace, candidateTestPath);
    return {
      ok: false,
      rejectStage: 'run_repro_flaky',
      reason: `Runs disagreed: ${runs.map((r) => `${r.exitCode}/${r.sentinelObserved ? 'S' : '_'}`).join('|')}`,
      runs,
      candidateTestPath,
    };
  }

  // ---------------------------------------------------------------
  // (10) Build the recipe
  // ---------------------------------------------------------------

  const lastFailing =
    runs.filter((r) => r.exitCode !== 0 && r.sentinelObserved).slice(-1)[0] ?? runs[runs.length - 1];

  const recipe: ReproRecipe = {
    version: 1,
    candidateTestPath,
    testSource: source,
    sentinelString: candidate.sentinel,
    ...(candidate.expectedFailureSignature
      ? { expectedFailureSignature: candidate.expectedFailureSignature }
      : {}),
    pipInstalls: candidate.pipInstalls,
    requiresCredentials: candidate.requiresCredentials,
    verbatimSnippetIncompatible: false,
    approach: `builder:${candidate.failureMode}:${candidate.source}`,
    provenance: {
      exerciseImports: candidate.imports,
      preconditionsSatisfied: resolvedPreconditionsSatisfied,
      observedProbe: {
        sentinelObserved: lastFailing.sentinelObserved,
        signatureObserved: lastFailing.signatureObserved,
        exitCode: lastFailing.exitCode,
        durationMs: lastFailing.durationMs,
        stderrTail: lastFailing.stderrTail,
        stdoutTail: lastFailing.stdoutTail,
      },
      proberAttempts: 0,
      recordedAt: new Date().toISOString(),
    },
  };

  // eslint-disable-next-line no-console
  console.log(
    `[v2-builder] attempt=${args.attemptId} ok=true ranRepro=${runs.length}` +
      ` failingWithSentinel=${failingWithSentinel} failureMode=${candidate.failureMode}` +
      ` source=${candidate.source} pipInstalls=${candidate.pipInstalls.length}`
  );

  return {
    ok: true,
    recipe,
    reason: 'Builder produced a recipe; runs reproduced reliably with sentinel.',
    runs,
    candidateTestPath,
  };
}

function rej(stage: BuilderRejectStage, reason: string): ReproBuilderResult {
  // eslint-disable-next-line no-console
  console.log(`[v2-builder] reject stage=${stage} reason=${JSON.stringify(reason).slice(0, 240)}`);
  return { ok: false, rejectStage: stage, reason, runs: [] };
}

function observe(run: SandboxRun, sentinel: string, signature: string): BuilderRunObservation {
  const combined = `${run.stderr}\n${run.stdout}`;
  return {
    exitCode: run.exitCode,
    stdoutTail: tail(run.stdout, STDOUT_TAIL),
    stderrTail: tail(run.stderr, STDERR_TAIL),
    durationMs: run.durationMs,
    sentinelObserved: sentinel.length > 0 && combined.includes(sentinel),
    signatureObserved: signature.length > 0 && combined.includes(signature),
  };
}

function tail(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(-n);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderPipSpec(inst: ReproRecipePipInstall): string {
  return inst.editable ? `-e ${inst.package}` : inst.package;
}

type SandboxOutcome<T> = { ok: true; value: T } | { ok: false; error: string };
async function safeSandbox<T>(p: Promise<T>): Promise<SandboxOutcome<T>> {
  try {
    const value = await p;
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function safeRevert(ws: WorkspaceWriter, path: string): Promise<void> {
  try {
    await ws.revertFile(path);
  } catch {
    // best effort — failure to revert is logged but never fails the Builder
    // result (the Prober fallback will overwrite anyway).
  }
}
