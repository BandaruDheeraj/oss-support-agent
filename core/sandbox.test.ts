/**
 * Unit tests for the sandbox runner (US-008).
 */
import {
  SandboxConfig,
  ActionsClient,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunLogs,
  SandboxRunError,
  SandboxTimeoutError,
  SANDBOX_WORKFLOW_FILE,
  DEFAULT_TIMEOUT_MINUTES,
} from './sandbox-types';

import {
  validateSandboxConfig,
  buildWorkflowInputs,
  createSandboxConfig,
  buildSandboxArtifact,
  runSandbox,
} from './sandbox';

// --- Helper: create a valid config ---
function validConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    repoFullName: 'upstream-org/upstream-repo',
    forkFullName: 'my-org/my-repo',
    branchName: 'agent/scope-42-56',
    workflowRepoFullName: 'harness-org/harness-repo',
    testCommand: 'npm test',
    sandboxServices: [],
    timeoutMinutes: 15,
    ...overrides,
  };
}

// --- Helper: create a mock ActionsClient ---
function mockClient(overrides: Partial<ActionsClient> = {}): ActionsClient {
  return {
    triggerWorkflowDispatch: jest.fn().mockResolvedValue(undefined),
    getWorkflowRun: jest.fn().mockResolvedValue({
      id: 12345,
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/my-org/my-repo/actions/runs/12345',
      created_at: new Date().toISOString(),
    } as WorkflowRun),
    waitForWorkflowRun: jest.fn().mockResolvedValue({
      completed: true,
      conclusion: 'success',
      timedOut: false,
    } as WorkflowRunStatus),
    getWorkflowRunLogs: jest.fn().mockResolvedValue({
      stdout: 'All tests passed\n',
      stderr: '',
      exitCode: 0,
    } as WorkflowRunLogs),
    uploadArtifact: jest.fn().mockResolvedValue('artifact-url'),
    ...overrides,
  };
}

// ============================================================
// validateSandboxConfig
// ============================================================
describe('validateSandboxConfig', () => {
  it('accepts a valid config', () => {
    expect(() => validateSandboxConfig(validConfig())).not.toThrow();
  });

  it('rejects empty forkFullName', () => {
    expect(() => validateSandboxConfig(validConfig({ forkFullName: '' }))).toThrow(
      SandboxRunError
    );
  });

  it('rejects forkFullName without slash', () => {
    expect(() =>
      validateSandboxConfig(validConfig({ forkFullName: 'noslash' }))
    ).toThrow(/must be "org\/repo" format/);
  });

  it('rejects empty branchName', () => {
    expect(() =>
      validateSandboxConfig(validConfig({ branchName: '' }))
    ).toThrow(/branchName is required/);
  });

  it('rejects whitespace-only branchName', () => {
    expect(() =>
      validateSandboxConfig(validConfig({ branchName: '   ' }))
    ).toThrow(/branchName is required/);
  });

  it('allows empty testCommand because commands come from the adapter', () => {
    expect(() =>
      validateSandboxConfig(validConfig({ testCommand: '' }))
    ).not.toThrow();
  });

  it('rejects zero timeoutMinutes', () => {
    expect(() =>
      validateSandboxConfig(validConfig({ timeoutMinutes: 0 }))
    ).toThrow(/timeoutMinutes must be positive/);
  });

  it('rejects negative timeoutMinutes', () => {
    expect(() =>
      validateSandboxConfig(validConfig({ timeoutMinutes: -5 }))
    ).toThrow(/timeoutMinutes must be positive/);
  });

  it('error includes phase "validation"', () => {
    try {
      validateSandboxConfig(validConfig({ forkFullName: '' }));
    } catch (e: unknown) {
      expect((e as SandboxRunError).phase).toBe('validation');
    }
  });
});

