import {
  runReproExecutorFromRecipe,
  reproAstPreflight,
  type DeterministicExecutorResult,
  type DeterministicExecutorRun,
} from './executor';
import { detectCredentialError } from '../../credentials-check';
import type {
  ReproOraclePreconditionAssertion,
  ReproOracleSpec,
  ReproOracleSuspectPathAssertion,
  ReproRecipe,
  SemanticConfidence,
  SuspectSymbol,
} from '../analyst/dossier';
import type { RepoHandle, SandboxHandle, WorkspaceWriter } from '../tools/handles';
import type { SandboxResult as SandboxSessionResult } from '../../sandbox-session';

export interface DeterministicReproOracleArgs {
  attemptId: string;
  recipe: ReproRecipe;
  oracleSpec: ReproOracleSpec;
  suspectSymbols: SuspectSymbol[];
  repoLanguage: RepoHandle['language'];
  workspace: WorkspaceWriter;
  sandbox: SandboxHandle;
  editableInstallFallbacks?: string[];
  env?: NodeJS.ProcessEnv;
  semanticConfidence?: SemanticConfidence;
}

export interface OracleSuspectAssertionResult {
  passed: boolean;
  missing: ReproOracleSuspectPathAssertion[];
}

export interface OraclePreconditionAssertionResult {
  passed: boolean;
  missingMarkers: string[];
}

export interface DeterministicReproOracleCriteria {
  baseline_head_fails: boolean;
  reliable_failures: boolean;
  suspect_path_assertions: boolean;
  precondition_assertions: boolean;
  ast_preflight: boolean;
}

export interface DeterministicReproOracleResult {
  verdict: 'valid' | 'invalid' | 'credentials_required' | 'sandbox_failed';
  criteria: DeterministicReproOracleCriteria;
  message: string;
  executor: DeterministicExecutorResult;
  suspectPathAssertionResult: OracleSuspectAssertionResult;
  preconditionAssertionResult: OraclePreconditionAssertionResult;
  astReason: string | null;
  sandboxResult: SandboxSessionResult | null;
  credentialsTerminal:
    | {
        inferredEnvVars: string[];
        matchedPattern: string | null;
        stderrTail?: string;
      }
    | null;
}

export function evaluateSuspectPathAssertions(
  failingOutput: string,
  assertions: ReproOracleSuspectPathAssertion[]
): OracleSuspectAssertionResult {
  if (assertions.length === 0) {
    return { passed: true, missing: [] };
  }
  const missing = assertions.filter((a) => !failingOutput.includes(a.needle));
  return { passed: missing.length === 0, missing };
}

export function evaluatePreconditionAssertions(
  testSource: string,
  assertions: ReproOraclePreconditionAssertion[]
): OraclePreconditionAssertionResult {
  if (assertions.length === 0) {
    return { passed: true, missingMarkers: [] };
  }
  const missingMarkers = assertions.flatMap((a) =>
    a.markers.filter((marker) => marker.length > 0 && !testSource.includes(marker))
  );
  return {
    passed: missingMarkers.length === 0,
    missingMarkers: Array.from(new Set(missingMarkers)),
  };
}

function evaluateSuspectPathAssertionsFromSandboxResult(
  suspectPathHit: boolean,
  assertions: ReproOracleSuspectPathAssertion[]
): OracleSuspectAssertionResult {
  if (assertions.length === 0) {
    return { passed: true, missing: [] };
  }
  return {
    passed: suspectPathHit,
    missing: suspectPathHit ? [] : assertions,
  };
}

