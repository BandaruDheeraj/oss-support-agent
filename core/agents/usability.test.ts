/**
 * Unit tests for the usability agent (US-015).
 */

import {
  UsabilityAgentInput,
  UsabilityCheck,
  UsabilityExerciser,
  UsabilityExerciserOutput,
  UsabilityAgentError,
  USABILITY_WORKFLOW_FILE,
  DEFAULT_USABILITY_TIMEOUT_MINUTES,
} from './usability-types';

import {
  validateUsabilityConfig,
  buildUsabilityWorkflowInputs,
  calculateDxScore,
  extractBlockers,
  extractSuggestions,
  generateUsabilitySummary,
  createUsabilityConfig,
  runUsabilityAgent,
} from './usability';

import { ActionsClient, WorkflowRun, WorkflowRunStatus, WorkflowRunLogs } from '../sandbox-types';

// --- Test Helpers ---

function makeInput(overrides: Partial<UsabilityAgentInput> = {}): UsabilityAgentInput {
  return {
    forkFullName: 'my-org/my-repo',
    branchName: 'agent/scope-42',
    affectedModule: 'src/parser',
    confirmedIssues: [{ number: 42, title: 'Fix parser', body: null, labels: ['bug'] }],
    sandboxServices: [],
    timeoutMinutes: 15,
    installCommand: 'npm install',
    entryPoints: ['import { parse } from "my-repo"'],
    ...overrides,
  };
}

function makeCheck(overrides: Partial<UsabilityCheck> = {}): UsabilityCheck {
  return {
    category: 'import_paths',
    description: 'Import resolves correctly',
    status: 'pass',
    details: 'Import works',
    severity: 'major',
    ...overrides,
  };
}

function makeMockActionsClient(overrides: Partial<ActionsClient> = {}): ActionsClient {
  return {
    triggerWorkflowDispatch: jest.fn().mockResolvedValue(undefined),
    getWorkflowRun: jest.fn().mockResolvedValue({
      id: 100,
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/my-org/my-repo/actions/runs/100',
      created_at: new Date().toISOString(),
    } as WorkflowRun),
    waitForWorkflowRun: jest.fn().mockResolvedValue({
      completed: true,
      conclusion: 'success',
      timedOut: false,
    } as WorkflowRunStatus),
    getWorkflowRunLogs: jest.fn().mockResolvedValue({
      stdout: 'All checks passed',
      stderr: '',
      exitCode: 0,
    } as WorkflowRunLogs),
    uploadArtifact: jest.fn().mockResolvedValue('artifact-url'),
    ...overrides,
  };
}

function makeMockExerciser(overrides: Partial<UsabilityExerciserOutput> = {}): UsabilityExerciser {
  return {
    exercise: jest.fn().mockResolvedValue({
      checks: [
        makeCheck({ category: 'installation', description: 'Package installs', status: 'pass', details: 'Installed successfully' }),
        makeCheck({ category: 'import_paths', description: 'Import resolves', status: 'pass', details: 'Imports work' }),
        makeCheck({ category: 'error_messages', description: 'Error messages helpful', status: 'pass', details: 'Clear errors' }),
      ],
      installSuccess: true,
      installOutput: 'added 100 packages',
      ...overrides,
    }),
  };
}

// --- Tests ---

describe('validateUsabilityConfig', () => {
  it('passes with valid input', () => {
    expect(() => validateUsabilityConfig(makeInput())).not.toThrow();
  });

  it('rejects empty forkFullName', () => {
    expect(() => validateUsabilityConfig(makeInput({ forkFullName: '' }))).toThrow(UsabilityAgentError);
  });

  it('rejects forkFullName without slash', () => {
    expect(() => validateUsabilityConfig(makeInput({ forkFullName: 'noslash' }))).toThrow(UsabilityAgentError);
  });

  it('rejects empty branchName', () => {
    expect(() => validateUsabilityConfig(makeInput({ branchName: '' }))).toThrow(UsabilityAgentError);
  });

  it('rejects whitespace branchName', () => {
    expect(() => validateUsabilityConfig(makeInput({ branchName: '   ' }))).toThrow(UsabilityAgentError);
  });

  it('rejects empty affectedModule', () => {
    expect(() => validateUsabilityConfig(makeInput({ affectedModule: '' }))).toThrow(UsabilityAgentError);
  });

  it('rejects empty installCommand', () => {
    expect(() => validateUsabilityConfig(makeInput({ installCommand: '' }))).toThrow(UsabilityAgentError);
  });

  it('includes phase in error', () => {
    try {
      validateUsabilityConfig(makeInput({ forkFullName: '' }));
    } catch (e: any) {
      expect(e.phase).toBe('validation');
    }
  });
});

