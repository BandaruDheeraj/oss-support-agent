/**
 * Post-fix sanitizer.
 *
 * Runs after the fix-agent has committed + pushed its attempt and after the
 * repro-immutability check has passed. Goal: strip noise (out-of-scope new
 * files, modifications to unrelated files, whitespace-only hunks) from the
 * top commit so the eventual PR is minimal and meaningful.
 *
 * Strategy (see plan.md):
 *   A1/A2: per-file disposition (keep | revert-as-modification | revert-as-new)
 *   A3:    for kept-and-modified files, strip whitespace-only hunks via
 *          `git apply --reverse` from stdin.
 *   A4:    if nothing functional survives, throw SanitizeError so the caller
 *          can fail the attempt and feed retryContext to the next loop.
 *   A5:    any mechanical git failure is fatal (same SanitizeError path).
 *   A6:    on success, amend the commit and force-push-with-lease.
 *
 * Renames/deletes/binary/chmod hunks are treated as full-file decisions
 * (keep or revert), never hunk-sliced.
 */

import { execCommand } from '../../bin/clients/local-workspace';

export class SanitizeError extends Error {
  constructor(message: string, public readonly kind: 'empty' | 'mechanical') {
    super(message);
    this.name = 'SanitizeError';
  }
}

export interface SanitizeOptions {
  workspaceDir: string;
  /** Branch to push-force-with-lease after amend. Caller passes the workspace's branch. */
  branch: string;
  affectedModule: string;
  /** Path of the repro test file, relative to repo root. */
  reproPath: string;
  log: (msg: string) => void;
}

export interface SanitizeResult {
  /** Files fully reverted (either checked out from HEAD~1 or git-rm'd). */
  droppedPaths: string[];
  /** Number of whitespace-only hunks stripped across all retained files. */
  wsHunksStripped: number;
  /** Files that survived sanitization (kept changes). */
  retainedPaths: string[];
  /** True iff the commit was amended (i.e. anything was actually changed). */
  amended: boolean;
}

type FileStatus = {
  /** Single-letter git status: A,M,D,R,C,T,U. R/C carry a percentage suffix in the raw output but we collapse here. */
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';
  path: string;
  /** For renames/copies, the original path. */
  origPath?: string;
};