// ============================================================
// buildWorkflowInputs
// ============================================================
describe('buildWorkflowInputs', () => {
  it('base64-encodes test commands JSON', () => {
    const inputs = buildWorkflowInputs(validConfig({ testCommand: 'pytest -v' }));
    const decoded = JSON.parse(Buffer.from(inputs.test_commands_b64, 'base64').toString('utf8'));
    expect(decoded).toEqual(['pytest -v']);
  });

  it('includes branch_name from config', () => {
    const inputs = buildWorkflowInputs(validConfig({ branchName: 'agent/scope-1-2' }));
    expect(inputs.branch_name).toBe('agent/scope-1-2');
  });

  it('includes repo_full_name from config', () => {
    const inputs = buildWorkflowInputs(validConfig({ repoFullName: 'a/b' }));
    expect(inputs.repo_full_name).toBe('a/b');
  });

  it('base64-encodes services JSON', () => {
    const inputs = buildWorkflowInputs(validConfig({ sandboxServices: ['postgres', 'redis'] }));
    const decoded = JSON.parse(Buffer.from(inputs.services_b64, 'base64').toString('utf8'));
    expect(decoded).toEqual([
      { name: 'postgres', image: 'postgres', ports: [] },
      { name: 'redis', image: 'redis', ports: [] },
    ]);
  });

  it('uses default fork clone URL when none provided', () => {
    const inputs = buildWorkflowInputs(validConfig({ forkFullName: 'x/y', forkCloneUrl: undefined } as any));
    expect(inputs.fork_clone_url).toBe('https://github.com/x/y.git');
  });

  it('uses explicit forkCloneUrl when provided', () => {
    const inputs = buildWorkflowInputs(validConfig({ forkCloneUrl: 'https://example.com/fork.git' }));
    expect(inputs.fork_clone_url).toBe('https://example.com/fork.git');
  });
});

// ============================================================
// createSandboxConfig
// ============================================================
describe('createSandboxConfig', () => {
  it('creates config with all fields', () => {
    const config = createSandboxConfig({
      repoFullName: 'org/repo',
      forkFullName: 'org/repo',
      branchName: 'branch-1',
      testCommand: 'npm test',
      sandboxServices: ['postgres'],
      timeoutMinutes: 10,
      workflowRepoFullName: 'harness-org/harness-repo',
    });
    expect(config.repoFullName).toBe('org/repo');
    expect(config.forkFullName).toBe('org/repo');
    expect(config.branchName).toBe('branch-1');
    expect(config.workflowRepoFullName).toBe('harness-org/harness-repo');
    expect(config.testCommand).toBe('npm test');
    expect(config.sandboxServices).toEqual(['postgres']);
    expect(config.timeoutMinutes).toBe(10);
  });

  it('uses DEFAULT_TIMEOUT_MINUTES when not specified', () => {
    const config = createSandboxConfig({
      repoFullName: 'org/repo',
      forkFullName: 'org/repo',
      branchName: 'branch',
      testCommand: 'test',
      sandboxServices: [],
    });
    expect(config.timeoutMinutes).toBe(DEFAULT_TIMEOUT_MINUTES);
  });

  it('copies sandboxServices array (no shared reference)', () => {
    const services = ['redis'];
    const config = createSandboxConfig({
      repoFullName: 'org/repo',
      forkFullName: 'org/repo',
      branchName: 'branch',
      testCommand: 'test',
      sandboxServices: services,
    });
    services.push('postgres');
    expect(config.sandboxServices).toEqual(['redis']);
  });

  it('throws clear error when workflowRepoFullName is invalid', () => {
    expect(() =>
      createSandboxConfig({
        repoFullName: 'org/repo',
        forkFullName: 'org/repo',
        branchName: 'branch',
        testCommand: 'test',
        sandboxServices: [],
        workflowRepoFullName: 15 as unknown as string,
      })
    ).toThrow(
      'createSandboxConfig: workflowRepoFullName must be "owner/repo", got: 15'
    );
  });
});

// ============================================================
// buildSandboxArtifact
// ============================================================
describe('buildSandboxArtifact', () => {
  it('builds a complete artifact structure', () => {
    const config = validConfig();
    const result = {
      completed: true,
      exitCode: 0,
      stdout: 'OK',
      stderr: '',
      durationSeconds: 45,
      workflowRunUrl: 'https://example.com/run/1',
      timedOut: false,
      workflowRunId: 1,
    };
    const artifact = buildSandboxArtifact(
      config,
      result,
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:45Z'
    );
    expect(artifact.config).toBe(config);
    expect(artifact.result).toBe(result);
    expect(artifact.startedAt).toBe('2026-01-01T00:00:00Z');
    expect(artifact.completedAt).toBe('2026-01-01T00:00:45Z');
  });
});

