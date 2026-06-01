import { DossierStore, type ReproRecipe } from '../analyst/dossier';
import { runReproV2 } from './orchestrator';
import { runAnalyst } from '../analyst/analyst';
import { runReproBuilder } from './builder';
import { runReproProber } from './prober';
import { runDeterministicReproOracle } from './deterministic-oracle';
import { rankValidReproCandidates } from './advisory-ranker';
import type { DeterministicExecutorResult } from './executor';
import type {
  DeterministicReproOracleCriteria,
  DeterministicReproOracleResult,
} from './deterministic-oracle';
import type { RunAnalystArgs } from '../analyst/analyst';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';

jest.mock('../analyst/analyst', () => ({ runAnalyst: jest.fn() }));
jest.mock('./builder', () => ({ runReproBuilder: jest.fn() }));
jest.mock('./prober', () => ({ runReproProber: jest.fn() }));
jest.mock('./deterministic-oracle', () => ({ runDeterministicReproOracle: jest.fn() }));
jest.mock('./advisory-ranker', () => ({ rankValidReproCandidates: jest.fn() }));

const runAnalystMock = jest.mocked(runAnalyst);
const runReproBuilderMock = jest.mocked(runReproBuilder);
const runReproProberMock = jest.mocked(runReproProber);
const runDeterministicOracleMock = jest.mocked(runDeterministicReproOracle);
const rankValidReproCandidatesMock = jest.mocked(rankValidReproCandidates);

const issue: IssueHandle = {
  number: 42,
  title: 'Repro issue',
  body: 'body',
  labels: [],
  url: 'https://example.test/issue/42',
};

const repo: RepoHandle = {
  fullName: 'org/repo',
  forkFullName: 'fork/repo',
  branch: 'main',
  baselineSha: 'abc123',
  affectedModule: '.',
  language: 'python',
};

const workspace: WorkspaceReader & WorkspaceWriter = {
  readFile: async () => null,
  listDir: async () => [],
  grep: async () => [],
  readDiff: async () => '',
  gitLog: async () => [],
  gitBlame: async () => [],
  changedFiles: async () => [],
  writeTest: async () => {},
  applyPatch: async () => ({ patchId: 'patch-1' }),
  revertFile: async () => {},
  testRoots: () => ['tests'],
  affectedModule: () => '.',
  reproTestPath: () => undefined,
};

const sandbox: SandboxHandle = {
  setReproTestPath: () => {},
  runRepro: async () => ({ exitCode: 1, stdout: '', stderr: '', durationMs: 1 }),
  runTests: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
  runPython: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
  pipInstall: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
  pythonModuleCheck: async () => ({ importable: true }),
  listPackages: async () => [],
};

function makeRecipe(candidateId: string): ReproRecipe {
  return {
    version: 1,
    candidateTestPath: `tests/repro/${candidateId}.py`,
    testSource: 'def test_repro():\n    assert False, "boom"\n',
    sentinelString: 'AssertionError',
    expectedFailureSignature: 'AssertionError',
    pipInstalls: [],
    requiresCredentials: [],
    verbatimSnippetIncompatible: false,
    approach: 'direct-call',
    provenance: {
      exerciseImports: [],
      preconditionsSatisfied: [],
      observedProbe: {
        sentinelObserved: true,
        signatureObserved: true,
        exitCode: 1,
        durationMs: 25,
        stderrTail: 'AssertionError',
        stdoutTail: '',
      },
      proberAttempts: 1,
      recordedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    },
  };
}

function makeExecutor(outcome: DeterministicExecutorResult['outcome'], reason: string): DeterministicExecutorResult {
  return {
    outcome,
    candidateTestPath: 'tests/repro/test_repro.py',
    sentinelString: 'AssertionError',
    expectedFailureSignature: 'AssertionError',
    ranReproCount: 2,
    lastReproExitCode: outcome === 'unexpected_pass' ? 0 : 1,
    runs: [],
    reproducedReliably: outcome === 'reproduced',
    signatureMatched: true,
    missingCredentials: [],
    installFailures: [],
    reason,
  };
}

