/**
 * Basic sandbox runner (US-008).
 * Executes adapter-provided commands on the fork branch via GitHub Actions
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
import type { RepoAdapter, SandboxCommandResult, ServiceConfig } from './adapter.interface';

/**
 * Validates sandbox configuration.
 */
export function validateSandboxConfig(config: SandboxConfig): void {
  if (!config.repoFullName || !config.repoFullName.includes('/')) {
    throw new SandboxRunError(
      `Invalid repoFullName: "${config.repoFullName}" (must be "owner/repo" format)`,
      'validation',
      config.repoFullName || ''
    );
  }
  if (!config.forkFullName || !config.forkFullName.includes('/')) {
    throw new SandboxRunError(
      `Invalid forkFullName: "${config.forkFullName}" (must be "org/repo" format)`,
      'validation',
      config.forkFullName || ''
    );
  }
  if (!config.workflowRepoFullName || !config.workflowRepoFullName.includes('/')) {
    throw new SandboxRunError(
      `Invalid workflowRepoFullName: "${config.workflowRepoFullName}" (must be "owner/repo" format)`,
      'validation',
      config.workflowRepoFullName || ''
    );
  }
  if (!config.branchName || config.branchName.trim() === '') {
    throw new SandboxRunError(
      'branchName is required',
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
  const configuredCommands = config.testCommands ?? [];
  const commands = configuredCommands.length > 0
    ? configuredCommands
    : config.testCommand
    ? [config.testCommand]
    : [];

  const services = config.sandboxServices.map((s) => (typeof s === 'string'
    ? { name: s, image: s, ports: [] }
    : s));

  const testCommandsB64 = Buffer.from(JSON.stringify(commands), 'utf8').toString('base64');
  const servicesB64 = Buffer.from(JSON.stringify(services), 'utf8').toString('base64');

  const forkCloneUrl = config.forkCloneUrl ?? `https://github.com/${config.forkFullName}.git`;

  return {
    repo_full_name: config.repoFullName,
    fork_clone_url: forkCloneUrl,
    branch_name: config.branchName,
    test_commands_b64: testCommandsB64,
    services_b64: servicesB64,
  };
}

/**
 * Creates a SandboxConfig from adapter fields and fork context.
 */
type CreateSandboxConfigOptions =
  | {
      repoFullName: string;
      forkFullName: string;
      branchName: string;
      adapter: RepoAdapter;
      timeoutMinutes?: number;
      workflowRepoFullName?: string;
    }
  | {
      repoFullName: string;
      forkFullName: string;
      branchName: string;
      testCommand: string;
      sandboxServices: Array<ServiceConfig | string>;
      timeoutMinutes?: number;
      workflowRepoFullName?: string;
    };

function requireRepoFullName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.includes('/')) {
    throw new Error(
      `createSandboxConfig: ${field} must be "owner/repo", got: ${JSON.stringify(value)}`
    );
  }
  return value;
}

function cloneSandboxServices(
  services: Array<ServiceConfig | string>
): Array<ServiceConfig | string> {
  return services.map((service) =>
    typeof service === 'string'
      ? service
      : {
          ...service,
          ports: [...service.ports],
          ...(service.env ? { env: { ...service.env } } : {}),
        }
  );
}

function resolveWorkflowRepoFullName(
  workflowRepoFullName: unknown,
  repoFullName: string
): string {
  const inferred =
    workflowRepoFullName ??
    process.env.HARNESS_REPO_FULL_NAME ??
    process.env.GITHUB_REPOSITORY ??
    repoFullName;
  return requireRepoFullName(inferred, 'workflowRepoFullName');
}

