/**
 * Regression guard for the OSS Autonomous Fix Loop (US-016).
 *
 * Diffs observable behaviour of the fork branch against upstream main
 * by running the same shared test cases on both in parallel sandbox jobs,
 * then comparing outputs to flag any change.
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
  ActionsClient,
} from '../sandbox-types';
import type { SandboxPhaseFailure, SandboxSession } from '../sandbox-session';

/**
 * Validates regression guard configuration.
 */
export function validateRegressionConfig(config: RegressionConfig): void {
  if (!config.forkFullName || !config.forkFullName.includes('/')) {
    throw new RegressionGuardError(
      `Invalid forkFullName: "${config.forkFullName}" (must be "org/repo" format)`,
      'validation',
      ''
    );
  }
  if (!config.forkBranchName || config.forkBranchName.trim() === '') {
    throw new RegressionGuardError(
      'forkBranchName is required',
      'validation',
      ''
    );
  }
  if (!config.upstreamRepo || !config.upstreamRepo.includes('/')) {
    throw new RegressionGuardError(
      `Invalid upstreamRepo: "${config.upstreamRepo}" (must be "owner/repo" format)`,
      'validation',
      ''
    );
  }
  if (!config.upstreamDefaultBranch || config.upstreamDefaultBranch.trim() === '') {
    throw new RegressionGuardError(
      'upstreamDefaultBranch is required',
      'validation',
      ''
    );
  }
  if (!config.testCommand || config.testCommand.trim() === '') {
    throw new RegressionGuardError(
      'testCommand is required',
      'validation',
      ''
    );
  }
  if (config.timeoutMinutes <= 0) {
    throw new RegressionGuardError(
      `timeoutMinutes must be positive, got ${config.timeoutMinutes}`,
      'validation',
      ''
    );
  }
}

/**
 * Creates a RegressionConfig from manifest and context.
 */
export function createRegressionConfig(
  forkFullName: string,
  forkBranchName: string,
  upstreamRepo: string,
  upstreamDefaultBranch: string,
  testCommand: string,
  sandboxServices: string[],
  timeoutMinutes?: number
): RegressionConfig {
  return {
    forkFullName,
    forkBranchName,
    upstreamRepo,
    upstreamDefaultBranch,
    testCommand,
    sandboxServices: [...sandboxServices],
    timeoutMinutes: timeoutMinutes ?? DEFAULT_REGRESSION_TIMEOUT_MINUTES,
  };
}

/**
 * Builds workflow dispatch inputs for a branch test run.
 */
export function buildRegressionWorkflowInputs(
  config: RegressionConfig,
  branch: string
): Record<string, string> {
  return {
    test_command: config.testCommand,
    branch,
    timeout_minutes: String(config.timeoutMinutes),
    sandbox_services: config.sandboxServices.join(','),
    network_policy: config.sandboxServices.length === 0
      ? 'none'
      : `allow:${config.sandboxServices.join(',')}`,
  };
}

/**
 * Runs the test command on a single branch and returns the result.
 */
async function runBranchTest(
  config: RegressionConfig,
  branch: string,
  sandboxSession: SandboxSession
): Promise<BranchTestResult> {
  const startedAtMs = Date.now();
  const inputs = buildRegressionWorkflowInputs(config, branch);

  const dispatch = await sandboxSession.dispatchWorkflow({
    workflowId: REGRESSION_WORKFLOW_FILE,
    timeoutMins: config.timeoutMinutes,
    inputs,
  });

  if (!dispatch.ok) {
    if (isTimeoutDispatchFailure(dispatch.diagnostics)) {
      const durationSeconds = Math.round((Date.now() - startedAtMs) / 1000);
      return {
        branch,
        completed: false,
        exitCode: null,
        stdout: '',
        stderr: 'Run timed out',
        durationSeconds,
        timedOut: true,
        workflowRunUrl: '',
      };
    }
    throw new RegressionGuardError(
      `Failed to trigger workflow dispatch for branch "${branch}": reason=${dispatch.reason} diagnostics=${JSON.stringify(dispatch.diagnostics)}`,
      'trigger',
      branch
    );
  }

  const durationSeconds = Math.round((Date.now() - startedAtMs) / 1000);

  return {
    branch,
    completed: true,
    exitCode: dispatch.exitCode,
    stdout: dispatch.stdout,
    stderr: dispatch.stderr,
    durationSeconds,
    timedOut: false,
    workflowRunUrl: dispatch.runUrl,
  };
}

/**
 * Normalizes test output for comparison by trimming whitespace,
 * removing timing/date information that varies between runs.
 */
export function normalizeOutput(output: string): string {
  return output
    .replace(/\d+(\.\d+)?\s*(milliseconds?|ms|seconds?|secs?|sec|s)\b/gi, '<TIME>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*/g, '<TIMESTAMP>')
    // Strip the synthetic GHA-log-archive marker produced by
    // GitHubActionsClient.getWorkflowRunLogs (e.g. "(GHA log archive: 1234
    // bytes; run https://...)"). The archive size and run URL differ between
    // every workflow run, so without this scrub the regression guard reports
    // a false-positive stdout diff on every comparison.
    .replace(/\(GHA log archive: \d+ bytes; run https?:\/\/[^)]+\)/g, '<GHA_LOG_MARKER>')
    .trim();
}

/**
 * Diffs the observable outputs between fork and upstream runs.
 * Compares exit codes, stdout, stderr, and timeout status.
 */
