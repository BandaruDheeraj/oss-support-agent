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
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; shell?: boolean } = {}
): Promise<ExecResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: opts.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    const proc = spawn(cmd, args, spawnOpts);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

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

  async push(): Promise<void> {
    await git(this.dir, ['push', 'origin', this.branch]);
  }
}
