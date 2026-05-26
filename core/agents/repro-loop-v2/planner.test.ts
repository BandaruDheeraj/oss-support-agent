import { findUnaddressedPreconditions, type ReproPlan } from './planner';
import type { Precondition } from '../analyst/dossier';

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