export function createSandboxConfig(
  options: {
    repoFullName: string;
    forkFullName: string;
    branchName: string;
    adapter: RepoAdapter;
    timeoutMinutes?: number;
    workflowRepoFullName?: string;
  }
): Promise<SandboxConfig>;
export function createSandboxConfig(
  options: {
    repoFullName: string;
    forkFullName: string;
    branchName: string;
    testCommand: string;
    sandboxServices: Array<ServiceConfig | string>;
    timeoutMinutes?: number;
    workflowRepoFullName?: string;
  }
): SandboxConfig;
export function createSandboxConfig(
  options: CreateSandboxConfigOptions
): SandboxConfig | Promise<SandboxConfig> {
  const repoFullName = requireRepoFullName(options.repoFullName, 'repoFullName');
  const forkFullName = requireRepoFullName(options.forkFullName, 'forkFullName');
  const workflowRepoFullName = resolveWorkflowRepoFullName(
    options.workflowRepoFullName,
    repoFullName
  );
  const timeoutMinutes = options.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
  const base = {
    repoFullName,
    forkFullName,
    branchName: options.branchName,
    workflowRepoFullName,
    timeoutMinutes,
  };

  if ('adapter' in options) {
    return Promise.all([
      options.adapter.getTestCommands(),
      options.adapter.getSandboxServices(),
    ]).then(([testCommands, sandboxServices]) => ({
      ...base,
      testCommands: [...testCommands],
      testCommand: testCommands[0],
      sandboxServices: sandboxServices.map((service) => ({
        ...service,
        ports: [...service.ports],
        ...(service.env ? { env: { ...service.env } } : {}),
      })),
    }));
  }

  return {
    ...base,
    testCommands: [options.testCommand],
    testCommand: options.testCommand,
    sandboxServices: cloneSandboxServices(options.sandboxServices),
  };
}

/**
 * Builds a structured artifact for the eval agent.
 */
