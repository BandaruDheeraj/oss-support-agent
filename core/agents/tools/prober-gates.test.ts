/**
 * Unit tests for the Prober done-gate and the recipe-path scoping check
 * applied during record_evidence. These cover the three rubber-duck
 * blockers identified during Phase 2 design review:
 *   1. done-gate must reject hallucinated/malformed recipes (path mismatch,
 *      missing fields, < 2 failing run_repro with sentinel).
 *   2. record_evidence rejects a reproRecipe whose candidateTestPath would
 *      escape the workspace test roots, mirroring write_test's scoping.
 */

import { reproProberDoneGate, reproProberAbandonGate, reproProberRecordEvidenceGate } from './index';
import { recordEvidence } from './note-meta';
import { DossierStore } from '../analyst/dossier';
import type { TranscriptEntry, ToolContext } from './types';

function entry(partial: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    turn: partial.turn ?? 1,
    tool: partial.tool ?? 'note',
    tier: partial.tier ?? 'note',
    args: partial.args ?? {},
    result: partial.result ?? {},
    ok: partial.ok ?? true,
    startedAt: partial.startedAt ?? new Date().toISOString(),
    durationMs: partial.durationMs ?? 1,
  };
}

const VALID_RECIPE_ARGS = {
  reproRecipe: {
    candidateTestPath: 'tests/test_repro.py',
    testSource: 'def test_x():\n    raise RuntimeError("REPRO_SENTINEL")\n',
    sentinelString: 'REPRO_SENTINEL',
  },
};

describe('reproProberDoneGate', () => {
  it('blocks done when no record_evidence with recipe_recorded=true exists', () => {
    const reason = reproProberDoneGate([
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_repro.py', content: '...' } }),
    ]);
    expect(reason).not.toBeNull();
    expect(reason).toContain('have not yet emitted a ReproRecipe');
  });

  it('blocks done when record_evidence succeeded but recipe_recorded=false', () => {
    const reason = reproProberDoneGate([
      entry({ tool: 'record_evidence', args: { reproRecipe: VALID_RECIPE_ARGS.reproRecipe }, result: { snapshot_id: 'snap-1', recipe_recorded: false } }),
    ]);
    expect(reason).toContain('have not yet emitted a ReproRecipe');
  });

  it('blocks done when reproRecipe.candidateTestPath does not match any prior write', () => {
    const transcript: TranscriptEntry[] = [
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_other.py', content: '...' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'REPRO_SENTINEL' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'REPRO_SENTINEL' } }),
      entry({ tool: 'record_evidence', args: VALID_RECIPE_ARGS, result: { snapshot_id: 'snap-1', recipe_recorded: true } }),
    ];
    const reason = reproProberDoneGate(transcript);
    expect(reason).not.toBeNull();
    expect(reason).toContain('does not match the path of any prior successful write_test');
  });

  it('blocks done when fewer than two failing run_repro with sentinel are observed', () => {
    const transcript: TranscriptEntry[] = [
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_repro.py', content: '...' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'REPRO_SENTINEL' } }),
      entry({ tool: 'record_evidence', args: VALID_RECIPE_ARGS, result: { snapshot_id: 'snap-1', recipe_recorded: true } }),
    ];
    const reason = reproProberDoneGate(transcript);
    expect(reason).toContain('Observed only 1 such call');
  });

  it('blocks done when run_repro exitCode is 0 even with sentinel in output', () => {
    const transcript: TranscriptEntry[] = [
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_repro.py', content: '...' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 0, stdout: 'REPRO_SENTINEL', stderr: '' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 0, stdout: 'REPRO_SENTINEL', stderr: '' } }),
      entry({ tool: 'record_evidence', args: VALID_RECIPE_ARGS, result: { snapshot_id: 'snap-1', recipe_recorded: true } }),
    ];
    const reason = reproProberDoneGate(transcript);
    expect(reason).toContain('Observed only 0 such call');
  });

  it('blocks done when sentinel is missing from failing run_repro output', () => {
    const transcript: TranscriptEntry[] = [
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_repro.py', content: '...' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'AssertionError' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'AssertionError' } }),
      entry({ tool: 'record_evidence', args: VALID_RECIPE_ARGS, result: { snapshot_id: 'snap-1', recipe_recorded: true } }),
    ];
    expect(reproProberDoneGate(transcript)).toContain('Observed only 0 such call');
  });

  it('blocks done when reproRecipe is missing candidateTestPath or sentinelString', () => {
    const transcript: TranscriptEntry[] = [
      entry({
        tool: 'record_evidence',
        args: { reproRecipe: { testSource: '...' } },
        result: { snapshot_id: 'snap-1', recipe_recorded: true },
      }),
    ];
    expect(reproProberDoneGate(transcript)).toContain('missing candidateTestPath or sentinelString');
  });

  it('allows done with a structurally valid recipe and two failing run_repro calls', () => {
    const transcript: TranscriptEntry[] = [
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_repro.py', content: '...' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'REPRO_SENTINEL trace' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: 'REPRO_SENTINEL', stderr: '' } }),
      entry({ tool: 'record_evidence', args: VALID_RECIPE_ARGS, result: { snapshot_id: 'snap-1', recipe_recorded: true } }),
    ];
    expect(reproProberDoneGate(transcript)).toBeNull();
  });

  it('accepts a revise_test as the matching write', () => {
    const transcript: TranscriptEntry[] = [
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_repro.py', content: 'old' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 0, stdout: '', stderr: '' } }),
      entry({ tool: 'revise_test', tier: 'write-test', args: { path: 'tests/test_repro.py', content: 'new' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'REPRO_SENTINEL' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'REPRO_SENTINEL' } }),
      entry({ tool: 'record_evidence', args: VALID_RECIPE_ARGS, result: { snapshot_id: 'snap-1', recipe_recorded: true } }),
    ];
    expect(reproProberDoneGate(transcript)).toBeNull();
  });

  it('only counts run_repro calls after the matching write, not before', () => {
    const transcript: TranscriptEntry[] = [
      // Two failing runs against an OLD test file
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_old.py', content: '...' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'REPRO_SENTINEL' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'REPRO_SENTINEL' } }),
      // Switch to the recipe's path with no further runs
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_repro.py', content: '...' } }),
      entry({ tool: 'record_evidence', args: VALID_RECIPE_ARGS, result: { snapshot_id: 'snap-1', recipe_recorded: true } }),
    ];
    expect(reproProberDoneGate(transcript)).toContain('Observed only 0 such call');
  });
});

