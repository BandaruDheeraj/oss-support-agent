/**
 * Tests for the post-fix sanitizer. Uses a real temp git workspace because
 * the module orchestrates real `git` invocations — mocking would defeat the
 * purpose of validating that the diff / revert / amend chain actually works.
 *
 * The "remote" is a bare repo, so `push --force-with-lease` exercises the
 * full mechanic without requiring network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execCommand } from '../../bin/clients/local-workspace';
import {
  classifyChange,
  sanitizeFixCommit,
  SanitizeError,
} from './fix-sanitize';

const noLog = (_msg: string) => {
  /* swallow */
};

async function runIn(cwd: string, args: string[], stdin?: string) {
  const r = await execCommand(args[0]!, args.slice(1), cwd, { stdin });
  if (r.exitCode !== 0) {
    throw new Error(`${args.join(' ')} failed (${r.exitCode}): ${r.stderr || r.stdout}`);
  }
  return r;
}

/** Build a (remote-bare, working-clone) pair on disk. Returns the clone dir. */
async function makeWorkspace(): Promise<{ dir: string; remote: string; branch: string; cleanup: () => void }> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-test-'));
  const remote = path.join(base, 'remote.git');
  const dir = path.join(base, 'wt');
  fs.mkdirSync(remote, { recursive: true });
  await runIn(remote, ['git', 'init', '--bare', '--initial-branch=main']);

  fs.mkdirSync(dir, { recursive: true });
  await runIn(dir, ['git', 'init', '--initial-branch=main']);
  await runIn(dir, ['git', 'config', 'user.email', 'test@example.com']);
  await runIn(dir, ['git', 'config', 'user.name', 'Test']);
  await runIn(dir, ['git', 'config', 'core.autocrlf', 'false']);
  await runIn(dir, ['git', 'config', 'core.eol', 'lf']);
  await runIn(dir, ['git', 'remote', 'add', 'origin', remote]);

  // Baseline commit on main: a module file + a non-module file.
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'lib.py'), 'def foo():\n    return 1\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  await runIn(dir, ['git', 'add', '-A']);
  await runIn(dir, ['git', 'commit', '-m', 'initial']);
  await runIn(dir, ['git', 'push', '-u', 'origin', 'main']);

  return {
    dir,
    remote,
    branch: 'main',
    cleanup: () => {
      try {
        fs.rmSync(base, { recursive: true, force: true });
      } catch {
        /* ignore Windows handle holds */
      }
    },
  };
}

async function makeFixCommit(dir: string, files: Array<{ path: string; content: string | null }>, message = 'fix'): Promise<void> {
  for (const f of files) {
    const full = path.join(dir, f.path);
    if (f.content === null) {
      fs.rmSync(full, { force: true });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content);
    }
  }
  await runIn(dir, ['git', 'add', '-A']);
  await runIn(dir, ['git', 'commit', '-m', message]);
  // Push so --force-with-lease has a remote ref to compare against.
  await runIn(dir, ['git', 'push']);
}

describe('classifyChange', () => {
  it('keeps the repro test file regardless of module', () => {
    expect(
      classifyChange({ status: 'A', path: 'tests/test_repro_issue_42.py' }, '.', 'tests/test_repro_issue_42.py')
    ).toBe('keep');
    expect(
      classifyChange({ status: 'A', path: 'tests/test_repro_issue_42.py' }, 'src/auth', 'tests/test_repro_issue_42.py')
    ).toBe('keep');
  });

  it('reverts new files outside affected module', () => {
    expect(
      classifyChange({ status: 'A', path: 'tests/test_fix.py' }, 'src/auth', 'tests/test_repro_issue_1.py')
    ).toBe('revert');
  });

  it('reverts ALL new files (except repro) when affectedModule is root', () => {
    expect(
      classifyChange({ status: 'A', path: 'tests/test_fix.py' }, '.', 'tests/test_repro_issue_1.py')
    ).toBe('revert');
    expect(
      classifyChange({ status: 'A', path: 'src/lib.py' }, '.', 'tests/test_repro_issue_1.py')
    ).toBe('revert');
  });

  it('keeps modifications under affected module', () => {
    expect(
      classifyChange({ status: 'M', path: 'src/auth/handler.py' }, 'src/auth', 'tests/test_repro.py')
    ).toBe('keep');
  });

  it('reverts modifications outside affected module (when module is not root)', () => {
    expect(
      classifyChange({ status: 'M', path: 'src/other.py' }, 'src/auth', 'tests/test_repro.py')
    ).toBe('revert');
  });

  it('allows modifications anywhere when module is root', () => {
    expect(
      classifyChange({ status: 'M', path: 'src/anywhere.py' }, '.', 'tests/test_repro.py')
    ).toBe('keep');
  });
});

