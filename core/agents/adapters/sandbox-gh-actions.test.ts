import type { ActionsClient, SandboxConfig } from '../../sandbox-types';
import { createGhActionsSandboxAdapter, type GhActionsSandboxAdapterOptions } from './sandbox-gh-actions';
import { buildPipInstallCommand } from './sandbox-local';

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

function makeOptions(
  overrides: Partial<GhActionsSandboxAdapterOptions> = {}
): GhActionsSandboxAdapterOptions {
  return {
    actionsClient: {} as unknown as ActionsClient,
    baseConfig: makeBaseConfig(),
    ...overrides,
  };
}

function makeSandboxSessionMock(overrides: Record<string, unknown> = {}): any {
  return {
    verifyAndPushBranch: jest
      .fn()
      .mockResolvedValue({ ok: true, phase: 'branch', sha: 'abc123' }),
    verifyWorkflowReachability: jest.fn().mockResolvedValue({ ok: true, phase: 'workflow' }),
    setupDependencies: jest
      .fn()
      .mockResolvedValue({ ok: true, phase: 'setup', installManifest: [] }),
    dispatch: jest.fn().mockResolvedValue({
      ok: true,
      runId: 42,
      conclusion: 'success',
      stepOutcomes: [],
      rawLogs: 'dispatch-logs',
      exitCode: 0,
    }),
    result: jest.fn().mockReturnValue({
      ok: true,
      reproStatus: 'failing',
      failureOutput: 'AssertionError',
      sentinelMatched: true,
      suspectPathHit: true,
      installManifest: [],
      phaseFailures: [],
      rawLogs: 'dispatch-logs',
    }),
    recordReplayInstallCommand: jest.fn(),
    ...overrides,
  };
}

describe('createGhActionsSandboxAdapter', () => {
  it('throws when sandboxSession is missing', () => {
    expect(() => createGhActionsSandboxAdapter(makeOptions())).toThrow(
      'createGhActionsSandboxAdapter requires sandboxSession'
    );
  });

  it('uses sandboxSession dispatch path for runRepro', async () => {
    const session = makeSandboxSessionMock();
    const handle = createGhActionsSandboxAdapter(
      makeOptions({
        sandboxSession: session,
      })
    );
    handle.setReproTestPath('tests/repro/test_issue_52.py');

    const run = await handle.runRepro();

    expect(run.exitCode).toBe(0);
    expect(session.verifyAndPushBranch).toHaveBeenCalledTimes(1);
    expect(session.verifyWorkflowReachability).toHaveBeenCalledTimes(1);
    expect(session.dispatch).toHaveBeenCalledWith({
      commands: ['pytest -xvs tests/repro/test_issue_52.py'],
    });
  });

  it('reuses verified session readiness across multiple dispatches', async () => {
    const session = makeSandboxSessionMock();
    const handle = createGhActionsSandboxAdapter(
      makeOptions({
        sandboxSession: session,
      })
    );
    handle.setReproTestPath('tests/repro/test_issue_52.py');

    await handle.runRepro();
    await handle.runRepro();

    expect(session.verifyAndPushBranch).toHaveBeenCalledTimes(1);
    expect(session.verifyWorkflowReachability).toHaveBeenCalledTimes(1);
    expect(session.dispatch).toHaveBeenCalledTimes(2);
  });

  it('surfaces branch verification phase failures as sandbox_setup_failed', async () => {
    const session = makeSandboxSessionMock({
      verifyAndPushBranch: jest.fn().mockResolvedValue({
        ok: false,
        phase: 'branch',
        reason: 'branch_push_unconfirmed',
        diagnostics: { branch: 'agent/scope-52' },
      }),
    });
    const handle = createGhActionsSandboxAdapter(makeOptions({ sandboxSession: session }));
    handle.setReproTestPath('tests/repro/test_issue_52.py');

    await expect(handle.runRepro()).rejects.toThrow(/sandbox_setup_failed: phase=branch/);
    expect(session.dispatch).not.toHaveBeenCalled();
  });

  it('records replay installs on successful session pip install', async () => {
    const session = makeSandboxSessionMock();
    const handle = createGhActionsSandboxAdapter(
      makeOptions({
        sandboxSession: session,
      })
    );

    const editableSpec = '-e python/openinference-instrumentation';
    const result = await handle.pipInstall(editableSpec);

    expect(result.exitCode).toBe(0);
    expect(session.dispatch).toHaveBeenCalledWith({
      commands: [buildPipInstallCommand(editableSpec)],
    });
    expect(session.recordReplayInstallCommand).toHaveBeenCalledWith(
      buildPipInstallCommand(editableSpec)
    );
  });

  it('delegates setupDependencies to sandboxSession after readiness checks', async () => {
    const session = makeSandboxSessionMock();
    const handle = createGhActionsSandboxAdapter(makeOptions({ sandboxSession: session }));

    const setup = await handle.setupDependencies?.({
      semanticConventionsPath: 'python/openinference-semantic-conventions',
      instrumentationCorePath: 'python/openinference-instrumentation',
      instrumentationPackagePath: 'python/instrumentation/openinference-instrumentation-smolagents',
      thirdPartyDeps: ['smolagents'],
      importVerification: {
        modulePath: 'openinference.instrumentation.smolagents',
        className: 'SmolagentsInstrumentor',
      },
    });

    expect(session.verifyAndPushBranch).toHaveBeenCalledTimes(1);
    expect(session.verifyWorkflowReachability).toHaveBeenCalledTimes(1);
    expect(session.setupDependencies).toHaveBeenCalledTimes(1);
    expect(setup?.ok).toBe(true);
  });
});
