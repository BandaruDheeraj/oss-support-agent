import { findUnaddressedPreconditions, shouldForceVerbatimIncompatible, type ReproPlan } from './planner';
import type { Precondition, SuspectSymbol } from '../analyst/dossier';
import type { IssueCodeSnippet } from './repro-hints';

function plan(steps: Array<{ id: string; intent: string; addressed?: string[] }>): ReproPlan {
  return {
    approach: 'test plan with enough characters to satisfy min(20)',
    candidateTestPath: 'tests/test_repro.py',
    sentinelString: 'SENTINEL-123',
    steps: steps.map((s) => ({
      stepId: s.id,
      intent: s.intent,
      toolHint: 'write_test',
      preconditionsAddressed: s.addressed ?? [],
    })),
    requiredEnv: [],
    expectedFailureSignature: 'AttributeError',
    verbatimSnippetIncompatible: false,
  };
}

function pc(id: string): Precondition {
  return {
    id,
    condition: `condition for ${id}`,
    kind: 'config_absence',
    evidenceRefs: [],
    satisfactionModes: [],
    threats: [],
  };
}

describe('findUnaddressedPreconditions', () => {
  it('returns nothing when there are no preconditions', () => {
    const p = plan([{ id: 's1', intent: 'do thing' }]);
    expect(findUnaddressedPreconditions(p, [])).toEqual([]);
  });

  it('returns preconditions not named in any step.preconditionsAddressed or intent', () => {
    const p = plan([{ id: 's1', intent: 'do thing', addressed: ['pc-0'] }]);
    const missed = findUnaddressedPreconditions(p, [pc('pc-0'), pc('pc-1')]);
    expect(missed.map((m) => m.id)).toEqual(['pc-1']);
  });

  it('accepts substring match in step.intent as addressing the precondition (fallback)', () => {
    const p = plan([{ id: 's1', intent: 'address pc-7 by direct call', addressed: [] }]);
    expect(findUnaddressedPreconditions(p, [pc('pc-7')])).toEqual([]);
  });

  it('flags all preconditions when none are addressed', () => {
    const p = plan([{ id: 's1', intent: 'do thing' }]);
    const missed = findUnaddressedPreconditions(p, [pc('pc-0'), pc('pc-1')]);
    expect(missed.map((m) => m.id)).toEqual(['pc-0', 'pc-1']);
  });
});

function snip(code: string, language = 'python'): IssueCodeSnippet {
  return { language, code };
}
function suspect(file: string, symbol = 'fn', reasoning = 'r'): SuspectSymbol {
  return { file, symbol, reasoning };
}

describe('shouldForceVerbatimIncompatible', () => {
  it('returns true when a snippet imports a heavy framework (snippet signal)', () => {
    expect(shouldForceVerbatimIncompatible([snip('from smolagents import CodeAgent')], [])).toBe(true);
  });

  it('returns false when snippets have no heavy framework imports and no other signals', () => {
    expect(shouldForceVerbatimIncompatible([snip('import json\nprint(1)')], [])).toBe(false);
  });

  it('returns true on prose-only issue body with framework name near "Install"', () => {
    const body = `### Reproduction\n1. Install openinference-instrumentation-smolagents\n2. Do not configure OTel\n`;
    expect(shouldForceVerbatimIncompatible([], [], body, [])).toBe(true);
  });

  it('returns true when issue body uses pip + heavy framework within window', () => {
    const body = `Run \`pip install langchain\` then call the agent.`;
    expect(shouldForceVerbatimIncompatible([], [], body, [])).toBe(true);
  });

  it('returns false on casual mention of langchain without install-adjacent token', () => {
    const body = `I am using langchain in my stack but the bug is in our own router code at the /api/foo endpoint. The traceback was about JSON serialization.`;
    expect(shouldForceVerbatimIncompatible([], [], body, [])).toBe(false);
  });

  it('normalises framework aliases (llama-index / llama_index / llamaindex)', () => {
    for (const alias of ['llama-index', 'llama_index', 'llamaindex']) {
      const body = `pip install ${alias} then run`;
      expect(shouldForceVerbatimIncompatible([], [], body, [])).toBe(true);
    }
  });

  it('returns true on dossier suspectSymbol path matching instrumentation-<framework>', () => {
    const ss = [
      suspect('python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py'),
    ];
    expect(shouldForceVerbatimIncompatible([], [], undefined, ss)).toBe(true);
  });

  it('returns true on dossier suspectSymbol path containing /<framework>/ segment', () => {
    const ss = [suspect('python/instrumentation/foo/src/openinference/instrumentation/autogen/wrappers.py')];
    expect(shouldForceVerbatimIncompatible([], [], undefined, ss)).toBe(true);
  });

  it('returns false on unrelated suspect paths and bland body', () => {
    const ss = [suspect('src/router/handler.py')];
    expect(shouldForceVerbatimIncompatible([], [], 'plain bug, no frameworks', ss)).toBe(false);
  });
});
