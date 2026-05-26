/**
 * v2 SandboxHandle adapter (local subprocess driver).
 *
 * Wraps a LocalWorkspace. Reuses ensurePythonVenv from local-sandbox so
 * pip/python commands run inside the workspace's `.agent-venv`.
 *
 * Each call shells one command via execCommand; we do not synthesize a
 * SandboxConfig per call (avoids re-running service health checks on
 * every Critic re-run).
 */

import * as path from 'path';
import { execCommand, LocalWorkspace } from '../../../bin/clients/local-workspace';
import { ensurePythonVenv } from '../../../bin/clients/local-sandbox';
import type { SandboxHandle, SandboxRun } from '../tools/handles';

export interface LocalSandboxAdapterOptions {
  /** Per-command timeout in milliseconds (default 600_000 = 10 min). */
  perCommandTimeoutMs?: number;
  /** Test runner command for runTests (e.g. `pytest -q`). */
  testCommand?: string;
  /** Repro test path (relative to workspace) for runRepro. */
  reproTestPath?: string;
  /** Repro runner template — `{path}` is substituted (default `pytest -xvs {path}`). */
  reproRunner?: string;
  log?: (msg: string) => void;
}

const noop = (_: string): void => {};

export function createLocalSandboxAdapter(
  workspace: LocalWorkspace,
  opts: LocalSandboxAdapterOptions = {}
): SandboxHandle {
  const log = opts.log ?? noop;
  const timeoutMs = opts.perCommandTimeoutMs ?? 600_000;

  let venvBinDir: string | null | undefined;
  const venvOnce = async (): Promise<string | null> => {
    if (venvBinDir !== undefined) return venvBinDir;
    const v = await ensurePythonVenv(workspace.dir, log, timeoutMs);
    venvBinDir = v ? v.binDir : null;
    return venvBinDir;
  };

  const buildEnv = async (extra?: Record<string, string>): Promise<NodeJS.ProcessEnv> => {
    const env: NodeJS.ProcessEnv = { ...(extra ?? {}) };
    const bin = await venvOnce();
    if (bin) {
      const sep = process.platform === 'win32' ? ';' : ':';
      env.PATH = `${bin}${sep}${process.env.PATH ?? ''}`;
      env.VIRTUAL_ENV = path.dirname(bin);
    }
    return env;
  };

  const runShell = async (cmd: string, env?: Record<string, string>): Promise<SandboxRun> => {
    const finalEnv = await buildEnv(env);
    log(`[sandbox-v2] $ ${cmd}`);
    const r = await execCommand(cmd, [], workspace.dir, {
      shell: true,
      timeoutMs,
      env: finalEnv,
    });
    return {
      exitCode: r.exitCode ?? 1,
      stdout: r.stdout,
      stderr: r.stderr,
      durationMs: r.durationMs,
    };
  };

  const handle: SandboxHandle = {
    setReproTestPath(p: string) {
      opts.reproTestPath = p;
    },
    async runRepro() {
      const reproPath = opts.reproTestPath;
      if (!reproPath) {
        return {
          exitCode: 2,
          stdout: '',
          stderr: '[sandbox-v2] runRepro called but reproTestPath not configured',
          durationMs: 0,
        };
      }
      const tpl = opts.reproRunner ?? 'pytest -xvs {path}';
      const cmd = tpl.replace('{path}', reproPath);
      return runShell(cmd);
    },
    async runTests(scopePath?: string) {
      const base = opts.testCommand ?? 'pytest -q';
      const cmd = scopePath ? `${base} ${scopePath}` : base;
      return runShell(cmd);
    },
    async runPython(snippet: string, env?: Record<string, string>) {
      const finalEnv = await buildEnv(env);
      log(`[sandbox-v2] $ python -c <snippet ${snippet.length}b>`);
      const r = await execCommand('python', ['-'], workspace.dir, {
        shell: false,
        timeoutMs,
        env: finalEnv,
        stdin: snippet,
      });
      return {
        exitCode: r.exitCode ?? 1,
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs: r.durationMs,
      };
    },
    async pipInstall(spec: string) {
      return runShell(`pip install ${JSON.stringify(spec)}`);
    },
    async pythonModuleCheck(name: string) {
      const snippet = `import importlib, json\ntry:\n  m = importlib.import_module(${JSON.stringify(name)})\n  v = getattr(m, "__version__", None)\n  print(json.dumps({"importable": True, "version": v}))\nexcept Exception as e:\n  print(json.dumps({"importable": False, "error": str(e)}))\n`;
      const r = await handle.runPython(snippet);
      try {
        return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
      } catch {
        return { importable: false, error: r.stderr || r.stdout || 'parse-failure' };
      }
    },
    async listPackages() {
      const r = await runShell('pip list --format=json');
      try {
        return JSON.parse(r.stdout) as { name: string; version: string }[];
      } catch {
        return [];
      }
    },
  };

  return handle;
}
