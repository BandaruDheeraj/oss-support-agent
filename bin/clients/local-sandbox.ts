/**
 * Local sandbox runner.
 *
 * Replaces the GitHub Actions workflow_dispatch path of core/sandbox.ts for live testing.
 * Runs adapter.getTestCommands() as subprocesses inside the local workspace clone and
 * builds a SandboxArtifact[] compatible with adapter.runCustomEval().
 *
 * Service health checks (sandbox services like Arize AX) are NOT started by this runner —
 * the operator is expected to start them out-of-band (e.g. via docker compose) before
 * running the harness. If a service URL is unreachable, the corresponding command will
 * fail and that failure will flow through to the eval agent normally.
 *
 * Python isolation: before running any command, the runner ensures a workspace-local
 * virtualenv exists at `<workspace>/.agent-venv` and prepends its bin directory to
 * PATH. This way `pip install` works even on hosts (Render, modern Debian) where the
 * system Python is locked down by PEP 668 ("externally-managed-environment").
 */

import * as fs from 'fs';
import * as path from 'path';

import type { SandboxCommandResult, ServiceConfig } from '../../core/adapter.interface';
import type { SandboxArtifact, SandboxConfig, SandboxResult } from '../../core/sandbox-types';
import { withExternalOperationSpan } from '../../core/observability';

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

/**
 * Ensure a Python venv exists in the workspace and return its bin directory.
 *
 * Why: `pip install` on hosts with a PEP 668-managed system Python (Render's
 * Ubuntu base image, modern Debian) errors out with "externally-managed-
 * environment" unless we install into a venv. Creating a per-workspace venv
 * also keeps installs isolated from other workspaces / the agent host itself.
 *
 * Idempotent: if `<workspaceDir>/<venvDirName>/bin/pip` already exists, we
 * reuse it. Otherwise we try `python3 -m venv` then fall back to `python -m
 * venv`. On failure we return null and let the caller decide what to do
 * (typically: continue without the venv and let pip fail naturally so the
 * halt-and-email machinery kicks in with a useful stderr).
 */
export async function ensurePythonVenv(
  workspaceDir: string,
  log: (m: string) => void,
  perCommandTimeoutMs: number,
  venvDirName = '.agent-venv'
): Promise<{ binDir: string } | null> {
  const venvDir = path.join(workspaceDir, venvDirName);
  // venv layout differs between Unix (`bin`) and Windows (`Scripts`).
  const binDirName = process.platform === 'win32' ? 'Scripts' : 'bin';
  const binDir = path.join(venvDir, binDirName);
  const pipPath = path.join(
    binDir,
    process.platform === 'win32' ? 'pip.exe' : 'pip'
  );
  if (fs.existsSync(pipPath)) {
    log(`[sandbox] reusing venv at ${venvDir}`);
    return { binDir };
  }

  // Try python3 first (Linux/Mac convention), fall back to python (Windows /
  // some Render images). We pipe stderr→stdout via shell:true so any error
  // shows up in the captured output.
  const candidates = ['python3', 'python'];
  for (const py of candidates) {
    // A partial/broken venv from a prior failed attempt (e.g. node-runtime
    // deploy without python3-venv) leaves the dir in place without a working
    // pip. `python3 -m venv` then fails with "Errno 17 File exists" or
    // produces an inconsistent venv whose pip raises on first use. Nuke any
    // dir that exists without a pip binary before retrying.
    if (fs.existsSync(venvDir) && !fs.existsSync(pipPath)) {
      log(`[sandbox] removing stale venv at ${venvDir}`);
      try {
        fs.rmSync(venvDir, { recursive: true, force: true });
      } catch (e) {
        log(`[sandbox] failed to remove stale venv: ${(e as Error).message}`);
      }
    }
    log(`[sandbox] creating venv with ${py} -m venv ${venvDir}`);
    const create = await execCommand(
      `${py} -m venv "${venvDir}"`,
      [],
      workspaceDir,
      { shell: true, timeoutMs: perCommandTimeoutMs }
    );
    if (create.exitCode === 0 && fs.existsSync(pipPath)) {
      // Bump pip + setuptools so editable installs (PEP 660) and modern
      // wheels work reliably. Best-effort — failures here just mean we
      // ship with whatever pip the venv was bootstrapped with.
      const upgrade = await execCommand(
        `"${pipPath}" install --quiet --upgrade pip setuptools wheel`,
        [],
        workspaceDir,
        { shell: true, timeoutMs: perCommandTimeoutMs }
      );
      if (upgrade.exitCode !== 0) {
        log(
          `[sandbox] venv pip upgrade exit=${upgrade.exitCode} (continuing): ${upgrade.stderr.slice(0, 200)}`
        );
      }
      return { binDir };
    }
    log(
      `[sandbox] ${py} -m venv failed (exit=${create.exitCode}): ${create.stderr.slice(0, 200) || create.stdout.slice(0, 200)}`
    );
  }
  return null;
}

