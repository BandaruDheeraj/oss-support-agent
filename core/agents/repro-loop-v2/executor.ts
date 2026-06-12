/**
 * Repro Executor — DETERMINISTIC transcription of a ReproRecipe.
 *
 * The LLM-using Executor has been replaced by the Prober (which authors and
 * verifies the recipe in its own sandbox). This module re-applies the recipe
 * deterministically: install required packages, write the test, run it twice,
 * tally sentinel + signature hits. No model calls, no tool loops.
 *
 * The Critic still uses the result. `reproAstPreflight` is preserved (the
 * orchestrator calls it as a sanity check on the candidate test source).
 */

import type { ReproRecipe } from '../analyst/dossier';
import type { RepoHandle, SandboxHandle, SandboxRun, WorkspaceWriter } from '../tools/handles';
import { ensureTestRootScoped } from '../tools/write-test';

export interface DeterministicExecutorArgs {
  attemptId: string;
  recipe: ReproRecipe;
  workspace: WorkspaceWriter;
  sandbox: SandboxHandle;
  /**
   * Process env consulted for the recipe.requiresCredentials check.
   * Defaults to process.env. A credential is "missing" when the env var is
   * undefined or zero-length.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Repo-relative editable-install paths the orchestrator resolved (typically
   * from the Analyst's reproTargets.editableInstall or BFS fallback). Used
   * to rewrite recipe.pipInstalls entries whose `package` is a bare name
   * (no path segment) when a known editable install ends with that name.
   * This handles the common Prober failure where the recipe records the
   * package name without its `python/instrumentation/` repo prefix.
   */
  editableInstallFallbacks?: string[];
  /**
   * Suspect-path needles forwarded to SandboxSession-backed repro execution so
   * the session can report whether failing output exercised suspect code.
   */
  suspectPathNeedles?: string[];
}

export interface DeterministicExecutorRun {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  sentinelObserved: boolean;
  signatureObserved: boolean;
}

export type DeterministicExecutorOutcome =
  | 'reproduced'
  | 'unexpected_pass'
  | 'install_failed'
  | 'credentials_missing'
  | 'write_failed'
  | 'preflight_failed';

export interface DeterministicExecutorResult {
  outcome: DeterministicExecutorOutcome;
  candidateTestPath: string;
  sentinelString: string;
  expectedFailureSignature: string | null;
  ranReproCount: number;
  lastReproExitCode: number | null;
  /** Per-run observations. Length === ranReproCount. */
  runs: DeterministicExecutorRun[];
  /** True when ≥2 runs exited != 0 AND contained the sentinel in stdout+stderr. */
  reproducedReliably: boolean;
  /** True when ≥2 runs contained the signature; vacuously true with no signature. */
  signatureMatched: boolean;
  /** Missing credential env var names when outcome === 'credentials_missing'. */
  missingCredentials: string[];
  /**
   * pip install failures (spec → stderr tail). Empty unless outcome ===
   * 'install_failed'.
   */
  installFailures: Array<{ spec: string; exitCode: number; stderrTail: string }>;
  /** Free-form diagnostic — surfaced in logs and in the orchestrator's message. */
  reason: string;
}

const STDOUT_TAIL = 4000;
const STDERR_TAIL = 4000;

/**
 * Re-applies `recipe` against `sandbox` + `workspace` deterministically.
 *
 * Sequence:
 *   1. Credentials check (short-circuit if any required env var is missing).
 *   2. pip installs (stop on first failure → install_failed).
 *   3. ensureTestRootScoped + workspace.writeTest (throw → write_failed).
 *   4. sandbox.setReproTestPath.
 *   5. sandbox.runRepro() × 2.
 *   6. Tally sentinel + signature in combined stdout+stderr.
 *
 * `signatureMatched` is REPORTED for every run, regardless of whether the
 * recipe's provenance.observedProbe says the signature was observed during
 * probing. The Critic decides whether to treat it as a hard gate.
 */
