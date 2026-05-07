/**
 * Local sandbox runner.
 *
 * Replaces the GitHub Actions workflow_dispatch path of core/sandbox.ts for live testing.
 * Runs adapter.getTestCommands() as subprocesses inside the local workspace clone and
 * builds a SandboxArtifact[] compatible with adapter.runCustomEval().
 *
 * Service health checks (sandbox services like Phoenix) are NOT started by this runner —
 * the operator is expected to start them out-of-band (e.g. via docker compose) before
 * running the harness. If a service URL is unreachable, the corresponding command will
 * fail and that failure will flow through to the eval agent normally.
 */

import type { SandboxCommandResult, ServiceConfig } from '../../core/adapter.interface';
import type { SandboxArtifact, SandboxConfig, SandboxResult } from '../../core/sandbox-types';

import { LocalWorkspace, execCommand } from './local-workspace';

export interface LocalSandboxOptions {
  /** Per-command timeout in milliseconds (default 600_000 = 10 min). */
  perCommandTimeoutMs?: number;
  /** Optional logger. */
  log?: (msg: string) => void;
}

function noopLog(_: string): void {
  /* */
}

async function checkServices(services: ServiceConfig[], log: (m: string) => void): Promise<void> {
  for (const svc of services) {
    if (!svc.healthCheckUrl) continue;
    try {
      const res = await fetch(svc.healthCheckUrl);
      if (res.ok) {
        log(`[sandbox] service "${svc.name}" healthy at ${svc.healthCheckUrl}`);
      } else {
        log(`[sandbox] service "${svc.name}" returned ${res.status} at ${svc.healthCheckUrl}`);
      }
    } catch (err: any) {
      log(`[sandbox] service "${svc.name}" UNREACHABLE at ${svc.healthCheckUrl}: ${err?.message ?? err}`);
      log(`[sandbox]   commands depending on it may fail; start the service externally if needed`);
    }
  }
}

export async function runLocalSandbox(args: {
  workspace: LocalWorkspace;
  config: SandboxConfig;
  services: ServiceConfig[];
  options?: LocalSandboxOptions;
}): Promise<SandboxArtifact> {
  const log = args.options?.log ?? noopLog;
  const timeoutMs = args.options?.perCommandTimeoutMs ?? 600_000;
  const startedAt = new Date().toISOString();

  await checkServices(args.services, log);

  const commands = args.config.testCommands ?? (args.config.testCommand ? [args.config.testCommand] : []);
  const results: SandboxCommandResult[] = [];
  let totalDurationSec = 0;
  let aggregateExitCode: number | null = 0;
  let timedOut = false;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  for (const cmd of commands) {
    log(`[sandbox] $ ${cmd}`);
    const r = await execCommand(cmd, [], args.workspace.dir, {
      timeoutMs,
      shell: true,
    });
    const durSec = r.durationMs / 1000;
    totalDurationSec += durSec;
    if (r.timedOut) timedOut = true;
    if (r.exitCode !== 0 && aggregateExitCode === 0) aggregateExitCode = r.exitCode ?? 1;

    stdoutChunks.push(`# ${cmd}\n${r.stdout}`);
    stderrChunks.push(`# ${cmd}\n${r.stderr}`);

    results.push({
      command: cmd,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode ?? 1,
    });

    log(
      `[sandbox]   exit=${r.exitCode} dur=${durSec.toFixed(1)}s stdout=${r.stdout.length}b stderr=${r.stderr.length}b`
    );
  }

  const completedAt = new Date().toISOString();

  const result: SandboxResult = {
    completed: !timedOut,
    exitCode: aggregateExitCode,
    stdout: stdoutChunks.join('\n'),
    stderr: stderrChunks.join('\n'),
    durationSeconds: totalDurationSec,
    workflowRunUrl: 'local://sandbox',
    timedOut,
    workflowRunId: 0,
  };

  return {
    config: args.config,
    result,
    commands: results,
    startedAt,
    completedAt,
  };
}
