/**
 * Deterministic Repro Builder — with LLM self-repair loop.
 *
 * Consumes the Analyst's reproFiles block:
 *   1. Writes all reproFiles to workspace and flushes to branch.
 *   2. pip-installs packages from installSpec.
 *   3. Runs GHA pytest via sandbox.runRepro() twice; tiebreak on disagreement.
 *   4. Emits a fully-formed ReproRecipe on success.
 *
 * On ANY failure (pip install, sandbox error, wrong test output, unexpected pass),
 * calls the LLM repair agent to fix the test files and/or installSpec and retries.
 * The loop runs up to MAX_REPAIR_ROUNDS times before giving up.
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
import { repairHarness, type RepairErrorPhase } from './repair-agent';

const STDOUT_TAIL = REPRO_RECIPE_OBSERVED_TAIL_MAX;
const STDERR_TAIL = REPRO_RECIPE_OBSERVED_TAIL_MAX;

const MAX_REPAIR_ROUNDS = 5;

/** Granular reject stages — every reject path gets its own histogram bucket. */
export type BuilderRejectStage =
  | 'no_candidate'
  | 'precondition_unknown'
  | 'pip_install_failed'
  | 'write_test_failed'
  | 'sandbox_error'
  | 'run_repro_pass'
  | 'run_repro_flaky'
  | 'expected_output_absent'
  | 'repair_exhausted';

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
  /** Repo-relative editable install paths surfaced by the orchestrator (for the repair agent). */
  editableInstallCandidates?: string[];
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
  /** Number of LLM repair rounds used. */
  repairRounds?: number;
}