async function runGit(cwd: string, args: string[], stdin?: string) {
  const r = await execCommand('git', args, cwd, { stdin });
  if (r.exitCode !== 0) {
    throw new SanitizeError(
      `git ${args.join(' ')} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
      'mechanical'
    );
  }
  return r;
}

function isUnderModule(path: string, mod: string): boolean {
  if (mod === '.' || mod === '') return true;
  const norm = mod.replace(/\/+$/, '');
  return path === norm || path.startsWith(norm + '/');
}

/**
 * Decide whether a changed file should be kept (and possibly hunk-stripped)
 * or fully reverted.
 *
 * Strict policies (see plan.md):
 *  - A new file (status A) is allowed ONLY if it is the repro test or, when
 *    affectedModule !== '.', strictly under affectedModule.
 *  - A modified file (status M/T) is allowed if it is the repro test OR
 *    under affectedModule (always true when affectedModule === '.').
 *  - Deletions (D) and renames (R) are conservative: keep only if BOTH the
 *    old and new paths satisfy the modification rule. Otherwise fully revert.
 */
export function classifyChange(
  change: FileStatus,
  affectedModule: string,
  reproPath: string
): 'keep' | 'revert' {
  const isRepro = change.path === reproPath || change.origPath === reproPath;
  if (change.status === 'A') {
    if (isRepro) return 'keep';
    if (affectedModule === '.' || affectedModule === '') return 'revert';
    return isUnderModule(change.path, affectedModule) ? 'keep' : 'revert';
  }
  if (change.status === 'D') {
    if (isRepro) return 'keep';
    return isUnderModule(change.path, affectedModule) ? 'keep' : 'revert';
  }
  if (change.status === 'R' || change.status === 'C') {
    const old = change.origPath ?? change.path;
    if (isRepro) return 'keep';
    return isUnderModule(change.path, affectedModule) && isUnderModule(old, affectedModule)
      ? 'keep'
      : 'revert';
  }
  // M, T (mode change), U (unmerged shouldn't occur here)
  if (isRepro) return 'keep';
  return isUnderModule(change.path, affectedModule) ? 'keep' : 'revert';
}

async function listTopCommitChanges(cwd: string): Promise<FileStatus[]> {
  const r = await runGit(cwd, ['diff', '--name-status', 'HEAD~1', 'HEAD']);
  const out: FileStatus[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]!;
    const letter = code.charAt(0).toUpperCase() as FileStatus['status'];
    if (letter === 'R' || letter === 'C') {
      // R100\told\tnew
      const [, origPath, path] = parts;
      out.push({ status: letter, path: path!, origPath: origPath! });
    } else {
      out.push({ status: letter, path: parts[1]! });
    }
  }
  return out;
}

interface Hunk {
  /** Full text including header line, ending with newline. */
  text: string;
  /** Lines starting with '+', without the leading '+'. */
  added: string[];
  /** Lines starting with '-', without the leading '-'. */
  removed: string[];
}

interface FileDiff {
  /** The pre-hunk preamble (diff --git, index, ---, +++) lines, joined with newlines, no trailing newline. */
  header: string;
  hunks: Hunk[];
}

function parseFileDiff(raw: string): FileDiff | null {
  if (!raw.trim()) return null;
  const lines = raw.split('\n');
  let headerEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('@@')) {
      headerEnd = i;
      break;
    }
  }
  if (headerEnd === -1) return null;
  const header = lines.slice(0, headerEnd).join('\n');
  const hunks: Hunk[] = [];
  let cur: string[] = [];
  for (let i = headerEnd; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      if (cur.length) hunks.push(finalizeHunk(cur));
      cur = [line];
    } else if (cur.length) {
      cur.push(line);
    }
  }
  if (cur.length) hunks.push(finalizeHunk(cur));
  return { header, hunks };
}

function finalizeHunk(lines: string[]): Hunk {
  const added: string[] = [];
  const removed: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('+') && !l.startsWith('+++')) added.push(l.slice(1));
    else if (l.startsWith('-') && !l.startsWith('---')) removed.push(l.slice(1));
  }
  // Re-attach trailing newline so the hunk text is a complete unit.
  return { text: lines.join('\n') + '\n', added, removed };
}

function isWhitespaceOnlyHunk(h: Hunk): boolean {
  const a = h.added.join('').replace(/\s+/g, '');
  const r = h.removed.join('').replace(/\s+/g, '');
  return a === r;
}

/**
 * Build a patch (only the whitespace-only hunks) that, when applied in
 * reverse to the worktree, undoes just those hunks.
 */
function buildWsOnlyPatch(fd: FileDiff): { patch: string; count: number } {
  const wsHunks = fd.hunks.filter(isWhitespaceOnlyHunk);
  if (wsHunks.length === 0) return { patch: '', count: 0 };
  const patch = fd.header + '\n' + wsHunks.map((h) => h.text).join('');
  return { patch, count: wsHunks.length };
}

/**
 * Main entry. May throw `SanitizeError`. On success, the commit at HEAD has
 * been amended and force-pushed.
 */
export async function sanitizeFixCommit(opts: SanitizeOptions): Promise<SanitizeResult> {
  const { workspaceDir, branch, affectedModule, reproPath, log } = opts;

  const changes = await listTopCommitChanges(workspaceDir);
  log(`[sanitize] HEAD~1..HEAD touches ${changes.length} path(s)`);

  const droppedPaths: string[] = [];
  const retainedPaths: string[] = [];

  // Phase 1: full-file dispositions.
  for (const c of changes) {
    const verdict = classifyChange(c, affectedModule, reproPath);
    if (verdict === 'revert') {
      droppedPaths.push(c.path);
      log(`[sanitize] revert path=${c.path} status=${c.status} reason=out-of-scope`);
      if (c.status === 'A') {
        // New file added by the fix → simply remove from index + worktree.
        await runGit(workspaceDir, ['rm', '-f', '--quiet', c.path]);
      } else if (c.status === 'D') {
        // Fix deleted a file → restore it from HEAD~1.
        await runGit(workspaceDir, ['checkout', 'HEAD~1', '--', c.path]);
      } else if (c.status === 'R' || c.status === 'C') {
        // Restore both old and new paths to their HEAD~1 state.
        await runGit(workspaceDir, ['rm', '-f', '--quiet', c.path]);
        if (c.origPath) {
          await runGit(workspaceDir, ['checkout', 'HEAD~1', '--', c.origPath]);
        }
      } else {
        // M / T → restore from HEAD~1.
        await runGit(workspaceDir, ['checkout', 'HEAD~1', '--', c.path]);
      }
    } else {
      retainedPaths.push(c.path);
    }
  }

  // Phase 2: strip whitespace-only hunks from retained modifications.
  let wsHunksStripped = 0;
  for (const c of changes) {
    if (classifyChange(c, affectedModule, reproPath) !== 'keep') continue;
    if (c.status !== 'M' && c.status !== 'R' && c.status !== 'C') continue; // only modifications
    const diffResult = await runGit(workspaceDir, [
      'diff',
      '-U0',
      'HEAD~1',
      'HEAD',
      '--',
      c.path,
    ]);
    const fd = parseFileDiff(diffResult.stdout);
    if (!fd) continue;
    const { patch, count } = buildWsOnlyPatch(fd);
    if (count === 0) continue;
    log(`[sanitize] strip ws-only hunks path=${c.path} count=${count}`);
    // Apply the ws-only patch in reverse to the worktree (index gets updated below).
    await runGit(workspaceDir, ['apply', '--reverse', '--unidiff-zero', '--whitespace=nowarn'], patch);
    wsHunksStripped += count;
  }

  // Did anything change?
  if (droppedPaths.length === 0 && wsHunksStripped === 0) {
    log('[sanitize] no changes needed; commit untouched');
    return {
      droppedPaths,
      wsHunksStripped,
      retainedPaths,
      amended: false,
    };
  }

  // Stage everything (including deletions, ws-strip worktree changes).
  await runGit(workspaceDir, ['add', '-A']);

  // Verify there is still a diff vs HEAD~1; if not, the entire fix was noise.
  const remaining = await runGit(workspaceDir, ['diff', '--cached', '--name-only', 'HEAD~1']);
  if (!remaining.stdout.trim()) {
    throw new SanitizeError(
      'After sanitization no functional changes remain. The fix was entirely out-of-scope or whitespace-only.',
      'empty'
    );
  }

  // Amend the top commit.
  await runGit(workspaceDir, ['commit', '--amend', '--no-edit', '--allow-empty-message']);

  // Capture new SHA + old SHA for log.
  const newSha = (await runGit(workspaceDir, ['rev-parse', 'HEAD'])).stdout.trim();
  log(`[sanitize] amended commit -> ${newSha.slice(0, 8)}; pushing --force-with-lease to ${branch}`);

  // Force-push with lease.
  await runGit(workspaceDir, ['push', '--force-with-lease', 'origin', branch]);

  return {
    droppedPaths,
    wsHunksStripped,
    retainedPaths,
    amended: true,
  };
}