describe('reproProberRecordEvidenceGate', () => {
  it('blocks record_evidence when fewer than two qualifying failing run_repro observations exist', () => {
    const reason = reproProberRecordEvidenceGate([
      entry({
        tool: 'write_test',
        tier: 'write-test',
        args: { path: 'tests/test_repro.py', content: 'def test_x():\n    assert False, "REPRO_SENTINEL"\n' },
      }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'REPRO_SENTINEL' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'ModuleNotFoundError' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', ok: false, result: undefined }),
    ]);
    expect(reason).not.toBeNull();
    expect(reason).toContain('Observed 1');
    expect(reason).toContain('do not count');
  });

  it('blocks record_evidence when no sentinel can be derived from the latest test write', () => {
    const reason = reproProberRecordEvidenceGate([
      entry({
        tool: 'write_test',
        tier: 'write-test',
        args: { path: 'tests/test_repro.py', content: 'def test_x():\n    raise RuntimeError("boom")\n' },
      }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'boom' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'boom' } }),
    ]);
    expect(reason).not.toBeNull();
    expect(reason).toContain('no sentinel was derivable');
  });

  it('allows record_evidence after two qualifying failing run_repro observations', () => {
    const reason = reproProberRecordEvidenceGate([
      entry({
        tool: 'write_test',
        tier: 'write-test',
        args: { path: 'tests/test_repro.py', content: 'def test_x():\n    assert False, "REPRO_SENTINEL"\n' },
      }),
      entry({ tool: 'run_repro', tier: 'sandbox', ok: false, result: undefined }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'REPRO_SENTINEL' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: 'REPRO_SENTINEL', stderr: '' } }),
    ]);
    expect(reason).toBeNull();
  });
});

describe('reproProberAbandonGate', () => {
  it('blocks abandon before any test has been authored', () => {
    const reason = reproProberAbandonGate([
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: '' } }),
    ]);
    expect(reason).toContain('before you have authored a candidate test');
  });

  it('blocks abandon when fewer than 2 run_repro calls have been made', () => {
    const reason = reproProberAbandonGate([
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_repro.py', content: '...' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'REPRO_SENTINEL' } }),
    ]);
    expect(reason).toContain('run_repro at least twice');
  });

  it('allows abandon when test authored, ≥2 run_repro, no positive observation', () => {
    const reason = reproProberAbandonGate([
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_repro.py', content: 'assert False, "REPRO_SENTINEL"' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 0, stdout: '', stderr: '' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 0, stdout: '', stderr: '' } }),
    ]);
    expect(reason).toBeNull();
  });

  it('blocks abandon when 1 positive observation exists, directing to confirm + record_evidence', () => {
    const reason = reproProberAbandonGate([
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_repro.py', content: 'assert False, "REPRO_SENTINEL"' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 0, stdout: '', stderr: '' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'REPRO_SENTINEL trace' } }),
    ]);
    expect(reason).not.toBeNull();
    expect(reason).toContain('1 POSITIVE run_repro observation');
    expect(reason).toContain('Run run_repro once more');
  });

  it('blocks abandon when ≥2 positive observations exist, directing to record_evidence NOW', () => {
    const reason = reproProberAbandonGate([
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_repro.py', content: 'assert False, "REPRO_SENTINEL"' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'REPRO_SENTINEL' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: 'REPRO_SENTINEL', stderr: '' } }),
    ]);
    expect(reason).not.toBeNull();
    expect(reason).toContain('2 POSITIVE run_repro observation');
    expect(reason).toContain('NEXT tool call MUST be record_evidence');
  });

  it('triggers install-fatigue clause when ≥2 failed pip_install with no positive observation', () => {
    const reason = reproProberAbandonGate([
      entry({ tool: 'write_test', tier: 'write-test', args: { path: 'tests/test_repro.py', content: 'x' } }),
      entry({ tool: 'pip_install', tier: 'sandbox', ok: false, result: { exitCode: 1 } }),
      entry({ tool: 'pip_install', tier: 'sandbox', ok: false, result: { exitCode: 1 } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'ModuleNotFoundError' } }),
      entry({ tool: 'run_repro', tier: 'sandbox', result: { exitCode: 1, stdout: '', stderr: 'ModuleNotFoundError' } }),
    ]);
    expect(reason).toContain('Install-fatigue');
  });
});

