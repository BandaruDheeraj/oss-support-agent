/**
 * Write-test tier tools.
 *
 * Path-scoped: only paths under one of WorkspaceWriter.testRoots() are
 * accepted. Apparent escape attempts (`..`, absolute paths) are rejected.
 */

import { z } from 'zod';
import type { ToolContext, ToolDef } from './types';
import { asHandles } from './handles';

/**
 * When the Prober (REPRO_PROBER) authors or revises its candidate repro
 * test, automatically point the sandbox's `run_repro` at that path. Without
 * this, run_repro returns exit=2 ("reproTestPath not configured") because
 * setReproTestPath is otherwise only called by the Builder / deterministic
 * Executor — neither of which runs in the Prober's no-candidate path.
 *
 * Scoped to the Prober so the Fix Executor's coverage-extending write_test
 * calls don't clobber an already-set canonical repro path.
 */
function maybeAutoSetReproTestPath(ctx: ToolContext, path: string): void {
  if (ctx.agentName !== 'REPRO_PROBER') return;
  const handles = ctx.handles as Record<string, unknown>;
  const sandbox = handles?.sandbox as { setReproTestPath?: (p: string) => void } | undefined;
  if (sandbox && typeof sandbox.setReproTestPath === 'function') {
    sandbox.setReproTestPath(path);
  }
}

export function ensureTestRootScoped(path: string, roots: string[], label = 'write-test'): void {
  if (!path || path.includes('..') || path.startsWith('/') || path.match(/^[A-Za-z]:/)) {
    throw new Error(`${label} path "${path}" must be repo-relative without ".."`);
  }
  const norm = path.replace(/\\/g, '/');
  const inRoot = roots.some((r) => norm.startsWith(r.replace(/\\/g, '/')));
  // Also allow package-local test directories (e.g. python/pkg/tests/), matching
  // the workspace adapter's writeTest rule — monorepos keep tests per-package.
  const isNestedTestDir =
    norm.includes('/tests/') || norm.includes('/test/') || norm.startsWith('tests/') || norm.startsWith('test/');
  if (!inRoot && !isNestedTestDir) {
    throw new Error(
      `${label} path "${path}" must be under one of: ${roots.join(', ')}, or a nested tests/ directory`
    );
  }
}

function ensureScoped(path: string, roots: string[]): void {
  ensureTestRootScoped(path, roots, 'write-test');
}

const WriteTest = z
  .object({
    path: z.string().min(1),
    content: z.string().min(1),
    append: z.boolean().optional(),
  })
  .strict();
export const writeTest: ToolDef<z.infer<typeof WriteTest>, unknown> = {
  name: 'write_test',
  tier: 'write-test',
  description:
    'Write a test file under one of the configured test roots. Used by the Repro Executor to commit the repro test, and by the Fix Executor to extend coverage. Set append=true to append to an existing file instead of overwriting it.',
  parameters: WriteTest,
  async execute({ path, content, append }, ctx) {
    const ws = asHandles(ctx.handles).workspace;
    ensureScoped(path, ws.testRoots());
    let finalContent = content;
    if (append) {
      let existing: string | null = null;
      try {
        existing = await ws.readFile(path);
      } catch {
        // file does not exist yet — treat as empty
        existing = null;
      }
      if (existing !== null) {
        finalContent = existing + '\n' + content;
      }
    }
    await ws.writeTest(path, finalContent);
    maybeAutoSetReproTestPath(ctx, path);
    return { written: path, bytes: Buffer.byteLength(finalContent, 'utf8'), appended: append };
  },
};

const ReviseTest = WriteTest;
export const reviseTest: ToolDef<z.infer<typeof ReviseTest>, unknown> = {
  name: 'revise_test',
  tier: 'write-test',
  description: 'Overwrite an existing test file (same path scoping as write_test).',
  parameters: ReviseTest,
  async execute({ path, content }, ctx) {
    const ws = asHandles(ctx.handles).workspace;
    ensureScoped(path, ws.testRoots());
    await ws.writeTest(path, content);
    maybeAutoSetReproTestPath(ctx, path);
    return { revised: path };
  },
};

export const WRITE_TEST_TOOLS = [writeTest, reviseTest] as const;
