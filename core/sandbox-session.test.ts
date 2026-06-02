import type { Manifest } from './manifest/types';
import type { ActionsClient } from './sandbox-types';
import {
  SandboxConfigError,
  SandboxSession,
  type GitClient,
  type InstallSpec,
  type SandboxPhaseResult,
} from './sandbox-session';

function makeManifest(): Manifest {
  return {
    repo: 'BandaruDheeraj/openinference',
    trigger_label: 'agent-fix',
    skip_pm_gate_label: 'skip-pm',
    fork_org: 'BandaruDheeraj',
    branch_prefix: 'agent/scope-',
    approval_keywords: ['approved'],
    pm_email: 'pm@example.com',
    max_retries: 3,
    sandbox_timeout_mins: 15,
    sandbox_runner: 'gha',
  };
}

function makeActionsClient(overrides: Partial<ActionsClient> = {}): ActionsClient {
  return {
    triggerWorkflowDispatch: jest.fn().mockResolvedValue(undefined),
    getWorkflowRun: jest.fn().mockResolvedValue({
      id: 123,
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://example.test/run/123',
      created_at: new Date().toISOString(),
    }),
    waitForWorkflowRun: jest.fn().mockResolvedValue({
      completed: true,
      conclusion: 'success',
      timedOut: false,
    }),
    getWorkflowRunLogs: jest.fn().mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    }),
    uploadArtifact: jest.fn().mockResolvedValue('artifact'),
    ...overrides,
  };
}

function makeGitClient(overrides: Partial<GitClient> = {}): GitClient {
  return {
    getDefaultBranch: jest.fn().mockResolvedValue('main'),
    getBranchSha: jest.fn().mockResolvedValue('abc123'),
    createBranch: jest.fn().mockResolvedValue(undefined),
    pushPendingChanges: jest.fn().mockResolvedValue(undefined),
    getFileContents: jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      content: 'name: sandbox',
    }),
    ...overrides,
  };
}

function makeSession(
  actionsOverrides: Partial<ActionsClient> = {},
  gitOverrides: Partial<GitClient> = {}
): SandboxSession {
  return new SandboxSession({
    manifest: makeManifest(),
    targetRepo: 'BandaruDheeraj/openinference',
    sandboxWorkflowRepo: 'BandaruDheeraj/oss-support-agent',
    sandboxWorkflowRef: 'main',
    branch: 'agent/scope-52',
    issueNumber: 52,
    timeoutMins: 15,
    actionsClient: makeActionsClient(actionsOverrides),
    gitClient: makeGitClient(gitOverrides),
  });
}

function expectConfigError(fn: () => void): SandboxConfigError {
  try {
    fn();
    throw new Error('Expected SandboxConfigError');
  } catch (err) {
    expect(err).toBeInstanceOf(SandboxConfigError);
    return err as SandboxConfigError;
  }
}

