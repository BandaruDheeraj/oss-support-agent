/**
 * v2 SandboxHandle adapter (GitHub Actions driver).
 */

import { runSandbox } from '../../sandbox';
import type { ActionsClient, SandboxConfig } from '../../sandbox-types';
import type { SandboxHandle, SandboxRun } from '../tools/handles';

export interface GhActionsSandboxAdapterOptions {
  actionsClient: ActionsClient;
  baseConfig: Omit<SandboxConfig, 'testCommand' | 'testCommands'>;
  testCommand?: string;
  reproTestPath?: string;
  reproRunner?: string;
  log?: (msg: string) => void;
}

const noop = (_: string): void => {};

function asRun(stdout: string, stderr: string, exitCode: number, durationMs: number): SandboxRun {
  return { stdout, stderr, exitCode, durationMs };
}

export function createGhActionsSandboxAdapter(opts: GhActionsSandboxAdapterOptions): SandboxHandle {
  const log = opts.log ?? noop;

  const runOne = async (cmd: string): Promise<SandboxRun> => {
    log(`[sandbox-gh] dispatching: ${cmd}`);
    const start = Date.now();
    const result = await runSandbox(
      { ...opts.baseConfig, testCommands: [cmd] },
      opts.actionsClient
    );
    const dur = Date.now() - start;
    return asRun(
      result.result.stdout,
      result.result.stderr,
      result.result.exitCode ?? 1,
      dur
    );
  };

  const handle: SandboxHandle = {
    setReproTestPath(p: string) {
      opts.reproTestPath = p;
    },
    async runRepro() {
      const reproPath = opts.reproTestPath;
      if (!reproPath) {
        return asRun('', '[sandbox-gh] reproTestPath not configured', 2, 0);
      }
      const tpl = opts.reproRunner ?? 'pytest -xvs {path}';
      return runOne(tpl.replace('{path}', reproPath));
    },
    async runTests(scopePath?: string) {
      const base = opts.testCommand ?? 'pytest -q';
      return runOne(scopePath ? `${base} ${scopePath}` : base);
    },
    async runPython(snippet) {
      const escaped = snippet.replace(/'/g, `'\\''`);
      return runOne(`python -c '${escaped}'`);
    },
    async pipInstall(spec) {
      return runOne(`pip install ${JSON.stringify(spec)}`);
    },
    async pythonModuleCheck(name) {
      const r = await handle.runPython(
        `import importlib,json\ntry:\n  m=importlib.import_module(${JSON.stringify(name)})\n  print(json.dumps({"importable":True,"version":getattr(m,"__version__",None)}))\nexcept Exception as e:\n  print(json.dumps({"importable":False,"error":str(e)}))`
      );
      try {
        return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
      } catch {
        return { importable: false, error: r.stderr || r.stdout || 'parse-failure' };
      }
    },
    async listPackages() {
      const r = await runOne('pip list --format=json');
      try {
        return JSON.parse(r.stdout);
      } catch {
        return [];
      }
    },
  };

  return handle;
}