describe('sanitizeFixCommit', () => {
  // These tests touch the filesystem and shell out to git, so give them time.
  jest.setTimeout(20_000);

  let ws: Awaited<ReturnType<typeof makeWorkspace>>;

  beforeEach(async () => {
    ws = await makeWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('drops a noise tests/test_fix.py file added alongside a legitimate fix', async () => {
    await makeFixCommit(ws.dir, [
      { path: 'src/lib.py', content: 'def foo():\n    return 2\n' },
      { path: 'tests/test_fix.py', content: 'def test_readme(): assert True\n' },
      { path: 'tests/test_repro_issue_1.py', content: 'def test_repro(): assert True\n' },
    ]);

    const result = await sanitizeFixCommit({
      workspaceDir: ws.dir,
      branch: ws.branch,
      affectedModule: '.',
      reproPath: 'tests/test_repro_issue_1.py',
      log: noLog,
    });

    expect(result.amended).toBe(true);
    expect(result.droppedPaths).toContain('tests/test_fix.py');
    expect(result.retainedPaths).toContain('tests/test_repro_issue_1.py');
    expect(result.retainedPaths).toContain('src/lib.py');

    // Verify the file is actually gone from HEAD.
    const listing = await execCommand('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], ws.dir);
    expect(listing.stdout).not.toMatch(/tests\/test_fix\.py/);
    expect(listing.stdout).toMatch(/src\/lib\.py/);
    expect(listing.stdout).toMatch(/tests\/test_repro_issue_1\.py/);
  });

  it('strips whitespace-only hunks while keeping functional ones', async () => {
    // Baseline `src/lib.py` has just `def foo():\n    return 1\n`.
    // The fix changes the return value AND, in a SEPARATE region, adds
    // pure-whitespace lines (a docstring block). Adding the docstring
    // requires a gap of context so it forms its own hunk.
    const baseline = (
      'def foo():\n' +
      '    return 1\n' +
      '\n' +
      'def bar():\n' +
      '    return 10\n' +
      '\n' +
      'def baz():\n' +
      '    return 100\n'
    );
    fs.writeFileSync(path.join(ws.dir, 'src/lib.py'), baseline);
    await runIn(ws.dir, ['git', 'add', '-A']);
    await runIn(ws.dir, ['git', 'commit', '-m', 'expand lib']);
    await runIn(ws.dir, ['git', 'push']);

    const fixedContent = (
      'def foo():\n' +
      '    return 2\n' +  // functional change
      '\n' +
      'def bar():\n' +
      '\n' +              // pure-whitespace addition (blank line inside)
      '    return 10\n' +
      '\n' +
      'def baz():\n' +
      '    return 100\n'
    );

    await makeFixCommit(ws.dir, [
      { path: 'src/lib.py', content: fixedContent },
      { path: 'tests/test_repro_issue_1.py', content: 'def test_repro(): assert True\n' },
    ]);

    const result = await sanitizeFixCommit({
      workspaceDir: ws.dir,
      branch: ws.branch,
      affectedModule: '.',
      reproPath: 'tests/test_repro_issue_1.py',
      log: noLog,
    });

    expect(result.retainedPaths).toContain('src/lib.py');
    expect(result.wsHunksStripped).toBeGreaterThan(0);

    // Final lib.py: functional change kept, ws-only change reverted.
    const final = fs.readFileSync(path.join(ws.dir, 'src/lib.py'), 'utf-8');
    expect(final).toMatch(/return 2/);
    // The bar() blank line should NOT survive sanitization.
    expect(final).toMatch(/def bar\(\):\n    return 10/);
  });

  it('throws SanitizeError(empty) when the entire fix is out-of-scope noise', async () => {
    await makeFixCommit(ws.dir, [{ path: 'tests/test_fix.py', content: 'def test_x(): pass\n' }]);

    await expect(
      sanitizeFixCommit({
        workspaceDir: ws.dir,
        branch: ws.branch,
        affectedModule: '.',
        reproPath: 'tests/test_repro_issue_1.py',
        log: noLog,
      })
    ).rejects.toMatchObject({ name: 'SanitizeError', kind: 'empty' });
  });

  it('makes no changes when the commit is already clean', async () => {
    await makeFixCommit(ws.dir, [
      { path: 'src/lib.py', content: 'def foo():\n    return 99\n' },
      { path: 'tests/test_repro_issue_1.py', content: 'def test_repro(): assert True\n' },
    ]);

    const headBefore = (await execCommand('git', ['rev-parse', 'HEAD'], ws.dir)).stdout.trim();

    const result = await sanitizeFixCommit({
      workspaceDir: ws.dir,
      branch: ws.branch,
      affectedModule: '.',
      reproPath: 'tests/test_repro_issue_1.py',
      log: noLog,
    });

    expect(result.amended).toBe(false);
    expect(result.droppedPaths).toEqual([]);
    expect(result.wsHunksStripped).toBe(0);

    const headAfter = (await execCommand('git', ['rev-parse', 'HEAD'], ws.dir)).stdout.trim();
    expect(headAfter).toBe(headBefore);
  });

  it('restricts new files to the repro test only when affectedModule="."', async () => {
    await makeFixCommit(ws.dir, [
      { path: 'src/new_helper.py', content: 'def helper(): return 1\n' },
      { path: 'tests/test_repro_issue_1.py', content: 'def test_repro(): assert True\n' },
    ]);

    const result = await sanitizeFixCommit({
      workspaceDir: ws.dir,
      branch: ws.branch,
      affectedModule: '.',
      reproPath: 'tests/test_repro_issue_1.py',
      log: noLog,
    });

    expect(result.droppedPaths).toContain('src/new_helper.py');
    expect(fs.existsSync(path.join(ws.dir, 'src/new_helper.py'))).toBe(false);
  });

  it('allows new files under a non-root affectedModule', async () => {
    fs.mkdirSync(path.join(ws.dir, 'src/auth'), { recursive: true });
    fs.writeFileSync(path.join(ws.dir, 'src/auth/__init__.py'), '');
    await runIn(ws.dir, ['git', 'add', '-A']);
    await runIn(ws.dir, ['git', 'commit', '-m', 'add auth pkg']);
    await runIn(ws.dir, ['git', 'push']);

    await makeFixCommit(ws.dir, [
      { path: 'src/auth/helper.py', content: 'def helper(): return 1\n' },
      { path: 'tests/test_repro_issue_1.py', content: 'def test_repro(): assert True\n' },
    ]);

    const result = await sanitizeFixCommit({
      workspaceDir: ws.dir,
      branch: ws.branch,
      affectedModule: 'src/auth',
      reproPath: 'tests/test_repro_issue_1.py',
      log: noLog,
    });

    // New file IS allowed under src/auth.
    expect(result.droppedPaths).not.toContain('src/auth/helper.py');
    expect(fs.existsSync(path.join(ws.dir, 'src/auth/helper.py'))).toBe(true);
  });

  it('reverts modifications to files outside affectedModule', async () => {
    fs.mkdirSync(path.join(ws.dir, 'src/auth'), { recursive: true });
    fs.writeFileSync(path.join(ws.dir, 'src/auth/__init__.py'), '');
    fs.writeFileSync(path.join(ws.dir, 'src/auth/handler.py'), 'def handle(): return None\n');
    await runIn(ws.dir, ['git', 'add', '-A']);
    await runIn(ws.dir, ['git', 'commit', '-m', 'add auth handler']);
    await runIn(ws.dir, ['git', 'push']);

    await makeFixCommit(ws.dir, [
      { path: 'src/auth/handler.py', content: 'def handle(): return "ok"\n' },
      { path: 'src/lib.py', content: 'def foo():\n    return 999\n' }, // out-of-scope mod
      { path: 'tests/test_repro_issue_1.py', content: 'def test_repro(): assert True\n' },
    ]);

    const result = await sanitizeFixCommit({
      workspaceDir: ws.dir,
      branch: ws.branch,
      affectedModule: 'src/auth',
      reproPath: 'tests/test_repro_issue_1.py',
      log: noLog,
    });

    expect(result.droppedPaths).toContain('src/lib.py');
    // Out-of-scope file restored to its pre-fix content.
    const libContent = fs.readFileSync(path.join(ws.dir, 'src/lib.py'), 'utf-8');
    expect(libContent).toBe('def foo():\n    return 1\n');
  });
});