// ============================================================
// runSandbox - integration tests
// ============================================================
describe('runSandbox', () => {
  it('triggers workflow_dispatch with correct parameters', async () => {
    const client = mockClient();
    const config = validConfig({ testCommand: 'make test' });
    await runSandbox(config, client, 0);

    expect(client.triggerWorkflowDispatch).toHaveBeenCalledWith(
      'harness-org/harness-repo',
      SANDBOX_WORKFLOW_FILE,
      'agent/scope-42-56',
      expect.objectContaining({ branch_name: 'agent/scope-42-56' })
    );
  });

  it('polls for workflow run after dispatch', async () => {
    const client = mockClient();
    await runSandbox(validConfig(), client, 0);

    expect(client.getWorkflowRun).toHaveBeenCalledWith(
      'harness-org/harness-repo',
      SANDBOX_WORKFLOW_FILE,
      'agent/scope-42-56',
      expect.any(String)
    );
  });

  it('waits for workflow run completion with correct timeout', async () => {
    const client = mockClient();
    const config = validConfig({ timeoutMinutes: 10 });
    await runSandbox(config, client, 0);

    expect(client.waitForWorkflowRun).toHaveBeenCalledWith(
      'harness-org/harness-repo',
      12345,
      10 * 60 * 1000, // 10 minutes in ms
      0
    );
  });

  it('retrieves logs on successful completion', async () => {
    const client = mockClient();
    await runSandbox(validConfig(), client, 0);

    expect(client.getWorkflowRunLogs).toHaveBeenCalledWith('harness-org/harness-repo', 12345);
  });

  it('prefers the emitted sandbox-output artifact for per-command results when available', async () => {
    const downloadWorkflowRunArtifact = jest.fn().mockResolvedValue(
      JSON.stringify([
        { command: 'npm test', exitCode: 0, stdout: 'ok\n', stderr: '' },
        { command: 'npm run lint', exitCode: 0, stdout: 'lint ok\n', stderr: '' },
      ])
    );

    const client = mockClient({ downloadWorkflowRunArtifact });
    const artifact = await runSandbox(validConfig(), client, 0);

    expect(downloadWorkflowRunArtifact).toHaveBeenCalledWith(
      'harness-org/harness-repo',
      12345,
      'sandbox-output'
    );

    expect(artifact.commands).toEqual([
      { command: 'npm test', exitCode: 0, stdout: 'ok\n', stderr: '' },
      { command: 'npm run lint', exitCode: 0, stdout: 'lint ok\n', stderr: '' },
    ]);
  });

  it('returns structured artifact with all fields on success', async () => {
    const client = mockClient();
    const artifact = await runSandbox(validConfig(), client, 0);

    expect(artifact.config).toEqual({ ...validConfig(), testCommands: ['npm test'] });
    expect(artifact.result.completed).toBe(true);
    expect(artifact.result.exitCode).toBe(0);
    expect(artifact.result.stdout).toBe('All tests passed\n');
    expect(artifact.result.stderr).toBe('');
    expect(artifact.result.timedOut).toBe(false);
    expect(artifact.result.workflowRunId).toBe(12345);
    expect(artifact.result.workflowRunUrl).toBe(
      'https://github.com/my-org/my-repo/actions/runs/12345'
    );
    expect(artifact.startedAt).toBeDefined();
    expect(artifact.completedAt).toBeDefined();
  });

  it('throws SandboxTimeoutError on timeout and cancels the workflow run (best-effort)', async () => {
    const cancelWorkflowRun = jest.fn().mockResolvedValue(undefined);
    const client = mockClient({
      waitForWorkflowRun: jest.fn().mockResolvedValue({
        completed: false,
        conclusion: null,
        timedOut: true,
      } as WorkflowRunStatus),
      cancelWorkflowRun,
    });

    await expect(runSandbox(validConfig(), client, 0)).rejects.toThrow(SandboxTimeoutError);
    expect(cancelWorkflowRun).toHaveBeenCalledWith('harness-org/harness-repo', 12345);
  });

  it('does not retrieve logs on timeout', async () => {
    const cancelWorkflowRun = jest.fn().mockResolvedValue(undefined);
    const client = mockClient({
      waitForWorkflowRun: jest.fn().mockResolvedValue({
        completed: false,
        conclusion: null,
        timedOut: true,
      } as WorkflowRunStatus),
      cancelWorkflowRun,
    });

    await expect(runSandbox(validConfig(), client, 0)).rejects.toThrow(SandboxTimeoutError);
    expect(client.getWorkflowRunLogs).not.toHaveBeenCalled();
  });

  it('throws SandboxRunError on dispatch failure', async () => {
    const client = mockClient({
      triggerWorkflowDispatch: jest.fn().mockRejectedValue(new Error('403 Forbidden')),
    });

    await expect(runSandbox(validConfig(), client, 0)).rejects.toThrow(SandboxRunError);
    await expect(runSandbox(validConfig(), client, 0)).rejects.toThrow(
      /Failed to trigger workflow dispatch/
    );
  });

  it('throws SandboxRunError if workflow run never appears', async () => {
    const client = mockClient({
      getWorkflowRun: jest.fn().mockResolvedValue(null),
    });

    await expect(runSandbox(validConfig(), client, 0)).rejects.toThrow(
      /Workflow run did not appear/
    );
  });

  it('throws SandboxRunError on log retrieval failure', async () => {
    const client = mockClient({
      getWorkflowRunLogs: jest.fn().mockRejectedValue(new Error('Not found')),
    });

    await expect(runSandbox(validConfig(), client, 0)).rejects.toThrow(
      /Failed to retrieve workflow logs/
    );
  });

  it('uploads structured artifact after run', async () => {
    const client = mockClient();
    await runSandbox(validConfig(), client, 0);

    expect(client.uploadArtifact).toHaveBeenCalledWith(
      'harness-org/harness-repo',
      12345,
      'sandbox-result',
      expect.any(String)
    );

    // Verify the uploaded content is valid JSON with the artifact structure
    const uploadedContent = (client.uploadArtifact as jest.Mock).mock.calls[0][3];
    const parsed = JSON.parse(uploadedContent);
    expect(parsed.config).toBeDefined();
    expect(parsed.result).toBeDefined();
    expect(parsed.startedAt).toBeDefined();
    expect(parsed.completedAt).toBeDefined();
  });

  it('does not throw if artifact upload fails (non-fatal)', async () => {
    const client = mockClient({
      uploadArtifact: jest.fn().mockRejectedValue(new Error('Upload failed')),
    });

    // Should not throw - artifact upload failure is non-fatal
    const artifact = await runSandbox(validConfig(), client, 0);
    expect(artifact.result.completed).toBe(true);
  });

  it('validates config before triggering (rejects invalid)', async () => {
    const client = mockClient();
    await expect(
      runSandbox(validConfig({ forkFullName: '' }), client, 0)
    ).rejects.toThrow(SandboxRunError);
    expect(client.triggerWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('uses 15-minute default timeout from config', async () => {
    const client = mockClient();
    const config = validConfig({ timeoutMinutes: 15 });
    await runSandbox(config, client, 0);

    expect(client.waitForWorkflowRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      15 * 60 * 1000,
      expect.any(Number)
    );
  });

  it('configurable timeout passed correctly', async () => {
    const client = mockClient();
    const config = validConfig({ timeoutMinutes: 5 });
    await runSandbox(config, client, 0);

    expect(client.waitForWorkflowRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      5 * 60 * 1000,
      expect.any(Number)
    );
  });

  it('calculates duration in seconds', async () => {
    const client = mockClient();
    const artifact = await runSandbox(validConfig(), client, 0);

    expect(typeof artifact.result.durationSeconds).toBe('number');
    expect(artifact.result.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns non-zero exit code for failed tests', async () => {
    const client = mockClient({
      getWorkflowRunLogs: jest.fn().mockResolvedValue({
        stdout: 'FAIL src/test.ts\n',
        stderr: 'Test suite failed\n',
        exitCode: 1,
      } as WorkflowRunLogs),
    });

    const artifact = await runSandbox(validConfig(), client, 0);
    expect(artifact.result.exitCode).toBe(1);
    expect(artifact.result.stdout).toBe('FAIL src/test.ts\n');
    expect(artifact.result.stderr).toBe('Test suite failed\n');
    expect(artifact.result.completed).toBe(true);
  });

  it('each run is isolated (no state from previous calls)', async () => {
    const client = mockClient();
    const artifact1 = await runSandbox(validConfig(), client, 0);
    const artifact2 = await runSandbox(validConfig(), client, 0);

    // Each gets its own timestamps
    expect(artifact1.startedAt).toBeDefined();
    expect(artifact2.startedAt).toBeDefined();
    // Dispatch was called twice
    expect(client.triggerWorkflowDispatch).toHaveBeenCalledTimes(2);
  });

  it('passes sandbox_services in workflow inputs for network policy', async () => {
    const client = mockClient();
    const config = validConfig({ sandboxServices: ['postgres', 'redis'] });
    await runSandbox(config, client, 0);

    const callArgs = (client.triggerWorkflowDispatch as jest.Mock).mock.calls[0];
    const inputs = callArgs[3];
    expect(typeof inputs.services_b64).toBe('string');
    expect(JSON.parse(Buffer.from(inputs.services_b64, 'base64').toString('utf8')).length).toBe(2);
  });

  it('sets network_policy to none when no services declared', async () => {
    const client = mockClient();
    const config = validConfig({ sandboxServices: [] });
    await runSandbox(config, client, 0);

    const callArgs = (client.triggerWorkflowDispatch as jest.Mock).mock.calls[0];
    const inputs = callArgs[3];
    expect(JSON.parse(Buffer.from(inputs.services_b64, 'base64').toString('utf8'))).toEqual([]);
  });

  it('uses fork branch for checkout (fresh checkout each run)', async () => {
    const client = mockClient();
    const config = validConfig({ branchName: 'agent/scope-100-200' });
    await runSandbox(config, client, 0);

    const callArgs = (client.triggerWorkflowDispatch as jest.Mock).mock.calls[0];
    expect(callArgs[2]).toBe('agent/scope-100-200'); // branch parameter
    expect(callArgs[3].branch_name).toBe('agent/scope-100-200'); // also in inputs
  });
});

describe('adapter-backed sandbox config', () => {
  function adapter() {
    return {
      classifyModule: jest.fn().mockResolvedValue('.'),
      getTestCommands: jest.fn().mockResolvedValue(['npm test', 'npm run lint']),
      getSandboxServices: jest.fn().mockResolvedValue([{ name: 'redis', image: 'redis:7', ports: [] }]),
      runCustomEval: jest.fn(),
      getPRMetadata: jest.fn(),
    };
  }

  it('createSandboxConfig calls adapter.getTestCommands and getSandboxServices', async () => {
    const repoAdapter = adapter();
    const config = await createSandboxConfig({
      repoFullName: 'org/repo',
      forkFullName: 'org/repo',
      branchName: 'branch',
      adapter: repoAdapter,
      timeoutMinutes: 9,
      workflowRepoFullName: 'harness-org/harness-repo',
    });
    expect(repoAdapter.getTestCommands).toHaveBeenCalledWith();
    expect(repoAdapter.getSandboxServices).toHaveBeenCalledWith();
    expect(config.testCommands).toEqual(['npm test', 'npm run lint']);
    expect(config.sandboxServices).toEqual([{ name: 'redis', image: 'redis:7', ports: [] }]);
    expect(config.workflowRepoFullName).toBe('harness-org/harness-repo');
  });

  it('buildWorkflowInputs serializes all adapter commands', async () => {
    const config = await createSandboxConfig({
      repoFullName: 'org/repo',
      forkFullName: 'org/repo',
      branchName: 'branch',
      adapter: adapter(),
      timeoutMinutes: 9,
      workflowRepoFullName: 'harness-org/harness-repo',
    });
    const inputs = buildWorkflowInputs(config);
    expect(JSON.parse(Buffer.from(inputs.test_commands_b64, 'base64').toString('utf8'))).toEqual(['npm test', 'npm run lint']);
  });

  it('buildWorkflowInputs uses adapter service names for network policy', async () => {
    const config = await createSandboxConfig({
      repoFullName: 'org/repo',
      forkFullName: 'org/repo',
      branchName: 'branch',
      adapter: adapter(),
      timeoutMinutes: 9,
      workflowRepoFullName: 'harness-org/harness-repo',
    });
    const inputs = buildWorkflowInputs(config);
    const decoded = JSON.parse(Buffer.from(inputs.services_b64, 'base64').toString('utf8'));
    expect(decoded).toEqual([{ name: 'redis', image: 'redis:7', ports: [] }]);
  });

  it('runSandbox refreshes commands and services from the adapter', async () => {
    const repoAdapter = adapter();
    const client = mockClient();
    await runSandbox(validConfig({ testCommand: 'old command' }), repoAdapter, client, 0);
    const inputs = (client.triggerWorkflowDispatch as jest.Mock).mock.calls[0][3];
    expect(repoAdapter.getTestCommands).toHaveBeenCalledWith();
    expect(repoAdapter.getSandboxServices).toHaveBeenCalledWith();
    expect(JSON.parse(Buffer.from(inputs.test_commands_b64, 'base64').toString('utf8'))).toEqual(['npm test', 'npm run lint']);
    expect(JSON.parse(Buffer.from(inputs.services_b64, 'base64').toString('utf8'))).toEqual([{ name: 'redis', image: 'redis:7', ports: [] }]);
  });
});
