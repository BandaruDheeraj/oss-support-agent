/**
 * Write-test tier tools.
 *
 * Path-scoped: only paths under one of WorkspaceWriter.testRoots() are
 * accepted. Apparent escape attempts (`..`, absolute paths) are rejected.
 */

import { z } from 'zod';
import type { ToolDef } from './types';
import { asHandles } from './handles';

export function ensureTestRootScoped(path: string, roots: string[], label = 'write-test'): void {
  if (!path || path.includes('..') || path.startsWith('/') || path.match(/^[A-Za-z]:/)) {
    throw new Error(`${label} path "${path}" must be repo-relative without ".."`);
  }
  const norm = path.replace(/\\/g, '/');
  const inRoot = roots.some((r) => norm.startsWith(r.replace(/\\/g, '/')));
  if (!inRoot) {
    throw new Error(`${label} path "${path}" must be under one of: ${roots.join(', ')}`);
  }
}

function ensureScoped(path: string, roots: string[]): void {
  ensureTestRootScoped(path, roots, 'write-test');
}

const WriteTest = z
  .object({ path: z.string().min(1), content: z.string().min(1) })
  .strict();
export const writeTest: ToolDef<z.infer<typeof WriteTest>, unknown> = {
  name: 'write_test',
  tier: 'write-test',
  description:
    'Write a test file under one of the configured test roots. Used by the Repro Executor to commit the repro test, and by the Fix Executor to extend coverage.',
  parameters: WriteTest,
  async execute({ path, content }, ctx) {
    const ws = asHandles(ctx.handles).workspace;
    ensureScoped(path, ws.testRoots());
    await ws.writeTest(path, content);
    return { written: path, bytes: Buffer.byteLength(content, 'utf8') };
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
    return { revised: path };
  },
};

export const WRITE_TEST_TOOLS = [writeTest, reviseTest] as const;