export function diffOutputs(
  forkResult: BranchTestResult,
  upstreamResult: BranchTestResult
): OutputDiff[] {
  const diffs: OutputDiff[] = [];

  // Check timeout differences
  if (forkResult.timedOut !== upstreamResult.timedOut) {
    diffs.push({
      category: 'timeout',
      description: forkResult.timedOut
        ? 'Fork branch timed out but upstream did not'
        : 'Upstream timed out but fork branch did not',
      upstream: String(upstreamResult.timedOut),
      fork: String(forkResult.timedOut),
    });
  }

  // Check exit code differences
  if (forkResult.exitCode !== upstreamResult.exitCode) {
    diffs.push({
      category: 'exit_code',
      description: `Exit code changed from ${upstreamResult.exitCode} to ${forkResult.exitCode}`,
      upstream: String(upstreamResult.exitCode),
      fork: String(forkResult.exitCode),
    });
  }

  // Check stdout differences (normalized to remove timing)
  const normalizedForkStdout = normalizeOutput(forkResult.stdout);
  const normalizedUpstreamStdout = normalizeOutput(upstreamResult.stdout);
  if (normalizedForkStdout !== normalizedUpstreamStdout) {
    diffs.push({
      category: 'stdout',
      description: 'Standard output differs between fork and upstream',
      upstream: upstreamResult.stdout.slice(0, 500),
      fork: forkResult.stdout.slice(0, 500),
    });
  }

  // Check stderr differences (normalized to remove timing)
  const normalizedForkStderr = normalizeOutput(forkResult.stderr);
  const normalizedUpstreamStderr = normalizeOutput(upstreamResult.stderr);
  if (normalizedForkStderr !== normalizedUpstreamStderr) {
    diffs.push({
      category: 'stderr',
      description: 'Standard error differs between fork and upstream',
      upstream: upstreamResult.stderr.slice(0, 500),
      fork: forkResult.stderr.slice(0, 500),
    });
  }

  return diffs;
}

/**
 * Generates a human-readable summary of regression results for the PR body.
 */
export function generateRegressionSummary(result: RegressionResult): string {
  const lines: string[] = [];

  if (!result.regressionDetected) {
    lines.push('### Regression Guard: ✅ No Regressions Detected');
    lines.push('');
    lines.push('Tests produce identical observable output on both fork and upstream main.');
    return lines.join('\n');
  }

  lines.push('### Regression Guard: ⚠️ Behavioural Changes Detected');
  lines.push('');
  lines.push(`Found ${result.diffs.length} difference(s) between fork branch and upstream main:`);
  lines.push('');

  for (const diff of result.diffs) {
    lines.push(`**${diff.category}**: ${diff.description}`);
    lines.push(`- Upstream: \`${diff.upstream.slice(0, 100)}\``);
    lines.push(`- Fork: \`${diff.fork.slice(0, 100)}\``);
    lines.push('');
  }

  lines.push('---');
  lines.push(`Fork branch run: [Workflow](${result.forkResult.workflowRunUrl})`);
  lines.push(`Upstream main run: [Workflow](${result.upstreamResult.workflowRunUrl})`);

  return lines.join('\n');
}

/**
 * Runs the full regression guard:
 * 1. Validate config
 * 2. Run tests on fork branch and upstream main in parallel
 * 3. Diff observable outputs
 * 4. Return regression result with details
 */
export async function runRegressionGuard(
  config: RegressionConfig,
  client: ActionsClient,
  pollIntervalMs?: number,
  sandboxSession?: SandboxSession
): Promise<RegressionResult> {
  void client;
  void pollIntervalMs;

  // 1. Validate
  validateRegressionConfig(config);

  if (!sandboxSession) {
    throw new RegressionGuardError(
      'SandboxSession is required for regression guard dispatch',
      'trigger',
      config.forkBranchName
    );
  }

  const workflowResult = await sandboxSession.verifyWorkflowReachability(REGRESSION_WORKFLOW_FILE);
  if (!workflowResult.ok) {
    throw new RegressionGuardError(
      `Regression workflow reachability failed: ${formatSessionFailure(workflowResult)}`,
      'workflow',
      config.forkBranchName
    );
  }

  // 2. Run tests on both branches in parallel
  const [forkResult, upstreamResult] = await Promise.all([
    runBranchTest(config, config.forkBranchName, sandboxSession),
    runBranchTest(config, config.upstreamDefaultBranch, sandboxSession),
  ]);

  // 3. Diff observable outputs
  const diffs = diffOutputs(forkResult, upstreamResult);

  // 4. Build result
  const regressionDetected = diffs.length > 0;
  const summary = generateRegressionSummary({
    regressionDetected,
    diffs,
    forkResult,
    upstreamResult,
    summary: '', // placeholder, will be replaced
  });

  return {
    regressionDetected,
    diffs,
    forkResult,
    upstreamResult,
    summary,
  };
}

function formatSessionFailure(failure: SandboxPhaseFailure): string {
  const diagnostics = failure.diagnostics ? ` diagnostics=${JSON.stringify(failure.diagnostics)}` : '';
  return `phase=${failure.phase} reason=${failure.reason}${diagnostics}`;
}

function isTimeoutDispatchFailure(diagnostics: Record<string, unknown>): boolean {
  const errorText = diagnostics.error;
  return typeof errorText === 'string' && errorText.includes('workflow timed out');
}
