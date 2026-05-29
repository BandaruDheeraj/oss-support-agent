/**
 * Regression tests for the Prober auto-set of sandbox.reproTestPath when
 * write_test/revise_test is invoked. Without this auto-set, the Prober's
 * subsequent run_repro calls return exit=2 "reproTestPath not configured"
 * because setReproTestPath is otherwise only called by the Builder /
 * deterministic Executor — neither runs in the Prober no-candidate path.
 *
 * Observed on BandaruDheeraj/openinference#46 (1780011639965-repro): 13
 * run_repro calls all errored with exit=null, gating the abandon path and
 * trapping the loop until the turn budget was exhausted.
 */

import { writeTest, reviseTest } from './write-test';
import type { ToolContext } from './types';

function makeWorkspace() {
  return {
    writes: [] as Array<{ path: string; content: string }>,
    writeTest(p: string, c: string) {
      this.writes.push({ path: p, content: c });
      return Promise.resolve();
    },
    testRoots() {
      return ['tests/'];
    },
  };
}

function makeSandbox() {
  return {
    setCalls: [] as string[],
    setReproTestPath(p: string) {
      this.setCalls.push(p);
    },
  };
}

function ctxFor(
  agentName: string,
  workspace: ReturnType<typeof makeWorkspace>,
  sandbox?: ReturnType<typeof makeSandbox>,
): ToolContext {
  const handles: Record<string, unknown> = { workspace };
  if (sandbox) handles.sandbox = sandbox;
  return {
    agentName,
    attemptId: 'attempt-test',
    issueNumber: 99,
    handles,
    recordTranscript: () => undefined,
    getTranscript: () => [],
  };
}

describe('write_test / revise_test — auto-set repro test path for Prober', () => {
  it('write_test sets sandbox.reproTestPath when agent is REPRO_PROBER', async () => {
    const ws = makeWorkspace();
    const sandbox = makeSandbox();
    await writeTest.execute(
      { path: 'tests/test_repro_x.py', content: '# test' },
      ctxFor('REPRO_PROBER', ws, sandbox),
    );
    expect(ws.writes).toEqual([{ path: 'tests/test_repro_x.py', content: '# test' }]);
    expect(sandbox.setCalls).toEqual(['tests/test_repro_x.py']);
  });

  it('revise_test also updates sandbox.reproTestPath for REPRO_PROBER', async () => {
    const ws = makeWorkspace();
    const sandbox = makeSandbox();
    await reviseTest.execute(
      { path: 'tests/test_repro_y.py', content: '# v2' },
      ctxFor('REPRO_PROBER', ws, sandbox),
    );
    expect(sandbox.setCalls).toEqual(['tests/test_repro_y.py']);
  });

  it('does NOT call setReproTestPath for non-Prober agents (Fix Executor coverage)', async () => {
    const ws = makeWorkspace();
    const sandbox = makeSandbox();
    await writeTest.execute(
      { path: 'tests/test_more_coverage.py', content: '# extra' },
      ctxFor('FIX_EXECUTOR', ws, sandbox),
    );
    expect(ws.writes).toHaveLength(1);
    expect(sandbox.setCalls).toEqual([]);
  });

  it('is safe when no sandbox handle is registered (Repro Planner path)', async () => {
    const ws = makeWorkspace();
    await expect(
      writeTest.execute(
        { path: 'tests/test_only_ws.py', content: '# nosbx' },
        ctxFor('REPRO_PROBER', ws),
      ),
    ).resolves.toEqual({ written: 'tests/test_only_ws.py', bytes: 7 });
  });

  it('updates reproTestPath each time the Prober revises to a new path', async () => {
    const ws = makeWorkspace();
    const sandbox = makeSandbox();
    const ctx = ctxFor('REPRO_PROBER', ws, sandbox);
    await writeTest.execute({ path: 'tests/test_a.py', content: '# a' }, ctx);
    await reviseTest.execute({ path: 'tests/test_b.py', content: '# b' }, ctx);
    expect(sandbox.setCalls).toEqual(['tests/test_a.py', 'tests/test_b.py']);
  });
});
