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
  WorkflowRun,
  WorkflowRunLogs,
  DEFAULT_POLL_INTERVAL_MS,
} from './sandbox-types';

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
  client: ActionsClient,
  pollIntervalMs: number
): Promise<BranchTestResult> {
  const startedAt = new Date().toISOString();
  const inputs = buildRegressionWorkflowInputs(config, branch);

  // Trigger workflow_dispatch
  try {
    await client.triggerWorkflowDispatch(
      config.forkFullName,
      REGRESSION_WORKFLOW_FILE,
      branch,
      inputs
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RegressionGuardError(
      `Failed to trigger workflow dispatch for branch "${branch}": ${message}`,
      'trigger',
      branch
    );
  }

  // Wait for workflow run to appear
  let workflowRun: WorkflowRun | null = null;
  const maxWaitForRunMs = 60_000;
  const runPollInterval = Math.min(pollIntervalMs, 5_000);
  const runPollStart = Date.now();

  while (Date.now() - runPollStart < maxWaitForRunMs) {
    workflowRun = await client.getWorkflowRun(
      config.forkFullName,
      REGRESSION_WORKFLOW_FILE,
      branch,
      startedAt
    );
    if (workflowRun) break;
    await sleep(runPollInterval);
  }

  if (!workflowRun) {
    throw new RegressionGuardError(
      `Workflow run for branch "${branch}" did not appear within 60 seconds`,
      'wait_for_run',
      branch
    );
  }

  // Wait for completion
  const timeoutMs = config.timeoutMinutes * 60 * 1000;
  const runStatus = await client.waitForWorkflowRun(
    config.forkFullName,
    workflowRun.id,
    timeoutMs,
    pollIntervalMs
  );

  // Retrieve logs
  let logs: WorkflowRunLogs;
  if (runStatus.timedOut) {
    logs = { stdout: '', stderr: 'Run timed out', exitCode: null };
  } else {
    try {
      logs = await client.getWorkflowRunLogs(config.forkFullName, workflowRun.id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RegressionGuardError(
        `Failed to retrieve logs for branch "${branch}": ${message}`,
        'logs',
        branch
      );
    }
  }

  const completedAt = new Date().toISOString();
  const durationSeconds = Math.round(
    (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
  );

  return {
    branch,
    completed: runStatus.completed && !runStatus.timedOut,
    exitCode: logs.exitCode,
    stdout: logs.stdout,
    stderr: logs.stderr,
    durationSeconds,
    timedOut: runStatus.timedOut,
    workflowRunUrl: workflowRun.html_url,
  };
}

/**
 * Normalizes test output for comparison by trimming whitespace,
 * removing timing/date information that varies between runs.
 */
export function normalizeOutput(output: string): string {
  return output
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds|milliseconds)/gi, '<TIME>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*/g, '<TIMESTAMP>')
    .replace(/\d+(\.\d+)?\s*seconds?/gi, '<TIME>')
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
  pollIntervalMs?: number
): Promise<RegressionResult> {
  // 1. Validate
  validateRegressionConfig(config);

  const interval = pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // 2. Run tests on both branches in parallel
  const [forkResult, upstreamResult] = await Promise.all([
    runBranchTest(config, config.forkBranchName, client, interval),
    runBranchTest(config, config.upstreamDefaultBranch, client, interval),
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

/**
 * Sleep utility for polling.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