function makeProberResult(recipe: ReproRecipe) {
  return {
    text: '',
    terminated: 'done' as const,
    reason: undefined,
    turns: 1,
    toolCalls: 1,
    toolCallsByTier: { read: 0, note: 0, 'write-test': 0, mutation: 0, sandbox: 0, meta: 0 },
    transcriptSummary: 'done',
    recipeSnapshot: null,
    recipe,
    verbatimIncompatibleHint: false,
    transcript: [],
    ranReproCount: 2,
    lastReproExitCode: 1,
    verifiedSummary: 'ok',
  };
}

function makeOracleResult(args: {
  verdict: DeterministicReproOracleResult['verdict'];
  message: string;
  criteria?: Partial<DeterministicReproOracleCriteria>;
  executorOutcome?: DeterministicExecutorResult['outcome'];
  credentials?: string[];
}): DeterministicReproOracleResult {
  const criteria: DeterministicReproOracleCriteria = {
    baseline_head_fails: true,
    reliable_failures: true,
    suspect_path_assertions: true,
    precondition_assertions: true,
    ast_preflight: true,
    ...args.criteria,
  };
  const credentials = args.credentials ?? [];
  return {
    verdict: args.verdict,
    criteria,
    message: args.message,
    executor: makeExecutor(args.executorOutcome ?? 'reproduced', args.message),
    suspectPathAssertionResult: {
      passed: criteria.suspect_path_assertions,
      missing: [],
    },
    preconditionAssertionResult: {
      passed: criteria.precondition_assertions,
      missingMarkers: [],
    },
    astReason: criteria.ast_preflight ? null : 'AST preflight failed',
    credentialsTerminal:
      args.verdict === 'credentials_required'
        ? {
            inferredEnvVars: credentials,
            matchedPattern: 'mock-pattern',
            stderrTail: 'missing credentials',
          }
        : null,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  runAnalystMock.mockImplementation(async (args: RunAnalystArgs) => {
    const snapshot = args.dossier.append({
      issueNumber: args.issue.number,
      attemptId: args.attemptId,
      evidence: [
        {
          id: 'e1',
          kind: 'file_excerpt',
          source: 'src/module.py',
          summary: 'suspect summary',
          recordedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
        },
      ],
      suspectSymbols: [{ file: 'src/module.py', symbol: 'broken_symbol', reasoning: 'Issue stacktrace points here' }],
      preconditions: [],
      openQuestions: [],
      summary: 'seed dossier',
      confidence: 'medium',
      oracleSpec: {
        suspect_path_assertions: [{ kind: 'symbol', needle: 'broken_symbol', file: 'src/module.py' }],
        precondition_assertions: [],
      },
    });
    return {
      snapshot,
      terminated: 'done',
      toolCalls: 1,
      transcriptSummary: 'ok',
    };
  });
});

