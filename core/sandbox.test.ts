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
    forkFullName: 'my-org/my-repo',
    branchName: 'agent/scope-42-56',
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

  it('rejects empty testCommand', () => {
    expect(() =>
      validateSandboxConfig(validConfig({ testCommand: '' }))
    ).toThrow(/testCommand is required/);
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
  it('includes test_command from config', () => {
    const inputs = buildWorkflowInputs(validConfig({ testCommand: 'pytest -v' }));
    expect(inputs.test_command).toBe('pytest -v');
  });

  it('includes branch from config', () => {
    const inputs = buildWorkflowInputs(validConfig({ branchName: 'agent/scope-1-2' }));
    expect(inputs.branch).toBe('agent/scope-1-2');
  });

  it('includes timeout_minutes as string', () => {
    const inputs = buildWorkflowInputs(validConfig({ timeoutMinutes: 10 }));
    expect(inputs.timeout_minutes).toBe('10');
  });

  it('sets network_policy to "none" when no sandbox_services', () => {
    const inputs = buildWorkflowInputs(validConfig({ sandboxServices: [] }));
    expect(inputs.network_policy).toBe('none');
  });

  it('sets network_policy with allow list when sandbox_services present', () => {
    const inputs = buildWorkflowInputs(
      validConfig({ sandboxServices: ['postgres', 'redis'] })
    );
    expect(inputs.network_policy).toBe('allow:postgres,redis');
    expect(inputs.sandbox_services).toBe('postgres,redis');
  });

  it('joins sandbox_services with commas', () => {
    const inputs = buildWorkflowInputs(
      validConfig({ sandboxServices: ['a', 'b', 'c'] })
    );
    expect(inputs.sandbox_services).toBe('a,b,c');
  });
});

// ============================================================
// createSandboxConfig
// ============================================================
describe('createSandboxConfig', () => {
  it('creates config with all fields', () => {
    const config = createSandboxConfig(
      'org/repo',
      'branch-1',
      'npm test',
      ['postgres'],
      10
    );
    expect(config.forkFullName).toBe('org/repo');
    expect(config.branchName).toBe('branch-1');
    expect(config.testCommand).toBe('npm test');
    expect(config.sandboxServices).toEqual(['postgres']);
    expect(config.timeoutMinutes).toBe(10);
  });

  it('uses DEFAULT_TIMEOUT_MINUTES when not specified', () => {
    const config = createSandboxConfig('org/repo', 'branch', 'test', []);
    expect(config.timeoutMinutes).toBe(DEFAULT_TIMEOUT_MINUTES);
  });

  it('copies sandboxServices array (no shared reference)', () => {
    const services = ['redis'];
    const config = createSandboxConfig('org/repo', 'branch', 'test', services);
    services.push('postgres');
    expect(config.sandboxServices).toEqual(['redis']);
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
      'my-org/my-repo',
      SANDBOX_WORKFLOW_FILE,
      'agent/scope-42-56',
      expect.objectContaining({ test_command: 'make test' })
    );
  });

  it('polls for workflow run after dispatch', async () => {
    const client = mockClient();
    await runSandbox(validConfig(), client, 0);

    expect(client.getWorkflowRun).toHaveBeenCalledWith(
      'my-org/my-repo',
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
      'my-org/my-repo',
      12345,
      10 * 60 * 1000, // 10 minutes in ms
      0
    );
  });

  it('retrieves logs on successful completion', async () => {
    const client = mockClient();
    await runSandbox(validConfig(), client, 0);

    expect(client.getWorkflowRunLogs).toHaveBeenCalledWith('my-org/my-repo', 12345);
  });

  it('returns structured artifact with all fields on success', async () => {
    const client = mockClient();
    const artifact = await runSandbox(validConfig(), client, 0);

    expect(artifact.config).toEqual(validConfig());
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

  it('handles timeout: sets timedOut=true and completed=false', async () => {
    const client = mockClient({
      waitForWorkflowRun: jest.fn().mockResolvedValue({
        completed: false,
        conclusion: null,
        timedOut: true,
      } as WorkflowRunStatus),
    });

    const artifact = await runSandbox(validConfig(), client, 0);

    expect(artifact.result.timedOut).toBe(true);
    expect(artifact.result.completed).toBe(false);
    expect(artifact.result.exitCode).toBeNull();
    expect(artifact.result.stderr).toBe('Sandbox run timed out');
  });

  it('does not retrieve logs on timeout', async () => {
    const client = mockClient({
      waitForWorkflowRun: jest.fn().mockResolvedValue({
        completed: false,
        conclusion: null,
        timedOut: true,
      } as WorkflowRunStatus),
    });

    await runSandbox(validConfig(), client, 0);
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
      'my-org/my-repo',
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
    expect(inputs.sandbox_services).toBe('postgres,redis');
    expect(inputs.network_policy).toBe('allow:postgres,redis');
  });

  it('sets network_policy to none when no services declared', async () => {
    const client = mockClient();
    const config = validConfig({ sandboxServices: [] });
    await runSandbox(config, client, 0);

    const callArgs = (client.triggerWorkflowDispatch as jest.Mock).mock.calls[0];
    const inputs = callArgs[3];
    expect(inputs.network_policy).toBe('none');
  });

  it('uses fork branch for checkout (fresh checkout each run)', async () => {
    const client = mockClient();
    const config = validConfig({ branchName: 'agent/scope-100-200' });
    await runSandbox(config, client, 0);

    const callArgs = (client.triggerWorkflowDispatch as jest.Mock).mock.calls[0];
    expect(callArgs[2]).toBe('agent/scope-100-200'); // branch parameter
    expect(callArgs[3].branch).toBe('agent/scope-100-200'); // also in inputs
  });
});
