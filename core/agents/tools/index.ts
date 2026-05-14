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
    {
      budgets: defaultBudgets({ total: 40, perTier: { mutation: 0, 'write-test': 0, sandbox: 0 } }),
      maxTurns: 14,
      abandonGate: (transcript) => {
        const readCalls = transcript.filter((t) => t.tier === 'read' && t.ok).length;
        const usedSymbolSearch = transcript.some(
          (t) => t.ok && (t.tool === 'grep' || t.tool === 'find_symbol' || t.tool === 'find_callers'),
        );
        if (readCalls < 4) {
          return `abandon is forbidden before you have made at least 4 successful read-tier tool calls (you have ${readCalls}). Use gh_issue, grep, find_symbol, read_file to gather evidence first. record_evidence with low confidence is preferred over abandon.`;
        }
        if (!usedSymbolSearch) {
          return 'abandon is forbidden before you have searched for symbols. Call grep or find_symbol to locate the code referenced in the issue. record_evidence with low confidence is preferred over abandon.';
        }
        return null;
      },
    },
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
    {
      budgets: defaultBudgets({ total: 70, perTier: { mutation: 0 } }),
      maxTurns: 22,
      abandonGate: (transcript) => {
        const wroteTest = transcript.some(
          (t) => (t.tool === 'write_test' || t.tool === 'revise_test') && t.ok,
        );
        const ranRepro = transcript.filter((t) => t.tool === 'run_repro' && t.ok).length;
        if (!wroteTest) {
          return 'abandon is forbidden before you have authored a candidate test. Call write_test to create the candidate test file, then run_repro at least twice, before considering abandon.';
        }
        if (ranRepro < 2) {
          return `abandon is forbidden before you have run_repro at least twice (you have ${ranRepro}). Revise the test and run_repro again before considering abandon.`;
        }
        return null;
      },
    },
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
