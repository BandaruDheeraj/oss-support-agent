/**
 * Tool registry composition factories per agent role.
 *
 * Each factory returns a fresh ToolRegistry with the right tier of tools
 * registered and budgets sized for that agent.
 */

import { ToolRegistry } from './registry';
import { READ_TOOLS } from './read';
import { NOTE_META_TOOLS, note, stateHypothesis, recordEvidence, writeInvestigationNotes, commitPlan, revisePlan, deepenInvestigation, done, abandon } from './note-meta';
import { WRITE_TEST_TOOLS } from './write-test';
import { MUTATION_TOOLS } from './mutation';
import { SANDBOX_TOOLS } from './sandbox';
import type { ToolContext, RegistryBudgets } from './types';

export interface RegistryFactoryArgs {
  ctx: Omit<ToolContext, 'recordTranscript' | 'getTranscript'>;
}

function defaultBudgets(overrides: Partial<RegistryBudgets> = {}): RegistryBudgets {
  return {
    total: overrides.total ?? 80,
    perTier: {
      read: 60,
      note: 20,
      'write-test': 6,
      mutation: 10,
      sandbox: 12,
      meta: 8,
      ...overrides.perTier,
    },
  };
}

export function makeAnalystRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    { budgets: defaultBudgets({ total: 40, perTier: { mutation: 0, 'write-test': 0, sandbox: 0 } }), maxTurns: 14 },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, recordEvidence, abandon]);
}

export function makeFixInvestigatorRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    { budgets: defaultBudgets({ total: 50, perTier: { mutation: 0, 'write-test': 0, sandbox: 0 } }), maxTurns: 18 },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, stateHypothesis, writeInvestigationNotes, abandon]);
}

export function makeFixPlannerRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    { budgets: defaultBudgets({ total: 35, perTier: { mutation: 0, 'write-test': 0, sandbox: 0 } }), maxTurns: 10 },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, commitPlan, abandon]);
}

export function makeFixExecutorRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    { budgets: defaultBudgets({ total: 120 }), maxTurns: 30 },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([...NOTE_META_TOOLS])
    .registerMany([...WRITE_TEST_TOOLS])
    .registerMany([...MUTATION_TOOLS])
    .registerMany([...SANDBOX_TOOLS]);
}

export function makeFixCriticRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    { budgets: defaultBudgets({ total: 40, perTier: { mutation: 0, 'write-test': 0 } }), maxTurns: 12 },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, abandon])
    .registerMany([...SANDBOX_TOOLS]);
}

export function makeReproPlannerRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    { budgets: defaultBudgets({ total: 30, perTier: { mutation: 0, 'write-test': 0, sandbox: 0 } }), maxTurns: 8 },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, abandon]);
}

export function makeReproExecutorRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    { budgets: defaultBudgets({ total: 70, perTier: { mutation: 0 } }), maxTurns: 22 },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, deepenInvestigation, done, abandon])
    .registerMany([...WRITE_TEST_TOOLS])
    .registerMany([...SANDBOX_TOOLS]);
}

export function makeReproCriticRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    { budgets: defaultBudgets({ total: 25, perTier: { mutation: 0, 'write-test': 0 } }), maxTurns: 8 },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, abandon])
    .registerMany([...SANDBOX_TOOLS]);
}

export * from './types';
export * from './handles';
export { ToolRegistry } from './registry';
export { READ_TOOLS, NOTE_META_TOOLS, WRITE_TEST_TOOLS, MUTATION_TOOLS, SANDBOX_TOOLS };
