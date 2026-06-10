/**
 * Green-evidence audit rules:
 *  - After the last mutation, run_repro and run_tests must both have gone green.
 *  - A verify-only run (no mutations) counts green runs anywhere in the run,
 *    since the code state never changed (regression from openinference#62:
 *    iteration 2 re-verified an already-committed fix, ran everything green,
 *    and was scored "not verified" because no mutation preceded the runs).
 */

import { computeGreenEvidence } from './executor';

const green = { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
const red = { exitCode: 1, stdout: '', stderr: 'fail', durationMs: 1 };

describe('computeGreenEvidence', () => {
  it('is green when both runs pass after the last mutation', () => {
    const evidence = computeGreenEvidence([
      { turn: 1, tool: 'apply_patch', ok: true },
      { turn: 2, tool: 'run_repro', ok: true, result: green },
      { turn: 3, tool: 'run_tests', ok: true, result: green },
    ]);
    expect(evidence.lastMutationTurn).toBe(1);
    expect(evidence.reproGreenAfterMutation).toBe(true);
    expect(evidence.testsGreenAfterMutation).toBe(true);
  });

  it('ignores green runs that happened before the last mutation', () => {
    const evidence = computeGreenEvidence([
      { turn: 1, tool: 'run_repro', ok: true, result: green },
      { turn: 2, tool: 'run_tests', ok: true, result: green },
      { turn: 3, tool: 'apply_patch', ok: true },
    ]);
    expect(evidence.reproGreenAfterMutation).toBe(false);
    expect(evidence.testsGreenAfterMutation).toBe(false);
  });

  it('counts green runs in a verify-only run with no mutations', () => {
    const evidence = computeGreenEvidence([
      { turn: 1, tool: 'read_file', ok: true },
      { turn: 2, tool: 'run_repro', ok: true, result: green },
      { turn: 3, tool: 'run_tests', ok: true, result: green },
    ]);
    expect(evidence.lastMutationTurn).toBeNull();
    expect(evidence.reproGreenAfterMutation).toBe(true);
    expect(evidence.testsGreenAfterMutation).toBe(true);
  });

  it('is not green in a verify-only run whose runs failed', () => {
    const evidence = computeGreenEvidence([
      { turn: 1, tool: 'run_repro', ok: true, result: red },
      { turn: 2, tool: 'run_tests', ok: true, result: red },
    ]);
    expect(evidence.reproGreenAfterMutation).toBe(false);
    expect(evidence.testsGreenAfterMutation).toBe(false);
  });

  it('treats failed mutation attempts as non-mutations', () => {
    const evidence = computeGreenEvidence([
      { turn: 1, tool: 'run_repro', ok: true, result: green },
      { turn: 2, tool: 'run_tests', ok: true, result: green },
      { turn: 3, tool: 'apply_patch', ok: false },
    ]);
    // The failed patch changed nothing, so the earlier green runs still hold.
    expect(evidence.lastMutationTurn).toBeNull();
    expect(evidence.reproGreenAfterMutation).toBe(true);
    expect(evidence.testsGreenAfterMutation).toBe(true);
  });
});
