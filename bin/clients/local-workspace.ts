/**
 * Local workspace helper: clones the fork, manages a working branch, runs git commands,
 * and pushes back to GitHub. Used by the fix agent (RepoFileReader/ForkCommitter) and
 * the local sandbox runner.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, SpawnOptions } from 'child_process';

export interface WorkspaceOptions {
  /** Directory under which workspaces are created (default: data/workspaces). */
  rootDir: string;
  /** OAuth token used in HTTPS clone/push URLs. */
  token: string;
  /** Git user.name / user.email for commits. */
  authorName: string;
  authorEmail: string;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** Run a shell command and capture stdout/stderr/exitCode. Never throws on non-zero exit. */
export async function execCommand(
  cmd: string,
  args: string[],
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; shell?: boolean; stdin?: string } = {}
): Promise<ExecResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: opts.shell ?? false,
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    };
    const proc = spawn(cmd, args, spawnOpts);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    if (opts.stdin !== undefined && proc.stdin) {
      proc.stdin.on('error', () => {
        /* ignore EPIPE etc — the spawn error handler covers it */
      });
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    }

    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf-8');
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8');
    });

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }, opts.timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr: stderr + `\n[spawn-error] ${err.message}`,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  const r = await execCommand('git', args, cwd, { env });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`);
  }
  return r;
}

function cloneUrl(token: string, fullName: string): string {
  return `https://x-access-token:${token}@github.com/${fullName}.git`;
}

export class LocalWorkspace {
  public readonly dir: string;

  constructor(
    private readonly opts: WorkspaceOptions,
    public readonly forkFullName: string,
    public readonly branch: string
  ) {
    const safeName = forkFullName.replace('/', '__');
    this.dir = path.join(opts.rootDir, `${safeName}__${branch.replace(/[^a-z0-9_-]/gi, '_')}`);
  }

  async ensureCheckedOut(baseBranch: string): Promise<void> {
    fs.mkdirSync(this.opts.rootDir, { recursive: true });

    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      // Fresh clone of the fork.
      await git(this.opts.rootDir, [
        'clone',
        '--no-tags',
        '--single-branch',
        '--branch',
        baseBranch,
        cloneUrl(this.opts.token, this.forkFullName),
        path.basename(this.dir),
      ]);
      await git(this.dir, ['config', 'user.name', this.opts.authorName]);
      await git(this.dir, ['config', 'user.email', this.opts.authorEmail]);
      // Defense-in-depth: register .agent-venv in the repo-local exclude
      // file so even an accidental `git add -A` (e.g. from a future code
      // path) cannot stage the per-workspace Python venv. This is local
      // to the clone — it does NOT modify the upstream repo's .gitignore.
      try {
        const excludePath = path.join(this.dir, '.git', 'info', 'exclude');
        fs.mkdirSync(path.dirname(excludePath), { recursive: true });
        const existing = fs.existsSync(excludePath)
          ? fs.readFileSync(excludePath, 'utf-8')
          : '';
        if (!/^\.agent-venv\/?$/m.test(existing)) {
          const sep = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
          fs.writeFileSync(excludePath, `${existing}${sep}.agent-venv/\n`, 'utf-8');
        }
      } catch {
        // Best-effort; commitChanges already restricts to authored paths.
      }
    }