describe('buildUsabilityWorkflowInputs', () => {
  it('includes branch', () => {
    const inputs = buildUsabilityWorkflowInputs(makeInput());
    expect(inputs.branch).toBe('agent/scope-42');
  });

  it('includes install_command', () => {
    const inputs = buildUsabilityWorkflowInputs(makeInput());
    expect(inputs.install_command).toBe('npm install');
  });

  it('includes affected_module', () => {
    const inputs = buildUsabilityWorkflowInputs(makeInput());
    expect(inputs.affected_module).toBe('src/parser');
  });

  it('includes entry_points as JSON', () => {
    const inputs = buildUsabilityWorkflowInputs(makeInput());
    expect(JSON.parse(inputs.entry_points)).toEqual(['import { parse } from "my-repo"']);
  });

  it('includes timeout', () => {
    const inputs = buildUsabilityWorkflowInputs(makeInput({ timeoutMinutes: 10 }));
    expect(inputs.timeout).toBe('10');
  });

  it('sets network_policy=none when no services', () => {
    const inputs = buildUsabilityWorkflowInputs(makeInput({ sandboxServices: [] }));
    expect(inputs.network_policy).toBe('none');
  });

  it('sets network_policy=allow when services declared', () => {
    const inputs = buildUsabilityWorkflowInputs(makeInput({ sandboxServices: ['postgres', 'redis'] }));
    expect(inputs.network_policy).toBe('allow:postgres,redis');
  });

  it('joins sandbox_services', () => {
    const inputs = buildUsabilityWorkflowInputs(makeInput({ sandboxServices: ['postgres'] }));
    expect(inputs.sandbox_services).toBe('postgres');
  });
});

describe('calculateDxScore', () => {
  it('returns 100 when all checks pass', () => {
    const checks = [
      makeCheck({ status: 'pass', severity: 'major' }),
      makeCheck({ status: 'pass', severity: 'critical' }),
    ];
    expect(calculateDxScore(checks)).toBe(100);
  });

  it('returns 0 for empty checks', () => {
    expect(calculateDxScore([])).toBe(0);
  });

  it('deducts 30 for a critical failure', () => {
    const checks = [makeCheck({ status: 'fail', severity: 'critical' })];
    expect(calculateDxScore(checks)).toBe(70);
  });

  it('deducts 20 for a major failure', () => {
    const checks = [makeCheck({ status: 'fail', severity: 'major' })];
    expect(calculateDxScore(checks)).toBe(80);
  });

  it('deducts 10 for a minor failure', () => {
    const checks = [makeCheck({ status: 'fail', severity: 'minor' })];
    expect(calculateDxScore(checks)).toBe(90);
  });

  it('deducts nothing for info-level failure', () => {
    const checks = [makeCheck({ status: 'fail', severity: 'info' })];
    expect(calculateDxScore(checks)).toBe(100);
  });

  it('deducts half for warnings', () => {
    const checks = [makeCheck({ status: 'warning', severity: 'major' })];
    expect(calculateDxScore(checks)).toBe(90);
  });

  it('accumulates multiple deductions', () => {
    const checks = [
      makeCheck({ status: 'fail', severity: 'critical' }),
      makeCheck({ status: 'fail', severity: 'major' }),
    ];
    expect(calculateDxScore(checks)).toBe(50);
  });

  it('floors at 0', () => {
    const checks = [
      makeCheck({ status: 'fail', severity: 'critical' }),
      makeCheck({ status: 'fail', severity: 'critical' }),
      makeCheck({ status: 'fail', severity: 'critical' }),
      makeCheck({ status: 'fail', severity: 'critical' }),
    ];
    expect(calculateDxScore(checks)).toBe(0);
  });
});

