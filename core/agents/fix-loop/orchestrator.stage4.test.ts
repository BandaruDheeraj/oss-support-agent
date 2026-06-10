import { DossierStore } from '../analyst/dossier';
import { runFixV2 } from './orchestrator';
import { runFixInvestigator } from './investigator';
import { runFixPlanner } from './planner';
import { runFixExecutor, type FixExecutorResult } from './executor';
import { runFixCritic } from './critic';
import type { InvestigationNotes } from './investigation-notes';
import type { Plan, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';

jest.mock('./investigator');
jest.mock('./planner');
jest.mock('./executor');
jest.mock('./critic');

const runFixInvestigatorMock = runFixInvestigator as jest.MockedFunction<typeof runFixInvestigator>;
const runFixPlannerMock = runFixPlanner as jest.MockedFunction<typeof runFixPlanner>;
const runFixExecutorMock = runFixExecutor as jest.MockedFunction<typeof runFixExecutor>;
const runFixCriticMock = runFixCritic as jest.MockedFunction<typeof runFixCritic>;

const issue = {
  number: 42,
  title: 'Fix failing path',
  body: '',
  labels: [],
  url: 'https://example.com/issues/42',
};

const repo = {
  fullName: 'owner/repo',
  forkFullName: 'owner/repo',
  branch: 'fix-branch',
  baselineSha: 'base',
  affectedModule: 'src',
  language: 'python' as const,
};

function makeWorkspace(diff = ''): WorkspaceReader & WorkspaceWriter {
  return {
    readFile: jest.fn(async () => null),
    listDir: jest.fn(async () => []),
    grep: jest.fn(async () => []),
    readDiff: jest.fn(async () => diff),
    gitLog: jest.fn(async () => []),
    gitBlame: jest.fn(async () => []),
    changedFiles: jest.fn(async () => []),
    githubReadFile: jest.fn(async () => null),
    writeTest: jest.fn(async () => {}),
    applyPatch: jest.fn(async () => ({ patchId: 'p1' })),
    revertFile: jest.fn(async () => {}),
    commitAndPush: jest.fn(async () => ({ sha: 'abc123', pushedFiles: [] })),
    testRoots: jest.fn(() => ['tests']),
    affectedModule: jest.fn(() => 'src'),
    reproTestPath: jest.fn(() => 'tests/test_repro.py'),
  };
}

function makeSandbox(): SandboxHandle {
  return {
    setReproTestPath: jest.fn(),
    runRepro: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 })),
    runTests: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 })),
    runPython: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 })),
    pipInstall: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 })),
    pythonModuleCheck: jest.fn(async () => ({ importable: true })),
    listPackages: jest.fn(async () => []),
  };
}

function makeNotes(snapshotId: string): InvestigationNotes {
  return {
    notesId: 'note-1',
    createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    body: {
      issueNumber: issue.number,
      attemptId: 'attempt-1',
      dossierSnapshotId: snapshotId,
      findings: [],
      rootCauseHypothesis: 'root cause',
      suggestedApproach: 'fix it',
      risks: [],
      confidence: 'medium',
    },
  };
}

function makePlan(): Plan {
  return {
    summary: 'plan summary',
    steps: [
      {
        stepId: 's1',
        goal: 'edit file',
        hypothesisSummary: 'because reason',
        successCheck: 'run_repro green && run_tests green',
        files: ['src/module.py'],
        risk: 'low',
      },
    ],
  };
}

function makeExecutorResult(overrides: Partial<FixExecutorResult> = {}): FixExecutorResult {
  return {
    text: '',
    terminated: 'done',
    reason: undefined,
    turns: 1,
    toolCalls: 1,
    toolCallsByTier: { read: 1, note: 0, 'write-test': 0, mutation: 0, sandbox: 1, meta: 0 },
    transcriptSummary: 'ok',
    greenEvidence: {
      lastMutationTurn: 1,
      reproGreenAfterMutation: true,
      testsGreenAfterMutation: true,
      lastReproRun: { exitCode: 0, stdout: '', stderr: '', durationMs: 1 },
      lastTestsRun: { exitCode: 0, stdout: '', stderr: '', durationMs: 1 },
    },
    changedFiles: ['src/module.py'],
    unconsumedHypothesisFiles: [],
    pushedShas: [],
    ...overrides,
  };
}

function makeDossier() {
  const dossier = new DossierStore();
  const snapshot = dossier.append({
    issueNumber: issue.number,
    attemptId: 'attempt-1',
    evidence: [
      {
        id: 'e1',
        kind: 'file_excerpt',
        source: 'src/module.py',
        summary: 'suspect module',
        recordedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      },
    ],
    suspectSymbols: [{ file: 'src/module.py', symbol: 'broken_symbol', reasoning: 'traceback points here' }],
    preconditions: [],
    openQuestions: [],
    summary: 'dossier summary',
    confidence: 'medium',
    oracleSpec: {
      suspect_path_assertions: [{ kind: 'symbol', needle: 'broken_symbol', file: 'src/module.py' }],
      precondition_assertions: [],
    },
  });
  return { dossier, snapshot };
}

