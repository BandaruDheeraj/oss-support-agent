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