describe('extractBlockers', () => {
  it('extracts critical failures', () => {
    const checks = [
      makeCheck({ status: 'fail', severity: 'critical', category: 'installation', description: 'Install', details: 'Failed' }),
    ];
    const blockers = extractBlockers(checks);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('installation');
    expect(blockers[0]).toContain('Failed');
  });

  it('extracts major failures', () => {
    const checks = [
      makeCheck({ status: 'fail', severity: 'major', category: 'import_paths', description: 'Import', details: 'Not found' }),
    ];
    expect(extractBlockers(checks)).toHaveLength(1);
  });

  it('does not include minor failures', () => {
    const checks = [
      makeCheck({ status: 'fail', severity: 'minor', details: 'Minor issue' }),
    ];
    expect(extractBlockers(checks)).toHaveLength(0);
  });

  it('does not include warnings', () => {
    const checks = [
      makeCheck({ status: 'warning', severity: 'critical', details: 'Warning' }),
    ];
    expect(extractBlockers(checks)).toHaveLength(0);
  });

  it('returns empty for all passing', () => {
    const checks = [makeCheck({ status: 'pass' })];
    expect(extractBlockers(checks)).toHaveLength(0);
  });
});

describe('extractSuggestions', () => {
  it('extracts warnings', () => {
    const checks = [
      makeCheck({ status: 'warning', category: 'error_messages', description: 'Error msg', details: 'Could be clearer' }),
    ];
    const suggestions = extractSuggestions(checks);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toContain('error_messages');
  });

  it('extracts minor failures as suggestions', () => {
    const checks = [
      makeCheck({ status: 'fail', severity: 'minor', details: 'Typo in error' }),
    ];
    expect(extractSuggestions(checks)).toHaveLength(1);
  });

  it('does not include critical/major failures', () => {
    const checks = [
      makeCheck({ status: 'fail', severity: 'critical' }),
      makeCheck({ status: 'fail', severity: 'major' }),
    ];
    expect(extractSuggestions(checks)).toHaveLength(0);
  });

  it('returns empty for all passing', () => {
    const checks = [makeCheck({ status: 'pass' })];
    expect(extractSuggestions(checks)).toHaveLength(0);
  });
});

describe('generateUsabilitySummary', () => {
  it('includes DX score', () => {
    const summary = generateUsabilitySummary([], 85, true);
    expect(summary).toContain('DX Score: 85/100');
  });

  it('indicates installation success', () => {
    const summary = generateUsabilitySummary([], 100, true);
    expect(summary).toContain('✓ Success');
  });

  it('indicates installation failure', () => {
    const summary = generateUsabilitySummary([], 0, false);
    expect(summary).toContain('✗ Failed');
  });

  it('includes check counts', () => {
    const checks = [
      makeCheck({ status: 'pass' }),
      makeCheck({ status: 'fail' }),
      makeCheck({ status: 'warning' }),
    ];
    const summary = generateUsabilitySummary(checks, 80, true);
    expect(summary).toContain('1 passed');
    expect(summary).toContain('1 failed');
    expect(summary).toContain('1 warnings');
  });

  it('includes issues found section for failures', () => {
    const checks = [makeCheck({ status: 'fail', severity: 'critical', category: 'import_paths', details: 'Module not found' })];
    const summary = generateUsabilitySummary(checks, 70, true);
    expect(summary).toContain('Issues Found');
    expect(summary).toContain('Module not found');
  });

  it('includes suggestions section for warnings', () => {
    const checks = [makeCheck({ status: 'warning', category: 'error_messages', details: 'Vague error' })];
    const summary = generateUsabilitySummary(checks, 90, true);
    expect(summary).toContain('Suggestions');
    expect(summary).toContain('Vague error');
  });
});

describe('createUsabilityConfig', () => {
  it('copies all fields', () => {
    const config = createUsabilityConfig(makeInput());
    expect(config.forkFullName).toBe('my-org/my-repo');
    expect(config.branchName).toBe('agent/scope-42');
    expect(config.affectedModule).toBe('src/parser');
  });

  it('uses default timeout when not provided', () => {
    const config = createUsabilityConfig(makeInput({ timeoutMinutes: 0 }));
    expect(config.timeoutMinutes).toBe(DEFAULT_USABILITY_TIMEOUT_MINUTES);
  });

  it('copies sandboxServices array', () => {
    const input = makeInput({ sandboxServices: ['postgres'] });
    const config = createUsabilityConfig(input);
    input.sandboxServices.push('redis');
    expect(config.sandboxServices).toEqual(['postgres']);
  });
});

