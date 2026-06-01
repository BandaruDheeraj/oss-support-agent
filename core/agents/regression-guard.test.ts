/**
 * Unit tests for the regression guard (US-016).
 * Tests cover: config validation, workflow inputs, output normalization,
 * output diffing, summary generation, and full pipeline integration.
 */

import {
  RegressionConfig,
  RegressionResult,
  BranchTestResult,
  OutputDiff,
  REGRESSION_WORKFLOW_FILE,
  DEFAULT_REGRESSION_TIMEOUT_MINUTES,
  RegressionGuardError,
} from './regression-guard-types';

import {
  validateRegressionConfig,
  createRegressionConfig,
  buildRegressionWorkflowInputs,
  normalizeOutput,
  diffOutputs,
  generateRegressionSummary,
  runRegressionGuard,
} from './regression-guard';

import { ActionsClient, WorkflowRun, WorkflowRunStatus, WorkflowRunLogs } from '../sandbox-types';
import type { SandboxSession } from '../sandbox-session';

// --- Helpers ---

function makeConfig(overrides?: Partial<RegressionConfig>): RegressionConfig {
  return {
    forkFullName: 'my-org/my-repo',
    forkBranchName: 'agent/scope-42',
    upstreamRepo: 'upstream-owner/my-repo',
    upstreamDefaultBranch: 'main',
    testCommand: 'npm test',
    sandboxServices: [],
    timeoutMinutes: 15,
    ...overrides,
  };
}

function makeBranchResult(overrides?: Partial<BranchTestResult>): BranchTestResult {
  return {
    branch: 'main',
    completed: true,
    exitCode: 0,
    stdout: 'Tests passed: 42',
    stderr: '',
    durationSeconds: 30,
    timedOut: false,
    workflowRunUrl: 'https://github.com/my-org/my-repo/actions/runs/123',
    ...overrides,
  };
}

function makeWorkflowRun(overrides?: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 100,
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/my-org/my-repo/actions/runs/100',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockClient(overrides?: Partial<ActionsClient>): ActionsClient {
  let callCount = 0;
  return {
    triggerWorkflowDispatch: jest.fn().mockResolvedValue(undefined),
    getWorkflowRun: jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(makeWorkflowRun({ id: 100 + callCount }));
    }),
    waitForWorkflowRun: jest.fn().mockResolvedValue({
      completed: true,
      conclusion: 'success',
      timedOut: false,
    } as WorkflowRunStatus),
    getWorkflowRunLogs: jest.fn().mockResolvedValue({
      stdout: 'Tests passed: 42',
      stderr: '',
      exitCode: 0,
    } as WorkflowRunLogs),
    uploadArtifact: jest.fn().mockResolvedValue('artifact-url'),
    ...overrides,
  };
}

function makeMockSandboxSession(overrides: Partial<SandboxSession> = {}): SandboxSession {
  let callCount = 0;
  const base = {
    verifyWorkflowReachability: jest.fn().mockResolvedValue({
      ok: true,
      phase: 'workflow',
    }),
    dispatchWorkflow: jest.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve({
        ok: true,
        runId: 100 + callCount,
        runUrl: `https://github.com/support/oss-support-agent/actions/runs/${100 + callCount}`,
        conclusion: 'success',
        stepOutcomes: [],
        stdout: 'Tests passed: 42',
        stderr: '',
        rawLogs: 'Tests passed: 42',
        exitCode: 0,
      });
    }),
  };
  return Object.assign(base, overrides) as unknown as SandboxSession;
}

// --- Tests ---