export function buildSandboxArtifact(
  config: SandboxConfig,
  result: SandboxResult,
  startedAt: string,
  completedAt: string,
  commands?: SandboxCommandResult[]
): SandboxArtifact {
  const synthesizedCommands = commands && commands.length > 0
    ? commands
    : [{
        command: config.testCommands?.[0] ?? config.testCommand ?? '',
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
      }];
  return {
    config,
    result,
    commands: synthesizedCommands,
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
  adapter: RepoAdapter,
  client: ActionsClient,
  pollIntervalMs?: number
): Promise<SandboxArtifact>;
export async function runSandbox(
  config: SandboxConfig,
  client: ActionsClient,
  pollIntervalMs?: number
): Promise<SandboxArtifact>;
export async function runSandbox(
  config: SandboxConfig,
  adapterOrClient: RepoAdapter | ActionsClient,
  clientOrPoll?: ActionsClient | number,
  maybePollIntervalMs?: number
): Promise<SandboxArtifact> {
  const usingLegacyClient = 'triggerWorkflowDispatch' in adapterOrClient;
  const adapter: RepoAdapter = usingLegacyClient
    ? legacyAdapterFromConfig(config)
    : adapterOrClient;
  const client = usingLegacyClient ? adapterOrClient : clientOrPoll as ActionsClient;
  const pollIntervalMs = usingLegacyClient ? clientOrPoll as number | undefined : maybePollIntervalMs;

  const inferredWorkflowRepo =
    config.workflowRepoFullName ??
    process.env.HARNESS_REPO_FULL_NAME ??
    process.env.GITHUB_REPOSITORY ??
    config.forkFullName;

  const [testCommands, sandboxServices] = await Promise.all([
    adapter.getTestCommands(),
    adapter.getSandboxServices(),
  ]);

  const refreshedConfig: SandboxConfig = {
    ...config,
    repoFullName: config.repoFullName ?? config.forkFullName,
    workflowRepoFullName: inferredWorkflowRepo,
    forkCloneUrl: config.forkCloneUrl,
    testCommands: [...testCommands],
    testCommand: testCommands[0],
    sandboxServices: sandboxServices.map((service) => ({ ...service, ports: [...service.ports] })),
  };

  // 1. Validate
  validateSandboxConfig(refreshedConfig);

  const startedAt = new Date().toISOString();
  const interval = pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // 2. Trigger workflow_dispatch
  const inputs = buildWorkflowInputs(refreshedConfig);
  try {
    await client.triggerWorkflowDispatch(
      refreshedConfig.workflowRepoFullName,
      SANDBOX_WORKFLOW_FILE,
      refreshedConfig.branchName,
      inputs
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SandboxRunError(
      `Failed to trigger workflow dispatch: ${message}`,
      'trigger',
      refreshedConfig.forkFullName
    );
  }

  // 3. Wait for workflow run to appear (poll with backoff)
  let workflowRun: WorkflowRun | null = null;
  const runPollInterval = Math.min(interval, 5_000);
  // Bound the wait for run-appearance by a small multiple of the poll interval.
  // This keeps unit tests (which pass interval=0/1) fast while preserving a reasonable
  // default when interval is large.
  const maxWaitForRunMs = runPollInterval === 0
    ? 50
    : Math.min(60_000, runPollInterval * 12);
  const runPollStart = Date.now();

  while (Date.now() - runPollStart < maxWaitForRunMs) {
    workflowRun = await client.getWorkflowRun(
      refreshedConfig.workflowRepoFullName,
      SANDBOX_WORKFLOW_FILE,
      refreshedConfig.branchName,
      startedAt
    );
    if (workflowRun) break;
    await sleep(runPollInterval);
  }

  if (!workflowRun) {
    throw new SandboxRunError(
      `Workflow run did not appear within ${maxWaitForRunMs}ms after dispatch`,
      'wait_for_run',
      refreshedConfig.forkFullName
    );
  }

  // 4. Poll until complete or timeout
  const timeoutMs = refreshedConfig.timeoutMinutes * 60 * 1000;
  const runStatus = await client.waitForWorkflowRun(
    refreshedConfig.workflowRepoFullName,
    workflowRun.id,
    timeoutMs,
    interval
  );

  // 5. Retrieve logs + the structured SandboxOutput artifact
  if (runStatus.timedOut) {
    try {
      await client.cancelWorkflowRun?.(refreshedConfig.workflowRepoFullName, workflowRun.id);
    } catch {
      // Best-effort cancel; still surface the timeout.
    }

    throw new SandboxTimeoutError(
      `Sandbox run timed out after ${refreshedConfig.timeoutMinutes} minutes`,
      refreshedConfig.timeoutMinutes,
      workflowRun.id
    );
  }

  let logs: WorkflowRunLogs;
  try {
    logs = await client.getWorkflowRunLogs(refreshedConfig.workflowRepoFullName, workflowRun.id);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SandboxRunError(
      `Failed to retrieve workflow logs: ${message}`,
      'logs',
      refreshedConfig.workflowRepoFullName
    );
  }

  let commands: SandboxCommandResult[] | undefined;
  if (client.downloadWorkflowRunArtifact) {
    try {
      const raw = await client.downloadWorkflowRunArtifact(
        refreshedConfig.workflowRepoFullName,
        workflowRun.id,
        'sandbox-output'
      );
      commands = raw ? parseSandboxOutputArtifact(raw) : undefined;
    } catch {
      // Non-fatal; fall back to synthesized outputs.
    }
  }

  // Fallback for older clients that only provide logs.
  if (!commands || commands.length === 0) {
    commands = logs.commands;
  }

  const completedAt = new Date().toISOString();
  const durationSeconds = Math.round(
    (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
  );

  // 6. Build result
  const result: SandboxResult = {
    completed: runStatus.completed,
    exitCode: logs.exitCode,
    stdout: logs.stdout,
    stderr: logs.stderr,
    durationSeconds,
    workflowRunUrl: workflowRun.html_url,
    timedOut: false,
    workflowRunId: workflowRun.id,
  };

  // Build and upload artifact
  const artifact = buildSandboxArtifact(refreshedConfig, result, startedAt, completedAt, commands);

  try {
    await client.uploadArtifact(
      refreshedConfig.workflowRepoFullName,
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
function legacyAdapterFromConfig(config: SandboxConfig): RepoAdapter {
  return {
    async classifyModule() { return '.'; },
    async getTestCommands() { return config.testCommands ?? (config.testCommand ? [config.testCommand] : []); },
    async getSandboxServices() {
      return config.sandboxServices.map((service) => typeof service === 'string'
        ? { name: service, image: service, ports: [] }
        : service);
    },
    async runCustomEval() { return { passed: true, summary: '', retryContext: [] }; },
    async getPRMetadata() { return { extraLabels: [], extraBodySections: [] }; },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSandboxOutputArtifact(raw: string): SandboxCommandResult[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) return undefined;

  const results: SandboxCommandResult[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return undefined;
    const r = item as Record<string, unknown>;
    if (typeof r.command !== 'string') return undefined;
    if (typeof r.exitCode !== 'number') return undefined;
    if (typeof r.stdout !== 'string') return undefined;
    if (typeof r.stderr !== 'string') return undefined;

    results.push({
      command: r.command,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
    });
  }

  return results;
}
