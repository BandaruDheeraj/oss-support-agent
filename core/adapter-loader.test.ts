import * as fs from 'fs';
import * as path from 'path';

import {
  loadAdapter,
  AdapterContractError,
  AdapterBootstrapEnvError,
} from './adapter-loader';

async function writeFile(p: string, content: string) {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, content, 'utf-8');
}

async function makeTempRoot(): Promise<string> {
  const base = path.join(__dirname, '__tests__', 'tmp-adapter-loader-');
  await fs.promises.mkdir(path.dirname(base), { recursive: true });
  return await fs.promises.mkdtemp(base);
}

async function rmrf(p: string) {
  await fs.promises.rm(p, { recursive: true, force: true });
}

describe('loadAdapter (US-108)', () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...prevEnv };
  });

  afterAll(() => {
    process.env = prevEnv;
  });

  test('loads an existing adapter successfully', async () => {
    const root = await makeTempRoot();
    try {
      const repo = 'acme/widgets';
      const adapterPath = path.join(root, 'configs', 'acme', 'widgets', 'adapter.ts');

      await writeFile(
        adapterPath,
        `export default class WidgetsAdapter {
          async classifyModule() { return '.'; }
          async getTestCommands() { return ['npm test']; }
          async getSandboxServices() { return []; }
          async runCustomEval() { return { passed: true, summary: 'ok', retryContext: [] }; }
          async getPRMetadata() { return { extraLabels: [], extraBodySections: [] }; }
        }\n`
      );

      const adapter = await loadAdapter(repo, { repoRoot: root });
      expect(typeof adapter.classifyModule).toBe('function');
      expect(typeof adapter.getTestCommands).toBe('function');
    } finally {
      await rmrf(root);
    }
  });

  test('missing adapter triggers introspection then loads', async () => {
    const root = await makeTempRoot();
    try {
      process.env.DEFAULT_PM_EMAIL = 'pm@example.com';
      process.env.DEFAULT_FORK_ORG = 'fork-org';

      const repo = 'acme/missing';
      const adapterPath = path.join(root, 'configs', 'acme', 'missing', 'adapter.ts');

      let calls = 0;
      const runIntrospection = async (repoFullName: string, pmEmail: string, forkOrg: string, options: any) => {
        calls++;
        expect(repoFullName).toBe(repo);
        expect(pmEmail).toBe('pm@example.com');
        expect(forkOrg).toBe('fork-org');
        expect(options.repoRoot).toBe(root);

        await writeFile(
          adapterPath,
          `export default class MissingAdapter {
            async classifyModule() { return '.'; }
            async getTestCommands() { return []; }
            async getSandboxServices() { return []; }
            async runCustomEval() { return { passed: true, summary: 'ok', retryContext: [] }; }
            async getPRMetadata() { return { extraLabels: [], extraBodySections: [] }; }
          }\n`
        );

        return {
          repoFullName,
          activated: true,
          configDir: path.dirname(adapterPath),
          manifestPath: path.join(path.dirname(adapterPath), 'manifest.yaml'),
          adapterPath,
          labels: { created: [], skipped: [] },
        };
      };

      const adapter = await loadAdapter(repo, { repoRoot: root, runIntrospection: runIntrospection as any });
      expect(calls).toBe(1);
      expect(typeof adapter.getPRMetadata).toBe('function');
    } finally {
      await rmrf(root);
    }
  });

  test('missing default export raises AdapterContractError', async () => {
    const root = await makeTempRoot();
    try {
      const repo = 'acme/nodefault';
      const adapterPath = path.join(root, 'configs', 'acme', 'nodefault', 'adapter.ts');

      await writeFile(adapterPath, `export class NotDefault {}\n`);

      await expect(loadAdapter(repo, { repoRoot: root })).rejects.toMatchObject({
        name: 'AdapterContractError',
        code: 'missing_default_export',
        repoFullName: repo,
        adapterPath,
      } satisfies Partial<AdapterContractError>);
    } finally {
      await rmrf(root);
    }
  });

  test('missing env vars raises startup error (no introspection attempt)', async () => {
    const root = await makeTempRoot();
    try {
      delete process.env.DEFAULT_PM_EMAIL;
      delete process.env.DEFAULT_FORK_ORG;

      const repo = 'acme/noenv';

      const runIntrospection = async () => {
        throw new Error('should-not-be-called');
      };

      await expect(loadAdapter(repo, { repoRoot: root, runIntrospection: runIntrospection as any })).rejects.toMatchObject({
        name: 'AdapterBootstrapEnvError',
        envVar: 'DEFAULT_PM_EMAIL',
      } satisfies Partial<AdapterBootstrapEnvError>);
    } finally {
      await rmrf(root);
    }
  });

  test('runtime shape check rejects adapter missing a required method', async () => {
    const root = await makeTempRoot();
    try {
      const repo = 'acme/missingmethod';
      const adapterPath = path.join(root, 'configs', 'acme', 'missingmethod', 'adapter.ts');

      await writeFile(
        adapterPath,
        `export default class MissingMethodAdapter {
          async classifyModule() { return '.'; }
          async getTestCommands() { return []; }
          async getSandboxServices() { return []; }
          // runCustomEval missing
          async getPRMetadata() { return { extraLabels: [], extraBodySections: [] }; }
        }\n`
      );

      await expect(loadAdapter(repo, { repoRoot: root })).rejects.toMatchObject({
        name: 'AdapterContractError',
        code: 'missing_method',
        repoFullName: repo,
        adapterPath,
      } satisfies Partial<AdapterContractError>);
    } finally {
      await rmrf(root);
    }
  });

  test('rejects adapter with synchronous method implementations', async () => {
    const root = await makeTempRoot();
    try {
      const repo = 'acme/syncmethod';
      const adapterPath = path.join(root, 'configs', 'acme', 'syncmethod', 'adapter.ts');

      await writeFile(
        adapterPath,
        `export default class SyncAdapter {
          // classifyModule is sync
          classifyModule() { return '.'; }
          async getTestCommands() { return []; }
          async getSandboxServices() { return []; }
          async runCustomEval() { return { passed: true, summary: 'ok', retryContext: [] }; }
          async getPRMetadata() { return { extraLabels: [], extraBodySections: [] }; }
        }\n`
      );

      await expect(loadAdapter(repo, { repoRoot: root })).rejects.toMatchObject({
        name: 'AdapterContractError',
        code: 'sync_method',
        repoFullName: repo,
        adapterPath,
      } satisfies Partial<AdapterContractError>);
    } finally {
      await rmrf(root);
    }
  });

  test('rejects unsafe classifyModule return values', async () => {
    const root = await makeTempRoot();
    try {
      const repo = 'acme/badmodule';
      const adapterPath = path.join(root, 'configs', 'acme', 'badmodule', 'adapter.ts');

      await writeFile(
        adapterPath,
        `export default class BadModuleAdapter {
          async classifyModule() { return '../secrets'; }
          async getTestCommands() { return []; }
          async getSandboxServices() { return []; }
          async runCustomEval() { return { passed: true, summary: 'ok', retryContext: [] }; }
          async getPRMetadata() { return { extraLabels: [], extraBodySections: [] }; }
        }\n`
      );

      await expect(loadAdapter(repo, { repoRoot: root })).rejects.toMatchObject({
        name: 'AdapterContractError',
        code: 'invalid_classify_module',
        repoFullName: repo,
        adapterPath,
      } satisfies Partial<AdapterContractError>);
    } finally {
      await rmrf(root);
    }
  });
});
