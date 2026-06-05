import {
  buildApiUnavailableRunDiagnostics,
  buildNotReproducedRunDiagnostics,
  buildSandboxFailedRunDiagnostics,
  classifyAlreadyFixedOnMain,
  classifyNotReproducedAsApiUnavailable,
  ReproStageTimeoutError,
  resolveReproStageTimeoutMs,
  runReproPipelineWithTimeout,
} from '../bin/run-pipeline';
import type { ReproPipelineOutcome } from '../core/agents/run-v2';
import { DossierStore } from '../core/agents/analyst/dossier';
import type { ReproCandidateEvaluation, ReproV2Outcome } from '../core/agents/repro-loop-v2/orchestrator';
import type { DeterministicExecutorResult } from '../core/agents/repro-loop-v2/executor';

function makeExecutor(
  outcome: DeterministicExecutorResult['outcome'],
  reason: string
): DeterministicExecutorResult {
  return {
    outcome,
    candidateTestPath: 'tests/test_repro_issue.py',
    sentinelString: 'sentinel-hit',
    expectedFailureSignature: null,
    ranReproCount: 2,
    lastReproExitCode: outcome === 'unexpected_pass' ? 0 : 1,
    runs: [],
    reproducedReliably: false,
    signatureMatched: true,
    missingCredentials: [],
    installFailures: [],
    reason,
  };
}

function makeOutcome(args: {
  status: ReproPipelineOutcome['status'];
  message?: string;
  candidates?: ReproCandidateEvaluation[];
  dossier?: DossierStore;
}): ReproPipelineOutcome {
  const message = args.message ?? 'repro pipeline message';
  const v2: ReproV2Outcome = {
    status: args.status,
    dossier: args.dossier ?? new DossierStore(),
    message,
    candidates: args.candidates ?? [],
  };
  return {
    ok: args.status === 'reproduced',
    status: args.status,
    message,
    v2,
  };
}

