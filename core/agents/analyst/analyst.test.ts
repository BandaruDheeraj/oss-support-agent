import { runAnalyst } from './analyst';
import { DossierStore } from './dossier';
import { runAgentLoop, type AgentLoopResult } from '../agent-loop';
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

function makeLoopResult(overrides: Partial<AgentLoopResult> = {}): AgentLoopResult {
  return {
    text: '',
    terminated: 'done',
    reason: undefined,
    turns: 1,
    toolCalls: 1,
    toolCallsByTier: {
      read: 0,
      note: 1,
      'write-test': 0,
      mutation: 0,
      sandbox: 0,
      meta: 0,
    },
    transcriptSummary: 'record_evidence(1)',
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
    runRepro: async () => ({ exitCode: 1, stdout: '', stderr: '', durationMs: 1 }),
    runTests: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    runPython: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    pipInstall: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    pythonModuleCheck: async () => ({ importable: true, version: '1.0.0' }),
    listPackages: async () => [],
  };
}

function makeIssue(): IssueHandle {
  return {
    number: 48,
    title: 'google-genai sentry conflict',
    body: 'repro body',
    labels: ['bug'],
    url: 'https://github.com/o/r/issues/48',
  };
}

function makeRepo(): RepoHandle {
  return {
    fullName: 'o/r',
    forkFullName: 'me/r',
    branch: 'agent/scope-48',
    baselineSha: 'abc123',
    affectedModule: '.',
    language: 'python',
  };
}

describe('runAnalyst parse-recovery', () => {
  const mockedRunAgentLoop = runAgentLoop as jest.MockedFunction<typeof runAgentLoop>;

  beforeEach(() => {
    mockedRunAgentLoop.mockReset();
  });

  it('retries once after record_evidence JSON parse failure', async () => {
    const dossier = new DossierStore();
    let calls = 0;
    mockedRunAgentLoop.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return makeLoopResult({
          terminated: 'error',
          reason: 'Invalid arguments for tool record_evidence: JSON parsing failed: Text: {"summary":"..."',
          turns: 14,
          toolCalls: 23,
          transcriptSummary: 'record_evidence(0/1err)',
        });
      }
      dossier.append({
        issueNumber: 48,
        attemptId: 'attempt-1',
        evidence: [],
        suspectSymbols: [],
        openQuestions: [],
        summary: 'recovered',
        confidence: 'low',
      });
      return makeLoopResult({ terminated: 'done', turns: 2, toolCalls: 2 });
    });

    const result = await runAnalyst({
      issue: makeIssue(),
      repo: makeRepo(),
      workspace: makeWorkspace(),
      sandbox: makeSandbox(),
      attemptId: 'attempt-1',
      dossier,
    });

    expect(mockedRunAgentLoop).toHaveBeenCalledTimes(2);
    const retryPrompt = mockedRunAgentLoop.mock.calls[1][0].user;
    expect(retryPrompt).toContain('failed JSON parsing');
    expect(retryPrompt).toContain('record_evidence({');
    expect(result.snapshot).not.toBeNull();
    expect(result.terminated).toBe('done');
    expect(result.toolCalls).toBe(25);
  });

  it('does not retry on non-JSON tool errors', async () => {
    const dossier = new DossierStore();
    mockedRunAgentLoop.mockResolvedValue(
      makeLoopResult({
        terminated: 'error',
        reason: '[rate-limited] 429',
        turns: 4,
        toolCalls: 7,
      })
    );

    const result = await runAnalyst({
      issue: makeIssue(),
      repo: makeRepo(),
      workspace: makeWorkspace(),
      sandbox: makeSandbox(),
      attemptId: 'attempt-1',
      dossier,
    });

    expect(mockedRunAgentLoop).toHaveBeenCalledTimes(1);
    expect(result.snapshot).toBeNull();
    expect(result.terminated).toBe('error');
    expect(result.toolCalls).toBe(7);
  });
});