describe('runUsabilityAgent', () => {
  it('validates input before proceeding', async () => {
    const exerciser = makeMockExerciser();
    const client = makeMockActionsClient();
    await expect(
      runUsabilityAgent(makeInput({ forkFullName: '' }), exerciser, client)
    ).rejects.toThrow(UsabilityAgentError);
    expect(exerciser.exercise).not.toHaveBeenCalled();
  });

  it('triggers workflow dispatch', async () => {
    const client = makeMockActionsClient();
    const exerciser = makeMockExerciser();
    await runUsabilityAgent(makeInput(), exerciser, client);
    expect(client.triggerWorkflowDispatch).toHaveBeenCalledWith(
      'my-org/my-repo',
      USABILITY_WORKFLOW_FILE,
      'agent/scope-42',
      expect.objectContaining({ branch: 'agent/scope-42' })
    );
  });

  it('polls for workflow run', async () => {
    const client = makeMockActionsClient();
    const exerciser = makeMockExerciser();
    await runUsabilityAgent(makeInput(), exerciser, client);
    expect(client.getWorkflowRun).toHaveBeenCalled();
  });

  it('waits for workflow completion', async () => {
    const client = makeMockActionsClient();
    const exerciser = makeMockExerciser();
    await runUsabilityAgent(makeInput(), exerciser, client);
    expect(client.waitForWorkflowRun).toHaveBeenCalledWith(
      'my-org/my-repo',
      100,
      15 * 60 * 1000
    );
  });

  it('handles timeout', async () => {
    const client = makeMockActionsClient({
      waitForWorkflowRun: jest.fn().mockResolvedValue({
        completed: false,
        conclusion: null,
        timedOut: true,
      }),
    });
    const exerciser = makeMockExerciser();
    const result = await runUsabilityAgent(makeInput(), exerciser, client);
    expect(result.completed).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.blockers).toContain('Usability run timed out — could not complete DX assessment');
  });

  it('exercises the API after workflow completes', async () => {
    const exerciser = makeMockExerciser();
    const client = makeMockActionsClient();
    await runUsabilityAgent(makeInput(), exerciser, client);
    expect(exerciser.exercise).toHaveBeenCalledWith(expect.objectContaining({
      forkFullName: 'my-org/my-repo',
      affectedModule: 'src/parser',
    }));
  });

  it('returns structured result on success', async () => {
    const exerciser = makeMockExerciser();
    const client = makeMockActionsClient();
    const result = await runUsabilityAgent(makeInput(), exerciser, client);
    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.dxScore).toBeGreaterThan(0);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.summary).toContain('DX Score');
  });

  it('returns DX score of 0 when installation fails', async () => {
    const exerciser: UsabilityExerciser = {
      exercise: jest.fn().mockResolvedValue({
        checks: [],
        installSuccess: false,
        installOutput: 'ERR! peer dependency conflict',
      }),
    };
    const client = makeMockActionsClient();
    const result = await runUsabilityAgent(makeInput(), exerciser, client);
    expect(result.dxScore).toBe(0);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers[0]).toContain('installation');
  });

  it('includes workflow run URL', async () => {
    const client = makeMockActionsClient();
    const exerciser = makeMockExerciser();
    const result = await runUsabilityAgent(makeInput(), exerciser, client);
    expect(result.workflowRunUrl).toContain('https://github.com');
  });

  it('calculates duration', async () => {
    const exerciser = makeMockExerciser();
    const client = makeMockActionsClient();
    const result = await runUsabilityAgent(makeInput(), exerciser, client);
    expect(result.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('throws UsabilityAgentError on dispatch failure', async () => {
    const client = makeMockActionsClient({
      triggerWorkflowDispatch: jest.fn().mockRejectedValue(new Error('API error')),
    });
    const exerciser = makeMockExerciser();
    await expect(
      runUsabilityAgent(makeInput(), exerciser, client)
    ).rejects.toThrow(UsabilityAgentError);
  });

  it('error has dispatch phase', async () => {
    const client = makeMockActionsClient({
      triggerWorkflowDispatch: jest.fn().mockRejectedValue(new Error('API error')),
    });
    const exerciser = makeMockExerciser();
    try {
      await runUsabilityAgent(makeInput(), exerciser, client);
    } catch (e: any) {
      expect(e.phase).toBe('dispatch');
    }
  });

  it('throws UsabilityAgentError on exerciser failure', async () => {
    const exerciser: UsabilityExerciser = {
      exercise: jest.fn().mockRejectedValue(new Error('Exercise failed')),
    };
    const client = makeMockActionsClient();
    await expect(
      runUsabilityAgent(makeInput(), exerciser, client)
    ).rejects.toThrow(UsabilityAgentError);
  });

  it('error has exercise phase', async () => {
    const exerciser: UsabilityExerciser = {
      exercise: jest.fn().mockRejectedValue(new Error('Exercise failed')),
    };
    const client = makeMockActionsClient();
    try {
      await runUsabilityAgent(makeInput(), exerciser, client);
    } catch (e: any) {
      expect(e.phase).toBe('exercise');
    }
  });

  it('reports DX issues not just pass/fail', async () => {
    const exerciser: UsabilityExerciser = {
      exercise: jest.fn().mockResolvedValue({
        checks: [
          makeCheck({ status: 'pass', category: 'installation' }),
          makeCheck({ status: 'warning', category: 'error_messages', severity: 'minor', details: 'Error message is vague' }),
          makeCheck({ status: 'fail', category: 'import_paths', severity: 'major', details: 'Deep import path required' }),
        ],
        installSuccess: true,
        installOutput: 'ok',
      }),
    };
    const client = makeMockActionsClient();
    const result = await runUsabilityAgent(makeInput(), exerciser, client);
    expect(result.dxScore).toBeLessThan(100);
    expect(result.blockers.length).toBe(1);
    expect(result.suggestions.length).toBe(1);
    expect(result.summary).toContain('import_paths');
  });

  it('runs in the same sandbox (uses same workflow dispatch pattern)', async () => {
    const client = makeMockActionsClient();
    const exerciser = makeMockExerciser();
    await runUsabilityAgent(makeInput({ sandboxServices: ['postgres'] }), exerciser, client);
    const dispatchCall = (client.triggerWorkflowDispatch as jest.Mock).mock.calls[0];
    expect(dispatchCall[3].sandbox_services).toBe('postgres');
    expect(dispatchCall[3].network_policy).toBe('allow:postgres');
  });

  it('output is structured for eval agent consumption', async () => {
    const exerciser = makeMockExerciser();
    const client = makeMockActionsClient();
    const result = await runUsabilityAgent(makeInput(), exerciser, client);
    // Verify the result has all fields the eval agent and PR body need
    expect(result).toHaveProperty('completed');
    expect(result).toHaveProperty('dxScore');
    expect(result).toHaveProperty('checks');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('durationSeconds');
    expect(result).toHaveProperty('timedOut');
    expect(result).toHaveProperty('workflowRunUrl');
    expect(result).toHaveProperty('blockers');
    expect(result).toHaveProperty('suggestions');
  });

  it('exercises import paths', async () => {
    const exerciser = makeMockExerciser();
    const client = makeMockActionsClient();
    const input = makeInput({ entryPoints: ['import { parse } from "my-repo"'] });
    await runUsabilityAgent(input, exerciser, client);
    expect(exerciser.exercise).toHaveBeenCalledWith(
      expect.objectContaining({ entryPoints: ['import { parse } from "my-repo"'] })
    );
  });

  it('handles workflow run not found gracefully', async () => {
    const client = makeMockActionsClient({
      getWorkflowRun: jest.fn().mockResolvedValue(null),
    });
    const exerciser = makeMockExerciser();
    // Should still proceed to exercise (workflow run URL will be empty)
    const result = await runUsabilityAgent(makeInput(), exerciser, client);
    expect(result.completed).toBe(true);
    expect(result.workflowRunUrl).toBe('');
  });

  it('configurable timeout passed to workflow', async () => {
    const client = makeMockActionsClient();
    const exerciser = makeMockExerciser();
    await runUsabilityAgent(makeInput({ timeoutMinutes: 10 }), exerciser, client);
    expect(client.waitForWorkflowRun).toHaveBeenCalledWith(
      'my-org/my-repo',
      100,
      10 * 60 * 1000
    );
  });
});

describe('constants', () => {
  it('USABILITY_WORKFLOW_FILE is defined', () => {
    expect(USABILITY_WORKFLOW_FILE).toBe('usability-test.yml');
  });

  it('DEFAULT_USABILITY_TIMEOUT_MINUTES is 15', () => {
    expect(DEFAULT_USABILITY_TIMEOUT_MINUTES).toBe(15);
  });
});
