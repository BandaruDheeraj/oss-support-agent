import {
  classifyAlreadyFixedOnMain,
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
}): ReproPipelineOutcome {
  const message = args.message ?? 'repro pipeline message';
  const v2: ReproV2Outcome = {
    status: args.status,
    dossier: new DossierStore(),
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

  test('does not flag unrelated prober failure', () => {
    const outcome = makeOutcome({
      status: 'not_reproduced',
      candidates: [
        {
          candidateId: 'candidate-1',
          source: 'prober',
          sampleIndex: 1,
          status: 'generation_failed',
          message: 'Prober could not draft a valid recipe.',
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
    expect(resolveReproStageTimeoutMs({})).toBe(20 * 60 * 1000);
    expect(resolveReproStageTimeoutMs({ OSA_REPRO_STAGE_TIMEOUT_MS: 'invalid' })).toBe(20 * 60 * 1000);
    expect(resolveReproStageTimeoutMs({ OSA_REPRO_STAGE_TIMEOUT_MS: '0' })).toBe(20 * 60 * 1000);
  });

  test('returns configured timeout from env', () => {
    expect(resolveReproStageTimeoutMs({ OSA_REPRO_STAGE_TIMEOUT_MS: '45000' })).toBe(45_000);
  });
});