describe('classifyAlreadyFixedOnMain', () => {
  test('flags deterministic unexpected_pass as already fixed', () => {
    const outcome = makeOutcome({
      status: 'not_reproduced',
      candidates: [
        {
          candidateId: 'candidate-0',
          source: 'builder',
          sampleIndex: 0,
          status: 'invalid',
          message: 'oracle rejected',
          executor: makeExecutor('unexpected_pass', 'Unexpected pass: test passed on both runs (exit=0).'),
        },
      ],
    });

    const result = classifyAlreadyFixedOnMain(outcome);

    expect(result.alreadyFixedOnMain).toBe(true);
    expect(result.reason).toContain('Unexpected pass');
  });

  test('flags builder run_repro_pass + prober_failed as already fixed', () => {
    const outcome = makeOutcome({
      status: 'not_reproduced',
      candidates: [
        {
          candidateId: 'candidate-0',
          source: 'builder',
          sampleIndex: 0,
          status: 'generation_failed',
          message: 'Builder candidate passed on every run (2/2).',
          builderRejectStage: 'run_repro_pass',
        },
      ],
    });

    const result = classifyAlreadyFixedOnMain(outcome);

    expect(result.alreadyFixedOnMain).toBe(true);
    expect(result.reason).toContain('passed on every run');
  });

  test('does not flag unrelated builder generation failure', () => {
    const outcome = makeOutcome({
      status: 'not_reproduced',
      candidates: [
        {
          candidateId: 'candidate-0',
          source: 'builder',
          sampleIndex: 0,
          status: 'generation_failed',
          message: 'Builder could not draft a valid recipe.',
        },
      ],
    });

    const result = classifyAlreadyFixedOnMain(outcome);

    expect(result.alreadyFixedOnMain).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  test('does not flag credential-required terminal state', () => {
    const outcome = makeOutcome({
      status: 'credentials_required',
      message: 'Missing credential OPENAI_API_KEY in sandbox runtime.',
    });

    const result = classifyAlreadyFixedOnMain(outcome);

    expect(result.alreadyFixedOnMain).toBe(false);
  });
});

describe('buildNotReproducedRunDiagnostics', () => {
  test('emits structured diagnostics for not_reproduced outcomes', () => {
    const dossier = new DossierStore();
    dossier.append({
      issueNumber: 48,
      attemptId: 'attempt-diag',
      evidence: [],
      suspectFiles: ['python/instrumentation/foo.py'],
      suspectSymbols: [
        {
          file: 'python/instrumentation/foo.py',
          symbol: 'Instrumentor',
          reasoning: 'semantic hit',
        },
      ],
      semanticConfidence: {
        top_score: 0.41,
        low_confidence: true,
        diagnostics: 'semantic top_score=0.410 below threshold 0.600; suspects are low-confidence',
      },
      openQuestions: [],
      summary: 'low confidence',
      confidence: 'low',
    });

    const outcome = makeOutcome({
      status: 'not_reproduced',
      message:
        'Analyst terminated without producing a dossier (error: [credits-exhausted] 402 Payment Required: insufficient credit balance)',
      candidates: [
        {
          candidateId: 'candidate-0',
          source: 'builder',
          sampleIndex: 0,
          status: 'invalid',
          message: 'Deterministic repro oracle rejected candidate.',
          executor: {
            outcome: 'fails_reliably',
            candidateTestPath: 'tests/test_repro.py',
            sentinelString: 'REPRO_SENTINEL',
            expectedFailureSignature: null,
            ranReproCount: 2,
            lastReproExitCode: 1,
            runs: [
              { runId: 1, exitCode: 1, stderrTail: 'AssertionError', stdoutTail: '', durationMs: 10 },
              { runId: 2, exitCode: 1, stderrTail: 'AssertionError', stdoutTail: '', durationMs: 12 },
            ],
            reproducedReliably: true,
            signatureMatched: true,
            missingCredentials: [],
            installFailures: [],
            reason: 'failing',
          },
          oracle: {
            verdict: 'invalid',
            criteria: {
              baseline_head_fails: true,
              reliable_failures: true,
              suspect_path_assertions: false,
              precondition_assertions: true,
              ast_preflight: true,
            },
            message: 'missing suspect_path_assertions',
            executor: {} as any,
            suspectPathAssertionResult: {
              passed: false,
              missing: [{ kind: 'symbol', needle: 'Instrumentor', file: 'python/instrumentation/foo.py' }],
            },
            preconditionAssertionResult: { passed: true, missingMarkers: [] },
            astReason: null,
            credentialsTerminal: null,
          },
        } as any,
        {
          candidateId: 'candidate-1',
          source: 'prober',
          sampleIndex: 1,
          status: 'generation_failed',
          message: 'Prober sample terminated without recipe ([rate-limited] 429)',
          prober: {
            terminated: 'error',
            reason: '[rate-limited] 429',
            turns: 4,
            toolCalls: 6,
            toolCallsByTier: {
              read: 2,
              note: 0,
              'write-test': 1,
              mutation: 0,
              sandbox: 3,
              meta: 0,
            },
            transcriptSummary: 'run_repro(0)',
            text: '',
            recipeSnapshot: null,
            recipe: null,
            verbatimIncompatibleHint: false,
            transcript: [],
            ranReproCount: 0,
            lastReproExitCode: null,
            verifiedSummary: 'run_repro_ok=0',
          },
        } as any,
      ],
      dossier,
    });

    const diagnostics = buildNotReproducedRunDiagnostics(outcome);

    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.semantic_confidence).toEqual({
      top_score: 0.41,
      low_confidence: true,
      diagnostics: 'semantic top_score=0.410 below threshold 0.600; suspects are low-confidence',
      files_returned: ['python/instrumentation/foo.py'],
    });
    expect(diagnostics?.analyst).toEqual({
      has_suspect_symbols: true,
      suspect_symbol_count: 1,
    });
    expect(diagnostics?.oracle.by_candidate[0]?.failed_criteria).toEqual(['suspect_path_assertions']);
    expect(diagnostics?.run_repro.any_executed).toBe(true);
    expect(diagnostics?.run_repro.total_calls).toBe(2);
    expect(diagnostics?.run_repro.errored_before_execution[0]?.candidate_id).toBe('candidate-1');
    expect(diagnostics?.llm_quota_failure?.stage).toBe('analyst');
    expect(diagnostics?.llm_quota_failure?.reason).toContain('credits-exhausted');
  });

  test('returns null for non-not_reproduced outcomes', () => {
    const diagnostics = buildNotReproducedRunDiagnostics(makeOutcome({ status: 'reproduced' }));
    expect(diagnostics).toBeNull();
  });
});

describe('buildApiUnavailableRunDiagnostics', () => {
  test('emits structured diagnostics for api_unavailable outcomes', () => {
    const outcome = makeOutcome({
      status: 'api_unavailable',
      message: 'Analyst API preflight failed ([credits-exhausted] 402 Payment Required)',
    });
    outcome.v2.apiUnavailable = {
      stage: 'analyst_preflight',
      reason: '[credits-exhausted] 402 Payment Required',
      routeId: 'openrouter:k1:m1',
      modelId: 'anthropic/claude-sonnet-4.5',
    };

    const diagnostics = buildApiUnavailableRunDiagnostics(outcome);

    expect(diagnostics).toEqual({
      reason: 'Analyst API preflight failed ([credits-exhausted] 402 Payment Required)',
      api_preflight: {
        stage: 'analyst_preflight',
        route_id: 'openrouter:k1:m1',
        model_id: 'anthropic/claude-sonnet-4.5',
        failure_reason: '[credits-exhausted] 402 Payment Required',
      },
    });
  });

  test('returns null for non-api_unavailable outcomes', () => {
    const diagnostics = buildApiUnavailableRunDiagnostics(makeOutcome({ status: 'not_reproduced' }));
    expect(diagnostics).toBeNull();
  });
});

describe('buildSandboxFailedRunDiagnostics', () => {
  test('emits structured diagnostics for sandbox_failed outcomes', () => {
    const outcome = makeOutcome({
      status: 'sandbox_failed',
      message: 'Sandbox execution failed before runnable repro evidence',
      candidates: [
        {
          candidateId: 'candidate-0',
          source: 'builder',
          sampleIndex: 0,
          status: 'sandbox_failed',
          message: 'Sandbox execution failed before runnable repro evidence: setup/import_verification_failed',
          oracle: {
            verdict: 'sandbox_failed',
            criteria: {
              baseline_head_fails: false,
              reliable_failures: false,
              suspect_path_assertions: false,
              precondition_assertions: true,
              ast_preflight: true,
            },
            message: 'sandbox failed',
            executor: {} as any,
            suspectPathAssertionResult: { passed: false, missing: [] },
            preconditionAssertionResult: { passed: true, missingMarkers: [] },
            astReason: null,
            sandboxResult: {
              ok: false,
              reproStatus: 'not_executed',
              failureOutput: '',
              sentinelMatched: false,
              suspectPathHit: false,
              installManifest: [{ name: 'openinference-instrumentation-smolagents', version: '0.1.0' }],
              phaseFailures: [
                {
                  ok: false,
                  phase: 'setup',
                  reason: 'import_verification_failed',
                  failedStep: 5,
                  stdout: '',
                  stderr: 'ImportError: cannot import name SmolagentsInstrumentor',
                  diagnostics: {
                    sandboxWorkflowRepo: 'BandaruDheeraj/oss-support-agent',
                    targetRepo: 'BandaruDheeraj/openinference',
                  },
                },
              ],
              rawLogs: 'setup logs',
            },
            credentialsTerminal: null,
          },
        } as any,
      ],
    });

    const diagnostics = buildSandboxFailedRunDiagnostics({
      outcome,
      targetRepo: 'BandaruDheeraj/openinference',
      sandboxWorkflowRepo: 'BandaruDheeraj/oss-support-agent',
      sandboxWorkflowRef: 'main',
    });

    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.sandbox_workflow).toEqual({
      configured_repo: 'BandaruDheeraj/oss-support-agent',
      configured_ref: 'main',
      target_repo: 'BandaruDheeraj/openinference',
      configured_repo_is_target_repo: false,
    });
    expect(diagnostics?.runnable_candidates.count).toBe(0);
    expect(diagnostics?.candidates[0]?.phase_failures[0]?.reason).toBe('import_verification_failed');
    expect(diagnostics?.candidates[0]?.import_verification.passed).toBe(false);
    expect(diagnostics?.oracle.by_candidate[0]?.failed_criteria).toContain('sandbox_failed');
  });

  test('returns null for non-sandbox_failed outcomes', () => {
    const diagnostics = buildSandboxFailedRunDiagnostics({
      outcome: makeOutcome({ status: 'not_reproduced' }),
      targetRepo: 'BandaruDheeraj/openinference',
      sandboxWorkflowRepo: 'BandaruDheeraj/oss-support-agent',
      sandboxWorkflowRef: 'main',
    });

    expect(diagnostics).toBeNull();
  });
});