describe('Regression Guard (US-016)', () => {
  describe('validateRegressionConfig', () => {
    it('passes with a valid config', () => {
      expect(() => validateRegressionConfig(makeConfig())).not.toThrow();
    });

    it('rejects empty forkFullName', () => {
      expect(() => validateRegressionConfig(makeConfig({ forkFullName: '' }))).toThrow(
        RegressionGuardError
      );
    });

    it('rejects forkFullName without slash', () => {
      expect(() => validateRegressionConfig(makeConfig({ forkFullName: 'noslash' }))).toThrow(
        /must be "org\/repo" format/
      );
    });

    it('rejects empty forkBranchName', () => {
      expect(() => validateRegressionConfig(makeConfig({ forkBranchName: '' }))).toThrow(
        /forkBranchName is required/
      );
    });

    it('rejects whitespace-only forkBranchName', () => {
      expect(() => validateRegressionConfig(makeConfig({ forkBranchName: '   ' }))).toThrow(
        /forkBranchName is required/
      );
    });

    it('rejects empty upstreamRepo', () => {
      expect(() => validateRegressionConfig(makeConfig({ upstreamRepo: '' }))).toThrow(
        /Invalid upstreamRepo/
      );
    });

    it('rejects upstreamRepo without slash', () => {
      expect(() => validateRegressionConfig(makeConfig({ upstreamRepo: 'noslash' }))).toThrow(
        /must be "owner\/repo" format/
      );
    });

    it('rejects empty upstreamDefaultBranch', () => {
      expect(() => validateRegressionConfig(makeConfig({ upstreamDefaultBranch: '' }))).toThrow(
        /upstreamDefaultBranch is required/
      );
    });

    it('rejects empty testCommand', () => {
      expect(() => validateRegressionConfig(makeConfig({ testCommand: '' }))).toThrow(
        /testCommand is required/
      );
    });

    it('rejects zero timeoutMinutes', () => {
      expect(() => validateRegressionConfig(makeConfig({ timeoutMinutes: 0 }))).toThrow(
        /timeoutMinutes must be positive/
      );
    });

    it('rejects negative timeoutMinutes', () => {
      expect(() => validateRegressionConfig(makeConfig({ timeoutMinutes: -5 }))).toThrow(
        /timeoutMinutes must be positive/
      );
    });

    it('includes phase in error', () => {
      try {
        validateRegressionConfig(makeConfig({ forkFullName: '' }));
      } catch (err) {
        expect((err as RegressionGuardError).phase).toBe('validation');
      }
    });
  });

  describe('createRegressionConfig', () => {
    it('creates config with all fields', () => {
      const config = createRegressionConfig(
        'org/repo', 'agent/scope-1', 'owner/repo', 'main',
        'npm test', ['postgres'], 20
      );
      expect(config.forkFullName).toBe('org/repo');
      expect(config.forkBranchName).toBe('agent/scope-1');
      expect(config.upstreamRepo).toBe('owner/repo');
      expect(config.upstreamDefaultBranch).toBe('main');
      expect(config.testCommand).toBe('npm test');
      expect(config.sandboxServices).toEqual(['postgres']);
      expect(config.timeoutMinutes).toBe(20);
    });

    it('applies default timeout', () => {
      const config = createRegressionConfig(
        'org/repo', 'branch', 'owner/repo', 'main', 'npm test', []
      );
      expect(config.timeoutMinutes).toBe(DEFAULT_REGRESSION_TIMEOUT_MINUTES);
    });

    it('copies sandboxServices array (immutability)', () => {
      const services = ['redis', 'postgres'];
      const config = createRegressionConfig(
        'org/repo', 'branch', 'owner/repo', 'main', 'npm test', services
      );
      services.push('mysql');
      expect(config.sandboxServices).toEqual(['redis', 'postgres']);
    });
  });

  describe('buildRegressionWorkflowInputs', () => {
    it('includes test_command', () => {
      const inputs = buildRegressionWorkflowInputs(makeConfig(), 'main');
      expect(inputs.test_command).toBe('npm test');
    });

    it('uses the provided branch, not config branch', () => {
      const inputs = buildRegressionWorkflowInputs(makeConfig(), 'upstream-main');
      expect(inputs.branch).toBe('upstream-main');
    });

    it('includes timeout_minutes', () => {
      const inputs = buildRegressionWorkflowInputs(makeConfig({ timeoutMinutes: 20 }), 'main');
      expect(inputs.timeout_minutes).toBe('20');
    });

    it('sets network_policy to none when no services', () => {
      const inputs = buildRegressionWorkflowInputs(makeConfig({ sandboxServices: [] }), 'main');
      expect(inputs.network_policy).toBe('none');
    });

    it('sets network_policy to allow when services declared', () => {
      const inputs = buildRegressionWorkflowInputs(
        makeConfig({ sandboxServices: ['redis', 'postgres'] }), 'main'
      );
      expect(inputs.network_policy).toBe('allow:redis,postgres');
    });

    it('joins sandbox_services with comma', () => {
      const inputs = buildRegressionWorkflowInputs(
        makeConfig({ sandboxServices: ['a', 'b'] }), 'main'
      );
      expect(inputs.sandbox_services).toBe('a,b');
    });
  });

  describe('normalizeOutput', () => {
    it('replaces millisecond timings', () => {
      expect(normalizeOutput('Ran in 245ms')).toBe('Ran in <TIME>');
    });

    it('replaces second timings', () => {
      expect(normalizeOutput('Took 3.5s to complete')).toBe('Took <TIME> to complete');
    });

    it('replaces ISO timestamps', () => {
      expect(normalizeOutput('Started at 2026-05-06T17:14:59.380Z')).toBe('Started at <TIMESTAMP>');
    });

    it('replaces "X seconds" format', () => {
      expect(normalizeOutput('Completed in 42 seconds')).toBe('Completed in <TIME>');
    });

    it('trims whitespace', () => {
      expect(normalizeOutput('  hello  ')).toBe('hello');
    });

    it('leaves non-timing text unchanged', () => {
      expect(normalizeOutput('Test suite passed')).toBe('Test suite passed');
    });

    it('handles multiple timings', () => {
      const input = 'Test 1: 10ms, Test 2: 200ms, Total: 0.5s';
      const result = normalizeOutput(input);
      expect(result).not.toContain('10ms');
      expect(result).not.toContain('200ms');
      expect(result).not.toContain('0.5s');
    });

    it('strips the synthetic GHA log archive marker so fork/upstream runs compare equal', () => {
      const forkSide =
        'tests passed\n(GHA log archive: 1234 bytes; run https://github.com/fork/repo/actions/runs/111)';
      const upstreamSide =
        'tests passed\n(GHA log archive: 9876 bytes; run https://github.com/upstream/repo/actions/runs/222)';
      expect(normalizeOutput(forkSide)).toBe(normalizeOutput(upstreamSide));
      expect(normalizeOutput(forkSide)).toContain('<GHA_LOG_MARKER>');
      expect(normalizeOutput(forkSide)).not.toContain('1234');
      expect(normalizeOutput(forkSide)).not.toContain('actions/runs/111');
    });
  });

  describe('diffOutputs', () => {
    it('returns empty array when outputs are identical', () => {
      const fork = makeBranchResult({ branch: 'agent/scope-1' });
      const upstream = makeBranchResult({ branch: 'main' });
      expect(diffOutputs(fork, upstream)).toEqual([]);
    });

    it('detects exit code difference', () => {
      const fork = makeBranchResult({ branch: 'agent/scope-1', exitCode: 1 });
      const upstream = makeBranchResult({ branch: 'main', exitCode: 0 });
      const diffs = diffOutputs(fork, upstream);
      expect(diffs).toHaveLength(1);
      expect(diffs[0].category).toBe('exit_code');
      expect(diffs[0].upstream).toBe('0');
      expect(diffs[0].fork).toBe('1');
    });

    it('detects stdout difference', () => {
      const fork = makeBranchResult({ branch: 'fork', stdout: 'Tests: 43 passed' });
      const upstream = makeBranchResult({ branch: 'main', stdout: 'Tests: 42 passed' });
      const diffs = diffOutputs(fork, upstream);
      const stdoutDiff = diffs.find((d) => d.category === 'stdout');
      expect(stdoutDiff).toBeDefined();
      expect(stdoutDiff!.description).toContain('Standard output differs');
    });

    it('detects stderr difference', () => {
      const fork = makeBranchResult({ branch: 'fork', stderr: 'Warning: deprecated API' });
      const upstream = makeBranchResult({ branch: 'main', stderr: '' });
      const diffs = diffOutputs(fork, upstream);
      const stderrDiff = diffs.find((d) => d.category === 'stderr');
      expect(stderrDiff).toBeDefined();
    });

    it('detects timeout difference', () => {
      const fork = makeBranchResult({ branch: 'fork', timedOut: true });
      const upstream = makeBranchResult({ branch: 'main', timedOut: false });
      const diffs = diffOutputs(fork, upstream);
      const timeoutDiff = diffs.find((d) => d.category === 'timeout');
      expect(timeoutDiff).toBeDefined();
      expect(timeoutDiff!.description).toContain('Fork branch timed out');
    });

    it('detects upstream timeout', () => {
      const fork = makeBranchResult({ branch: 'fork', timedOut: false });
      const upstream = makeBranchResult({ branch: 'main', timedOut: true });
      const diffs = diffOutputs(fork, upstream);
      const timeoutDiff = diffs.find((d) => d.category === 'timeout');
      expect(timeoutDiff!.description).toContain('Upstream timed out');
    });

    it('ignores timing differences in stdout', () => {
      const fork = makeBranchResult({ branch: 'fork', stdout: 'Ran in 100ms' });
      const upstream = makeBranchResult({ branch: 'main', stdout: 'Ran in 200ms' });
      const diffs = diffOutputs(fork, upstream);
      expect(diffs.find((d) => d.category === 'stdout')).toBeUndefined();
    });

    it('ignores timing differences in stderr', () => {
      const fork = makeBranchResult({ branch: 'fork', stderr: 'Completed in 5 seconds' });
      const upstream = makeBranchResult({ branch: 'main', stderr: 'Completed in 3 seconds' });
      const diffs = diffOutputs(fork, upstream);
      expect(diffs.find((d) => d.category === 'stderr')).toBeUndefined();
    });

    it('detects multiple differences simultaneously', () => {
      const fork = makeBranchResult({
        branch: 'fork',
        exitCode: 1,
        stdout: 'FAIL: test_foo',
        stderr: 'Error: assertion failed',
      });
      const upstream = makeBranchResult({
        branch: 'main',
        exitCode: 0,
        stdout: 'Tests passed: 42',
        stderr: '',
      });
      const diffs = diffOutputs(fork, upstream);
      expect(diffs.length).toBeGreaterThanOrEqual(3);
      expect(diffs.map((d) => d.category)).toContain('exit_code');
      expect(diffs.map((d) => d.category)).toContain('stdout');
      expect(diffs.map((d) => d.category)).toContain('stderr');
    });

    it('truncates long output in diff values', () => {
      const longStr = 'x'.repeat(1000);
      const fork = makeBranchResult({ branch: 'fork', stdout: longStr });
      const upstream = makeBranchResult({ branch: 'main', stdout: 'short' });
      const diffs = diffOutputs(fork, upstream);
      const stdoutDiff = diffs.find((d) => d.category === 'stdout');
      expect(stdoutDiff!.fork.length).toBeLessThanOrEqual(500);
      expect(stdoutDiff!.upstream.length).toBeLessThanOrEqual(500);
    });

    it('treats null and non-null exit codes as different', () => {
      const fork = makeBranchResult({ branch: 'fork', exitCode: null });
      const upstream = makeBranchResult({ branch: 'main', exitCode: 0 });
      const diffs = diffOutputs(fork, upstream);
      expect(diffs.find((d) => d.category === 'exit_code')).toBeDefined();
    });
  });

  describe('generateRegressionSummary', () => {
    it('reports no regressions when none detected', () => {
      const result: RegressionResult = {
        regressionDetected: false,
        diffs: [],
        forkResult: makeBranchResult({ branch: 'fork' }),
        upstreamResult: makeBranchResult({ branch: 'main' }),
        summary: '',
      };
      const summary = generateRegressionSummary(result);
      expect(summary).toContain('No Regressions Detected');
      expect(summary).toContain('identical observable output');
    });

    it('reports regressions with diff details', () => {
      const result: RegressionResult = {
        regressionDetected: true,
        diffs: [
          {
            category: 'exit_code',
            description: 'Exit code changed from 0 to 1',
            upstream: '0',
            fork: '1',
          },
        ],
        forkResult: makeBranchResult({ branch: 'fork', workflowRunUrl: 'https://fork-url' }),
        upstreamResult: makeBranchResult({ branch: 'main', workflowRunUrl: 'https://upstream-url' }),
        summary: '',
      };
      const summary = generateRegressionSummary(result);
      expect(summary).toContain('Behavioural Changes Detected');
      expect(summary).toContain('1 difference');
      expect(summary).toContain('exit_code');
      expect(summary).toContain('https://fork-url');
      expect(summary).toContain('https://upstream-url');
    });

    it('includes multiple diffs in summary', () => {
      const result: RegressionResult = {
        regressionDetected: true,
        diffs: [
          { category: 'exit_code', description: 'Changed', upstream: '0', fork: '1' },
          { category: 'stdout', description: 'Differs', upstream: 'a', fork: 'b' },
        ],
        forkResult: makeBranchResult({ branch: 'fork' }),
        upstreamResult: makeBranchResult({ branch: 'main' }),
        summary: '',
      };
      const summary = generateRegressionSummary(result);
      expect(summary).toContain('2 difference');
      expect(summary).toContain('exit_code');
      expect(summary).toContain('stdout');
    });
  });

  describe('runRegressionGuard - integration', () => {
    it('validates config before running', async () => {
      const client = makeMockClient();
      const session = makeMockSandboxSession();
      await expect(
        runRegressionGuard(makeConfig({ forkFullName: '' }), client, 1, session)
      ).rejects.toThrow(RegressionGuardError);
      expect(session.dispatchWorkflow).not.toHaveBeenCalled();
    });

    it('triggers workflow dispatch for both branches in parallel', async () => {
      const client = makeMockClient();
      const session = makeMockSandboxSession();
      await runRegressionGuard(makeConfig(), client, 1, session);
      expect(session.dispatchWorkflow).toHaveBeenCalledTimes(2);

      const calls = (session.dispatchWorkflow as jest.Mock).mock.calls;
      const branches = calls.map((c: any[]) => c[0].inputs.branch);
      expect(branches).toContain('agent/scope-42');
      expect(branches).toContain('main');
    });

    it('uses REGRESSION_WORKFLOW_FILE for dispatch', async () => {
      const client = makeMockClient();
      const session = makeMockSandboxSession();
      await runRegressionGuard(makeConfig(), client, 1, session);
      const calls = (session.dispatchWorkflow as jest.Mock).mock.calls;
      expect(calls[0][0].workflowId).toBe(REGRESSION_WORKFLOW_FILE);
      expect(calls[1][0].workflowId).toBe(REGRESSION_WORKFLOW_FILE);
    });

    it('returns no regression when outputs match', async () => {
      const client = makeMockClient();
      const session = makeMockSandboxSession();
      const result = await runRegressionGuard(makeConfig(), client, 1, session);
      expect(result.regressionDetected).toBe(false);
      expect(result.diffs).toHaveLength(0);
    });

    it('detects regression when fork has different exit code', async () => {
      const client = makeMockClient();
      let callCount = 0;
      const session = makeMockSandboxSession({
        dispatchWorkflow: jest.fn().mockImplementation(() => {
          callCount += 1;
          if (callCount === 1) {
            return Promise.resolve({
              ok: true,
              runId: 101,
              runUrl: 'https://github.com/support/oss-support-agent/actions/runs/101',
              conclusion: 'failure',
              stepOutcomes: [],
              stdout: 'FAIL',
              stderr: 'error',
              rawLogs: 'FAIL\nerror',
              exitCode: 1,
            });
          }
          return Promise.resolve({
            ok: true,
            runId: 102,
            runUrl: 'https://github.com/support/oss-support-agent/actions/runs/102',
            conclusion: 'success',
            stepOutcomes: [],
            stdout: 'PASS',
            stderr: '',
            rawLogs: 'PASS',
            exitCode: 0,
          });
        }),
      });
      const result = await runRegressionGuard(makeConfig(), client, 1, session);
      expect(result.regressionDetected).toBe(true);
      expect(result.diffs.find((d) => d.category === 'exit_code')).toBeDefined();
    });

    it('detects regression when stdout differs', async () => {
      const client = makeMockClient();
      let callCount = 0;
      const session = makeMockSandboxSession({
        dispatchWorkflow: jest.fn().mockImplementation(() => {
          callCount += 1;
          return Promise.resolve({
            ok: true,
            runId: 100 + callCount,
            runUrl: `https://github.com/support/oss-support-agent/actions/runs/${100 + callCount}`,
            conclusion: 'success',
            stepOutcomes: [],
            stdout: callCount === 1 ? 'Tests: 43 passed' : 'Tests: 42 passed',
            stderr: '',
            rawLogs: callCount === 1 ? 'Tests: 43 passed' : 'Tests: 42 passed',
            exitCode: 0,
          });
        }),
      });
      const result = await runRegressionGuard(makeConfig(), client, 1, session);
      expect(result.regressionDetected).toBe(true);
      expect(result.diffs.find((d) => d.category === 'stdout')).toBeDefined();
    });

    it('includes both branch results in output', async () => {
      const client = makeMockClient();
      const session = makeMockSandboxSession();
      const result = await runRegressionGuard(makeConfig(), client, 1, session);
      expect(result.forkResult).toBeDefined();
      expect(result.forkResult.branch).toBe('agent/scope-42');
      expect(result.upstreamResult).toBeDefined();
      expect(result.upstreamResult.branch).toBe('main');
    });

    it('includes summary in result', async () => {
      const client = makeMockClient();
      const session = makeMockSandboxSession();
      const result = await runRegressionGuard(makeConfig(), client, 1, session);
      expect(result.summary).toContain('No Regressions Detected');
    });

    it('handles timeout on fork branch', async () => {
      const client = makeMockClient();
      let callCount = 0;
      const session = makeMockSandboxSession({
        dispatchWorkflow: jest.fn().mockImplementation(() => {
          callCount += 1;
          if (callCount === 1) {
            return Promise.resolve({
              ok: false,
              reason: 'dispatch_failed',
              diagnostics: { error: 'workflow timed out after 15 minute(s)' },
            });
          }
          return Promise.resolve({
            ok: true,
            runId: 102,
            runUrl: 'https://github.com/support/oss-support-agent/actions/runs/102',
            conclusion: 'success',
            stepOutcomes: [],
            stdout: 'PASS',
            stderr: '',
            rawLogs: 'PASS',
            exitCode: 0,
          });
        }),
      });
      const result = await runRegressionGuard(makeConfig(), client, 1, session);
      expect(result.regressionDetected).toBe(true);
      expect(result.diffs.find((d) => d.category === 'timeout')).toBeDefined();
    });

    it('throws RegressionGuardError on dispatch failure', async () => {
      const client = makeMockClient();
      const session = makeMockSandboxSession({
        dispatchWorkflow: jest.fn().mockResolvedValue({
          ok: false,
          reason: 'dispatch_failed',
          diagnostics: { error: 'dispatch failed' },
        }),
      });
      await expect(
        runRegressionGuard(makeConfig(), client, 1, session)
      ).rejects.toThrow(RegressionGuardError);
    });

    it('throws RegressionGuardError when workflow is unreachable', async () => {
      const client = makeMockClient();
      const session = makeMockSandboxSession({
        verifyWorkflowReachability: jest.fn().mockResolvedValue({
          ok: false,
          phase: 'workflow',
          reason: 'workflow_unreachable',
          diagnostics: { httpStatus: 404 },
        }),
      });
      await expect(
        runRegressionGuard(makeConfig(), client, 1, session)
      ).rejects.toThrow(/reachability failed/);
    });

    it('includes branch name in error', async () => {
      const client = makeMockClient();
      const session = makeMockSandboxSession({
        dispatchWorkflow: jest.fn().mockResolvedValue({
          ok: false,
          reason: 'dispatch_failed',
          diagnostics: { error: 'fail' },
        }),
      });
      try {
        await runRegressionGuard(makeConfig(), client, 1, session);
      } catch (err) {
        expect((err as RegressionGuardError).branch).toBeDefined();
        expect((err as RegressionGuardError).phase).toBe('trigger');
      }
    });

    it('passes correct test_command in workflow inputs', async () => {
      const client = makeMockClient();
      const session = makeMockSandboxSession();
      await runRegressionGuard(makeConfig({ testCommand: 'pytest -v' }), client, 1, session);
      const calls = (session.dispatchWorkflow as jest.Mock).mock.calls;
      expect(calls[0][0].inputs.test_command).toBe('pytest -v');
      expect(calls[1][0].inputs.test_command).toBe('pytest -v');
    });

    it('uses configurable timeout', async () => {
      const client = makeMockClient();
      const session = makeMockSandboxSession();
      await runRegressionGuard(makeConfig({ timeoutMinutes: 30 }), client, 1, session);
      const calls = (session.dispatchWorkflow as jest.Mock).mock.calls;
      expect(calls[0][0].timeoutMins).toBe(30);
      expect(calls[1][0].timeoutMins).toBe(30);
    });

    it('each branch run is fully isolated (fresh checkout)', async () => {
      const client = makeMockClient();
      const session = makeMockSandboxSession();
      await runRegressionGuard(makeConfig(), client, 1, session);
      const triggerCalls = (session.dispatchWorkflow as jest.Mock).mock.calls;
      // Each run specifies its own branch
      expect(triggerCalls[0][0].inputs.branch).toBe('agent/scope-42');
      expect(triggerCalls[1][0].inputs.branch).toBe('main');
    });

    it('regression details suitable for PR body and per-issue verdicts', async () => {
      const client = makeMockClient();
      let callCount = 0;
      const session = makeMockSandboxSession({
        dispatchWorkflow: jest.fn().mockImplementation(() => {
          callCount += 1;
          if (callCount === 1) {
            return Promise.resolve({
              ok: true,
              runId: 101,
              runUrl: 'https://github.com/support/oss-support-agent/actions/runs/101',
              conclusion: 'failure',
              stepOutcomes: [],
              stdout: 'FAIL: test_regression',
              stderr: 'AssertionError',
              rawLogs: 'FAIL: test_regression\nAssertionError',
              exitCode: 1,
            });
          }
          return Promise.resolve({
            ok: true,
            runId: 102,
            runUrl: 'https://github.com/support/oss-support-agent/actions/runs/102',
            conclusion: 'success',
            stepOutcomes: [],
            stdout: 'PASS: all tests',
            stderr: '',
            rawLogs: 'PASS: all tests',
            exitCode: 0,
          });
        }),
      });
      const result = await runRegressionGuard(makeConfig(), client, 1, session);
      expect(result.regressionDetected).toBe(true);
      // Summary is suitable for PR body
      expect(result.summary).toContain('Behavioural Changes Detected');
      // Diffs contain enough detail for per-issue verdicts
      for (const diff of result.diffs) {
        expect(diff.category).toBeDefined();
        expect(diff.description).toBeDefined();
        expect(diff.upstream).toBeDefined();
        expect(diff.fork).toBeDefined();
      }
    });

    it('throws when sandbox session is omitted', async () => {
      const client = makeMockClient();
      await expect(runRegressionGuard(makeConfig(), client, 1)).rejects.toThrow(
        /SandboxSession is required/
      );
    });
  });

  describe('Constants', () => {
    it('REGRESSION_WORKFLOW_FILE is regression-test.yml', () => {
      expect(REGRESSION_WORKFLOW_FILE).toBe('regression-test.yml');
    });

    it('DEFAULT_REGRESSION_TIMEOUT_MINUTES is 15', () => {
      expect(DEFAULT_REGRESSION_TIMEOUT_MINUTES).toBe(15);
    });
  });
});
