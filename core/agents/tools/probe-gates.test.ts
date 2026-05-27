import { gateRequirePriorProbe, gateRequireRunReproSinceLastWrite } from './index';
import type { TranscriptEntry, ToolTier } from './types';

function entry(
  partial: Partial<TranscriptEntry> & Pick<TranscriptEntry, 'tool' | 'tier' | 'ok'>
): TranscriptEntry {
  return {
    turn: 1,
    args: {},
    result: {},
    startedAt: '2026-01-01T00:00:00Z',
    durationMs: 1,
    ...partial,
  };
}

const sandbox: ToolTier = 'sandbox';
const writeTier: ToolTier = 'write-test';

describe('gateRequirePriorProbe', () => {
  it('blocks write_test on an empty transcript', () => {
    const reason = gateRequirePriorProbe([]);
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/no successful import probe yet/);
    expect(reason).toMatch(/VERIFIED SANDBOX STATE/);
  });

  it('blocks write_test when only failed probes have happened', () => {
    const t = [
      entry({
        tool: 'run_python',
        tier: sandbox,
        ok: false,
        args: { snippet: 'from missing import thing' },
        result: { exitCode: 1, stderr: "ModuleNotFoundError: No module named 'missing'" },
      }),
      entry({
        tool: 'python_module_check',
        tier: sandbox,
        ok: true,
        args: { name: 'missing' },
        result: { importable: false, error: 'not found' },
      }),
    ];
    expect(gateRequirePriorProbe(t)).not.toBeNull();
  });

  it('blocks write_test when run_python had non-import success only (print(1))', () => {
    // The gate must NOT accept arbitrary successful run_python — only
    // import-shaped probes should credit the ledger.
    const t = [
      entry({
        tool: 'run_python',
        tier: sandbox,
        ok: true,
        args: { snippet: 'print(1)' },
        result: { exitCode: 0, stderr: '', stdout: '1' },
      }),
    ];
    expect(gateRequirePriorProbe(t)).not.toBeNull();
  });

  it('allows write_test after a successful import-shaped run_python probe', () => {
    const t = [
      entry({
        tool: 'run_python',
        tier: sandbox,
        ok: true,
        args: { snippet: 'from opentelemetry.trace import NonRecordingSpan' },
        result: { exitCode: 0, stderr: '', stdout: '' },
      }),
    ];
    expect(gateRequirePriorProbe(t)).toBeNull();
  });

  it('allows write_test after a successful python_module_check', () => {
    const t = [
      entry({
        tool: 'python_module_check',
        tier: sandbox,
        ok: true,
        args: { name: 'opentelemetry.trace' },
        result: { importable: true },
      }),
    ];
    expect(gateRequirePriorProbe(t)).toBeNull();
  });

  it('allows write_test after a run_python that imported successfully but the exercise raised the bug', () => {
    // verified-state.ts credits the import as importable when run_python
    // fails for non-import reasons. A strong "probe + exercise" snippet that
    // reaches the bug should satisfy the gate.
    const t = [
      entry({
        tool: 'run_python',
        tier: sandbox,
        ok: false,
        args: { snippet: 'from openinference.instrumentation.smolagents._wrappers import _StepWrapper\n_StepWrapper(None)._finalize_step_span()' },
        result: {
          exitCode: 1,
          stderr: "AttributeError: 'NoneType' object has no attribute 'tracer'",
        },
      }),
    ];
    expect(gateRequirePriorProbe(t)).toBeNull();
  });
});

describe('gateRequireRunReproSinceLastWrite', () => {
  it('allows revise_test on an empty transcript (no prior write)', () => {
    expect(gateRequireRunReproSinceLastWrite([])).toBeNull();
  });

  it('blocks revise_test when the last successful write was not followed by run_repro', () => {
    const t = [
      entry({
        tool: 'run_python',
        tier: sandbox,
        ok: true,
        args: { snippet: 'import x' },
        result: { exitCode: 0 },
      }),
      entry({
        tool: 'write_test',
        tier: writeTier,
        ok: true,
        args: { path: 'tests/a.py', content: '...' },
        result: { written: 'tests/a.py' },
      }),
    ];
    const reason = gateRequireRunReproSinceLastWrite(t);
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/have not run run_repro/);
  });

  it('allows revise_test once run_repro has happened since the last write', () => {
    const t = [
      entry({
        tool: 'write_test',
        tier: writeTier,
        ok: true,
        args: { path: 'tests/a.py', content: '...' },
        result: { written: 'tests/a.py' },
      }),
      entry({
        tool: 'run_repro',
        tier: sandbox,
        ok: true,
        args: {},
        result: { exitCode: 1, stderr: 'BOOM' },
      }),
    ];
    expect(gateRequireRunReproSinceLastWrite(t)).toBeNull();
  });

  it('re-blocks after revise_test until another run_repro', () => {
    const t = [
      entry({
        tool: 'write_test',
        tier: writeTier,
        ok: true,
        args: { path: 'tests/a.py', content: '...' },
        result: { written: 'tests/a.py' },
      }),
      entry({
        tool: 'run_repro',
        tier: sandbox,
        ok: true,
        args: {},
        result: { exitCode: 1, stderr: 'BOOM' },
      }),
      entry({
        tool: 'revise_test',
        tier: writeTier,
        ok: true,
        args: { path: 'tests/a.py', content: '...' },
        result: { revised: 'tests/a.py' },
      }),
    ];
    expect(gateRequireRunReproSinceLastWrite(t)).not.toBeNull();
  });

  it('blocks a SECOND write_test without an intervening run_repro', () => {
    // The write_test path also applies this gate (Commit B fix-up) so the
    // model cannot blind-loop write_test → write_test → write_test.
    const t = [
      entry({
        tool: 'write_test',
        tier: writeTier,
        ok: true,
        args: { path: 'tests/a.py', content: '...' },
        result: { written: 'tests/a.py' },
      }),
    ];
    expect(gateRequireRunReproSinceLastWrite(t)).not.toBeNull();
  });
});