describe('runReproV2 stage3 orchestration', () => {
  test('returns api_unavailable when analyst preflight fails before dossier creation', async () => {
    runAnalystMock.mockResolvedValueOnce({
      snapshot: null,
      terminated: 'api_unavailable',
      reason: '[credits-exhausted] 402 Payment Required',
      apiUnavailable: {
        stage: 'analyst_preflight',
        reason: '[credits-exhausted] 402 Payment Required',
        routeId: 'openrouter:k1:m1',
        modelId: 'anthropic/claude-sonnet-4.5',
      },
      toolCalls: 0,
      transcriptSummary: '(analyst api preflight failed)',
    });

    const outcome = await runReproV2({
      attemptId: 'attempt-stage3-api-unavailable',
      issue,
      repo,
      workspace,
      sandbox,
    });

    expect(outcome.status).toBe('api_unavailable');
    expect(outcome.message).toContain('Analyst API preflight failed');
    expect(outcome.apiUnavailable).toEqual({
      stage: 'analyst_preflight',
      reason: '[credits-exhausted] 402 Payment Required',
      routeId: 'openrouter:k1:m1',
      modelId: 'anthropic/claude-sonnet-4.5',
    });
    expect(runReproBuilderMock).not.toHaveBeenCalled();
    expect(runReproProberMock).not.toHaveBeenCalled();
    expect(runDeterministicOracleMock).not.toHaveBeenCalled();
  });

  test('defaults to builder + 3 prober samples and returns not_reproduced when none pass oracle', async () => {
    runReproBuilderMock.mockResolvedValue({
      ok: false,
      rejectStage: 'no_candidate',
      reason: 'No candidate',
      runs: [],
    });
    runReproProberMock.mockImplementation(async ({ forcedCandidateTestPath }) =>
      makeProberResult(makeRecipe(forcedCandidateTestPath ?? 'fallback'))
    );
    runDeterministicOracleMock.mockResolvedValue(
      makeOracleResult({
        verdict: 'invalid',
        criteria: { suspect_path_assertions: false },
        message: 'suspect assertions failed',
      })
    );

    const outcome = await runReproV2({
      attemptId: 'attempt-stage3-default',
      issue,
      repo,
      workspace,
      sandbox,
    });

    expect(runReproProberMock).toHaveBeenCalledTimes(3);
    expect(runDeterministicOracleMock).toHaveBeenCalledTimes(3);
    expect(rankValidReproCandidatesMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe('not_reproduced');
    expect(outcome.candidates).toHaveLength(4);
  });

  test('halts with sandbox_setup_failed before prober sampling when OpenInference preflight fails', async () => {
    runReproBuilderMock.mockResolvedValue({
      ok: false,
      rejectStage: 'no_candidate',
      reason: 'No candidate',
      runs: [],
    });

    const pipInstall = jest.fn(async (spec: string) => ({
      exitCode: spec === '-e python/openinference-semantic-conventions' ? 1 : 0,
      stdout: '',
      stderr: spec === '-e python/openinference-semantic-conventions' ? 'editable install failed' : '',
      durationMs: 1,
    }));
    const runPython = jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }));

    const failingPreflightSandbox: SandboxHandle = {
      ...sandbox,
      pipInstall,
      runPython,
    };

    const outcome = await runReproV2({
      attemptId: 'attempt-stage3-preflight-fail',
      issue,
      repo: { ...repo, fullName: 'BandaruDheeraj/openinference' },
      workspace,
      sandbox: failingPreflightSandbox,
      proberSampleCount: 2,
    });

    expect(outcome.status).toBe('not_reproduced');
    expect(outcome.message).toContain('sandbox_setup_failed');
    expect(runReproProberMock).not.toHaveBeenCalled();
    expect(runDeterministicOracleMock).not.toHaveBeenCalled();
    expect(pipInstall).toHaveBeenCalledTimes(1);
    expect(runPython).not.toHaveBeenCalled();
    expect(outcome.candidates).toHaveLength(3);
    expect(outcome.candidates.filter((candidate) => candidate.source === 'prober')).toHaveLength(2);
    expect(
      outcome.candidates
        .filter((candidate) => candidate.source === 'prober')
        .every((candidate) => candidate.status === 'setup_failed')
    ).toBe(true);
    expect(
      outcome.candidates
        .filter((candidate) => candidate.source === 'prober')
        .every((candidate) => candidate.message.includes('sandbox_setup_failed'))
    ).toBe(true);
  });

  test('classifies prober dispatch ref errors as setup_failed candidates', async () => {
    runReproBuilderMock.mockResolvedValue({
      ok: false,
      rejectStage: 'no_candidate',
      reason: 'No candidate',
      runs: [],
    });
    runReproProberMock.mockRejectedValue(new Error('No ref found for: agent/scope-52'));

    const outcome = await runReproV2({
      attemptId: 'attempt-stage3-missing-ref',
      issue,
      repo,
      workspace,
      sandbox,
      proberSampleCount: 2,
    });

    expect(outcome.status).toBe('not_reproduced');
    expect(outcome.message).toContain('failed sandbox setup before oracle validation');
    const proberCandidates = outcome.candidates.filter((candidate) => candidate.source === 'prober');
    expect(proberCandidates).toHaveLength(2);
    expect(proberCandidates.every((candidate) => candidate.status === 'setup_failed')).toBe(true);
    expect(runDeterministicOracleMock).not.toHaveBeenCalled();
  });

  test('classifies non-authoritative wait_for_run termination as setup_failed', async () => {
    runReproBuilderMock.mockResolvedValue({
      ok: false,
      rejectStage: 'no_candidate',
      reason: 'No candidate',
      runs: [],
    });
    runReproProberMock.mockResolvedValue({
      text: '',
      terminated: 'abandon',
      reason:
        'sandbox_setup_failed: wait_for_run: Workflow run did not appear within 180000ms after dispatch',
      turns: 1,
      toolCalls: 1,
      toolCallsByTier: { read: 0, note: 0, 'write-test': 0, mutation: 0, sandbox: 1, meta: 0 },
      transcriptSummary: 'abandon',
      recipeSnapshot: null,
      recipe: null,
      verbatimIncompatibleHint: false,
      transcript: [
        {
          tool: 'run_repro',
          ok: false,
          result: {
            exitCode: 2,
            stdout: '',
            stderr: 'Workflow run did not appear within 180000ms after dispatch',
          },
        },
      ],
      ranReproCount: 0,
      lastReproExitCode: null,
      verifiedSummary: 'run_repro_positive_since_write=0',
    });

    const outcome = await runReproV2({
      attemptId: 'attempt-stage3-wait-for-run',
      issue,
      repo,
      workspace,
      sandbox,
      proberSampleCount: 1,
    });

    expect(outcome.status).toBe('not_reproduced');
    expect(outcome.message.startsWith('sandbox_setup_failed:')).toBe(true);
    const proberCandidate = outcome.candidates.find((candidate) => candidate.source === 'prober');
    expect(proberCandidate?.status).toBe('setup_failed');
    expect(proberCandidate?.message).toContain('wait_for_run');
    expect(runDeterministicOracleMock).not.toHaveBeenCalled();
  });

  test('ranks only valid candidates and selects ranked winner', async () => {
    runReproBuilderMock.mockResolvedValue({
      ok: true,
      recipe: makeRecipe('builder'),
      reason: 'Builder produced candidate',
      runs: [],
    });
    runReproProberMock.mockImplementation(async ({ forcedCandidateTestPath }) =>
      makeProberResult(makeRecipe(forcedCandidateTestPath ?? 'fallback'))
    );
    runDeterministicOracleMock.mockImplementation(async ({ recipe }) => {
      const isSample2 = recipe.candidateTestPath.includes('_candidate_2.py');
      const isBuilder = recipe.candidateTestPath.includes('builder');
      if (isBuilder || isSample2) {
        return makeOracleResult({
          verdict: 'valid',
          message: 'valid candidate',
        });
      }
      return makeOracleResult({
        verdict: 'invalid',
        criteria: { suspect_path_assertions: false },
        message: 'invalid candidate',
      });
    });
    rankValidReproCandidatesMock.mockResolvedValue({
      selectedCandidateId: 'candidate-2',
      reason: 'simpler test body',
      transcript: 'selected candidate-2',
    });

    const outcome = await runReproV2({
      attemptId: 'attempt-stage3-ranking',
      issue,
      repo,
      workspace,
      sandbox,
      proberSampleCount: 2,
    });

    expect(rankValidReproCandidatesMock).toHaveBeenCalledTimes(1);
    const rankedCandidateIds = rankValidReproCandidatesMock.mock.calls[0]![0].candidates.map(
      (candidate) => candidate.candidateId
    );
    expect(rankedCandidateIds).toEqual(['candidate-0', 'candidate-2']);
    expect(outcome.status).toBe('reproduced');
    expect(outcome.selectedCandidateId).toBe('candidate-2');
  });

  test('returns credentials_required when no valid candidate exists but credentials are required', async () => {
    runReproBuilderMock.mockResolvedValue({
      ok: false,
      rejectStage: 'sandbox_error',
      reason: 'Required credentials not set: OPENAI_API_KEY',
      runs: [],
      missingCredentials: ['OPENAI_API_KEY'],
    });
    runReproProberMock.mockResolvedValue(makeProberResult(makeRecipe('candidate-prober')));
    runDeterministicOracleMock.mockResolvedValue(
      makeOracleResult({
        verdict: 'invalid',
        criteria: { suspect_path_assertions: false },
        message: 'invalid candidate',
      })
    );

    const outcome = await runReproV2({
      attemptId: 'attempt-stage3-creds',
      issue,
      repo,
      workspace,
      sandbox,
      proberSampleCount: 1,
    });

    expect(outcome.status).toBe('credentials_required');
    expect(outcome.credentialsTerminal?.inferredEnvVars).toContain('OPENAI_API_KEY');
  });
});