describe('runFixV2 stage4 loop', () => {
  const originalMaxIterations = process.env.FIX_V2_MAX_ITERATIONS;
  const originalTokenBudget = process.env.FIX_V2_TOKEN_BUDGET;

  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.FIX_V2_MAX_ITERATIONS;
    delete process.env.FIX_V2_TOKEN_BUDGET;
  });

  afterAll(() => {
    if (originalMaxIterations === undefined) delete process.env.FIX_V2_MAX_ITERATIONS;
    else process.env.FIX_V2_MAX_ITERATIONS = originalMaxIterations;

    if (originalTokenBudget === undefined) delete process.env.FIX_V2_TOKEN_BUDGET;
    else process.env.FIX_V2_TOKEN_BUDGET = originalTokenBudget;
  });

  test('retries on failed completion promise and approves with advisory critic verdict', async () => {
    const { dossier, snapshot } = makeDossier();
    const workspace = makeWorkspace();
    const sandbox = makeSandbox();
    const headMock = jest.fn(async () => 'sha-1');

    runFixInvestigatorMock.mockResolvedValue({
      notes: makeNotes(snapshot.snapshotId),
      terminated: 'done',
      reason: undefined,
      toolCalls: 1,
      transcriptSummary: 'ok',
    });
    runFixPlannerMock.mockResolvedValue({
      plan: makePlan(),
      terminated: 'done',
      reason: undefined,
      transcriptSummary: 'ok',
    });
    runFixExecutorMock
      .mockResolvedValueOnce(
        makeExecutorResult({
          greenEvidence: {
            lastMutationTurn: 1,
            reproGreenAfterMutation: false,
            testsGreenAfterMutation: false,
            lastReproRun: { exitCode: 1, stdout: '', stderr: 'assertion failed', durationMs: 1 },
            lastTestsRun: { exitCode: 1, stdout: '', stderr: 'regression failed', durationMs: 1 },
          },
          unconsumedHypothesisFiles: ['src/module.py'],
        })
      )
      .mockResolvedValueOnce(makeExecutorResult());

    runFixCriticMock.mockResolvedValue({
      verdict: {
        verdict: 'reject',
        reason: 'looks suspicious',
      },
      transcriptSummary: 'critic-summary',
    });

    const outcome = await runFixV2({
      attemptId: 'attempt-1',
      dossier,
      snapshot,
      reproTestPath: 'tests/test_repro.py',
      issue,
      repo,
      workspace,
      sandbox,
      getCurrentHeadSha: headMock,
    });

    expect(runFixInvestigatorMock).toHaveBeenCalledTimes(2);
    expect(runFixPlannerMock).toHaveBeenCalledTimes(2);
    expect(runFixExecutorMock).toHaveBeenCalledTimes(2);
    expect(runFixCriticMock).toHaveBeenCalledTimes(1);
    expect(runFixInvestigatorMock.mock.calls[1]?.[0].retryFeedback).toContain('failed_stage=completion_promise');
    expect(runFixInvestigatorMock.mock.calls[1]?.[0].retryFeedback).toContain(
      'unconsumed_hypothesis_files=src/module.py'
    );
    expect(outcome.status).toBe('fix_approved');
    expect(outcome.criticVerdict?.verdict).toBe('reject');
  });

  test('accepts the executor pushing its own commits as legitimate HEAD movement', async () => {
    process.env.FIX_V2_MAX_ITERATIONS = '1';

    const { dossier, snapshot } = makeDossier();
    const workspace = makeWorkspace();
    const sandbox = makeSandbox();
    // HEAD before the iteration is sha-0; the executor commits and pushes,
    // moving HEAD to sha-fix. Previously this failed no_head_drift and burned
    // the iteration despite green evidence (openinference#62).
    const headMock = jest
      .fn<Promise<string>, []>()
      .mockResolvedValueOnce('sha-0') // iteration baseline
      .mockResolvedValue('sha-fix'); // after executor + critic checks

    runFixInvestigatorMock.mockResolvedValue({
      notes: makeNotes(snapshot.snapshotId),
      terminated: 'done',
      reason: undefined,
      toolCalls: 1,
      transcriptSummary: 'ok',
    });
    runFixPlannerMock.mockResolvedValue({
      plan: makePlan(),
      terminated: 'done',
      reason: undefined,
      transcriptSummary: 'ok',
    });
    runFixExecutorMock.mockResolvedValue(makeExecutorResult({ pushedShas: ['sha-fix'] }));
    runFixCriticMock.mockResolvedValue({
      verdict: { verdict: 'approve', reason: 'fix verified' },
      transcriptSummary: 'critic-summary',
    });

    const outcome = await runFixV2({
      attemptId: 'attempt-1',
      dossier,
      snapshot,
      reproTestPath: 'tests/test_repro.py',
      issue,
      repo,
      workspace,
      sandbox,
      getCurrentHeadSha: headMock,
    });

    expect(runFixExecutorMock).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('fix_approved');
  });

  test('still fails no_head_drift when HEAD moves to a commit the executor did not push', async () => {
    process.env.FIX_V2_MAX_ITERATIONS = '1';

    const { dossier, snapshot } = makeDossier();
    const workspace = makeWorkspace();
    const sandbox = makeSandbox();
    const headMock = jest
      .fn<Promise<string>, []>()
      .mockResolvedValueOnce('sha-0')
      .mockResolvedValue('sha-foreign'); // someone else pushed

    runFixInvestigatorMock.mockResolvedValue({
      notes: makeNotes(snapshot.snapshotId),
      terminated: 'done',
      reason: undefined,
      toolCalls: 1,
      transcriptSummary: 'ok',
    });
    runFixPlannerMock.mockResolvedValue({
      plan: makePlan(),
      terminated: 'done',
      reason: undefined,
      transcriptSummary: 'ok',
    });
    runFixExecutorMock.mockResolvedValue(makeExecutorResult({ pushedShas: ['sha-fix'] }));

    const outcome = await runFixV2({
      attemptId: 'attempt-1',
      dossier,
      snapshot,
      reproTestPath: 'tests/test_repro.py',
      issue,
      repo,
      workspace,
      sandbox,
      getCurrentHeadSha: headMock,
    });

    expect(runFixCriticMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe('fix_failed');
    expect(outcome.message).toContain('exhausted without satisfying deterministic completion promise');
  });

  test('returns fix_failed when iteration cap is hit without a green completion promise', async () => {
    process.env.FIX_V2_MAX_ITERATIONS = '1';

    const { dossier, snapshot } = makeDossier();
    const workspace = makeWorkspace();
    const sandbox = makeSandbox();
    const headMock = jest.fn(async () => 'sha-1');

    runFixInvestigatorMock.mockResolvedValue({
      notes: makeNotes(snapshot.snapshotId),
      terminated: 'done',
      reason: undefined,
      toolCalls: 1,
      transcriptSummary: 'ok',
    });
    runFixPlannerMock.mockResolvedValue({
      plan: makePlan(),
      terminated: 'done',
      reason: undefined,
      transcriptSummary: 'ok',
    });
    runFixExecutorMock.mockResolvedValue(
      makeExecutorResult({
        greenEvidence: {
          lastMutationTurn: 1,
          reproGreenAfterMutation: false,
          testsGreenAfterMutation: true,
          lastReproRun: { exitCode: 1, stdout: '', stderr: 'still failing', durationMs: 1 },
          lastTestsRun: { exitCode: 0, stdout: '', stderr: '', durationMs: 1 },
        },
      })
    );

    const outcome = await runFixV2({
      attemptId: 'attempt-1',
      dossier,
      snapshot,
      reproTestPath: 'tests/test_repro.py',
      issue,
      repo,
      workspace,
      sandbox,
      getCurrentHeadSha: headMock,
    });

    expect(runFixCriticMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe('fix_failed');
    expect(outcome.message).toContain('exhausted without satisfying deterministic completion promise');
  });

  test('applies deterministic structural veto for potential secret leakage', async () => {
    const { dossier, snapshot } = makeDossier();
    const workspace = makeWorkspace('+OPENAI_API_KEY = "sk-live-abcdef1234567890"\n');
    const sandbox = makeSandbox();
    const headMock = jest.fn(async () => 'sha-1');

    runFixInvestigatorMock.mockResolvedValue({
      notes: makeNotes(snapshot.snapshotId),
      terminated: 'done',
      reason: undefined,
      toolCalls: 1,
      transcriptSummary: 'ok',
    });
    runFixPlannerMock.mockResolvedValue({
      plan: makePlan(),
      terminated: 'done',
      reason: undefined,
      transcriptSummary: 'ok',
    });
    runFixExecutorMock.mockResolvedValue(
      makeExecutorResult({
        changedFiles: ['src/module.py'],
      })
    );
    runFixCriticMock.mockResolvedValue({
      verdict: {
        verdict: 'approve',
        reason: 'looks good',
        approvedDiffSha: 'sha-1',
      },
      transcriptSummary: 'critic-summary',
    });

    const outcome = await runFixV2({
      attemptId: 'attempt-1',
      dossier,
      snapshot,
      reproTestPath: 'tests/test_repro.py',
      issue,
      repo,
      workspace,
      sandbox,
      getCurrentHeadSha: headMock,
    });

    expect(runFixCriticMock).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('critic_rejected');
    expect(outcome.message).toContain('potential secret leakage');
  });
});
