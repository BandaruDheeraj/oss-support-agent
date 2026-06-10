import { z } from 'zod';
import { ToolRegistry } from './registry';
import type { ToolDef } from './types';

function makeRegistry(opts: ConstructorParameters<typeof ToolRegistry>[0]) {
  return new ToolRegistry(opts, {
    agentName: 'TEST',
    attemptId: 'attempt-1',
    issueNumber: 46,
    handles: {},
  });
}

describe('ToolRegistry budget governors', () => {
  test('enforces per-tool caps to prevent call loops', async () => {
    const registry = makeRegistry({
      budgets: {
        total: 10,
        perTier: { read: 10, note: 10, 'write-test': 0, mutation: 0, sandbox: 0, meta: 0 },
      },
      maxTurns: 10,
      perToolCaps: { ping: 1 },
    });

    const pingSchema = z.object({}).strict();
    const ping: ToolDef<z.infer<typeof pingSchema>, { ok: boolean }> = {
      name: 'ping',
      tier: 'read',
      description: 'test tool',
      parameters: pingSchema,
      execute: async () => ({ ok: true }),
    };
    registry.register(ping);

    registry.beginTurn();
    const first = await registry.dispatch(ping, {});
    expect((first as any).ok).toBe(true);

    registry.beginTurn();
    const second = await registry.dispatch(ping, {});
    expect((second as any).__kind).toBe('budget_exhausted');
    expect((second as any).__toolError).toContain('Tool "ping" budget exhausted');
  });

  test('reserves final calls for explicit finalization tools', async () => {
    const registry = makeRegistry({
      budgets: {
        total: 4,
        perTier: { read: 10, note: 10, 'write-test': 0, mutation: 0, sandbox: 0, meta: 0 },
      },
      maxTurns: 10,
      finalizationReserve: { calls: 2, allowTools: ['record_evidence', 'abandon'] },
    });

    const noArgs = z.object({}).strict();
    const readProbe: ToolDef<z.infer<typeof noArgs>, { ok: boolean }> = {
      name: 'probe',
      tier: 'read',
      description: 'read probe',
      parameters: noArgs,
      execute: async () => ({ ok: true }),
    };
    const finalize: ToolDef<z.infer<typeof noArgs>, { ok: boolean }> = {
      name: 'record_evidence',
      tier: 'note',
      description: 'finalize',
      parameters: noArgs,
      execute: async () => ({ ok: true }),
    };
    registry.registerMany([readProbe, finalize]);

    registry.beginTurn();
    await registry.dispatch(readProbe, {});
    registry.beginTurn();
    await registry.dispatch(readProbe, {});

    registry.beginTurn();
    const blocked = await registry.dispatch(readProbe, {});
    expect((blocked as any).__kind).toBe('budget_exhausted');
    expect((blocked as any).__toolError).toContain('Finalization reserve active');

    registry.beginTurn();
    const allowed = await registry.dispatch(finalize, {});
    expect((allowed as any).ok).toBe(true);
  });
});

describe('ToolRegistry execution-error handling', () => {
  // Regression: openinference#62 — tool implementation errors (applyPatch
  // anchor mismatch, write_test path rejection, commitAndPush no-changes)
  // were re-thrown, which propagates through generateText and kills the
  // entire agent run. The model never saw the error and repeated the same
  // call every retry iteration. Execution errors must come back as tool
  // results the model can read and react to.
  test('returns thrown execution errors as a tool result instead of rethrowing', async () => {
    const registry = makeRegistry({
      budgets: {
        total: 10,
        perTier: { read: 10, note: 10, 'write-test': 10, mutation: 10, sandbox: 10, meta: 10 },
      },
      maxTurns: 10,
    });

    const noArgs = z.object({}).strict();
    const boom: ToolDef<z.infer<typeof noArgs>, { ok: boolean }> = {
      name: 'boom',
      tier: 'write-test',
      description: 'always throws',
      parameters: noArgs,
      execute: async () => {
        throw new Error('write-test path "pkg/tests/x.py" must be under one of: tests/');
      },
    };
    registry.register(boom);

    registry.beginTurn();
    const result = await registry.dispatch(boom, {});
    expect((result as any).__kind).toBe('execution_error');
    expect((result as any).__toolError).toContain('must be under one of');

    // The failure is recorded in the transcript with ok=false so audits
    // (changed files, green evidence) ignore it.
    const entry = registry.getTranscript().find((e) => e.tool === 'boom');
    expect(entry?.ok).toBe(false);
    expect(entry?.error).toContain('must be under one of');

    // The registry is not terminated — the loop continues.
    expect(registry.isTerminated()).toBeNull();
  });
});
