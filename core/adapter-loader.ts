import * as fs from 'fs';
import * as path from 'path';

import type { RepoAdapter } from './adapter.interface';
import { runIntrospection } from './agents/introspection-orchestration';

export class AdapterBootstrapEnvError extends Error {
  public readonly envVar: string;

  constructor(envVar: string) {
    super(`Missing required environment variable: ${envVar}`);
    this.name = 'AdapterBootstrapEnvError';
    this.envVar = envVar;
  }
}

export type AdapterContractViolationCode =
  | 'adapter_not_found'
  | 'missing_default_export'
  | 'default_export_not_class'
  | 'missing_method'
  | 'sync_method'
  | 'invalid_classify_module';

export class AdapterContractError extends Error {
  public readonly code: AdapterContractViolationCode;
  public readonly repoFullName: string;
  public readonly adapterPath: string;

  constructor(args: {
    message: string;
    code: AdapterContractViolationCode;
    repoFullName: string;
    adapterPath: string;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = 'AdapterContractError';
    this.code = args.code;
    this.repoFullName = args.repoFullName;
    this.adapterPath = args.adapterPath;
    if (args.cause) (this as any).cause = args.cause;
  }
}

function parseRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const parts = repoFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repoFullName (expected owner/repo): ${repoFullName}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function getRequiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new AdapterBootstrapEnvError(name);
  }
  return v;
}

function fileExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function resolveAdapterPath(repoRoot: string, repoFullName: string): string {
  const { owner, repo } = parseRepoFullName(repoFullName);

  // Prefer compiled .js (production: tsc outputs to dist/), then source .ts (ts-node / dev).
  const distJsPath = path.join(repoRoot, 'dist', 'configs', owner, repo, 'adapter.js');
  if (fileExists(distJsPath)) return distJsPath;

  const jsPath = path.join(repoRoot, 'configs', owner, repo, 'adapter.js');
  if (fileExists(jsPath)) return jsPath;

  const tsPath = path.join(repoRoot, 'configs', owner, repo, 'adapter.ts');
  return tsPath;
}

function clearRequireCache(modulePath: string): void {
  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
  } catch {
    // Best-effort.
  }
}

function isPromiseLike(v: any): boolean {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
}

function assertAdapterShape(adapter: any, repoFullName: string, adapterPath: string): asserts adapter is RepoAdapter {
  const requiredMethods: Array<keyof RepoAdapter> = [
    'classifyModule',
    'getTestCommands',
    'getSandboxServices',
    'runCustomEval',
    'getPRMetadata',
  ];

  for (const m of requiredMethods) {
    if (typeof adapter?.[m] !== 'function') {
      throw new AdapterContractError({
        message: `Adapter is missing required method: ${String(m)}`,
        code: 'missing_method',
        repoFullName,
        adapterPath,
      });
    }
  }
}

async function assertAdapterMethodsReturnPromises(adapter: any, repoFullName: string, adapterPath: string): Promise<void> {
  const dummyIssue = { number: 0, title: '', body: '', labels: [] };
  const calls: Array<{ name: keyof RepoAdapter; args: any[] }> = [
    { name: 'classifyModule', args: [dummyIssue] },
    { name: 'getTestCommands', args: [] },
    { name: 'getSandboxServices', args: [] },
    { name: 'runCustomEval', args: [[]] },
    { name: 'getPRMetadata', args: [[]] },
  ];

  for (const c of calls) {
    let ret: any;
    try {
      ret = adapter[c.name](...c.args);
    } catch {
      ret = null;
    }

    if (!isPromiseLike(ret)) {
      throw new AdapterContractError({
        message: `Adapter method ${String(c.name)} must be async (return a Promise)`,
        code: 'sync_method',
        repoFullName,
        adapterPath,
      });
    }
  }
}

function assertClassifyModuleIsSafe(modulePath: string, repoFullName: string, adapterPath: string): void {
  if (typeof modulePath !== 'string') {
    throw new AdapterContractError({
      message: `Invalid classifyModule return value (expected string): ${String(modulePath)}`,
      code: 'invalid_classify_module',
      repoFullName,
      adapterPath,
    });
  }

  const normalized = modulePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new AdapterContractError({
      message: `Invalid classifyModule return value "${modulePath}": must be relative and cannot contain ".."`,
      code: 'invalid_classify_module',
      repoFullName,
      adapterPath,
    });
  }
}

export type RunIntrospectionLike = typeof runIntrospection;

export async function loadAdapter(
  repoFullName: string,
  options: {
    repoRoot?: string;
    runIntrospection?: RunIntrospectionLike;
    defaultPmEmailEnvVar?: string;
    defaultForkOrgEnvVar?: string;
  } = {}
): Promise<RepoAdapter> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const adapterPath = resolveAdapterPath(repoRoot, repoFullName);

  // Adapter missing? Auto-trigger introspection.
  if (!fileExists(adapterPath)) {
    const pmEnv = options.defaultPmEmailEnvVar ?? 'DEFAULT_PM_EMAIL';
    const forkEnv = options.defaultForkOrgEnvVar ?? 'DEFAULT_FORK_ORG';

    const pmEmail = getRequiredEnv(pmEnv);
    const forkOrg = getRequiredEnv(forkEnv);

    const run = options.runIntrospection ?? runIntrospection;
    await run(repoFullName, pmEmail, forkOrg, { repoRoot });

    // Re-resolve after introspection.
    const afterPath = resolveAdapterPath(repoRoot, repoFullName);
    if (!fileExists(afterPath)) {
      throw new AdapterContractError({
        message: `Adapter not found after introspection: ${afterPath}`,
        code: 'adapter_not_found',
        repoFullName,
        adapterPath: afterPath,
      });
    }

    return loadAdapter(repoFullName, { ...options, repoRoot });
  }

  clearRequireCache(adapterPath);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod: any = require(adapterPath);

  if (!mod || !mod.default) {
    throw new AdapterContractError({
      message: `Adapter module must have a default export (export default class ...) at: ${adapterPath}`,
      code: 'missing_default_export',
      repoFullName,
      adapterPath,
    });
  }

  let instance: any;
  try {
    instance = new mod.default();
  } catch (err) {
    throw new AdapterContractError({
      message: `Adapter default export must be a class constructible with 'new': ${adapterPath}`,
      code: 'default_export_not_class',
      repoFullName,
      adapterPath,
      cause: err,
    });
  }

  assertAdapterShape(instance, repoFullName, adapterPath);
  await assertAdapterMethodsReturnPromises(instance, repoFullName, adapterPath);

  // Lightweight safety check on classifyModule output (full path existence check happens in triage).
  try {
    const modulePath = await instance.classifyModule({ number: 0, title: '', body: '', labels: [] });
    assertClassifyModuleIsSafe(modulePath, repoFullName, adapterPath);
  } catch (err) {
    if (err instanceof AdapterContractError) throw err;
    // Ignore errors from adapter logic; this check is best-effort.
  }

  return instance;
}
