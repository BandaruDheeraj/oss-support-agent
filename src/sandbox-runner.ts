/**
 * Basic sandbox runner (US-008).
 * Executes the manifest test_command on the fork branch via GitHub Actions
 * workflow_dispatch and captures stdout/stderr/exit code.
 */

import {
  SandboxConfig,
  SandboxResult,
  SandboxArtifact,
  ActionsClient,
  WorkflowRun,
  WorkflowRunLogs,
  SANDBOX_WORKFLOW_FILE,
  DEFAULT_TIMEOUT_MINUTES,
  DEFAULT_POLL_INTERVAL_MS,
  SandboxRunError,
  SandboxTimeoutError,
} from './sandbox-types';

/**
 * Validates sandbox configuration.
 */
export function validateSandboxConfig(config: SandboxConfig): void {
  if (!config.forkFullName || !config.forkFullName.includes('/')) {
    throw new SandboxRunError(
      `Invalid forkFullName: "${config.forkFullName}" (must be "org/repo" format)`,
      'validation',
      config.forkFullName || ''
    );
  }
  if (!config.branchName || config.branchName.trim() === '') {
    throw new SandboxRunError(
      'branchName is required',
      'validation',
      config.forkFullName
    );
  }
  if (!config.testCommand || config.testCommand.trim() === '') {
    throw new SandboxRunError(
      'testCommand is required',
      'validation',
      config.forkFullName
    );
  }
  if (config.timeoutMinutes <= 0) {
    throw new SandboxRunError(
      `timeoutMinutes must be positive, got ${config.timeoutMinutes}`,
      'validation',
      config.forkFullName
    );
  }
}

/**
 * Builds the workflow dispatch inputs for the sandbox workflow.
 * The sandbox workflow is expected to accept these inputs to configure
 * the test run environment.
 */
export function buildWorkflowInputs(config: SandboxConfig): Record<string, string> {
  return {
    test_command: config.testCommand,
    branch: config.branchName,
    timeout_minutes: String(config.timeoutMinutes),
    sandbox_services: config.sandboxServices.join(','),
    // Network isolation: only declared services are accessible
    network_policy: config.sandboxServices.length === 0
      ? 'none'
      : `allow:${config.sandboxServices.join(',')}`,
  };
}

/**
 * Creates a SandboxConfig from manifest fields and fork context.
 */
export function createSandboxConfig(
  forkFullName: string,
  branchName: string,
  testCommand: string,
  sandboxServices: string[],
  timeoutMinutes?: number
): SandboxConfig {
  return {
    forkFullName,
    branchName,
    testCommand,
    sandboxServices: [...sandboxServices],
    timeoutMinutes: timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
  };
}

/**
 * Builds a structured artifact for the eval agent.
 */
export function buildSandboxArtifact(
  config: SandboxConfig,
  result: SandboxResult,
  startedAt: string,
  completedAt: string
): SandboxArtifact {
  return {
    config,
    result,
    startedAt,
    completedAt,
  };
}

/**
 * Runs the sandbox test suite on the fork branch.
 *
 * Pipeline:
 * 1. Validate config
 * 2. Trigger workflow_dispatch on fork
 * 3. Wait for workflow run to appear
 * 4. Poll until complete or timeout
 * 5. Retrieve logs (stdout/stderr/exit code)
 * 6. Build structured artifact for eval agent
 */
export async function runSandbox(
  config: SandboxConfig,
  client: ActionsClient,
  pollIntervalMs?: number
): Promise<SandboxArtifact> {
  // 1. Validate
  validateSandboxConfig(config);

  const startedAt = new Date().toISOString();
  const interval = pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // 2. Trigger workflow_dispatch
  const inputs = buildWorkflowInputs(config);
  try {
    await client.triggerWorkflowDispatch(
      config.forkFullName,
      SANDBOX_WORKFLOW_FILE,
      config.branchName,
      inputs
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SandboxRunError(
      `Failed to trigger workflow dispatch: ${message}`,
      'trigger',
      config.forkFullName
    );
  }

  // 3. Wait for workflow run to appear (poll with backoff)
  let workflowRun: WorkflowRun | null = null;
  const maxWaitForRunMs = 60_000; // Wait up to 60s for run to appear
  const runPollInterval = Math.min(interval, 5_000);
  const runPollStart = Date.now();

  while (Date.now() - runPollStart < maxWaitForRunMs) {
    workflowRun = await client.getWorkflowRun(
      config.forkFullName,
      SANDBOX_WORKFLOW_FILE,
      config.branchName,
      startedAt
    );
    if (workflowRun) break;
    await sleep(runPollInterval);
  }

  if (!workflowRun) {
    throw new SandboxRunError(
      'Workflow run did not appear within 60 seconds after dispatch',
      'wait_for_run',
      config.forkFullName
    );
  }

  // 4. Poll until complete or timeout
  const timeoutMs = config.timeoutMinutes * 60 * 1000;
  const runStatus = await client.waitForWorkflowRun(
    config.forkFullName,
    workflowRun.id,
    timeoutMs,
    interval
  );

  // 5. Retrieve logs
  let logs: WorkflowRunLogs;
  if (runStatus.timedOut) {
    logs = { stdout: '', stderr: 'Sandbox run timed out', exitCode: null };
  } else {
    try {
      logs = await client.getWorkflowRunLogs(config.forkFullName, workflowRun.id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SandboxRunError(
        `Failed to retrieve workflow logs: ${message}`,
        'logs',
        config.forkFullName
      );
    }
  }

  const completedAt = new Date().toISOString();
  const durationSeconds = Math.round(
    (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
  );

  // 6. Build result
  const result: SandboxResult = {
    completed: runStatus.completed && !runStatus.timedOut,
    exitCode: logs.exitCode,
    stdout: logs.stdout,
    stderr: logs.stderr,
    durationSeconds,
    workflowRunUrl: workflowRun.html_url,
    timedOut: runStatus.timedOut,
    workflowRunId: workflowRun.id,
  };

  // Build and upload artifact
  const artifact = buildSandboxArtifact(config, result, startedAt, completedAt);

  try {
    await client.uploadArtifact(
      config.forkFullName,
      workflowRun.id,
      'sandbox-result',
      JSON.stringify(artifact, null, 2)
    );
  } catch {
    // Artifact upload failure is non-fatal; the result is still returned
  }

  return artifact;
}

/**
 * Sleep utility for polling.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
