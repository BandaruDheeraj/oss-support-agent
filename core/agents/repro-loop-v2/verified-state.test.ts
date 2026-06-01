import type { TranscriptEntry, ToolTier } from '../tools/types';
import {
  deriveVerifiedState,
  renderVerifiedState,
  summariseVerifiedState,
} from './verified-state';

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

describe('deriveVerifiedState', () => {
  it('returns an empty-but-shaped state for an empty transcript', () => {
    const s = deriveVerifiedState([]);
    expect(s).toEqual({
      installsOK: [],
      installsFailed: [],
      importable: [],
      notImportable: [],
      runPythonSuccessCount: 0,
      runPythonFailureCount: 0,
      testCommittedPath: null,
      runReproCount: 0,
      runReproPassingCount: 0,
      runReproFailingCount: 0,
      runReproErrorCount: 0,
      runReproPositiveSinceWrite: 0,
      derivedSentinel: null,
    });
  });

  it('classifies pip_install by exitCode', () => {
    const s = deriveVerifiedState([
      entry({ tool: 'pip_install', tier: sandbox, ok: true,
        args: { spec: '-e python/foo' }, result: { exitCode: 0, stdout: '', stderr: '' } }),
      entry({ tool: 'pip_install', tier: sandbox, ok: true,
        args: { spec: 'smolagents' }, result: { exitCode: 1, stdout: '', stderr: 'ERROR: ...' } }),
    ]);
    expect(s.installsOK).toEqual(['-e python/foo']);
    expect(s.installsFailed).toEqual(['smolagents']);
  });

  it('records python_module_check positive results as importable', () => {
    const s = deriveVerifiedState([
      entry({ tool: 'python_module_check', tier: sandbox, ok: true,
        args: { name: 'opentelemetry.trace' }, result: { importable: true, version: '1.20.0' } }),
      entry({ tool: 'python_module_check', tier: sandbox, ok: true,
        args: { name: 'smolagents' }, result: { importable: false, error: 'No module named smolagents' } }),
    ]);
    expect(s.importable).toEqual(['opentelemetry.trace']);
    expect(s.notImportable).toEqual([
      { module: 'smolagents', reason: 'No module named smolagents' },
    ]);
  });

  it('prefers resolved module names from python_module_check results', () => {
    const s = deriveVerifiedState([
      entry({ tool: 'python_module_check', tier: sandbox, ok: true,
        args: { name: 'openinference-instrumentation-openai' },
        result: { importable: false, error: 'No module named openinference-instrumentation-openai' } }),
      entry({ tool: 'python_module_check', tier: sandbox, ok: true,
        args: { name: 'openinference-instrumentation-openai' },
        result: { importable: true, module: 'openinference.instrumentation.openai', version: '0.1.0' } }),
    ]);
    expect(s.importable).toContain('openinference.instrumentation.openai');
    expect(s.notImportable.map((n) => n.module)).not.toContain('openinference-instrumentation-openai');
  });

  it('infers importable modules from successful run_python "from X import Y" snippets', () => {
    const s = deriveVerifiedState([
      entry({ tool: 'run_python', tier: sandbox, ok: true,
        args: { snippet: 'from opentelemetry.trace import NonRecordingSpan\nprint("ok")' },
        result: { exitCode: 0, stdout: 'ok\n', stderr: '' } }),
      entry({ tool: 'run_python', tier: sandbox, ok: true,
        args: { snippet: 'import json' },
        result: { exitCode: 0, stdout: '', stderr: '' } }),
    ]);
    expect(s.importable).toEqual(['opentelemetry.trace', 'json']);
    expect(s.runPythonSuccessCount).toBe(2);
  });

  it('extracts the failing module name from run_python ModuleNotFoundError stderr', () => {
    const s = deriveVerifiedState([
      entry({ tool: 'run_python', tier: sandbox, ok: true,
        args: { snippet: 'from smolagents._wrappers import _StepWrapper' },
        result: { exitCode: 1, stdout: '', stderr: "Traceback (most recent call last):\n  ...\nModuleNotFoundError: No module named 'smolagents'" } }),
    ]);
    expect(s.runPythonFailureCount).toBe(1);
    expect(s.notImportable.map((n) => n.module)).toContain('smolagents');
  });

  it('credits the imported module when run_python fails for a NON-import reason', () => {
    // Strong probes that "import + exercise" the bug exit non-zero. The
    // import itself succeeded — the failure surfaced after import. Without
    // this credit, the gate would block write_test even though the model
    // has actually found a working repro skeleton.
    const s = deriveVerifiedState([
      entry({ tool: 'run_python', tier: sandbox, ok: false,
        args: { snippet: 'from openinference.instrumentation.smolagents._wrappers import _StepWrapper\n_StepWrapper(None)._finalize_step_span()' },
        result: { exitCode: 1, stdout: '',
          stderr: "Traceback (most recent call last):\n  ...\nAttributeError: 'NoneType' object has no attribute 'tracer'" } }),
    ]);
    expect(s.importable).toContain('openinference.instrumentation.smolagents._wrappers');
    expect(s.notImportable.map((n) => n.module)).not.toContain(
      'openinference.instrumentation.smolagents._wrappers'
    );
  });

  it('lets a later successful import promote a module out of not-importable', () => {
    const s = deriveVerifiedState([
      entry({ tool: 'python_module_check', tier: sandbox, ok: true,
        args: { name: 'openinference.instrumentation.smolagents' },
        result: { importable: false, error: 'not installed' } }),
      entry({ tool: 'pip_install', tier: sandbox, ok: true,
        args: { spec: '-e python/instrumentation/openinference-instrumentation-smolagents' },
        result: { exitCode: 0, stdout: '', stderr: '' } }),
      entry({ tool: 'run_python', tier: sandbox, ok: true,
        args: { snippet: 'from openinference.instrumentation.smolagents import _wrappers' },
        result: { exitCode: 0, stdout: '', stderr: '' } }),
    ]);
    expect(s.importable).toContain('openinference.instrumentation.smolagents');
    expect(s.notImportable.map((n) => n.module)).not.toContain('openinference.instrumentation.smolagents');
  });

  it('records the most recent write_test/revise_test path as testCommittedPath', () => {
    const s = deriveVerifiedState([
      entry({ tool: 'write_test', tier: writeTier, ok: true,
        args: { path: 'tests/test_repro.py', content: '...' },
        result: { written: 'tests/test_repro.py', bytes: 100 } }),
      entry({ tool: 'revise_test', tier: writeTier, ok: true,
        args: { path: 'tests/test_repro.py', content: '...' },
        result: { revised: 'tests/test_repro.py' } }),
    ]);
    expect(s.testCommittedPath).toBe('tests/test_repro.py');
  });

  it('counts successful run_repro calls', () => {
    const s = deriveVerifiedState([
      entry({ tool: 'run_repro', tier: sandbox, ok: true, result: { exitCode: 1 } }),
      entry({ tool: 'run_repro', tier: sandbox, ok: false, error: 'sandbox timeout' }),
      entry({ tool: 'run_repro', tier: sandbox, ok: true, result: { exitCode: 1 } }),
    ]);
    expect(s.runReproCount).toBe(2);
  });

  it('does not throw on malformed result shapes', () => {
    expect(() =>
      deriveVerifiedState([
        entry({ tool: 'pip_install', tier: sandbox, ok: true, args: {}, result: null }),
        entry({ tool: 'python_module_check', tier: sandbox, ok: true, args: { name: 'x' }, result: 'not-an-object' as unknown }),
        entry({ tool: 'run_python', tier: sandbox, ok: false, args: { snippet: 'oops' }, result: undefined }),
      ])
    ).not.toThrow();
  });

  it('classifies run_repro into passing/failing/errored by exitCode', () => {
    const s = deriveVerifiedState([
      entry({ tool: 'run_repro', tier: sandbox, ok: true, result: { exitCode: 0, stdout: 'ok', stderr: '' } }),
      entry({ tool: 'run_repro', tier: sandbox, ok: true, result: { exitCode: 1, stdout: '', stderr: 'AssertionError' } }),
      entry({ tool: 'run_repro', tier: sandbox, ok: false, error: 'sandbox timeout' }),
      entry({ tool: 'run_repro', tier: sandbox, ok: true, result: { exitCode: null as unknown as number, stdout: '', stderr: '' } }),
    ]);
    expect(s.runReproPassingCount).toBe(1);
    expect(s.runReproFailingCount).toBe(1);
    expect(s.runReproErrorCount).toBe(2);
    expect(s.runReproCount).toBe(2);
  });

  it('extracts sentinel from latest write_test/revise_test (double-quote)', () => {
    const s = deriveVerifiedState([
      entry({ tool: 'write_test', tier: writeTier, ok: true,
        args: { path: 'tests/t.py', content: 'def test_x():\n    assert False, "REPRO_46_NRS"\n' },
        result: { written: 'tests/t.py' } }),
    ]);
    expect(s.derivedSentinel).toBe('REPRO_46_NRS');
  });

  it('extracts sentinel from revise_test single-quote with trailing colon variant', () => {
    const s = deriveVerifiedState([
      entry({ tool: 'write_test', tier: writeTier, ok: true,
        args: { path: 'tests/t.py', content: 'def t():\n    assert False, "OLD_SENTINEL"\n' },
        result: { written: 'tests/t.py' } }),
      entry({ tool: 'revise_test', tier: writeTier, ok: true,
        args: { path: 'tests/t.py', content: "def t():\n    try:\n        f()\n    except Exception as e:\n        assert False, 'NEW_SENTINEL: ' + str(e)\n    else:\n        assert False, 'NEW_SENTINEL: expected'\n" },
        result: { revised: 'tests/t.py' } }),
    ]);
    expect(s.derivedSentinel).toBe('NEW_SENTINEL');
  });

  it('counts runReproPositiveSinceWrite only for runs after latest write with exit!=0 + sentinel', () => {
    const transcript: TranscriptEntry[] = [
      // Old test with old sentinel + 2 failing runs (should NOT count)
      entry({ tool: 'write_test', tier: writeTier, ok: true,
        args: { path: 'tests/t.py', content: 'assert False, "OLD"' },
        result: { written: 'tests/t.py' } }),
      entry({ tool: 'run_repro', tier: sandbox, ok: true,
        result: { exitCode: 1, stdout: '', stderr: 'OLD trace' } }),
      // Revise switches to new sentinel
      entry({ tool: 'revise_test', tier: writeTier, ok: true,
        args: { path: 'tests/t.py', content: 'assert False, "NEW_SENTINEL"' },
        result: { revised: 'tests/t.py' } }),
      // Passing run after revise (exit 0 -> not positive)
      entry({ tool: 'run_repro', tier: sandbox, ok: true,
        result: { exitCode: 0, stdout: 'NEW_SENTINEL', stderr: '' } }),
      // Failing without sentinel -> not positive
      entry({ tool: 'run_repro', tier: sandbox, ok: true,
        result: { exitCode: 1, stdout: '', stderr: 'unrelated error' } }),
      // Failing WITH sentinel -> positive (1)
      entry({ tool: 'run_repro', tier: sandbox, ok: true,
        result: { exitCode: 1, stdout: '', stderr: 'NEW_SENTINEL trace' } }),
      // Failing WITH sentinel in stdout -> positive (2)
      entry({ tool: 'run_repro', tier: sandbox, ok: true,
        result: { exitCode: 1, stdout: 'NEW_SENTINEL', stderr: '' } }),
    ];
    const s = deriveVerifiedState(transcript);
    expect(s.derivedSentinel).toBe('NEW_SENTINEL');
    expect(s.runReproPositiveSinceWrite).toBe(2);
  });

  it('honours explicit sentinel override in opts', () => {
    const s = deriveVerifiedState(
      [
        entry({ tool: 'write_test', tier: writeTier, ok: true,
          args: { path: 'tests/t.py', content: 'no_assert_here' },
          result: { written: 'tests/t.py' } }),
        entry({ tool: 'run_repro', tier: sandbox, ok: true,
          result: { exitCode: 1, stdout: '', stderr: 'MY_SENTINEL hit' } }),
      ],
      { sentinel: 'MY_SENTINEL' }
    );
    expect(s.derivedSentinel).toBe('MY_SENTINEL');
    expect(s.runReproPositiveSinceWrite).toBe(1);
  });

  it('positive count is 0 when no sentinel derivable', () => {
    const s = deriveVerifiedState([
      entry({ tool: 'write_test', tier: writeTier, ok: true,
        args: { path: 'tests/t.py', content: 'plain test, no assert False' },
        result: { written: 'tests/t.py' } }),
      entry({ tool: 'run_repro', tier: sandbox, ok: true,
        result: { exitCode: 1, stdout: '', stderr: 'failed' } }),
    ]);
    expect(s.derivedSentinel).toBeNull();
    expect(s.runReproPositiveSinceWrite).toBe(0);
  });
});

