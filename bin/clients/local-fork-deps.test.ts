/**
 * Regression tests for LocalForkCommitter: a fix-agent commit must contain
 * ONLY the LLM-authored paths, never untracked workspace artifacts like the
 * per-workspace .agent-venv/ directory. This pathology produced PR #39 with
 * 1342 changed files and 298k additions on issue #38; the fix here is to
 * use commitPaths() instead of commitAll() so `git add -A` never runs on a
 * tree that contains the venv.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import { LocalForkCommitter } from './local-fork-deps';
import { LocalWorkspace } from './local-workspace';

function initBareRemoteAndClone(): { workDir: string; remoteDir: string; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lfc-test-'));
  const remoteDir = path.join(tmp, 'remote.git');
  const cloneDir = path.join(tmp, 'clone');
  execSync(`git init --bare "${remoteDir}"`, { stdio: 'ignore' });
  execSync(`git -c init.defaultBranch=main clone "${remoteDir}" "${cloneDir}"`, { stdio: 'ignore' });
  execSync('git config user.email test@example.com', { cwd: cloneDir, stdio: 'ignore' });
  execSync('git config user.name test', { cwd: cloneDir, stdio: 'ignore' });
  // Seed an initial commit so there's a HEAD to commit against.
  fs.writeFileSync(path.join(cloneDir, 'README.md'), 'seed\n', 'utf-8');
  execSync('git checkout -B main', { cwd: cloneDir, stdio: 'ignore' });
  execSync('git add README.md', { cwd: cloneDir, stdio: 'ignore' });
  execSync('git commit -m seed', { cwd: cloneDir, stdio: 'ignore' });
  execSync('git push -u origin main', { cwd: cloneDir, stdio: 'ignore' });
  return {
    workDir: cloneDir,
    remoteDir,
    cleanup: () => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/**
 * Build a LocalWorkspace pointing at an already-cloned directory by reaching
 * into the private `dir` field. ensureCheckedOut() is bypassed because we've
 * already set up the clone manually for hermetic-ness.
 */
function makeWorkspace(workDir: string): LocalWorkspace {
  const ws = new LocalWorkspace(
    { rootDir: path.dirname(workDir), token: 'x', authorName: 'test', authorEmail: 't@e' },
    'owner/repo',
    'main'
  );
  // Override the auto-computed dir to the actual clone we set up above.
  (ws as unknown as { dir: string }).dir = workDir;
  return ws;
}

describe('LocalForkCommitter.commitChanges', () => {
  jest.setTimeout(30_000);
  test('commits ONLY the authored paths, not stray untracked files like .agent-venv', async () => {
    const { workDir, cleanup } = initBareRemoteAndClone();
    try {
      // Simulate the sandbox having created a per-workspace venv full of files.
      const venvDir = path.join(workDir, '.agent-venv', 'lib', 'python3.11', 'site-packages', 'foo');
      fs.mkdirSync(venvDir, { recursive: true });
      fs.writeFileSync(path.join(venvDir, '__init__.py'), '# venv content\n', 'utf-8');
      fs.writeFileSync(path.join(workDir, '.agent-venv', 'pyvenv.cfg'), 'home=/usr\n', 'utf-8');
      // And an unrelated untracked file from some other side effect.
      fs.writeFileSync(path.join(workDir, 'stray.txt'), 'side effect\n', 'utf-8');

      const ws = makeWorkspace(workDir);
      const committer = new LocalForkCommitter(ws, ['repo']);

      await committer.commitChanges('owner/repo', 'main', [
        { path: 'src/fix.py', action: 'create', content: 'def fixed(): return True\n' },
        { path: 'tests/test_fix.py', action: 'create', content: 'def test_fix(): assert True\n' },
      ], 'fix: stuff');

      const filesInCommit = execSync('git show --name-only --pretty=format: HEAD', { cwd: workDir })
        .toString('utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .sort();

      expect(filesInCommit).toEqual(['src/fix.py', 'tests/test_fix.py']);
      // Hard assertion: zero venv / stray files in the commit.
      expect(filesInCommit.some((f) => f.startsWith('.agent-venv'))).toBe(false);
      expect(filesInCommit).not.toContain('stray.txt');
    } finally {
      cleanup();
    }
  });

  test('throws when no authored changes are passed', async () => {
    const { workDir, cleanup } = initBareRemoteAndClone();
    try {
      const ws = makeWorkspace(workDir);
      const committer = new LocalForkCommitter(ws, ['repo']);
      await expect(
        committer.commitChanges('owner/repo', 'main', [], 'noop')
      ).rejects.toThrow(/no paths|No changes to commit/i);
    } finally {
      cleanup();
    }
  });
});
