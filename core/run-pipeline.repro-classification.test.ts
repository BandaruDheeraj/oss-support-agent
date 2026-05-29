import { classifyAlreadyFixedOnMain } from '../bin/run-pipeline';
import type { ReproPipelineOutcome } from '../core/agents/run-v2';
import { DossierStore } from '../core/agents/analyst/dossier';
import type { ReproV2Outcome } from '../core/agents/repro-loop-v2/orchestrator';
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
  builderRejectStage?: ReproV2Outcome['builderRejectStage'];
  executor?: DeterministicExecutorResult;
}): ReproPipelineOutcome {
  const message = args.message ?? 'repro pipeline message';
  const v2: ReproV2Outcome = {
    status: args.status,
    dossier: new DossierStore(),
    message,
    builderRejectStage: args.builderRejectStage,
    executor: args.executor,
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
      status: 'executor_failed',
      executor: makeExecutor(
        'unexpected_pass',
        'Unexpected pass: test passed on both runs (exit=0).'
      ),
    });

    const result = classifyAlreadyFixedOnMain(outcome);

    expect(result.alreadyFixedOnMain).toBe(true);
    expect(result.reason).toContain('Unexpected pass');
  });

  test('flags builder run_repro_pass + prober_failed as already fixed', () => {
    const outcome = makeOutcome({
      status: 'prober_failed',
      builderRejectStage: 'run_repro_pass',
      message: 'Builder candidate passed on every run (2/2).',
    });

    const result = classifyAlreadyFixedOnMain(outcome);

    expect(result.alreadyFixedOnMain).toBe(true);
    expect(result.reason).toContain('passed on every run');
  });

  test('does not flag unrelated prober failure', () => {
    const outcome = makeOutcome({
      status: 'prober_failed',
      builderRejectStage: 'schema_invalid',
      message: 'Prober could not draft a valid recipe.',
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