describe('classifyNotReproducedAsApiUnavailable', () => {
  test('classifies not_reproduced as api unavailable when quota failure happened before any repro execution', () => {
    const outcome = makeOutcome({
      status: 'not_reproduced',
      message: 'Deterministic repro oracle rejected all 4 candidates.',
      candidates: [
        {
          candidateId: 'candidate-0',
          source: 'builder',
          sampleIndex: 0,
          status: 'generation_failed',
          message: 'Builder did not produce a candidate recipe.',
          builderRejectStage: 'no_candidate',
        },
        {
          candidateId: 'candidate-1',
          source: 'prober',
          sampleIndex: 1,
          status: 'generation_failed',
          message: 'Prober sample terminated without recipe (Key limit exceeded (total limit).)',
          prober: {
            terminated: 'error',
            reason: 'Key limit exceeded (total limit).',
            turns: 0,
            toolCalls: 0,
            toolCallsByTier: {
              read: 0,
              note: 0,
              'write-test': 0,
              mutation: 0,
              sandbox: 0,
              meta: 0,
            },
            transcriptSummary: 'run_repro(0)',
            text: '',
            recipeSnapshot: null,
            recipe: null,
            verbatimIncompatibleHint: false,
            transcript: [],
            ranReproCount: 0,
            lastReproExitCode: null,
            verifiedSummary: 'run_repro_ok=0',
          },
        } as any,
      ],
    });

    const classified = classifyNotReproducedAsApiUnavailable(outcome);

    expect(classified).toEqual({
      reason:
        'LLM provider unavailable before repro execution (prober/candidate-1): Key limit exceeded (total limit).',
      failureReason: 'Key limit exceeded (total limit).',
    });
  });

  test('does not classify when repro execution actually happened', () => {
    const outcome = makeOutcome({
      status: 'not_reproduced',
      candidates: [
        {
          candidateId: 'candidate-0',
          source: 'builder',
          sampleIndex: 0,
          status: 'invalid',
          message: 'Deterministic repro oracle rejected candidate.',
          executor: {
            ...makeExecutor('reproduced', 'failing'),
            runs: [
              {
                runId: 1,
                exitCode: 1,
                stdoutTail: '',
                stderrTail: 'AssertionError',
                durationMs: 10,
                sentinelObserved: true,
                signatureObserved: true,
              },
              {
                runId: 2,
                exitCode: 1,
                stdoutTail: '',
                stderrTail: 'AssertionError',
                durationMs: 12,
                sentinelObserved: true,
                signatureObserved: true,
              },
            ],
          },
          oracle: {
            verdict: 'invalid',
            criteria: {
              baseline_head_fails: true,
              reliable_failures: true,
              suspect_path_assertions: false,
              precondition_assertions: true,
              ast_preflight: true,
            },
            message: 'missing suspect_path_assertions',
            executor: {} as any,
            suspectPathAssertionResult: { passed: false, missing: [] },
            preconditionAssertionResult: { passed: true, missingMarkers: [] },
            astReason: null,
            credentialsTerminal: null,
          },
        } as any,
        {
          candidateId: 'candidate-1',
          source: 'prober',
          sampleIndex: 1,
          status: 'generation_failed',
          message: 'Prober sample terminated without recipe ([rate-limited] 429)',
          prober: {
            terminated: 'error',
            reason: '[rate-limited] 429',
            turns: 2,
            toolCalls: 3,
            toolCallsByTier: {
              read: 1,
              note: 0,
              'write-test': 0,
              mutation: 0,
              sandbox: 2,
              meta: 0,
            },
            transcriptSummary: 'run_repro(0)',
            text: '',
            recipeSnapshot: null,
            recipe: null,
            verbatimIncompatibleHint: false,
            transcript: [],
            ranReproCount: 0,
            lastReproExitCode: null,
            verifiedSummary: 'run_repro_ok=0',
          },
        } as any,
      ],
    });

    expect(classifyNotReproducedAsApiUnavailable(outcome)).toBeNull();
  });
});

