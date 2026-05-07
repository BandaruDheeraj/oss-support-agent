/**
 * Unit tests for US-104 repo signal gathering.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { gatherRepoSignals } from './introspection';
import type { RepoCloner } from './introspection-types';

const FIXTURES_ROOT = path.join(__dirname, 'fixtures', 'repo-signals');

function fixturePath(name: string) {
  return path.join(FIXTURES_ROOT, name);
}

async function withTmpRoot<T>(fn: (tmpRoot: string) => Promise<T>): Promise<T> {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oss-agent-us104-'));
  try {
    return await fn(tmpRoot);
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

class FixtureCloner implements RepoCloner {
  constructor(private readonly sourceDir: string) {}

  async clone(_repoFullName: string, destDir: string): Promise<void> {
    await fs.promises.mkdir(destDir, { recursive: true });
    await fs.promises.cp(this.sourceDir, destDir, { recursive: true });
  }
}

describe('gatherRepoSignals (US-104)', () => {
  test('extracts CI workflow run steps and monorepo package manifests', async () => {
    await withTmpRoot(async (tmpRoot) => {
      const signals = await gatherRepoSignals('fixture/node-monorepo', {
        cloner: new FixtureCloner(fixturePath('node-monorepo')),
        tmpRoot,
      });

      expect(signals.ciWorkflows.length).toBe(1);
      expect(signals.ciWorkflows[0].path).toMatch(/\.github\/workflows\/ci\.yml$/);
      expect(signals.ciWorkflows[0].commands).toEqual(['npm ci', 'npm test\nnpm run lint']);

      expect(signals.packageManifests.map((m) => m.path).sort()).toEqual([
        'packages/a/package.json',
        'packages/b/package.json',
      ]);

      expect(signals.monorepoLayout['packages/a']).toEqual(['node']);
      expect(signals.monorepoLayout['packages/b']).toEqual(['node']);

      expect(signals.readme).toBe('');
      expect(fs.readdirSync(tmpRoot).length).toBe(0);
    });
  });

  test('extracts python manifest and contributing code blocks', async () => {
    await withTmpRoot(async (tmpRoot) => {
      const signals = await gatherRepoSignals('fixture/python', {
        cloner: new FixtureCloner(fixturePath('python-single')),
        tmpRoot,
      });

      expect(signals.packageManifests.length).toBe(1);
      expect(signals.packageManifests[0].kind).toBe('pyproject.toml');
      expect(signals.packageManifests[0].stack).toBe('python');

      expect(signals.contributingDocs.length).toBe(1);
      expect(signals.contributingDocs[0].codeBlocks).toEqual(['pytest -q']);
      expect(fs.readdirSync(tmpRoot).length).toBe(0);
    });
  });

  test('extracts Makefile targets matching test/check/verify', async () => {
    await withTmpRoot(async (tmpRoot) => {
      const signals = await gatherRepoSignals('fixture/make', {
        cloner: new FixtureCloner(fixturePath('makefile-only')),
        tmpRoot,
      });

      expect(signals.makefileTargets.map((t) => t.target).sort()).toEqual(['check', 'test']);
      expect(signals.readme).toBe('');
      expect(fs.readdirSync(tmpRoot).length).toBe(0);
    });
  });

  test('uses README.md as fallback when no other test signals exist', async () => {
    await withTmpRoot(async (tmpRoot) => {
      const signals = await gatherRepoSignals('fixture/readme', {
        cloner: new FixtureCloner(fixturePath('readme-only')),
        tmpRoot,
      });

      expect(signals.ciWorkflows).toEqual([]);
      expect(signals.packageManifests).toEqual([]);
      expect(signals.makefileTargets).toEqual([]);
      expect(signals.readme).toContain('Hello');
      expect(fs.readdirSync(tmpRoot).length).toBe(0);
    });
  });

  test('is tolerant of missing files and returns empty arrays/strings', async () => {
    await withTmpRoot(async (tmpRoot) => {
      const signals = await gatherRepoSignals('fixture/none', {
        cloner: new FixtureCloner(fixturePath('no-signals')),
        tmpRoot,
      });

      expect(signals.ciWorkflows).toEqual([]);
      expect(signals.packageManifests).toEqual([]);
      expect(signals.makefileTargets).toEqual([]);
      expect(signals.contributingDocs).toEqual([]);
      expect(signals.composeServices).toEqual([]);
      expect(signals.readme).toBe('');
      expect(fs.readdirSync(tmpRoot).length).toBe(0);
    });
  });

  test('cleans up temp dirs on error', async () => {
    await withTmpRoot(async (tmpRoot) => {
      const cloner: RepoCloner = {
        async clone() {
          throw new Error('boom');
        },
      };

      await expect(gatherRepoSignals('fixture/error', { cloner, tmpRoot })).rejects.toThrow('boom');
      expect(fs.readdirSync(tmpRoot).length).toBe(0);
    });
  });
});
