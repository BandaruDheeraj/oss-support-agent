/**
 * Deterministic Repro Builder.
 *
 * Consumes the Analyst's reproFiles block:
 *   1. validates credentials and pip installs.
 *   2. writes all reproFiles to workspace.
 *   3. flushes workspace to branch.
 *   4. runs GHA pytest via sandbox.runRepro() twice; tiebreak on disagreement.
 *   5. emits a fully-formed ReproRecipe on success.
 *
 * NO LLM tool loops.
 */

import type {
  CandidateRepro,
  DossierSnapshot,
  ReproRecipe,
} from '../analyst/dossier';
import {
  REPRO_RECIPE_OBSERVED_TAIL_MAX,
  REPRO_RECIPE_TEST_SOURCE_MAX,
} from '../analyst/dossier';
import {
  type ReproFilesCandidate,
} from '../analyst/candidate-repro';
import type {
  RepoHandle,
  SandboxHandle,
  SandboxRun,
  WorkspaceReader,
  WorkspaceWriter,
} from '../tools/handles';

const STDOUT_TAIL = REPRO_RECIPE_OBSERVED_TAIL_MAX;
const STDERR_TAIL = REPRO_RECIPE_OBSERVED_TAIL_MAX;

/** Granular reject stages — every reject path gets its own histogram bucket. */
export type BuilderRejectStage =
  | 'no_candidate'
  | 'precondition_unknown'
  | 'pip_install_failed'
  | 'write_test_failed'
  | 'sandbox_error'
  | 'run_repro_pass'
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
    // Promote reproFiles block to a candidateRepro with an inline reproFilesCandidate
    // so the committed path (runReproFilesPath) is used directly.
    const promotedReproFilesCandidate: import('../analyst/candidate-repro').ReproFilesCandidate = {
      reproFiles: rawReproFiles.reproFiles ?? [],
      testEntryPoint: rawReproFiles.testEntryPoint ?? 'tests/repro/test_repro.py',
      installSpec: rawReproFiles.installSpec ?? { editableInstall: [], additionalPackages: [] },
      expectedFailureOutput: rawReproFiles.expectedFailureOutput ?? '',
      fixHypothesis: rawReproFiles.fixHypothesis ?? { file: '', description: '' },
      rationale: rawReproFiles.rationale ?? '',
    };
    candidate = {
      version: 1 as const,
      source: 'direct_call' as const,
      failureMode: 'wrong_return' as const,
      testSource: rawReproFiles.reproFiles?.[0]?.content ?? '',
      candidateTestPath: (rawReproFiles.testEntryPoint ?? 'tests/repro/test_repro.py').split('::')[0],
      imports: [],
      setup: '',
      pipInstalls: [],
      requiresCredentials: [],
      preconditionsSatisfied: [],
      rationale: rawReproFiles.rationale ?? '',
      reproFilesCandidate: promotedReproFilesCandidate,
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
  // (1) Validate preconditions against dossier
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

  // ---------------------------------------------------------------
  // (2) Route to reproFilesCandidate path (the only supported path)
  // ---------------------------------------------------------------

  if (candidate.reproFilesCandidate) {
    return runReproFilesPath(args, candidate.reproFilesCandidate, candidate, resolvedPreconditionsSatisfied);
  }

  // No reproFilesCandidate — Builder cannot proceed.
  return rej('no_candidate', 'Dossier candidateRepro has no reproFilesCandidate block; Builder requires the reproFiles path.');
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