/** Build a single recipe from a candidate. No retries at this level — the repair loop is inside. */
export async function runReproBuilder(args: ReproBuilderArgs): Promise<ReproBuilderResult> {
  const rawReproFiles = (args.dossierSnapshot.body as any).reproFiles;
  let candidate = args.dossierSnapshot.body.candidateRepro;
  if (!candidate && rawReproFiles) {
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

  if (candidate.reproFilesCandidate) {
    return runReproFilesPath(args, candidate.reproFilesCandidate, candidate, resolvedPreconditionsSatisfied);
  }

  return rej('no_candidate', 'Dossier candidateRepro has no reproFilesCandidate block; Builder requires the reproFiles path.');
}

// ---------------------------------------------------------------------------
// reproFiles path — multi-file repro execution with LLM self-repair loop
// ---------------------------------------------------------------------------

async function runReproFilesPath(
  args: ReproBuilderArgs,
  reproFilesCandidate: ReproFilesCandidate,
  candidate: CandidateRepro,
  resolvedPreconditionsSatisfied: string[]
): Promise<ReproBuilderResult> {
  const testEntryPoint = reproFilesCandidate.testEntryPoint;
  const expectedOut = reproFilesCandidate.expectedFailureOutput;

  // Mutable harness state — LLM repair updates these each round.
  let currentFiles = reproFilesCandidate.reproFiles.map((f) => ({ path: f.path, content: f.content, append: f.append }));
  let currentInstallSpec = {
    editableInstall: [...(reproFilesCandidate.installSpec.editableInstall ?? [])],
    additionalPackages: [...(reproFilesCandidate.installSpec.additionalPackages ?? [])],
  };
  const repairHistory: string[] = [];
  let repairRounds = 0;

  // Issue context for the repair agent (best-effort).
  const issueTitle = (args.dossierSnapshot.body as any).issueTitle as string | undefined;
  const issueBody = (args.dossierSnapshot.body as any).issueBody as string | undefined;

  const writtenPaths: string[] = [];

  // Helper: revert all written files.
  const revertAll = async () => {
    for (const p of writtenPaths) await safeRevert(args.workspace, p);
    writtenPaths.length = 0;
  };

  // Helper: call LLM repair agent and apply result to mutable state.
  // Returns true if repair was applied, false if we should give up.
  const repair = async (phase: RepairErrorPhase, errorOutput: string): Promise<boolean> => {
    if (repairRounds >= MAX_REPAIR_ROUNDS - 1) return false;

    let result;
    try {
      result = await repairHarness({
        attemptId: args.attemptId,
        errorPhase: phase,
        errorOutput,
        currentTestFiles: currentFiles.map((f) => ({ path: f.path, content: f.content })),
        currentInstallSpec,
        availableEditableInstalls: args.editableInstallCandidates ?? [],
        issueTitle,
        issueBody,
        roundNumber: repairRounds,
        maxRounds: MAX_REPAIR_ROUNDS,
        repairHistory,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[v2-builder] repair LLM_ERROR round=${repairRounds} phase=${phase} err=${err instanceof Error ? err.message : String(err)}`
      );
      repairRounds++;
      return false;
    }

    repairRounds++;

    if (!result || result.abandon) {
      // eslint-disable-next-line no-console
      console.log(
        `[v2-builder] repair round=${repairRounds} abandon=${!result ? 'no_llm' : result.abandonReason ?? 'true'}`
      );
      return false;
    }

    repairHistory.push(result.explanation);

    // Apply test file updates.
    if (result.testFileUpdates.length > 0) {
      const updatesByPath = new Map(result.testFileUpdates.map((u) => [u.path, u.content]));
      currentFiles = currentFiles.map((f) =>
        updatesByPath.has(f.path) ? { ...f, content: updatesByPath.get(f.path)! } : f
      );
      // Add any new files the agent introduced.
      for (const update of result.testFileUpdates) {
        if (!currentFiles.some((f) => f.path === update.path)) {
          currentFiles.push({ path: update.path, content: update.content, append: undefined });
        }
      }
    }

    // Apply installSpec updates.
    currentInstallSpec = {
      editableInstall: result.installSpec.editableInstall,
      additionalPackages: result.installSpec.additionalPackages,
    };

    return true;
  };

  // ── Self-repair loop ────────────────────────────────────────────────────────
  for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
    // (a) Revert any files written in the previous round, then write fresh.
    await revertAll();

    let writeError: string | null = null;
    for (const file of currentFiles) {
      try {
        let content = file.content;
        if (file.append) {
          const existing = await args.workspace.readFile(file.path);
          content = (existing ?? '') + file.content;
        }
        await args.workspace.writeTest(file.path, content);
        writtenPaths.push(file.path);
      } catch (err) {
        writeError = `workspace.writeTest threw for ${file.path}: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }

    if (writeError) {
      const fixed = await repair('write_failed', writeError);
      if (!fixed) {
        await revertAll();
        return rej('write_test_failed', writeError);
      }
      continue;
    }

    // (b) Flush workspace to branch so GHA can see updated test files.
    try {
      await args.sandbox.flushWorkspaceToBranch?.();
    } catch {
      // Non-fatal — best effort flush; the dispatch will pick up the branch anyway.
    }

    // (c) pip installs from current installSpec.
    let installErrorMsg: string | null = null;
    let installFailureDetail: ReproBuilderResult['pipInstallFailure'] | undefined;

    for (const editablePath of currentInstallSpec.editableInstall) {
      const spec = `-e ${editablePath}`;
      const run = await safeSandbox(args.sandbox.pipInstall(spec));
      if (!run.ok) {
        installErrorMsg = `pip install (editable) threw for ${editablePath}: ${run.error}`;
        break;
      }
      if (run.value.exitCode !== 0) {
        installFailureDetail = {
          spec,
          exitCode: run.value.exitCode,
          stderrTail: tail(run.value.stderr, STDERR_TAIL),
        };
        installErrorMsg = `pip install -e ${editablePath} failed (exit ${run.value.exitCode})\n${run.value.stderr}`;
        break;
      }
    }

    if (!installErrorMsg) {
      for (const pkg of currentInstallSpec.additionalPackages) {
        const run = await safeSandbox(args.sandbox.pipInstall(pkg));
        if (!run.ok) {
          installErrorMsg = `pip install threw for ${pkg}: ${run.error}`;
          break;
        }
        if (run.value.exitCode !== 0) {
          installFailureDetail = {
            spec: pkg,
            exitCode: run.value.exitCode,
            stderrTail: tail(run.value.stderr, STDERR_TAIL),
          };
          installErrorMsg = `pip install ${pkg} failed (exit ${run.value.exitCode})\n${run.value.stderr}`;
          break;
        }
      }
    }

    if (installErrorMsg) {
      const phase: RepairErrorPhase = installFailureDetail ? 'pip_install' : 'sandbox_error';
      const fixed = await repair(phase, installErrorMsg);
      if (!fixed) {
        await revertAll();
        if (installFailureDetail) {
          return {
            ok: false,
            rejectStage: 'pip_install_failed',
            reason: installErrorMsg,
            runs: [],
            pipInstallFailure: installFailureDetail,
            repairRounds,
          };
        }
        return {
          ok: false,
          rejectStage: 'sandbox_error',
          reason: installErrorMsg,
          runs: [],
          candidateTestPath: testEntryPoint,
          repairRounds,
        };
      }
      continue;
    }

    // (d) Run the test.
    args.sandbox.setReproTestPath(testEntryPoint);
    const run1 = await safeSandbox(args.sandbox.runRepro());

    if (!run1.ok) {
      const fixed = await repair('test_run_threw', `runRepro threw: ${run1.error}`);
      if (!fixed) {
        await revertAll();
        return {
          ok: false,
          rejectStage: 'sandbox_error',
          reason: `runRepro threw: ${run1.error}`,
          runs: [],
          candidateTestPath: testEntryPoint,
          repairRounds,
        };
      }
      continue;
    }

    if (run1.value.exitCode === 0) {
      // Test passed — bug not triggered.
      const combined = `${run1.value.stdout}\n${run1.value.stderr}`;
      const fixed = await repair('test_pass_unexpected', `Test passed (exit 0) — the bug was not triggered.\nOutput:\n${combined.slice(0, 2000)}`);
      if (!fixed) {
        await revertAll();
        return {
          ok: false,
          rejectStage: 'run_repro_pass',
          reason: 'Candidate reproFiles test passed on every run; bug not triggered.',
          runs: [observe(run1.value, '', '')],
          candidateTestPath: testEntryPoint,
          repairRounds,
        };
      }
      continue;
    }

    const combined1 = `${run1.value.stdout}\n${run1.value.stderr}`;

    // exit code 4 = pytest collection error (syntax error, bad import, etc.)
    // exit code 5 = no tests collected
    // These mean the test file itself is broken — not a valid repro failure.
    if (run1.value.exitCode === 4 || run1.value.exitCode === 5) {
      const fixed = await repair(
        'expected_output_absent',
        `Test could not be collected (exit ${run1.value.exitCode}) — test file has a syntax error or bad import. ` +
          `Fix imports to use the correct Python module path (no hyphens in module names). ` +
          `Import the buggy function directly (e.g. from openinference.instrumentation.claude_agent_sdk._wrappers import ...) ` +
          `and ensure the assertion message contains the function name and "Tool execution error".\n` +
          `Actual output:\n${combined1.slice(0, 2000)}`
      );
      if (!fixed) {
        await revertAll();
        return {
          ok: false,
          rejectStage: 'expected_output_absent',
          reason: `Test collection failed (exit ${run1.value.exitCode}) — test file has syntax error or bad import.`,
          runs: [observe(run1.value, '', '')],
          candidateTestPath: testEntryPoint,
          repairRounds,
        };
      }
      continue;
    }

    // Test failed (exitCode !== 0) — this is what we want for a repro.
    // Check expectedFailureOutput before doing the second run.
    if (expectedOut && !combined1.includes(expectedOut)) {
      const fixed = await repair(
        'expected_output_absent',
        `Test failed but expected output "${expectedOut}" not found.\nActual output:\n${combined1.slice(0, 2000)}`
      );
      if (!fixed) {
        await revertAll();
        return {
          ok: false,
          rejectStage: 'expected_output_absent',
          reason: `expectedFailureOutput "${expectedOut.slice(0, 120)}" not found in run output.`,
          runs: [observe(run1.value, '', '')],
          candidateTestPath: testEntryPoint,
          repairRounds,
        };
      }
      continue;
    }

    // Run 1 is good. Do run 2 for confirmation.
    const run2 = await safeSandbox(args.sandbox.runRepro());
    if (!run2.ok) {
      const fixed = await repair('test_run_threw', `runRepro #2 threw: ${run2.error}`);
      if (!fixed) {
        await revertAll();
        return {
          ok: false,
          rejectStage: 'sandbox_error',
          reason: `runRepro #2 threw: ${run2.error}`,
          runs: [observe(run1.value, '', '')],
          candidateTestPath: testEntryPoint,
          repairRounds,
        };
      }
      continue;
    }

    const runs: BuilderRunObservation[] = [observe(run1.value, '', ''), observe(run2.value, '', '')];

    // Tiebreak if runs disagree.
    const agree = (a: BuilderRunObservation, b: BuilderRunObservation) =>
      (a.exitCode === 0) === (b.exitCode === 0);

    if (!agree(runs[0], runs[1])) {
      const tie = await safeSandbox(args.sandbox.runRepro());
      if (!tie.ok) {
        await revertAll();
        return {
          ok: false,
          rejectStage: 'sandbox_error',
          reason: `runRepro tiebreak threw: ${tie.error}`,
          runs,
          candidateTestPath: testEntryPoint,
          repairRounds,
        };
      }
      runs.push(observe(tie.value, '', ''));
    }

    const allPassed = runs.every((r) => r.exitCode === 0);
    if (allPassed) {
      const combined = runs.map((r) => `${r.stdoutTail}\n${r.stderrTail}`).join('\n---\n');
      const fixed = await repair('test_pass_unexpected', `All runs passed — bug not triggered.\nOutput:\n${combined.slice(0, 2000)}`);
      if (!fixed) {
        await revertAll();
        return {
          ok: false,
          rejectStage: 'run_repro_pass',
          reason: 'Candidate reproFiles test passed on every run; bug not triggered.',
          runs,
          candidateTestPath: testEntryPoint,
          repairRounds,
        };
      }
      continue;
    }

    const failingCount = runs.filter((r) => r.exitCode !== 0).length;
    if (failingCount < 2) {
      await revertAll();
      return {
        ok: false,
        rejectStage: 'run_repro_flaky',
        reason: `Runs disagreed (reproFiles path): ${runs.map((r) => `${r.exitCode}`).join('|')}`,
        runs,
        candidateTestPath: testEntryPoint,
        repairRounds,
      };
    }

    // Validate expectedFailureOutput across all runs.
    if (expectedOut) {
      const anyRunContainsOutput = runs.some((r) => {
        const combined = `${r.stderrTail}\n${r.stdoutTail}`;
        return combined.includes(expectedOut);
      });
      if (!anyRunContainsOutput) {
        const combined = runs.map((r) => `${r.stderrTail}\n${r.stdoutTail}`).join('\n---\n');
        const fixed = await repair(
          'expected_output_absent',
          `expectedFailureOutput "${expectedOut}" not found in any run.\nActual output:\n${combined.slice(0, 2000)}`
        );
        if (!fixed) {
          await revertAll();
          return {
            ok: false,
            rejectStage: 'expected_output_absent',
            reason: `expectedFailureOutput "${expectedOut.slice(0, 120)}" not found in any failing run's output.`,
            runs,
            candidateTestPath: testEntryPoint,
            repairRounds,
          };
        }
        continue;
      }
    }

    // ── SUCCESS ───────────────────────────────────────────────────────────────
    const lastFailing = runs.filter((r) => r.exitCode !== 0).slice(-1)[0] ?? runs[runs.length - 1];
    const primaryFile = currentFiles[0];
    const recipeTestSource = (primaryFile?.content ?? '').slice(0, REPRO_RECIPE_TEST_SOURCE_MAX);

    const recipe: ReproRecipe = {
      version: 1,
      candidateTestPath: testEntryPoint,
      testSource: recipeTestSource,
      sentinelString: expectedOut || testEntryPoint,
      pipInstalls: [
        ...currentInstallSpec.editableInstall.map((p) => ({ package: p, editable: true })),
        ...currentInstallSpec.additionalPackages.map((p) => ({ package: p, editable: false })),
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
        ` failingCount=${failingCount} source=${candidate.source}` +
        ` reproFiles=${currentFiles.length} repairRounds=${repairRounds}`
    );

    return {
      ok: true,
      recipe,
      reason: 'Builder (reproFiles path) produced a recipe; runs reproduced reliably.',
      runs,
      candidateTestPath: testEntryPoint,
      repairRounds,
    };
  }

  // Loop exhausted without success.
  await revertAll();
  return {
    ok: false,
    rejectStage: 'repair_exhausted',
    reason: `Self-repair loop exhausted ${MAX_REPAIR_ROUNDS} rounds without producing a valid repro.`,
    runs: [],
    candidateTestPath: testEntryPoint,
    repairRounds,
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
    // best effort
  }
}
