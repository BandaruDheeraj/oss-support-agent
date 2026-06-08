/**
 * v2 SandboxHandle adapter (GitHub Actions driver).
 *
 * All dispatch/push/ref/setup lifecycle concerns are delegated to
 * SandboxSession. This adapter only translates SandboxHandle calls into
 * SandboxSession recipes.
 */

import type { ActionsClient, SandboxConfig } from '../../sandbox-types';
import type { SandboxHandle, SandboxRun } from '../tools/handles';
import type {
  InstallSpec,
  SandboxPhaseFailure,
  SandboxPhaseResult,
  SandboxResult as SandboxSessionResult,
  SandboxSession,
} from '../../sandbox-session';
import { resolveSkippablePipInstall } from './pip-spec';
import { buildPipInstallCommand } from './sandbox-local';
import { buildPythonModuleCheckSnippet } from './python-module-check';

export interface GhActionsSandboxAdapterOptions {
  actionsClient: ActionsClient;
  baseConfig: Omit<SandboxConfig, 'testCommand' | 'testCommands'>;
  testCommand?: string;
  reproTestPath?: string;
  reproRunner?: string;
  sandboxSession?: SandboxSession;
  log?: (msg: string) => void;
}

const noop = (_: string): void => {};

function asRun(stdout: string, stderr: string, exitCode: number, durationMs: number): SandboxRun {
  return { stdout, stderr, exitCode, durationMs };
}

function normalizePipSpec(spec: string): string {
  return spec.trim();
}

function formatPhaseFailure(phase: SandboxPhaseFailure): string {
  const details = [
    `phase=${phase.phase}`,
    `reason=${phase.reason}`,
    phase.failedStep ? `failedStep=${phase.failedStep}` : null,
    phase.stdout ? `stdout=${phase.stdout.slice(-300)}` : null,
    phase.stderr ? `stderr=${phase.stderr.slice(-300)}` : null,
    phase.diagnostics ? `diagnostics=${JSON.stringify(phase.diagnostics)}` : null,
  ]
    .filter((part) => !!part)
    .join(' ');
  return `sandbox_setup_failed: ${details}`;
}

export function createGhActionsSandboxAdapter(opts: GhActionsSandboxAdapterOptions): SandboxHandle {
  const log = opts.log ?? noop;
  if (!opts.sandboxSession) {
    throw new Error(
      'createGhActionsSandboxAdapter requires sandboxSession; direct workflow dispatch is owned by SandboxSession.'
    );
  }

  const session = opts.sandboxSession;
  let preDispatchReady = false;

  const ensureReadyForDispatch = async (): Promise<void> => {
    if (preDispatchReady) return;
    const branch = await session.verifyAndPushBranch();
    if (!branch.ok) {
      throw new Error(formatPhaseFailure(branch));
    }
    const workflow = await session.verifyWorkflowReachability();
    if (!workflow.ok) {
      throw new Error(formatPhaseFailure(workflow));
    }
    preDispatchReady = true;
  };

  const runCommands = async (
    commands: readonly string[],
    options?: { suspectPathNeedles?: string[] }
  ): Promise<SandboxRun> => {
    await ensureReadyForDispatch();
    log(`[sandbox-gh] dispatching: ${commands.join(' && ')}`);
    const start = Date.now();
    const dispatch = await session.dispatch({
      commands: [...commands],
      ...(options?.suspectPathNeedles && options.suspectPathNeedles.length > 0
        ? { suspectPathNeedles: options.suspectPathNeedles }
        : {}),
    });
    const dur = Date.now() - start;
    if (!dispatch.ok) {
      throw new Error(
        `sandbox_dispatch_failed: ${dispatch.reason} ${JSON.stringify(dispatch.diagnostics)}`
      );
    }
    const exitCode = dispatch.exitCode ?? 1;
    return asRun(dispatch.rawLogs, exitCode === 0 ? '' : dispatch.rawLogs, exitCode, dur);
  };

  const runOne = async (
    cmd: string,
    options?: { suspectPathNeedles?: string[] }
  ): Promise<SandboxRun> => runCommands([cmd], options);

  const handle: SandboxHandle = {
    setReproTestPath(p: string) {
      opts.reproTestPath = p;
    },
    async flushWorkspaceToBranch() {
      preDispatchReady = false;
      // Use forceFlushBranch to bypass the verifyAndPushBranch cache — the
      // cached result was set before writeTest wrote files to disk, so a
      // cached return would skip the commitAll in pushPendingChanges.
      await session.forceFlushBranch();
    },
    async runRepro(options?: { suspectPathNeedles?: string[] }) {
      const reproPath = opts.reproTestPath;
      if (!reproPath) {
        return asRun('', '[sandbox-gh] reproTestPath not configured', 2, 0);
      }
      const tpl = opts.reproRunner ?? 'pytest -xvs {path}';
      return runOne(tpl.replace('{path}', reproPath), options);
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
      const installCommand = buildPipInstallCommand(normalizedSpec);
      const installRun = await runCommands([installCommand]);
      if (installRun.exitCode === 0) {
        session.recordReplayInstallCommand(installCommand);
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
    async setupDependencies(spec: InstallSpec): Promise<SandboxPhaseResult> {
      await ensureReadyForDispatch();
      return session.setupDependencies(spec);
    },
    getSandboxResult(): SandboxSessionResult | null {
      return session.result();
    },
  };

  return handle;
}