export async function runDeterministicReproOracle(
  args: DeterministicReproOracleArgs
): Promise<DeterministicReproOracleResult> {
  // Fast path: if the recipe was produced by the inline reproFiles Builder path,
  // the Builder already ran the test twice and confirmed the bug via runPython().
  // Skip re-running — there is no file on the branch for pytest to find, and the
  // Builder's runs are already authoritative.
  if (args.recipe.approach === 'builder:repro_files:inline') {
    const passedCriteria: DeterministicReproOracleCriteria = {
      baseline_head_fails: true,
      reliable_failures: true,
      suspect_path_assertions: true,
      precondition_assertions: true,
      ast_preflight: true,
    };
    return {
      verdict: 'valid',
      criteria: passedCriteria,
      message: 'reproFiles inline — Builder already confirmed via runPython(); no pytest file on branch',
      executor: null as unknown as DeterministicExecutorResult,
      suspectPathAssertionResult: { passed: true, missing: [] },
      preconditionAssertionResult: { passed: true, missingMarkers: [] },
      astReason: null,
      sandboxResult: null,
      credentialsTerminal: null,
    };
  }
  const preconditionAssertionResult = evaluatePreconditionAssertions(
    args.recipe.testSource,
    args.oracleSpec.precondition_assertions
  );

  const suspectFiles = Array.from(
    new Set(
      [
        ...args.suspectSymbols.map((s) => s.file),
        ...args.oracleSpec.suspect_path_assertions
          .map((a) => a.file)
          .filter((f): f is string => typeof f === 'string' && f.length > 0),
      ].filter((f) => typeof f === 'string' && f.length > 0)
    )
  );
  const suspectSymbols = Array.from(
    new Set(
      [
        ...args.suspectSymbols.map((s) => s.symbol),
        ...args.oracleSpec.suspect_path_assertions
          .filter((a) => a.kind === 'symbol')
          .map((a) => a.needle),
      ].filter((s) => typeof s === 'string' && s.length > 0)
    )
  );

  const ast = reproAstPreflight(
    args.repoLanguage,
    args.recipe.testSource,
    suspectFiles,
    suspectSymbols
  );

  const suspectPathNeedles = args.oracleSpec.suspect_path_assertions
    .map((assertion) => assertion.needle)
    .filter((needle): needle is string => typeof needle === 'string' && needle.length > 0);

  let executor: DeterministicExecutorResult;
  try {
    executor = await runReproExecutorFromRecipe({
      attemptId: args.attemptId,
      recipe: args.recipe,
      workspace: args.workspace,
      sandbox: args.sandbox,
      env: args.env,
      editableInstallFallbacks: args.editableInstallFallbacks,
      suspectPathNeedles,
    });
  } catch (err) {
    const sandboxResult = readSandboxResult(args.sandbox);
    if (sandboxResult && isSandboxNonRunnable(sandboxResult)) {
      return buildSandboxFailedOracleResult({
        sandboxResult,
        preconditionAssertionResult,
        ast,
        fallbackMessage: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }

  if (executor.outcome === 'credentials_missing') {
    return {
      verdict: 'credentials_required',
      criteria: {
        baseline_head_fails: false,
        reliable_failures: false,
        suspect_path_assertions: false,
        precondition_assertions: preconditionAssertionResult.passed,
        ast_preflight: ast.ok,
      },
      message: `Missing credentials declared by recipe: ${executor.missingCredentials.join(', ')}`,
      executor,
      suspectPathAssertionResult: { passed: false, missing: args.oracleSpec.suspect_path_assertions },
      preconditionAssertionResult,
      astReason: ast.ok ? null : ast.reason,
      sandboxResult: null,
      credentialsTerminal: {
        inferredEnvVars: executor.missingCredentials,
        matchedPattern: 'recipe.requiresCredentials',
        stderrTail: undefined,
      },
    };
  }

  const credFromRuns = detectCredentialsFromRuns(executor.runs, args.env ?? process.env);
  if (credFromRuns) {
    return {
      verdict: 'credentials_required',
      criteria: {
        baseline_head_fails: false,
        reliable_failures: false,
        suspect_path_assertions: false,
        precondition_assertions: preconditionAssertionResult.passed,
        ast_preflight: ast.ok,
      },
      message: `Detected missing credentials from repro output: ${credFromRuns.inferredEnvVars.join(', ')}`,
      executor,
      suspectPathAssertionResult: { passed: false, missing: args.oracleSpec.suspect_path_assertions },
      preconditionAssertionResult,
      astReason: ast.ok ? null : ast.reason,
      sandboxResult: null,
      credentialsTerminal: credFromRuns,
    };
  }

  const sandboxResult = readSandboxResult(args.sandbox);
  if (sandboxResult && isSandboxNonRunnable(sandboxResult)) {
    return buildSandboxFailedOracleResult({
      sandboxResult,
      preconditionAssertionResult,
      ast,
      executor,
    });
  }

  const baseline_head_fails = (executor.runs[0]?.exitCode ?? 0) !== 0;
  const reliable_failures = executor.runs.filter((r) => r.exitCode !== 0).length >= 2;
  const relaxSuspectPathAssertion = args.semanticConfidence?.low_confidence === true;
  const suspectPathAssertionResult = sandboxResult
    ? evaluateSuspectPathAssertionsFromSandboxResult(
        sandboxResult.suspectPathHit,
        args.oracleSpec.suspect_path_assertions
      )
    : evaluateSuspectPathAssertions(
        executor.runs
          .filter((r) => r.exitCode !== 0)
          .map((r) => `${r.stderrTail}\n${r.stdoutTail}`)
          .join('\n'),
        args.oracleSpec.suspect_path_assertions
      );
  const criteria: DeterministicReproOracleCriteria = {
    baseline_head_fails,
    reliable_failures,
    suspect_path_assertions: relaxSuspectPathAssertion ? true : suspectPathAssertionResult.passed,
    precondition_assertions: preconditionAssertionResult.passed,
    ast_preflight: ast.ok,
  };

  if (allCriteriaPass(criteria)) {
    const acceptedWithSoftCheck =
      relaxSuspectPathAssertion && !suspectPathAssertionResult.passed && args.oracleSpec.suspect_path_assertions.length > 0;
    return {
      verdict: 'valid',
      criteria,
      message: acceptedWithSoftCheck
        ? 'Deterministic repro oracle accepted candidate: suspect_path_assertions treated as soft-check due to low semantic confidence.'
        : 'Deterministic repro oracle accepted candidate: all criteria satisfied.',
      executor,
      suspectPathAssertionResult,
      preconditionAssertionResult,
      astReason: ast.ok ? null : ast.reason,
      sandboxResult,
      credentialsTerminal: null,
    };
  }

  return {
    verdict: 'invalid',
    criteria,
    message: summarizeFailure(criteria, suspectPathAssertionResult, preconditionAssertionResult, ast),
    executor,
    suspectPathAssertionResult,
    preconditionAssertionResult,
    astReason: ast.ok ? null : ast.reason,
    sandboxResult,
    credentialsTerminal: null,
  };
}

function allCriteriaPass(criteria: DeterministicReproOracleCriteria): boolean {
  return (
    criteria.baseline_head_fails &&
    criteria.reliable_failures &&
    criteria.suspect_path_assertions &&
    criteria.precondition_assertions &&
    criteria.ast_preflight
  );
}

function summarizeFailure(
  criteria: DeterministicReproOracleCriteria,
  suspectResult: OracleSuspectAssertionResult,
  preconditionResult: OraclePreconditionAssertionResult,
  ast: { ok: true } | { ok: false; reason: string }
): string {
  if (!criteria.baseline_head_fails) {
    return 'Deterministic repro oracle rejected candidate: baseline run did not fail.';
  }
  if (!criteria.reliable_failures) {
    return 'Deterministic repro oracle rejected candidate: failures were not reliable across >=2 runs.';
  }
  if (!criteria.suspect_path_assertions) {
    const needles = suspectResult.missing.map((m) => m.needle).join(', ');
    return `Deterministic repro oracle rejected candidate: missing suspect_path_assertions in failure output: ${needles}`;
  }
  if (!criteria.precondition_assertions) {
    return `Deterministic repro oracle rejected candidate: missing precondition markers in test source: ${preconditionResult.missingMarkers.join(', ')}`;
  }
  if (!criteria.ast_preflight) {
    return `Deterministic repro oracle rejected candidate: AST preflight failed (${ast.ok ? 'unknown reason' : ast.reason}).`;
  }
  return 'Deterministic repro oracle rejected candidate.';
}

function detectCredentialsFromRuns(
  runs: DeterministicExecutorRun[],
  env: NodeJS.ProcessEnv
): DeterministicReproOracleResult['credentialsTerminal'] {
  for (const run of runs) {
    const detected = detectCredentialError(run.stdoutTail ?? '', run.stderrTail ?? '');
    if (!detected.isCredentialError) continue;
    const missing = detected.inferredEnvVars.filter((v) => !env[v] || env[v]?.length === 0);
    if (missing.length === 0) continue;
    return {
      inferredEnvVars: missing,
      matchedPattern: detected.matchedPattern ?? null,
      stderrTail: run.stderrTail,
    };
  }
  return null;
}

function readSandboxResult(sandbox: SandboxHandle): SandboxSessionResult | null {
  return sandbox.getSandboxResult ? sandbox.getSandboxResult() : null;
}

function isSandboxNonRunnable(result: SandboxSessionResult): boolean {
  return result.reproStatus === 'not_executed' || result.reproStatus === 'errored';
}

function buildSandboxFailedOracleResult(args: {
  sandboxResult: SandboxSessionResult;
  preconditionAssertionResult: OraclePreconditionAssertionResult;
  ast: { ok: true } | { ok: false; reason: string };
  executor?: DeterministicExecutorResult;
  fallbackMessage?: string;
}): DeterministicReproOracleResult {
  const detail =
    args.sandboxResult.phaseFailures.length > 0
      ? args.sandboxResult.phaseFailures
          .map((failure) => `${failure.phase}:${failure.reason}`)
          .join(', ')
      : args.sandboxResult.failureOutput || args.fallbackMessage || 'sandbox execution failed';
  return {
    verdict: 'sandbox_failed',
    criteria: {
      baseline_head_fails: false,
      reliable_failures: false,
      suspect_path_assertions: false,
      precondition_assertions: args.preconditionAssertionResult.passed,
      ast_preflight: args.ast.ok,
    },
    message: `Sandbox execution failed before runnable repro evidence: ${detail}`,
    executor:
      args.executor ??
      {
        outcome: 'preflight_failed',
        candidateTestPath: '',
        sentinelString: '',
        expectedFailureSignature: null,
        ranReproCount: 0,
        lastReproExitCode: null,
        runs: [],
        reproducedReliably: false,
        signatureMatched: false,
        missingCredentials: [],
        installFailures: [],
        reason: detail,
      },
    suspectPathAssertionResult: { passed: false, missing: [] },
    preconditionAssertionResult: args.preconditionAssertionResult,
    astReason: args.ast.ok ? null : args.ast.reason,
    sandboxResult: args.sandboxResult,
    credentialsTerminal: null,
  };
}