export async function runLocalSandbox(args: {
  workspace: LocalWorkspace;
  config: SandboxConfig;
  services: ServiceConfig[];
  options?: LocalSandboxOptions;
}): Promise<SandboxArtifact> {
  const commands = args.config.testCommands ?? (args.config.testCommand ? [args.config.testCommand] : []);
  return withExternalOperationSpan(
    'sandbox.local_run',
    {
      repo: args.config.repoFullName,
      fork: args.config.forkFullName,
      branch: args.config.branchName,
      workflow_repo: args.config.workflowRepoFullName,
      command_count: commands.length,
      service_count: args.services.length,
      workspace_dir: args.workspace.dir,
      timeout_minutes: args.config.timeoutMinutes,
    },
    async (span) => {
      const artifact = await runLocalSandboxImpl(args, commands);
      span.setAttributes({
        'sandbox.completed': artifact.result.completed,
        'sandbox.exit_code': artifact.result.exitCode ?? -1,
        'sandbox.timed_out': artifact.result.timedOut,
        'sandbox.duration_seconds': artifact.result.durationSeconds,
        'sandbox.command_count': artifact.commands.length,
      });
      span.setOutput({
        completed: artifact.result.completed,
        exit_code: artifact.result.exitCode,
        timed_out: artifact.result.timedOut,
        duration_seconds: artifact.result.durationSeconds,
        command_count: artifact.commands.length,
      });
      return artifact;
    }
  );
}

async function runLocalSandboxImpl(
  args: {
    workspace: LocalWorkspace;
    config: SandboxConfig;
    services: ServiceConfig[];
    options?: LocalSandboxOptions;
  },
  commands: string[]
): Promise<SandboxArtifact> {
  const log = args.options?.log ?? noopLog;
  const timeoutMs = args.options?.perCommandTimeoutMs ?? 600_000;
  const startedAt = new Date().toISOString();

  await checkServices(args.services, log);

  // Set up an isolated Python venv for this sandbox run. If creation fails
  // (e.g. python3 missing), we still proceed: the per-command pip will fail
  // naturally and halt-and-email surfaces the real error to the operator.
  const venv = await withExternalOperationSpan(
    'sandbox.local_venv',
    {
      repo: args.config.repoFullName,
      fork: args.config.forkFullName,
      branch: args.config.branchName,
      workspace_dir: args.workspace.dir,
      timeout_ms: timeoutMs,
    },
    async (span) => {
      const result = await ensurePythonVenv(args.workspace.dir, log, timeoutMs);
      span.setAttributes({ 'sandbox.venv_available': !!result });
      span.setOutput({ venv_available: !!result });
      return result;
    }
  );
  const sandboxEnv: NodeJS.ProcessEnv = {};
  if (venv) {
    const sep = process.platform === 'win32' ? ';' : ':';
    sandboxEnv.PATH = `${venv.binDir}${sep}${process.env.PATH ?? ''}`;
    // Belt-and-suspenders: VIRTUAL_ENV makes some tools (pip, pipx, poetry)
    // detect the venv even if PATH is overridden mid-script.
    sandboxEnv.VIRTUAL_ENV = path.dirname(venv.binDir);
  } else {
    log(`[sandbox] proceeding WITHOUT venv (python3/python not available); pip commands likely to fail`);
  }

  const results: SandboxCommandResult[] = [];
  let totalDurationSec = 0;
  let aggregateExitCode: number | null = 0;
  let timedOut = false;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  for (const cmd of commands) {
    log(`[sandbox] $ ${cmd}`);
    const r = await withExternalOperationSpan(
      'sandbox.local_command',
      {
        repo: args.config.repoFullName,
        fork: args.config.forkFullName,
        branch: args.config.branchName,
        command: cmd,
        timeout_ms: timeoutMs,
      },
      async (span) => {
        const result = await execCommand(cmd, [], args.workspace.dir, {
          timeoutMs,
          shell: true,
          env: sandboxEnv,
        });
        span.setAttributes({
          'sandbox.exit_code': result.exitCode ?? -1,
          'sandbox.timed_out': result.timedOut,
          'sandbox.duration_ms': result.durationMs,
          'sandbox.stdout_bytes': result.stdout.length,
          'sandbox.stderr_bytes': result.stderr.length,
        });
        span.setOutput({
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          duration_ms: result.durationMs,
          stdout_bytes: result.stdout.length,
          stderr_bytes: result.stderr.length,
        });
        return result;
      }
    );
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