export async function runReproExecutorFromRecipe(
  args: DeterministicExecutorArgs
): Promise<DeterministicExecutorResult> {
  const { recipe } = args;
  const env = args.env ?? process.env;
  const candidateTestPath = recipe.candidateTestPath;
  const sentinelString = recipe.sentinelString;
  const expectedFailureSignature = (recipe.expectedFailureSignature ?? '').trim();

  const baseResult: Omit<
    DeterministicExecutorResult,
    'outcome' | 'reason'
  > = {
    candidateTestPath,
    sentinelString,
    expectedFailureSignature: expectedFailureSignature.length > 0 ? expectedFailureSignature : null,
    ranReproCount: 0,
    lastReproExitCode: null,
    runs: [],
    reproducedReliably: false,
    signatureMatched: expectedFailureSignature.length === 0,
    missingCredentials: [],
    installFailures: [],
  };

  // (1) Credentials check
  const missing = (recipe.requiresCredentials ?? []).filter(
    (name) => !env[name] || env[name]?.length === 0
  );
  if (missing.length > 0) {
    return {
      ...baseResult,
      missingCredentials: missing,
      outcome: 'credentials_missing',
      reason: `Required credentials not set in env: ${missing.join(', ')}`,
    };
  }

  // (2) pip installs
  const installFailures: DeterministicExecutorResult['installFailures'] = [];
  for (const inst of recipe.pipInstalls ?? []) {
    const rewrittenPackage = inst.editable
      ? resolveEditableInstallPackage(inst.package, args.editableInstallFallbacks ?? [])
      : inst.package;
    const spec = inst.editable ? `-e ${rewrittenPackage}` : rewrittenPackage;
    if (inst.editable && rewrittenPackage !== inst.package) {
      // eslint-disable-next-line no-console
      console.log(
        `[v2-executor-det] attempt=${args.attemptId} install_spec_rewritten from=${JSON.stringify(inst.package)} to=${JSON.stringify(rewrittenPackage)} via=editableInstallFallbacks`
      );
    }
    const run = await args.sandbox.pipInstall(spec);
    if (run.exitCode !== 0) {
      installFailures.push({
        spec,
        exitCode: run.exitCode,
        stderrTail: tail(run.stderr, STDERR_TAIL),
      });
      // eslint-disable-next-line no-console
      console.log(
        `[v2-executor-det] attempt=${args.attemptId} install_failed spec=${JSON.stringify(spec)} exit=${run.exitCode}`
      );
      return {
        ...baseResult,
        installFailures,
        outcome: 'install_failed',
        reason: `pip install failed for ${spec} (exit ${run.exitCode}).`,
      };
    }
  }

  // (3) write the test (path-scoped, then write through workspace)
  try {
    const roots = args.workspace.testRoots();
    ensureTestRootScoped(candidateTestPath, roots, 'reproRecipe.candidateTestPath');
    await args.workspace.writeTest(candidateTestPath, recipe.testSource);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.log(
      `[v2-executor-det] attempt=${args.attemptId} write_failed path=${JSON.stringify(candidateTestPath)} err=${JSON.stringify(message).slice(0, 240)}`
    );
    return {
      ...baseResult,
      outcome: 'write_failed',
      reason: `Failed to write candidate test at ${candidateTestPath}: ${message}`,
    };
  }

  // (4) point the sandbox at the test
  args.sandbox.setReproTestPath(candidateTestPath);

  // (5) run × 2
  const runs: DeterministicExecutorRun[] = [];
  const reproOptions =
    args.suspectPathNeedles && args.suspectPathNeedles.length > 0
      ? { suspectPathNeedles: args.suspectPathNeedles }
      : undefined;
  for (let i = 0; i < 2; i++) {
    const r = await args.sandbox.runRepro(reproOptions);
    runs.push(observe(r, sentinelString, expectedFailureSignature));
  }

  // (6) tally
  const lastExit = runs[runs.length - 1]?.exitCode ?? null;
  const failingWithSentinel = runs.filter(
    (r) => r.exitCode !== 0 && r.sentinelObserved
  ).length;
  const reproducedReliably = failingWithSentinel >= 2;
  const signatureMatched =
    expectedFailureSignature.length === 0
      ? true
      : runs.filter((r) => r.signatureObserved).length >= 2;

  // eslint-disable-next-line no-console
  console.log(
    `[v2-executor-det] attempt=${args.attemptId} ran=${runs.length} reliable=${reproducedReliably}` +
      ` sigMatched=${signatureMatched} lastExit=${lastExit}` +
      ` runs=${runs.map((r) => `${r.exitCode}/${r.sentinelObserved ? 'S' : '_'}${r.signatureObserved ? 'X' : '_'}`).join('|')}`
  );

  if (!reproducedReliably) {
    const allPassed = runs.every((r) => r.exitCode === 0);
    return {
      ...baseResult,
      ranReproCount: runs.length,
      lastReproExitCode: lastExit,
      runs,
      reproducedReliably,
      signatureMatched,
      outcome: allPassed ? 'unexpected_pass' : 'reproduced',
      reason: allPassed
        ? `Recipe re-application: candidate test passed on both runs (expected failure).`
        : `Recipe re-application: failing runs did not consistently emit sentinel.`,
    };
  }

  return {
    ...baseResult,
    ranReproCount: runs.length,
    lastReproExitCode: lastExit,
    runs,
    reproducedReliably,
    signatureMatched,
    outcome: 'reproduced',
    reason: 'Recipe re-applied successfully; candidate test failed reliably.',
  };
}

