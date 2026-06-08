import { DossierStore, type ReproRecipe } from '../analyst/dossier';
import { runReproV2 } from './orchestrator';
import { runAnalyst } from '../analyst/analyst';
import { runReproBuilder } from './builder';
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
jest.mock('./deterministic-oracle', () => ({ runDeterministicReproOracle: jest.fn() }));
jest.mock('./advisory-ranker', () => ({ rankValidReproCandidates: jest.fn() }));

const runAnalystMock = jest.mocked(runAnalyst);
const runReproBuilderMock = jest.mocked(runReproBuilder);
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
  githubReadFile: async () => null,
  writeTest: async () => {},
  applyPatch: async () => ({ patchId: 'patch-1' }),
  revertFile: async () => {},
  commitAndPush: async () => ({ sha: 'abc123', pushedFiles: [] }),
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
    sandboxResult: null,
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

function makeCandidateRepro(path = 'tests/repro/test_issue_42_candidate_seed.py') {
  return {
    version: 1 as const,
    source: 'direct_call' as const,
    failureMode: 'unexpected_exception' as const,
    expectedExceptionType: 'AssertionError',
    candidateTestPath: path,
    imports: ['from src.module import broken_symbol'],
    setup: '',
    exerciseCall: 'broken_symbol()',
    sentinel: 'REPRO_BROKEN_SYMBOL_SEED_42',
    pipInstalls: [],
    requiresCredentials: [],
    preconditionsSatisfied: [],
    rationale: 'seeded deterministic candidate',
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
      candidateRepro: makeCandidateRepro(),
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
    expect(runDeterministicOracleMock).not.toHaveBeenCalled();
  });

  test('hard-stops as not_runnable when semantic-seeded analyst dossier omits candidateRepro', async () => {
    runAnalystMock.mockImplementationOnce(async (args: RunAnalystArgs) => {
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
        summary: 'seed dossier without candidate',
        confidence: 'medium',
      });
      return {
        snapshot,
        terminated: 'done',
        toolCalls: 1,
        transcriptSummary: 'ok',
      };
    });

    const outcome = await runReproV2({
      attemptId: 'attempt-stage3-not-runnable',
      issue,
      repo,
      workspace,
      sandbox,
      semanticSuspectSeed: {
        model: 'BAAI/bge-small-en-v1.5',
        query: 'issue query',
        cacheHit: true,
        cacheKey: 'seed-cache',
        indexedFileCount: 12,
        instrumentationDirs: ['src'],
        suspectFiles: ['src/module.py'],
        suspectSymbols: [
          {
            file: 'src/module.py',
            symbol: 'broken_symbol',
            reasoning: 'semantic hit',
          },
        ],
        semanticConfidence: {
          top_score: 0.74,
          low_confidence: false,
          diagnostics: 'semantic top_score=0.740',
        },
      },
    });

    expect(outcome.status).toBe('not_runnable');
    expect(outcome.message).toContain('candidateRepro');
    expect(runReproBuilderMock).not.toHaveBeenCalled();
    expect(runDeterministicOracleMock).not.toHaveBeenCalled();
  });

  test('builder returns not_reproduced when oracle rejects candidate', async () => {
    runReproBuilderMock.mockResolvedValue({
      ok: false,
      rejectStage: 'no_candidate',
      reason: 'No candidate',
      runs: [],
    });
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

    expect(runDeterministicOracleMock).not.toHaveBeenCalled();
    expect(rankValidReproCandidatesMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe('not_reproduced');
    expect(outcome.candidates).toHaveLength(1);
  });

  test('returns sandbox_failed when all candidates fail sandbox lifecycle before runnable repro evidence', async () => {
    runReproBuilderMock.mockResolvedValue({
      ok: true,
      recipe: makeRecipe('builder'),
      reason: 'Builder produced candidate',
      runs: [],
    });
    runDeterministicOracleMock.mockResolvedValue(
      makeOracleResult({
        verdict: 'sandbox_failed',
        message: 'Sandbox execution failed before runnable repro evidence: branch_push_unconfirmed',
      })
    );

    const outcome = await runReproV2({
      attemptId: 'attempt-stage3-sandbox-failed',
      issue,
      repo,
      workspace,
      sandbox,
    });

    expect(outcome.status).toBe('sandbox_failed');
    expect(outcome.candidates.every((candidate) => candidate.status === 'sandbox_failed')).toBe(true);
    expect(outcome.message).toContain('sandbox_failed');
  });

  test('returns credentials_required when builder detects missing credentials', async () => {
    runReproBuilderMock.mockResolvedValue({
      ok: false,
      rejectStage: 'sandbox_error',
      reason: 'Required credentials not set: OPENAI_API_KEY',
      runs: [],
      missingCredentials: ['OPENAI_API_KEY'],
    });
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
    });

    expect(outcome.status).toBe('credentials_required');
    expect(outcome.credentialsTerminal?.inferredEnvVars).toContain('OPENAI_API_KEY');
  });
});
