/**
 * v2 SandboxHandle adapter (GitHub Actions driver).
 */

import { runSandbox } from '../../sandbox';
import type { ActionsClient, SandboxConfig } from '../../sandbox-types';
import type { SandboxHandle, SandboxRun } from '../tools/handles';
import { resolveSkippablePipInstall } from './pip-spec';
import { buildPipInstallCommand } from './sandbox-local';
import { buildPythonModuleCheckSnippet } from './python-module-check';

export interface GhActionsSandboxAdapterOptions {
  actionsClient: ActionsClient;
  baseConfig: Omit<SandboxConfig, 'testCommand' | 'testCommands'>;
  testCommand?: string;
  reproTestPath?: string;
  reproRunner?: string;
  beforeDispatch?: () => Promise<void>;
  preDispatchRefCheckAttempts?: number;
  preDispatchRefCheckDelayMs?: number;
  log?: (msg: string) => void;
}

const noop = (_: string): void => {};
const DEFAULT_REF_CHECK_ATTEMPTS = 6;
const DEFAULT_REF_CHECK_DELAY_MS = 1500;

function asRun(stdout: string, stderr: string, exitCode: number, durationMs: number): SandboxRun {
  return { stdout, stderr, exitCode, durationMs };
}

function normalizePipSpec(spec: string): string {
  return spec.trim();
}

function buildInstallCommands(specs: readonly string[]): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();
  for (const rawSpec of specs) {
    const spec = normalizePipSpec(rawSpec);
    if (!spec || seen.has(spec)) {
      continue;
    }
    seen.add(spec);
    commands.push(buildPipInstallCommand(spec));
  }
  return commands;
}

function resolveWorkflowDispatchBranch(baseConfig: Omit<SandboxConfig, 'testCommand' | 'testCommands'>): string {
  return baseConfig.workflowRepoFullName === baseConfig.forkFullName
    ? baseConfig.branchName
    : process.env.HARNESS_WORKFLOW_REF ?? 'main';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyRefExists(args: {
  actionsClient: ActionsClient;
  repoFullName: string;
  branch: string;
  label: 'workflow dispatch ref' | 'fork repro ref';
  maxAttempts: number;
  retryDelayMs: number;
}): Promise<void> {
  if (!args.actionsClient.branchRefExists) {
    return;
  }

  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    let exists = false;
    try {
      exists = await args.actionsClient.branchRefExists(args.repoFullName, args.branch);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `sandbox_setup_failed: unable to verify ${args.label} "${args.branch}" in ${args.repoFullName}: ${detail}`
      );
    }
    if (exists) {
      return;
    }
    if (attempt < args.maxAttempts && args.retryDelayMs > 0) {
      await sleep(args.retryDelayMs);
    }
  }

  throw new Error(
    `sandbox_setup_failed: missing ${args.label} "${args.branch}" in ${args.repoFullName} before dispatch`
  );
}

export function createGhActionsSandboxAdapter(opts: GhActionsSandboxAdapterOptions): SandboxHandle {
  const log = opts.log ?? noop;
  const maxRefCheckAttempts = Math.max(1, opts.preDispatchRefCheckAttempts ?? DEFAULT_REF_CHECK_ATTEMPTS);
  const refCheckDelayMs = Math.max(0, opts.preDispatchRefCheckDelayMs ?? DEFAULT_REF_CHECK_DELAY_MS);
  const stickyPipInstalls: string[] = [];
  let preDispatchPushConfirmed = false;

  const ensureReadyForDispatch = async (): Promise<void> => {
    if (!preDispatchPushConfirmed && opts.beforeDispatch) {
      try {
        await opts.beforeDispatch();
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `sandbox_setup_failed: failed to confirm push for fork branch "${opts.baseConfig.branchName}" before dispatch: ${detail}`
        );
      }
      preDispatchPushConfirmed = true;
    }

    const workflowDispatchBranch = resolveWorkflowDispatchBranch(opts.baseConfig);
    await verifyRefExists({
      actionsClient: opts.actionsClient,
      repoFullName: opts.baseConfig.workflowRepoFullName,
      branch: workflowDispatchBranch,
      label: 'workflow dispatch ref',
      maxAttempts: maxRefCheckAttempts,
      retryDelayMs: refCheckDelayMs,
    });
    await verifyRefExists({
      actionsClient: opts.actionsClient,
      repoFullName: opts.baseConfig.forkFullName,
      branch: opts.baseConfig.branchName,
      label: 'fork repro ref',
      maxAttempts: maxRefCheckAttempts,
      retryDelayMs: refCheckDelayMs,
    });
  };

  const runCommands = async (commands: readonly string[]): Promise<SandboxRun> => {
    await ensureReadyForDispatch();
    log(`[sandbox-gh] dispatching: ${commands.join(' && ')}`);
    const start = Date.now();
    const result = await runSandbox(
      { ...opts.baseConfig, testCommands: [...commands] },
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

  const runOne = async (cmd: string): Promise<SandboxRun> => {
    const commands = [...buildInstallCommands(stickyPipInstalls), cmd];
    return runCommands(commands);
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
      const normalizedSpec = normalizePipSpec(spec);
      if (!normalizedSpec) {
        return asRun('', '[sandbox-gh] pip_install received an empty spec', 2, 0);
      }
      const skippable = await resolveSkippablePipInstall(normalizedSpec, (name) =>
        handle.pythonModuleCheck(name)
      );
      if (skippable) {
        const msg = `[sandbox-gh] pip_install skipped: "${skippable}" is already importable`;
        log(msg);
        return asRun(`${msg}\n`, '', 0, 0);
      }
      if (stickyPipInstalls.includes(normalizedSpec)) {
        const msg = `[sandbox-gh] pip_install already tracked for replay: "${normalizedSpec}"`;
        log(msg);
        return asRun(`${msg}\n`, '', 0, 0);
      }
      const installRun = await runCommands(
        buildInstallCommands([...stickyPipInstalls, normalizedSpec])
      );
      if (installRun.exitCode === 0) {
        stickyPipInstalls.push(normalizedSpec);
      }
      return installRun;
    },
    async pythonModuleCheck(name) {
      const r = await handle.runPython(buildPythonModuleCheckSnippet(name));
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