function observe(
  run: SandboxRun,
  sentinel: string,
  signature: string
): DeterministicExecutorRun {
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

/**
 * Rewrite a bare editable-install package name (e.g.
 * `openinference-instrumentation-smolagents`) to the full repo-relative path
 * (e.g. `python/instrumentation/openinference-instrumentation-smolagents`) when
 * one of the provided fallback paths ends with that name. Pip will reject a
 * bare name as "not a valid editable requirement" without a local path or VCS
 * URL — this rewriter covers the common Prober failure where the recorded
 * recipe omits the `python/instrumentation/` prefix that the orchestrator
 * already resolved upstream.
 *
 * Returns `pkg` unchanged when:
 *   - it already contains a path separator, `.`, `:`, `@`, or `=` (suggesting
 *     a path, VCS URL, version constraint, or PEP 440 extras spec).
 *   - no fallback path's final segment matches `pkg`.
 *   - multiple fallback paths match (ambiguous — leave it to pip).
 */
export function resolveEditableInstallPackage(pkg: string, fallbacks: string[]): string {
  const trimmed = pkg.trim();
  if (trimmed.length === 0) return pkg;
  if (/[/\\.:@=]/.test(trimmed)) return pkg;
  const matches = fallbacks.filter((p) => {
    const lastSeg = p.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    return lastSeg === trimmed;
  });
  if (matches.length !== 1) return pkg;
  return matches[0];
}

/**
 * Best-effort AST preflight for Python repro candidates. Rejects tests that
 * trivially fail (assert False, sys.exit, raise without try, etc.) without
 * actually exercising the codebase. Used by the orchestrator as a sanity
 * check against probe-authored recipes whose `testSource` slipped past the
 * Prober's structural gate.
 */
export function reproAstPreflight(
  language: RepoHandle['language'],
  src: string,
  suspectFiles: string[],
  suspectSymbols: string[]
):
  | { ok: true }
  | { ok: false; code: 'missing_suspect_reference' | 'trivial_failure'; reason: string } {
  if (language !== 'python') return { ok: true };
  const stripped = src
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
    .replace(/(^|\n)\s*#[^\n]*/g, '$1');

  // For each suspect file, check (a) the full repo-relative dotted path, or
  // (b) the Python-importable suffix after "src/" — needed because deep monorepo
  // paths like python/instrumentation/.../src/openinference/.../processor.py
  // are imported as openinference.instrumentation.strands_agents.processor.
  const fileMatch = (f: string): boolean => {
    const fullDot = f.replace(/[\\/]/g, '.').replace(/\.py$/, '');
    if (stripped.includes(fullDot)) return true;
    const srcIdx = f.search(/(?:^|[\\/])src[\\/]/);
    if (srcIdx !== -1) {
      const afterSrc = f.slice(srcIdx + f.slice(srcIdx).indexOf('src') + 4); // past "src/"
      const importable = afterSrc.replace(/[\\/]/g, '.').replace(/\.py$/, '');
      if (stripped.includes(importable)) return true;
    }
    return false;
  };
  // Symbols may be stored as "ClassName.method" — also check the base class name
  // so "StrandsAgentsToOpenInferenceProcessor.on_end" matches a test that only
  // imports StrandsAgentsToOpenInferenceProcessor.
  const symbolMatch = (s: string): boolean => {
    if (new RegExp(`\\b${s.replace(/\./g, '\\.')}\\b`).test(stripped)) return true;
    const base = s.split('.')[0];
    if (base && base !== s && new RegExp(`\\b${base}\\b`).test(stripped)) return true;
    return false;
  };
  const exercises =
    (suspectFiles.length > 0 && suspectFiles.some(fileMatch)) ||
    (suspectSymbols.length > 0 && suspectSymbols.some(symbolMatch)) ||
    (suspectFiles.length === 0 && suspectSymbols.length === 0);
  if (!exercises) {
    return {
      ok: false,
      code: 'missing_suspect_reference',
      reason: 'test does not reference any suspect file or symbol from the dossier',
    };
  }

  // A top-level `raise` without a try/except wrapper is usually a synthetic
  // always-fail test. But allow wrapped `else: raise AssertionError(...)`
  // patterns since those are common in valid repro templates.
  const hasStandaloneRaise = /^\s*raise\b/m.test(stripped) && !/^\s*try:/m.test(stripped);
  const trivial =
    /^\s*assert\s+False\s*[,;]?\s*$/m.test(stripped) ||
    /\bsys\.exit\s*\(/.test(stripped) ||
    hasStandaloneRaise ||
    /^\s*print\(['"][^'"]*sentinel[^'"]*['"]\)\s*;?\s*assert\s+False/i.test(stripped);
  if (trivial) {
    return {
      ok: false,
      code: 'trivial_failure',
      reason: 'test trivially fails without exercising suspect code paths',
    };
  }
  return { ok: true };
}
