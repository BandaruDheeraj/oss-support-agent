import { runSandbox } from '../../sandbox';
import type { ActionsClient, SandboxConfig } from '../../sandbox-types';
import { createGhActionsSandboxAdapter, type GhActionsSandboxAdapterOptions } from './sandbox-gh-actions';
import { buildPipInstallCommand } from './sandbox-local';

jest.mock('../../sandbox', () => ({
  runSandbox: jest.fn(),
}));

const runSandboxMock = runSandbox as jest.MockedFunction<typeof runSandbox>;

function makeBaseConfig(): Omit<SandboxConfig, 'testCommand' | 'testCommands'> {
  return {
    repoFullName: 'upstream/repo',
    forkFullName: 'fork/repo',
    branchName: 'agent/scope-52',
    workflowRepoFullName: 'harness/repo',
    sandboxServices: [],
    timeoutMinutes: 15,
  };
}

function makeRunSandboxResult(exitCode = 1) {
  return {
    config: {} as SandboxConfig,
    result: {
      completed: true,
      exitCode,
      stdout: 'stdout',
      stderr: 'stderr',
      durationSeconds: 1,
      workflowRunUrl: 'https://example.com/run/1',
      timedOut: false,
      workflowRunId: 1,
    },
    commands: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}

function makeOptions(
  overrides: Partial<GhActionsSandboxAdapterOptions> = {}
): GhActionsSandboxAdapterOptions {
  const branchRefExists = jest.fn().mockResolvedValue(true);
  return {
    actionsClient: { branchRefExists } as unknown as ActionsClient,
    baseConfig: makeBaseConfig(),
    preDispatchRefCheckAttempts: 2,
    preDispatchRefCheckDelayMs: 0,
    ...overrides,
  };
}

describe('createGhActionsSandboxAdapter pre-dispatch checks', () => {
  beforeEach(() => {
    runSandboxMock.mockReset();
    runSandboxMock.mockResolvedValue(makeRunSandboxResult() as any);
  });

  it('surfaces missing fork refs as sandbox_setup_failed before dispatch', async () => {
    const beforeDispatch = jest.fn().mockResolvedValue(undefined);
    const branchRefExists = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const handle = createGhActionsSandboxAdapter(
      makeOptions({
        beforeDispatch,
        actionsClient: { branchRefExists } as unknown as ActionsClient,
      })
    );
    handle.setReproTestPath('tests/repro/test_issue_52.py');

    await expect(handle.runRepro()).rejects.toThrow(/sandbox_setup_failed: missing fork repro ref/);
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(runSandboxMock).not.toHaveBeenCalled();
  });

  it('surfaces push confirmation failures as sandbox_setup_failed', async () => {
    const beforeDispatch = jest.fn().mockRejectedValue(new Error('push failed'));
    const handle = createGhActionsSandboxAdapter(
      makeOptions({
        beforeDispatch,
      })
    );
    handle.setReproTestPath('tests/repro/test_issue_52.py');

    await expect(handle.runRepro()).rejects.toThrow(
      /sandbox_setup_failed: failed to confirm push for fork branch/
    );
    expect(runSandboxMock).not.toHaveBeenCalled();
  });

  it('confirms branch push once and dispatches repro runs', async () => {
    const beforeDispatch = jest.fn().mockResolvedValue(undefined);
    const branchRefExists = jest.fn().mockResolvedValue(true);
    const handle = createGhActionsSandboxAdapter(
      makeOptions({
        beforeDispatch,
        actionsClient: { branchRefExists } as unknown as ActionsClient,
      })
    );
    handle.setReproTestPath('tests/repro/test_issue_52.py');

    await handle.runRepro();
    await handle.runRepro();

    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(runSandboxMock).toHaveBeenCalledTimes(2);
    expect(runSandboxMock.mock.calls[0][0]).toMatchObject({
      testCommands: ['pytest -xvs tests/repro/test_issue_52.py'],
    });
  });

  it('replays successful pip_install specs on subsequent dispatches', async () => {
    runSandboxMock
      .mockResolvedValueOnce(makeRunSandboxResult(0) as any)
      .mockResolvedValueOnce(makeRunSandboxResult(0) as any);
    const handle = createGhActionsSandboxAdapter(makeOptions());
    const editableSpec = '-e python/openinference-instrumentation';
    handle.setReproTestPath('tests/repro/test_issue_52.py');

    const install = await handle.pipInstall(editableSpec);
    expect(install.exitCode).toBe(0);
    await handle.runRepro();

    expect(runSandboxMock.mock.calls).toHaveLength(2);
    expect(runSandboxMock.mock.calls[0][0]).toMatchObject({
      testCommands: [buildPipInstallCommand(editableSpec)],
    });
    expect(runSandboxMock.mock.calls[1][0]).toMatchObject({
      testCommands: [
        buildPipInstallCommand(editableSpec),
        'pytest -xvs tests/repro/test_issue_52.py',
      ],
    });
  });

  it('does not replay failed pip_install specs', async () => {
    runSandboxMock
      .mockResolvedValueOnce(makeRunSandboxResult(1) as any)
      .mockResolvedValueOnce(makeRunSandboxResult(0) as any);
    const handle = createGhActionsSandboxAdapter(makeOptions());
    const failingSpec = '-e python/missing';
    handle.setReproTestPath('tests/repro/test_issue_52.py');

    const install = await handle.pipInstall(failingSpec);
    expect(install.exitCode).toBe(1);
    await handle.runRepro();

    expect(runSandboxMock.mock.calls).toHaveLength(2);
    expect(runSandboxMock.mock.calls[1][0]).toMatchObject({
      testCommands: ['pytest -xvs tests/repro/test_issue_52.py'],
    });
  });
});
