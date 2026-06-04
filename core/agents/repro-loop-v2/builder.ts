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
  type ReproFilesCandidate,
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
  | 'run_repro_flaky'
  | 'expected_output_absent';

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
  // Support both candidateRepro (legacy) and reproFiles (new integration-test schema).
  // If reproFiles is present in the dossier, synthesize a minimal candidateRepro from it
  // so the rest of the Builder pipeline can proceed unchanged.
  const rawReproFiles = (args.dossierSnapshot.body as any).reproFiles;
  let candidate = args.dossierSnapshot.body.candidateRepro;
  if (!candidate && rawReproFiles) {
    // Promote reproFiles to candidateRepro shape understood by the testSource path
    candidate = {
      version: 1 as const,
      source: 'direct_call' as const,
      failureMode: 'wrong_return' as const,
      testSource: rawReproFiles.reproFiles?.[0]?.content ?? '',
      candidateTestPath: rawReproFiles.testEntryPoint?.split('::')[0] ?? 'tests/repro/test_repro.py',
      imports: [],
      setup: '',
      pipInstalls: rawReproFiles.installSpec?.additionalPackages?.map((p: string) => ({ package: p, editable: false })) ?? [],
      requiresCredentials: [],
      preconditionsSatisfied: [],
      rationale: rawReproFiles.rationale ?? '',
      reproFiles: rawReproFiles.reproFiles,
      testEntryPoint: rawReproFiles.testEntryPoint,
      installSpec: rawReproFiles.installSpec,
      expectedFailureOutput: rawReproFiles.expectedFailureOutput,
    } as any;
  }
  if (!candidate) {
    return rej('no_candidate', 'Dossier carries no candidateRepro or reproFiles; Builder bypassed.');
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

  // When the analyst wrote the full test source, skip template validation
  // checks that only apply to the exerciseCall/sentinel schema path.
  const isTestSourcePath = !!candidate.testSource;

  const isReproFilesPath = !!(candidate as any).reproFiles && Array.isArray((candidate as any).reproFiles) && (candidate as any).reproFiles.length > 0;

  // exerciseCall must reference at least one suspect symbol — keeps the
  // Builder honest (no Builder-authored tests that exercise unrelated code).
  // Skip for testSource path: the analyst wrote the full test and is
  // responsible for relevance.
  const suspectSymbols = args.dossierSnapshot.body.suspectSymbols.map((s) => s.symbol);
  if (!isTestSourcePath && suspectSymbols.length > 0) {
    const referencesOne = suspectSymbols.some((sym) =>
      new RegExp(`\\b${escapeRegExp(sym)}\\b`).test(`${candidate.setup ?? ''}\n${candidate.exerciseCall ?? ''}`)
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

  // Static import shape check — only for template path (testSource path has
  // no separate imports array; safety checked via ast.parse of the full source).
  if (!isTestSourcePath) {
    for (const imp of candidate.imports) {
      if (!looksLikeSafeImport(imp)) {
        return rej('import_unsafe_static', `Import statement failed static safety check: ${JSON.stringify(imp)}`);
      }
    }
  }

  // ---------------------------------------------------------------
  // (reproFiles path) Multi-file repro — short-circuits before the
  // existing pip / import / template pipeline when candidate carries a
  // reproFilesCandidate block. The existing paths below remain 100%
  // unchanged and are only reached when reproFilesCandidate is absent.
  // ---------------------------------------------------------------

  if (candidate.reproFilesCandidate) {
    return runReproFilesPath(args, candidate.reproFilesCandidate, candidate, resolvedPreconditionsSatisfied);
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
  // (3) Import validation — skipped for testSource path
  // ---------------------------------------------------------------

  if (!isTestSourcePath) {
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
  }

  // ---------------------------------------------------------------
  // (4) Get test source — written by analyst OR rendered from template
  // ---------------------------------------------------------------

  let source: string;
  if (isTestSourcePath) {
    source = candidate.testSource!;
    // Reject testSource that has no assertion — a test that only prints
    // "BUG CONFIRMED" will exit 0 even when the bug is present, making
    // the pipeline blind to the failure.
    const hasAssertion = /\bassert\b/.test(source) || /\braise\b/.test(source) || /\bpytest\.raises\b/.test(source);
    if (!hasAssertion) {
      return rej(
        'test_source_render_failed',
        'testSource has no assert/raise statement. A test that only prints results exits 0 even when the bug is present — use assert or raise AssertionError to make the test fail when the bug fires.'
      );
    }
    if (source.length > REPRO_RECIPE_TEST_SOURCE_MAX) {
      return rej('test_source_render_failed', `testSource exceeded cap (${source.length} > ${REPRO_RECIPE_TEST_SOURCE_MAX}).`);
    }
  } else if (isReproFilesPath) {
    // For reproFiles, run the test INLINE via sandbox.runPython() rather than
    // writing files to the workspace. This avoids the git commit/push cycle:
    // workspace.writeTest() only writes locally — for GHA sandboxes, the file
    // would need to be committed and pushed before the sandbox clones the branch,
    // which doesn't happen between writeTest and dispatch. Running inline is simpler.
    const rf = (candidate as any).reproFiles as Array<{path: string, content: string}>;
    const testFile = rf.find(f => !f.path.endsWith('.yaml') && !f.path.endsWith('.yml'));
    source = testFile ? testFile.content : rf[0].content;
    // Synthesize a fake candidateTestPath so downstream steps have something to revert
    const testEntryPoint = (candidate as any).testEntryPoint;
    if (testEntryPoint && typeof testEntryPoint === 'string') {
      (candidate as any).candidateTestPath = testEntryPoint.split('::')[0];
    } else {
      (candidate as any).candidateTestPath = 'tests/repro/test_inline.py';
    }
    // Run the test inline — skip AST parse and template rendering steps below,
    // go directly to executing the source via runPython.
    const inlineResult = await safeSandbox(args.sandbox.runPython(source));
    if (!inlineResult.ok) {
      return rej('sandbox_error', `runPython(reproFiles inline test) threw: ${inlineResult.error}`);
    }
    const exitCode = inlineResult.value.exitCode ?? 0;
    const allOutput = inlineResult.value.stdout + inlineResult.value.stderr;
    const expectedOut = (candidate as any).expectedFailureOutput;
    const run1: BuilderRunObservation = {
      exitCode,
      sentinelObserved: expectedOut ? allOutput.includes(expectedOut) : exitCode !== 0,
      signatureObserved: false,
      stdoutTail: tail(inlineResult.value.stdout, STDERR_TAIL),
      stderrTail: tail(inlineResult.value.stderr, STDERR_TAIL),
      durationMs: 0,
    };
    // Run twice (required for verdict)
    const inlineResult2 = await safeSandbox(args.sandbox.runPython(source));
    const exitCode2 = inlineResult2.ok ? (inlineResult2.value.exitCode ?? 0) : 1;
    const allOutput2 = inlineResult2.ok ? inlineResult2.value.stdout + inlineResult2.value.stderr : '';
    const run2: BuilderRunObservation = {
      exitCode: exitCode2,
      sentinelObserved: expectedOut ? allOutput2.includes(expectedOut) : exitCode2 !== 0,
      signatureObserved: false,
      stdoutTail: inlineResult2.ok ? tail(inlineResult2.value.stdout, STDERR_TAIL) : '',
      stderrTail: inlineResult2.ok ? tail(inlineResult2.value.stderr, STDERR_TAIL) : '',
      durationMs: 0,
    };
    const runs = [run1, run2];
    const failingAny = runs.filter(r => r.exitCode !== 0).length;
    const allPassed = runs.every(r => r.exitCode === 0);
    if (allPassed) {
      return rej('run_repro_pass', 'Inline reproFiles test passed on every run; bug not triggered.');
    }
    if (failingAny < 2) {
      return rej('run_repro_flaky', `Inline reproFiles runs disagreed: ${runs.map(r => r.exitCode).join('/')}`);
    }
    // Bug confirmed — build recipe with inline source
    const candidateTestPath = (candidate as any).candidateTestPath ?? 'tests/repro/test_inline.py';
    const recipe: ReproRecipe = {
      version: 1,
      candidateTestPath,
      testSource: source,
      sentinelString: '',
      pipInstalls: candidate.pipInstalls ?? [],
      requiresCredentials: candidate.requiresCredentials ?? [],
      verbatimSnippetIncompatible: false,
      approach: 'builder:repro_files:inline',
      provenance: {
        exerciseImports: [],
        preconditionsSatisfied: [],
        observedProbe: {
          sentinelObserved: false,
          signatureObserved: false,
          exitCode: run1.exitCode,
          durationMs: 0,
          stderrTail: run1.stderrTail,
          stdoutTail: run1.stdoutTail,
        },
        proberAttempts: 0,
        recordedAt: new Date().toISOString(),
      },
    };
    return { ok: true, reason: '', recipe, runs, rejectStage: undefined, candidateTestPath };
  } else {
    const render = renderTestSource(candidate);
    if (!render.ok) {
      return rej('test_source_render_failed', `Template render rejected: ${render.reason}`);
    }
    source = render.source;
    if (source.length > REPRO_RECIPE_TEST_SOURCE_MAX) {
      return rej('test_source_render_failed', `Rendered source exceeded cap (${source.length} > ${REPRO_RECIPE_TEST_SOURCE_MAX}).`);
    }
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
      observe(r.value, candidate.sentinel ?? "", candidate.expectedFailureSignature ?? '')
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
    runs.push(observe(tie.value, candidate.sentinel ?? "", candidate.expectedFailureSignature ?? ''));
  }

  // ---------------------------------------------------------------
  // (9) Verdict
  // ---------------------------------------------------------------

  const failingWithSentinel = runs.filter(
    (r) => r.exitCode !== 0 && r.sentinelObserved
  ).length;
  const failingAny = runs.filter((r) => r.exitCode !== 0).length;
  const allPassed = runs.every((r) => r.exitCode === 0);
  const allFailedNoSentinel = runs.every((r) => r.exitCode !== 0 && !r.sentinelObserved);

  // For the testSource path the analyst wrote the full test; we don't require
  // a sentinel string in the output — exit-code alone confirms the bug fires.
  const hasSentinel = !!candidate.sentinel;
  const verdictOk = hasSentinel ? failingWithSentinel >= 2 : failingAny >= 2;

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

  if (!verdictOk) {
    if (hasSentinel && allFailedNoSentinel) {
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

  const expectedOut = (candidate as any).expectedFailureOutput;
  if (expectedOut && typeof expectedOut === 'string') {
    const allOutput = runs.map(r => (r as any).stdout + (r as any).stderr).join('\n');
    if (!allOutput.includes(expectedOut)) {
      await safeRevert(args.workspace, candidateTestPath);
      return rej('sentinel_absent', 'expectedFailureOutput "' + expectedOut + '" not found — likely unrelated failure');
    }
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
    sentinelString: candidate.sentinel ?? '',
    ...(candidate.expectedFailureSignature
      ? { expectedFailureSignature: candidate.expectedFailureSignature }
      : {}),
    pipInstalls: candidate.pipInstalls,
    requiresCredentials: candidate.requiresCredentials,
    verbatimSnippetIncompatible: false,
    approach: isTestSourcePath
      ? `builder:test_source:${candidate.source}`
      : `builder:${candidate.failureMode}:${candidate.source}`,
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

// ---------------------------------------------------------------------------
// reproFiles path — multi-file repro execution
// ---------------------------------------------------------------------------

async function runReproFilesPath(
  args: ReproBuilderArgs,
  reproFilesCandidate: ReproFilesCandidate,
  candidate: CandidateRepro,
  resolvedPreconditionsSatisfied: string[]
): Promise<ReproBuilderResult> {
  // (a) Write all files; track paths for cleanup on rejection.
  const writtenPaths: string[] = [];
  for (const file of reproFilesCandidate.reproFiles) {
    try {
      let content = file.content;
      if (file.append) {
        const existing = await args.workspace.readFile(file.path);
        content = (existing ?? '') + file.content;
      }
      await args.workspace.writeTest(file.path, content);
      writtenPaths.push(file.path);
    } catch (err) {
      // Revert already-written files before returning.
      for (const p of writtenPaths) {
        await safeRevert(args.workspace, p);
      }
      return rej(
        'write_test_failed',
        `workspace.writeTest threw for ${file.path}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // (b) Test entry point from reproFilesCandidate.
  const testEntryPoint = reproFilesCandidate.testEntryPoint;

  // (c) Install packages from installSpec (skip candidate.pipInstalls).
  const { installSpec } = reproFilesCandidate;
  for (const editablePath of installSpec.editableInstall) {
    const spec = `-e ${editablePath}`;
    const run = await safeSandbox(args.sandbox.pipInstall(spec));
    if (!run.ok) {
      for (const p of writtenPaths) await safeRevert(args.workspace, p);
      return rej('sandbox_error', `pip install (editable) threw for ${editablePath}: ${run.error}`);
    }
    if (run.value.exitCode !== 0) {
      for (const p of writtenPaths) await safeRevert(args.workspace, p);
      return {
        ok: false,
        rejectStage: 'pip_install_failed',
        reason: `pip install -e ${editablePath} failed (exit ${run.value.exitCode})`,
        runs: [],
        pipInstallFailure: {
          spec,
          exitCode: run.value.exitCode,
          stderrTail: tail(run.value.stderr, STDERR_TAIL),
        },
      };
    }
  }
  for (const pkg of installSpec.additionalPackages) {
    const run = await safeSandbox(args.sandbox.pipInstall(pkg));
    if (!run.ok) {
      for (const p of writtenPaths) await safeRevert(args.workspace, p);
      return rej('sandbox_error', `pip install threw for ${pkg}: ${run.error}`);
    }
    if (run.value.exitCode !== 0) {
      for (const p of writtenPaths) await safeRevert(args.workspace, p);
      return {
        ok: false,
        rejectStage: 'pip_install_failed',
        reason: `pip install ${pkg} failed (exit ${run.value.exitCode})`,
        runs: [],
        pipInstallFailure: {
          spec: pkg,
          exitCode: run.value.exitCode,
          stderrTail: tail(run.value.stderr, STDERR_TAIL),
        },
      };
    }
  }

  // (d) Run the test.
  args.sandbox.setReproTestPath(testEntryPoint);

  const runs: BuilderRunObservation[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await safeSandbox(args.sandbox.runRepro());
    if (!r.ok) {
      for (const p of writtenPaths) await safeRevert(args.workspace, p);
      return {
        ok: false,
        rejectStage: 'sandbox_error',
        reason: `runRepro #${i + 1} threw: ${r.error}`,
        runs,
        candidateTestPath: testEntryPoint,
      };
    }
    // No sentinel for reproFiles path — observe with empty sentinel.
    runs.push(observe(r.value, '', ''));
  }

  // Tiebreak on disagreement.
  const agree = (a: BuilderRunObservation, b: BuilderRunObservation) =>
    (a.exitCode === 0) === (b.exitCode === 0);

  if (!agree(runs[0], runs[1])) {
    const tie = await safeSandbox(args.sandbox.runRepro());
    if (!tie.ok) {
      for (const p of writtenPaths) await safeRevert(args.workspace, p);
      return {
        ok: false,
        rejectStage: 'sandbox_error',
        reason: `runRepro tiebreak threw: ${tie.error}`,
        runs,
        candidateTestPath: testEntryPoint,
      };
    }
    runs.push(observe(tie.value, '', ''));
  }

  // (e) Verdict: need 2 failing runs.
  const failingAny = runs.filter((r) => r.exitCode !== 0).length;
  const allPassed = runs.every((r) => r.exitCode === 0);

  if (allPassed) {
    for (const p of writtenPaths) await safeRevert(args.workspace, p);
    return {
      ok: false,
      rejectStage: 'run_repro_pass',
      reason: 'Candidate reproFiles test passed on every run; bug not triggered.',
      runs,
      candidateTestPath: testEntryPoint,
    };
  }

  if (failingAny < 2) {
    for (const p of writtenPaths) await safeRevert(args.workspace, p);
    return {
      ok: false,
      rejectStage: 'run_repro_flaky',
      reason: `Runs disagreed (reproFiles path): ${runs.map((r) => `${r.exitCode}`).join('|')}`,
      runs,
      candidateTestPath: testEntryPoint,
    };
  }

  // Validate expectedFailureOutput if set.
  const expectedOut = reproFilesCandidate.expectedFailureOutput;
  if (expectedOut) {
    const anyRunContainsOutput = runs.some((r) => {
      const combined = `${r.stderrTail}\n${r.stdoutTail}`;
      return combined.includes(expectedOut);
    });
    if (!anyRunContainsOutput) {
      for (const p of writtenPaths) await safeRevert(args.workspace, p);
      return {
        ok: false,
        rejectStage: 'expected_output_absent',
        reason: `expectedFailureOutput "${expectedOut.slice(0, 120)}" not found in any failing run's output.`,
        runs,
        candidateTestPath: testEntryPoint,
      };
    }
  }

  // (g) Build recipe using reproFilesCandidate data.
  const lastFailing = runs.filter((r) => r.exitCode !== 0).slice(-1)[0] ?? runs[runs.length - 1];

  // Use the first repro file's content as testSource in the recipe
  // (the recipe schema requires a testSource string; we record the entry-point file content).
  const entryFile = reproFilesCandidate.reproFiles.find(
    (f) => testEntryPoint.startsWith(f.path)
  ) ?? reproFilesCandidate.reproFiles[0];
  const recipeTestSource = entryFile
    ? entryFile.content.slice(0, REPRO_RECIPE_TEST_SOURCE_MAX)
    : testEntryPoint;

  const recipe: ReproRecipe = {
    version: 1,
    candidateTestPath: testEntryPoint,
    testSource: recipeTestSource,
    sentinelString: expectedOut || testEntryPoint,
    pipInstalls: [
      ...installSpec.editableInstall.map((p) => ({ package: p, editable: true })),
      ...installSpec.additionalPackages.map((p) => ({ package: p, editable: false })),
    ],
    requiresCredentials: candidate.requiresCredentials,
    verbatimSnippetIncompatible: false,
    approach: `reproFiles:${candidate.source}`,
    provenance: {
      exerciseImports: [],
      preconditionsSatisfied: resolvedPreconditionsSatisfied,
      observedProbe: {
        sentinelObserved: false,
        signatureObserved: false,
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
    `[v2-builder] attempt=${args.attemptId} ok=true path=reproFiles ranRepro=${runs.length}` +
      ` failingAny=${failingAny} source=${candidate.source}` +
      ` reproFiles=${reproFilesCandidate.reproFiles.length}`
  );

  return {
    ok: true,
    recipe,
    reason: 'Builder (reproFiles path) produced a recipe; runs reproduced reliably.',
    runs,
    candidateTestPath: testEntryPoint,
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
