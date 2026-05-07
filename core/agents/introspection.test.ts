/**
 * Unit tests for US-104 repo signal gathering.
 */

import * as path from 'path';
import * as fs from 'fs';

import { gatherRepoSignals } from './introspection';
import type { RepoCloner } from './introspection-types';

const FIXTURES_ROOT = path.join(__dirname, 'fixtures', 'repo-signals');

async function resetDir(dir: string) {
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
}

async function writeFile(filePath: string, content: string) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, 'utf-8');
}

function fixturePath(name: string) {
  return path.join(FIXTURES_ROOT, name);
}

class FixtureCloner implements RepoCloner {
  constructor(private readonly sourceDir: string) {}

  async clone(_repoFullName: string, destDir: string): Promise<void> {
    await fs.promises.mkdir(destDir, { recursive: true });
    await fs.promises.cp(this.sourceDir, destDir, { recursive: true });
  }
}

describe('gatherRepoSignals (US-104)', () => {
  beforeAll(async () => {
    await resetDir(FIXTURES_ROOT);

    // --- pure Node monorepo ---
    const nodeMono = fixturePath('node-monorepo');
    await writeFile(
      path.join(nodeMono, '.github', 'workflows', 'ci.yml'),
      `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: npm ci
      - name: Test
        run: |
          npm test
          npm run lint
`
    );
    await writeFile(
      path.join(nodeMono, 'packages', 'a', 'package.json'),
      JSON.stringify({ name: 'a', scripts: { test: 'jest' }, packageManager: 'pnpm@8.0.0' }, null, 2)
    );
    await writeFile(
      path.join(nodeMono, 'packages', 'b', 'package.json'),
      JSON.stringify({ name: 'b', scripts: { test: 'vitest run' } }, null, 2)
    );

    // --- single-package Python repo ---
    const pyRepo = fixturePath('python-single');
    await writeFile(
      path.join(pyRepo, 'pyproject.toml'),
      `[project]
name = "demo"

[tool.pytest.ini_options]
addopts = "-q"
`
    );
    await writeFile(path.join(pyRepo, 'CONTRIBUTING.md'), 'Run tests:\n```bash\npytest -q\n```\n');

    // --- Makefile only ---
    const makeOnly = fixturePath('makefile-only');
    await writeFile(
      path.join(makeOnly, 'Makefile'),
      `test:\n\t@echo running tests\n\ncheck:\n\t@echo checking\n\nall:\n\t@echo all\n`
    );

    // --- README only ---
    const readmeOnly = fixturePath('readme-only');
    await writeFile(path.join(readmeOnly, 'README.md'), '# Hello\n\nNo CI here.\n');

    // --- no signals ---
    const none = fixturePath('no-signals');
    await writeFile(path.join(none, 'NOTES.txt'), 'nothing interesting');
  });

  test('extracts CI workflow run steps and monorepo package manifests', async () => {
    const tmpRoot = path.join(FIXTURES_ROOT, 'tmp1');
    await resetDir(tmpRoot);

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

  test('extracts python manifest and contributing code blocks', async () => {
    const tmpRoot = path.join(FIXTURES_ROOT, 'tmp2');
    await resetDir(tmpRoot);

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

  test('extracts Makefile targets matching test/check/verify', async () => {
    const tmpRoot = path.join(FIXTURES_ROOT, 'tmp3');
    await resetDir(tmpRoot);

    const signals = await gatherRepoSignals('fixture/make', {
      cloner: new FixtureCloner(fixturePath('makefile-only')),
      tmpRoot,
    });

    expect(signals.makefileTargets.map((t) => t.target).sort()).toEqual(['check', 'test']);
    expect(signals.readme).toBe('');
    expect(fs.readdirSync(tmpRoot).length).toBe(0);
  });

  test('uses README.md as fallback when no other test signals exist', async () => {
    const tmpRoot = path.join(FIXTURES_ROOT, 'tmp4');
    await resetDir(tmpRoot);

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

  test('is tolerant of missing files and returns empty arrays/strings', async () => {
    const tmpRoot = path.join(FIXTURES_ROOT, 'tmp5');
    await resetDir(tmpRoot);

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

  test('cleans up temp dirs on error', async () => {
    const tmpRoot = path.join(FIXTURES_ROOT, 'tmp-error');
    await resetDir(tmpRoot);

    const cloner: RepoCloner = {
      async clone() {
        throw new Error('boom');
      },
    };

    await expect(gatherRepoSignals('fixture/error', { cloner, tmpRoot })).rejects.toThrow('boom');
    expect(fs.readdirSync(tmpRoot).length).toBe(0);
  });
});