describe('SandboxSession', () => {
  it('throws SandboxConfigError when targetRepo is not a string', () => {
    const error = expectConfigError(() => {
      new SandboxSession({
        manifest: makeManifest(),
        targetRepo: 123 as unknown as string,
        sandboxWorkflowRepo: 'BandaruDheeraj/oss-support-agent',
        sandboxWorkflowRef: 'main',
        branch: 'agent/scope-52',
        issueNumber: 52,
        timeoutMins: 15,
        actionsClient: makeActionsClient(),
        gitClient: makeGitClient(),
      });
    });
    expect(error.fields).toEqual(
      expect.arrayContaining([{ field: 'targetRepo', received: 123 }])
    );
  });

  it('throws SandboxConfigError when targetRepo does not contain exactly one slash', () => {
    const error = expectConfigError(() => {
      new SandboxSession({
        manifest: makeManifest(),
        targetRepo: 'BandaruDheeraj-openinference',
        sandboxWorkflowRepo: 'BandaruDheeraj/oss-support-agent',
        sandboxWorkflowRef: 'main',
        branch: 'agent/scope-52',
        issueNumber: 52,
        timeoutMins: 15,
        actionsClient: makeActionsClient(),
        gitClient: makeGitClient(),
      });
    });
    expect(error.fields).toEqual(
      expect.arrayContaining([
        { field: 'targetRepo', received: 'BandaruDheeraj-openinference' },
      ])
    );
  });

  it('throws SandboxConfigError when sandboxWorkflowRepo equals targetRepo', () => {
    const error = expectConfigError(() => {
      new SandboxSession({
        manifest: makeManifest(),
        targetRepo: 'BandaruDheeraj/openinference',
        sandboxWorkflowRepo: 'BandaruDheeraj/openinference',
        sandboxWorkflowRef: 'main',
        branch: 'agent/scope-52',
        issueNumber: 52,
        timeoutMins: 15,
        actionsClient: makeActionsClient(),
        gitClient: makeGitClient(),
      });
    });
    expect(error.fields).toEqual(
      expect.arrayContaining([
        {
          field: 'sandboxWorkflowRepo',
          received:
            'sandboxWorkflowRepo must be the support agent repo, not the target repo — this would cause a 404 on dispatch',
        },
      ])
    );
  });

  it('dispatch throws if verifyAndPushBranch was not called first', async () => {
    const session = makeSession();
    await expect(session.dispatch({ commands: ['echo hello'] })).rejects.toThrow(
      'verifyAndPushBranch'
    );
  });

  it('dispatch throws if it would target targetRepo instead of sandboxWorkflowRepo', async () => {
    const session = makeSession();
    (session as any).phaseResults.branch = { ok: true, phase: 'branch', sha: 'abc' };
    (session as any).phaseResults.workflow = { ok: true, phase: 'workflow' };
    (session as any).phaseResults.setup = { ok: true, phase: 'setup', installManifest: [] };
    (session as any).sandboxWorkflowRepo = 'BandaruDheeraj/openinference';

    await expect(session.dispatch({ commands: ['echo hello'] })).rejects.toThrow(
      'sandbox.yml lives in the support agent repo'
    );
  });

  it('setupDependencies returns import_verification_failed when step 5 output lacks import_ok', async () => {
    const session = makeSession();
    const runCommand = jest.spyOn<any, any>(session as any, 'runCommandInSandbox');
    runCommand
      .mockResolvedValueOnce({
        ok: true,
        runId: 1,
        conclusion: 'success',
        exitCode: 0,
        stdout: 'step1',
        stderr: '',
        rawLogs: 'step1',
      })
      .mockResolvedValueOnce({
        ok: true,
        runId: 2,
        conclusion: 'success',
        exitCode: 0,
        stdout: 'step2',
        stderr: '',
        rawLogs: 'step2',
      })
      .mockResolvedValueOnce({
        ok: true,
        runId: 3,
        conclusion: 'success',
        exitCode: 0,
        stdout: 'step3',
        stderr: '',
        rawLogs: 'step3',
      })
      .mockResolvedValueOnce({
        ok: true,
        runId: 4,
        conclusion: 'success',
        exitCode: 0,
        stdout: 'step4',
        stderr: '',
        rawLogs: 'step4',
      })
      .mockResolvedValueOnce({
        ok: true,
        runId: 5,
        conclusion: 'success',
        exitCode: 0,
        stdout: 'import output missing sentinel',
        stderr: '',
        rawLogs: 'import output missing sentinel',
      });

    const spec: InstallSpec = {
      semanticConventionsPath: 'python/openinference-semantic-conventions',
      instrumentationCorePath: 'python/openinference-instrumentation',
      instrumentationPackagePath:
        'python/instrumentation/openinference-instrumentation-smolagents',
      thirdPartyDeps: ['smolagents'],
      importVerification: {
        modulePath: 'openinference.instrumentation.smolagents',
        className: 'SmolagentsInstrumentor',
      },
    };

    const result = (await session.setupDependencies(spec)) as SandboxPhaseResult & {
      ok: false;
      reason: string;
      failedStep?: number;
    };

    expect(result.ok).toBe(false);
    expect(result.phase).toBe('setup');
    expect(result.reason).toBe('import_verification_failed');
    expect(result.failedStep).toBe(5);
  });

  it('result returns reproStatus=not_executed when any phase failed', () => {
    const session = makeSession();
    (session as any).phaseResults.workflow = {
      ok: false,
      phase: 'workflow',
      reason: 'workflow_unreachable',
      diagnostics: { httpStatus: 404 },
    };

    const result = session.result();
    expect(result.ok).toBe(false);
    expect(result.reproStatus).toBe('not_executed');
    expect(result.phaseFailures).toHaveLength(1);
    expect(result.phaseFailures[0].reason).toBe('workflow_unreachable');
  });

  it('uses sandbox-output artifact as authoritative command output', async () => {
    const session = makeSession({
      waitForWorkflowRun: jest.fn().mockResolvedValue({
        completed: true,
        conclusion: 'failure',
        timedOut: false,
      }),
      getWorkflowRunLogs: jest.fn().mockResolvedValue({
        stdout: '(GHA log archive: 1234 bytes; run https://example.test/run/123)',
        stderr: '',
        exitCode: 1,
      }),
      downloadWorkflowRunArtifact: jest.fn().mockResolvedValue(
        JSON.stringify([
          {
            command: 'pytest -q tests/repro.py',
            exitCode: 1,
            stdout: 'collected 1 item',
            stderr: 'AssertionError: REPRO_SENTINEL in suspect_symbol',
          },
        ])
      ),
    });
    (session as any).phaseResults.branch = { ok: true, phase: 'branch', sha: 'abc' };
    (session as any).phaseResults.workflow = { ok: true, phase: 'workflow' };
    (session as any).phaseResults.setup = { ok: true, phase: 'setup', installManifest: [] };

    const dispatch = await session.dispatch({
      commands: ['pytest -q tests/repro.py'],
      sentinel: 'REPRO_SENTINEL',
      suspectPathNeedles: ['suspect_symbol'],
    });

    expect(dispatch.ok).toBe(true);
    if (!dispatch.ok) throw new Error('expected dispatch ok');
    expect(dispatch.exitCode).toBe(1);
    expect(dispatch.stderr).toContain('REPRO_SENTINEL');
    expect(dispatch.rawLogs).toContain('suspect_symbol');
    expect(dispatch.stepOutcomes).toEqual([
      { command: 'pytest -q tests/repro.py', exitCode: 1 },
    ]);

    const result = session.result();
    expect(result.reproStatus).toBe('failing');
    expect(result.sentinelMatched).toBe(true);
    expect(result.suspectPathHit).toBe(true);
    expect(result.failureOutput).toContain('AssertionError');
  });
});
