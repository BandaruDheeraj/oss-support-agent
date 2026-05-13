/**
 * v2 WorkspaceReader+Writer adapter over a LocalWorkspace (git checkout dir).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execCommand, LocalWorkspace } from '../../../bin/clients/local-workspace';
import type {
  WorkspaceReader,
  WorkspaceWriter,
  GrepMatch,
  GitLogEntry,
  GitBlameLine,
} from '../tools/handles';

export interface WorkspaceFsAdapterOptions {
  baselineRef?: string;
  testRoots?: string[];
  affectedModule: string;
  reproTestPath?: string;
}

const TEXT_FILE_MAX_BYTES = 2 * 1024 * 1024;

export function createWorkspaceFsAdapter(
  workspace: LocalWorkspace,
  opts: WorkspaceFsAdapterOptions
): WorkspaceReader & WorkspaceWriter {
  const baselineRef = opts.baselineRef ?? 'HEAD';
  const testRoots = opts.testRoots ?? ['tests/', 'test/'];
  const resolve = (rel: string): string => path.join(workspace.dir, rel);

  return {
    async readFile(rel) {
      try {
        const abs = resolve(rel);
        const stat = fs.statSync(abs);
        if (!stat.isFile()) return null;
        if (stat.size > TEXT_FILE_MAX_BYTES) {
          return `[file truncated: ${stat.size} bytes exceeds adapter limit ${TEXT_FILE_MAX_BYTES}]`;
        }
        return fs.readFileSync(abs, 'utf-8');
      } catch {
        return null;
      }
    },
    async listDir(rel) {
      try {
        const abs = resolve(rel);
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
      } catch {
        return [];
      }
    },
    async grep(pattern, paths, flags) {
      const grepArgs: string[] = ['-rHn', '--no-color'];
      if (flags?.caseInsensitive) grepArgs.push('-i');
      grepArgs.push('-E', pattern, '--');
      const targets = paths && paths.length > 0 ? paths : ['.'];
      for (const t of targets) grepArgs.push(t);
      const r = await execCommand('grep', grepArgs, workspace.dir, { timeoutMs: 30_000 });
      if (r.exitCode !== 0 && r.exitCode !== 1) {
        return [];
      }
      const matches: GrepMatch[] = [];
      for (const line of r.stdout.split('\n')) {
        const m = /^([^:]+):(\d+):(.*)$/.exec(line);
        if (m) {
          matches.push({ path: m[1], line: parseInt(m[2], 10), text: m[3] });
        }
      }
      return matches.slice(0, 500);
    },
    async readDiff() {
      const r = await execCommand('git', ['diff', baselineRef], workspace.dir, {
        timeoutMs: 30_000,
      });
      return r.stdout;
    },
    async gitLog(p, n) {
      const args = [
        'log',
        `-${Math.max(1, Math.min(n, 200))}`,
        '--pretty=format:%H%x09%an%x09%aI%x09%s',
        '--name-only',
      ];
      if (p) args.push('--', p);
      const r = await execCommand('git', args, workspace.dir, { timeoutMs: 30_000 });
      const entries: GitLogEntry[] = [];
      const blocks = r.stdout.split('\n\n');
      for (const block of blocks) {
        const lines = block.split('\n').filter((l) => l.length > 0);
        if (lines.length === 0) continue;
        const parts = lines[0].split('\t');
        const sha = parts[0];
        const author = parts[1] ?? '';
        const date = parts[2] ?? '';
        const message = parts.slice(3).join('\t');
        if (!sha) continue;
        const files = lines.slice(1);
        entries.push({ sha, author, date, message, files });
      }
      return entries;
    },
    async gitBlame(p, lineStart, lineEnd) {
      const args = ['blame', '--line-porcelain'];
      if (lineStart && lineEnd) args.push('-L', `${lineStart},${lineEnd}`);
      args.push('--', p);
      const r = await execCommand('git', args, workspace.dir, { timeoutMs: 30_000 });
      const lines: GitBlameLine[] = [];
      let cur: Partial<GitBlameLine> = {};
      let lineNo = lineStart ?? 1;
      for (const raw of r.stdout.split('\n')) {
        if (/^[0-9a-f]{40}/.test(raw)) {
          cur = { sha: raw.split(' ')[0] };
        } else if (raw.startsWith('author ')) {
          cur.author = raw.slice(7);
        } else if (raw.startsWith('author-time ')) {
          cur.date = new Date(parseInt(raw.slice(12), 10) * 1000).toISOString();
        } else if (raw.startsWith('\t')) {
          lines.push({
            sha: cur.sha ?? '',
            author: cur.author ?? '',
            date: cur.date ?? '',
            line: lineNo++,
            text: raw.slice(1),
          });
        }
      }
      return lines;
    },
    async changedFiles() {
      const r = await execCommand('git', ['diff', '--name-only', baselineRef], workspace.dir, {
        timeoutMs: 15_000,
      });
      return r.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    },

    async writeTest(rel, content) {
      if (!testRoots.some((root) => rel.startsWith(root))) {
        throw new Error(`writeTest path "${rel}" outside testRoots [${testRoots.join(', ')}]`);
      }
      workspace.writeFile(rel, content);
    },
    async applyPatch(patch) {
      const inModule = patch.path.startsWith(opts.affectedModule);
      const inTests = testRoots.some((root) => patch.path.startsWith(root));
      if (!inModule && !inTests) {
        throw new Error(
          `applyPatch path "${patch.path}" outside affectedModule "${opts.affectedModule}" and testRoots`
        );
      }
      if (opts.reproTestPath && patch.path === opts.reproTestPath) {
        throw new Error(`applyPatch refuses to modify repro test path "${opts.reproTestPath}"`);
      }
      const abs = resolve(patch.path);
      const current = fs.readFileSync(abs, 'utf-8');
      const idx = current.indexOf(patch.oldText);
      if (idx < 0) {
        throw new Error(`applyPatch oldText not found in ${patch.path}`);
      }
      const updated = current.slice(0, idx) + patch.newText + current.slice(idx + patch.oldText.length);
      fs.writeFileSync(abs, updated, 'utf-8');
      const patchId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      return { patchId };
    },
    async revertFile(rel) {
      await execCommand('git', ['checkout', baselineRef, '--', rel], workspace.dir, {
        timeoutMs: 15_000,
      });
    },
    testRoots() {
      return testRoots;
    },
    affectedModule() {
      return opts.affectedModule;
    },
    reproTestPath() {
      return opts.reproTestPath;
    },
  };
}
