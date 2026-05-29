import { runReproProber, shouldRecoverFromToolCallsEmptyTermination } from './prober';
import type { AgentLoopResult } from '../agent-loop';
import { runAgentLoop } from '../agent-loop';
import { DossierStore } from '../analyst/dossier';
import type {
  IssueHandle,
  RepoHandle,
  SandboxHandle,
  WorkspaceReader,
  WorkspaceWriter,
} from '../tools/handles';

jest.mock('../agent-loop', () => ({
  runAgentLoop: jest.fn(),
}));

function loopResult(overrides: Partial<AgentLoopResult> = {}): AgentLoopResult {
  return {
    text: '',
    terminated: 'finished',
    reason: 'finishReason=tool-calls; finalText=(empty)',
    turns: 1,
    toolCalls: 0,
    toolCallsByTier: {
      read: 0,
      note: 0,
      'write-test': 0,
      mutation: 0,
      sandbox: 0,
      meta: 0,
    },
    transcriptSummary: '(no tool calls)',
    ...overrides,
  };
}

function makeWorkspace(): WorkspaceReader & WorkspaceWriter {
  return {
    readFile: async () => null,
    listDir: async () => [],
    grep: async () => [],
    readDiff: async () => '',
    gitLog: async () => [],
    gitBlame: async () => [],
    changedFiles: async () => [],
    writeTest: async () => undefined,
    applyPatch: async () => ({ patchId: 'patch-1' }),
    revertFile: async () => undefined,
    testRoots: () => ['tests/'],
    affectedModule: () => 'src',
    reproTestPath: () => undefined,
  };
}

function makeSandbox(): SandboxHandle {
  return {
    setReproTestPath: () => undefined,
    runRepro: async () => ({ exitCode: 1, stdout: '', stderr: 'sentinel', durationMs: 1 }),
    runTests: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    runPython: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    pipInstall: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    pythonModuleCheck: async () => ({ importable: true, version: '1.0.0' }),
    listPackages: async () => [],
  };
}

function makeArgs() {
  const dossier = new DossierStore();
  const snapshot = dossier.append({
    issueNumber: 46,
    attemptId: 'attempt-1',
    evidence: [],
    suspectSymbols: [],
    openQuestions: [],
    summary: 'prober retry test',
    confidence: 'low',
  });
  const issue: IssueHandle = {
    number: 46,
    title: 'repro issue',
    body: 'body',
    labels: ['bug'],
    url: 'https://github.com/o/r/issues/46',
  };
  const repo: RepoHandle = {
    fullName: 'o/r',
    forkFullName: 'me/r',
    branch: 'agent/46',
    baselineSha: 'abc123',
    affectedModule: 'src',
    language: 'python',
  };

  return {
    attemptId: 'attempt-1',
    dossier,
    dossierSnapshot: snapshot,
    issue,
    repo,
    workspace: makeWorkspace(),
    sandbox: makeSandbox(),
  };
}

describe('shouldRecoverFromToolCallsEmptyTermination', () => {
  it('returns true for finished tool-calls empty termination', () => {
    expect(
      shouldRecoverFromToolCallsEmptyTermination(
        loopResult({ reason: 'finishReason=tool-calls; finalText=(empty)' }),
      ),
    ).toBe(true);
  });

  it('returns false for non-tool-calls reasons', () => {
    expect(
      shouldRecoverFromToolCallsEmptyTermination(
        loopResult({ reason: 'finishReason=stop; finalText="done"' }),
      ),
    ).toBe(false);
  });
});

describe('runReproProber retry behavior', () => {
  const mockedRunAgentLoop = runAgentLoop as jest.MockedFunction<typeof runAgentLoop>;

  beforeEach(() => {
    mockedRunAgentLoop.mockReset();
  });

  it('performs an extra recovery pass after repeated tool-calls empty termination', async () => {
    mockedRunAgentLoop
      .mockResolvedValueOnce(loopResult())
      .mockResolvedValueOnce(loopResult())
      .mockResolvedValueOnce(loopResult({ reason: 'finishReason=stop; finalText="waiting"' }));

    const result = await runReproProber(makeArgs());

    expect(mockedRunAgentLoop).toHaveBeenCalledTimes(3);
    expect(result.reason).toBe('finishReason=stop; finalText="waiting"');
  });

  it('stops after the plain-text reminder when termination is no longer tool-calls-empty', async () => {
    mockedRunAgentLoop
      .mockResolvedValueOnce(loopResult())
      .mockResolvedValueOnce(loopResult({ reason: 'finishReason=stop; finalText="use done"' }));

    await runReproProber(makeArgs());

    expect(mockedRunAgentLoop).toHaveBeenCalledTimes(2);
  });
});