describe('runReproPipelineWithTimeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns repro outcome when run finishes before timeout', async () => {
    const expected = makeOutcome({ status: 'not_reproduced', message: 'no repro' });
    const result = await runReproPipelineWithTimeout({
      attemptId: 'attempt-fast',
      timeoutMs: 5_000,
      run: async () => expected,
      log: () => {},
    });
    expect(result).toBe(expected);
  });

  test('throws ReproStageTimeoutError when repro stage exceeds timeout', async () => {
    jest.useFakeTimers();
    const pending = runReproPipelineWithTimeout({
      attemptId: 'attempt-timeout',
      timeoutMs: 10,
      run: async () => await new Promise<ReproPipelineOutcome>(() => {}),
      log: () => {},
    });

    const rejection = expect(pending).rejects.toThrow('repro_stage_timeout');
    await jest.advanceTimersByTimeAsync(10);
    await rejection;
    await expect(pending).rejects.toBeInstanceOf(ReproStageTimeoutError);
  });
});

describe('resolveReproStageTimeoutMs', () => {
  test('returns default timeout when env value is missing or invalid', () => {
    expect(resolveReproStageTimeoutMs({})).toBe(60 * 60 * 1000);
    expect(resolveReproStageTimeoutMs({ OSA_REPRO_STAGE_TIMEOUT_MS: 'invalid' })).toBe(60 * 60 * 1000);
    expect(resolveReproStageTimeoutMs({ OSA_REPRO_STAGE_TIMEOUT_MS: '0' })).toBe(60 * 60 * 1000);
  });

  test('returns configured timeout from env', () => {
    expect(resolveReproStageTimeoutMs({ OSA_REPRO_STAGE_TIMEOUT_MS: '45000' })).toBe(45_000);
  });
});