    // Fetch and check out the working branch (it should already exist on the fork
    // because createForkAndBranch created it via the API). Use an explicit refspec
    // so the remote-tracking ref is created under origin/ for the single-branch clone.
    await git(this.dir, ['fetch', 'origin', `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`]);
    await git(this.dir, ['checkout', '-B', this.branch, `refs/remotes/origin/${this.branch}`]);
    await git(this.dir, ['reset', '--hard', `origin/${this.branch}`]);
  }

  readFile(relPath: string): string {
    return fs.readFileSync(path.join(this.dir, relPath), 'utf-8');
  }

  fileExists(relPath: string): boolean {
    return fs.existsSync(path.join(this.dir, relPath));
  }

  listFiles(relDir: string): string[] {
    const abs = path.join(this.dir, relDir);
    if (!fs.existsSync(abs)) return [];
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.posix.join(relDir, e.name));
  }

  listSubdirs(relDir: string): string[] {
    const abs = path.join(this.dir, relDir);
    if (!fs.existsSync(abs)) return [];
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name);
  }

  /**
   * Recursively search the workspace for files whose path ends with the
   * given suffix (matched at a path-component boundary, i.e. `bar/baz.py`
   * matches `foo/bar/baz.py` but not `xbar/baz.py`).
   *
   * Skips ignored / virtual dirs: `.git`, `node_modules`, `.venv`, `venv`,
   * `__pycache__`, `dist`, `build`, `.tox`, `.pytest_cache`, `.mypy_cache`.
   * Caps the total number of files visited to keep worst-case bounded.
   *
   * Returns repo-relative POSIX-normalized paths.
   */
  findFilesBySuffix(suffix: string, maxResults = 10): string[] {
    if (!suffix) return [];
    const norm = suffix.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!norm) return [];
    const IGNORE = new Set([
      '.git',
      'node_modules',
      '.venv',
      'venv',
      '__pycache__',
      'dist',
      'build',
      '.tox',
      '.pytest_cache',
      '.mypy_cache',
      '.next',
      '.cache',
    ]);
    const MAX_FILES_VISITED = 50_000;
    let visited = 0;
    const matches: string[] = [];
    const walk = (rel: string): void => {
      if (matches.length >= maxResults) return;
      if (visited >= MAX_FILES_VISITED) return;
      const abs = path.join(this.dir, rel);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (matches.length >= maxResults) return;
        if (visited >= MAX_FILES_VISITED) return;
        if (IGNORE.has(e.name)) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          walk(childRel);
        } else if (e.isFile()) {
          visited++;
          if (childRel === norm || childRel.endsWith(`/${norm}`)) {
            matches.push(childRel);
          }
        }
      }
    };
    walk('');
    return matches;
  }

  writeFile(relPath: string, content: string): void {
    const abs = path.join(this.dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }

  async commitAll(message: string): Promise<string> {
    const status = await execCommand('git', ['status', '--porcelain'], this.dir);
    if (!status.stdout.trim()) {
      throw new Error('No changes to commit');
    }
    await git(this.dir, ['add', '-A']);
    await git(this.dir, ['commit', '-m', message]);
    const rev = await git(this.dir, ['rev-parse', 'HEAD']);
    return rev.stdout.trim();
  }

  /**
   * Commit ONLY the given paths (use this when other files may have been
   * modified by sandbox runs that we don't want to commit, e.g. baseline
   * runs of LLM-authored repro scripts). Throws if there's nothing staged
   * after `git add` for those paths.
   */
  async commitPaths(relPaths: string[], message: string): Promise<string> {
    if (relPaths.length === 0) {
      throw new Error('commitPaths called with no paths');
    }
    await git(this.dir, ['add', '--', ...relPaths]);
    const staged = await execCommand('git', ['diff', '--cached', '--name-only'], this.dir);
    if (!staged.stdout.trim()) {
      throw new Error('No changes to commit');
    }
    await git(this.dir, ['commit', '-m', message]);
    const rev = await git(this.dir, ['rev-parse', 'HEAD']);
    return rev.stdout.trim();
  }

  /**
   * Return `git status --porcelain` lines that match the given paths.
   * Used as a diagnostic before a commit — answers "would `git add` of
   * these paths stage anything?". Returns an empty array if there are
   * no pending differences for those paths (e.g. LLM wrote content
   * identical to HEAD).
   */
  async statusForPaths(relPaths: string[]): Promise<string[]> {
    if (relPaths.length === 0) return [];
    const status = await execCommand(
      'git',
      ['status', '--porcelain', '--', ...relPaths],
      this.dir
    );
    return status.stdout
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
  }

  /**
   * Restore the working tree to HEAD: discard tracked-file modifications and
   * delete any untracked files / directories. Use this after running an
   * LLM-authored script in the sandbox so unintended side effects don't get
   * swept into the next commit.
   */
  async resetWorkingTree(): Promise<void> {
    await git(this.dir, ['reset', '--hard', 'HEAD']);
    // -fd: discard untracked files + directories. NOT -x: keep .gitignored
    // files like .venv/node_modules so we don't blow away install caches.
    // -e .agent-venv: explicitly preserve our per-workspace Python venv even
    // when the upstream repo doesn't gitignore it. Recreating the venv on
    // every attempt is slow and (on Render) flaky enough to break the repro
    // loop entirely; reusing it is both correct and dramatically faster.
    await git(this.dir, ['clean', '-fd', '-e', '.agent-venv']);
  }

  async push(): Promise<void> {
    await git(this.dir, ['push', 'origin', this.branch]);
  }

  /**
   * Force-push the local branch tip over the remote, but only if the remote
   * still matches what we last saw — so a concurrent push from another
   * pipeline run cannot get silently overwritten. Used by the post-fix
   * sanitizer after `git commit --amend`.
   */
  async pushForceWithLease(): Promise<void> {
    await git(this.dir, ['push', '--force-with-lease', 'origin', this.branch]);
  }
}