describe('renderVerifiedState', () => {
  it('includes the structural header and labelled rows', () => {
    const text = renderVerifiedState({
      installsOK: ['-e python/foo'],
      installsFailed: [],
      importable: ['opentelemetry.trace'],
      notImportable: [{ module: 'smolagents', reason: 'No module named smolagents' }],
      runPythonSuccessCount: 2,
      runPythonFailureCount: 1,
      testCommittedPath: null,
      runReproCount: 0,
      runReproPassingCount: 0,
      runReproFailingCount: 0,
      runReproErrorCount: 0,
      runReproPositiveSinceWrite: 0,
      derivedSentinel: null,
    });
    expect(text).toContain('VERIFIED SANDBOX STATE');
    expect(text).toContain('-e python/foo');
    expect(text).toContain('opentelemetry.trace');
    expect(text).toContain('smolagents');
    expect(text).toContain('Test file committed: no');
  });
});

describe('summariseVerifiedState', () => {
  it('produces a stable one-line grep-friendly summary', () => {
    const line = summariseVerifiedState({
      installsOK: ['-e a', '-e b'],
      installsFailed: ['c'],
      importable: ['x', 'y'],
      notImportable: [{ module: 'z', reason: 'r' }],
      runPythonSuccessCount: 4,
      runPythonFailureCount: 1,
      testCommittedPath: 'tests/test_repro.py',
      runReproCount: 2,
      runReproPassingCount: 0,
      runReproFailingCount: 2,
      runReproErrorCount: 0,
      runReproPositiveSinceWrite: 2,
      derivedSentinel: 'SENTINEL_X',
    });
    expect(line).toBe(
      'installs_ok=2 installs_failed=1 importable=2 not_importable=1 run_python_ok=4 run_python_err=1 test_committed=yes run_repro_ok=2 run_repro_failing=2 run_repro_passing=0 run_repro_errored=0 run_repro_positive_since_write=2'
    );
  });
});