function ctxFor(handles: Record<string, unknown>): ToolContext {
  return {
    agentName: 'REPRO_PROBER',
    attemptId: 'attempt-test',
    issueNumber: 99,
    handles,
    recordTranscript: () => undefined,
    getTranscript: () => [],
  };
}

function fakeWorkspace(roots: string[]) {
  return { testRoots: () => roots };
}

describe('record_evidence — reproRecipe path scoping', () => {
  it('accepts a recipe whose candidateTestPath is under a configured test root', async () => {
    const dossier = new DossierStore();
    const res = await recordEvidence.execute(
      {
        evidence: [],
        suspectSymbols: [],
        openQuestions: [],
        preconditions: [],
        summary: 'ok',
        confidence: 'medium',
        reproRecipe: {
          candidateTestPath: 'tests/test_repro.py',
          testSource: 'def test_x(): raise RuntimeError("S")',
          sentinelString: 'S',
        },
      } as any,
      ctxFor({ dossier, workspace: fakeWorkspace(['tests/']) }),
    );
    expect(res).toMatchObject({ recipe_recorded: true });
  });

  it('rejects a recipe whose candidateTestPath escapes via ".." segment', async () => {
    const dossier = new DossierStore();
    await expect(
      recordEvidence.execute(
        {
          evidence: [],
          suspectSymbols: [],
          openQuestions: [],
          preconditions: [],
          summary: 'ok',
          confidence: 'medium',
          reproRecipe: {
            candidateTestPath: 'tests/../src/foo.py',
            testSource: 'pwned',
            sentinelString: 'S',
          },
        } as any,
        ctxFor({ dossier, workspace: fakeWorkspace(['tests/']) }),
      ),
    ).rejects.toThrow(/reproRecipe\.candidateTestPath.*without "\.\."/);
  });

  it('rejects a recipe whose candidateTestPath is outside the test roots', async () => {
    const dossier = new DossierStore();
    await expect(
      recordEvidence.execute(
        {
          evidence: [],
          suspectSymbols: [],
          openQuestions: [],
          preconditions: [],
          summary: 'ok',
          confidence: 'medium',
          reproRecipe: {
            candidateTestPath: 'src/agent.py',
            testSource: 'pwned',
            sentinelString: 'S',
          },
        } as any,
        ctxFor({ dossier, workspace: fakeWorkspace(['tests/']) }),
      ),
    ).rejects.toThrow(/reproRecipe\.candidateTestPath.*under one of/);
  });

  it('rejects an absolute candidateTestPath', async () => {
    const dossier = new DossierStore();
    await expect(
      recordEvidence.execute(
        {
          evidence: [],
          suspectSymbols: [],
          openQuestions: [],
          preconditions: [],
          summary: 'ok',
          confidence: 'medium',
          reproRecipe: {
            candidateTestPath: '/etc/passwd',
            testSource: 'pwned',
            sentinelString: 'S',
          },
        } as any,
        ctxFor({ dossier, workspace: fakeWorkspace(['tests/']) }),
      ),
    ).rejects.toThrow(/reproRecipe\.candidateTestPath/);
  });

  it('skips scoping when no workspace handle is wired (back-compat for Analyst calls)', async () => {
    const dossier = new DossierStore();
    const res = await recordEvidence.execute(
      {
        evidence: [],
        suspectSymbols: [],
        openQuestions: [],
        preconditions: [],
        summary: 'ok',
        confidence: 'medium',
      } as any,
      ctxFor({ dossier }),
    );
    expect(res).toMatchObject({ recipe_recorded: false });
  });
});
