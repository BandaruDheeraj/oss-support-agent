import { runReproBuilder } from './builder';
import type { ReproBuilderArgs } from './builder';
import type { DossierSnapshot } from '../analyst/dossier';
import type { CandidateRepro } from '../analyst/candidate-repro';
import type {
  RepoHandle,
  SandboxHandle,
  SandboxRun,
  WorkspaceReader,
  WorkspaceWriter,
} from '../tools/handles';

const SENTINEL = 'BUILDER_TEST_SENTINEL_42';

function snap(overrides: Partial<DossierSnapshot['body']> = {}, candidate?: Partial<CandidateRepro>): DossierSnapshot {
  const baseCandidate: CandidateRepro = {
    version: 1,
    source: 'direct_call',
    failureMode: 'unexpected_exception',
    candidateTestPath: 'tests/test_repro_46.py',
    imports: ['import json'],
    setup: 'finalize = lambda: None',
    exerciseCall: 'finalize()',
    sentinel: SENTINEL,
    pipInstalls: [],
    requiresCredentials: [],
    preconditionsSatisfied: [],
    rationale: '',
  };
  return {
    snapshotId: 'snap-1',
    createdAt: '2025-01-01T00:00:00.000Z',
    body: {
      issueNumber: 46,
      attemptId: 'a1',
      parentSnapshotId: null,
      evidence: [],
      suspectSymbols: [{ file: 'src/foo.py', symbol: 'finalize', reasoning: 'why' }],
      preconditions: [],
      openQuestions: [],
      summary: 's',
      confidence: 'medium',
      candidateRepro: { ...baseCandidate, ...(candidate ?? {}) },
      ...overrides,
    },
  };
}

function mkRun(opts: Partial<SandboxRun> & { stdout?: string; stderr?: string } = {}): SandboxRun {
  return {
    exitCode: opts.exitCode ?? 0,
    stdout: opts.stdout ?? '',
    stderr: opts.stderr ?? '',
    durationMs: opts.durationMs ?? 1,
  };
}

class FakeWorkspace implements WorkspaceWriter, WorkspaceReader {
  writes: { path: string; content: string }[] = [];
  reverts: string[] = [];
  writeShouldThrow = false;

  // WorkspaceReader
  readFile(): Promise<string | null> {
    return Promise.resolve(null);
  }
  listDir(): Promise<{ name: string; isDir: boolean }[]> {
    return Promise.resolve([]);
  }
  grep(): Promise<never[]> {
    return Promise.resolve([]);
  }
  readDiff(): Promise<string> {
    return Promise.resolve('');
  }
  gitLog(): Promise<never[]> {
    return Promise.resolve([]);
  }
  gitBlame(): Promise<never[]> {
    return Promise.resolve([]);
  }
  changedFiles(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // WorkspaceWriter
  async writeTest(path: string, content: string): Promise<void> {
    if (this.writeShouldThrow) throw new Error('disk full');
    this.writes.push({ path, content });
  }
  applyPatch(): Promise<{ patchId: string }> {
    return Promise.resolve({ patchId: 'p1' });
  }
  async revertFile(path: string): Promise<void> {
    this.reverts.push(path);
  }
  testRoots(): string[] {
    return ['tests'];
  }
  affectedModule(): string {
    return 'mod';
  }
  reproTestPath(): string | undefined {
    return undefined;
  }
}

interface SandboxScript {
  pipInstall?: SandboxRun[];
  runPython?: SandboxRun[];
  runRepro?: SandboxRun[];
}

class FakeSandbox implements SandboxHandle {
  pipCalls: string[] = [];
  pythonCalls: string[] = [];
  reproPath?: string;
  reproCalls = 0;
  constructor(private script: SandboxScript = {}) {}

  setReproTestPath(p: string): void {
    this.reproPath = p;
  }
  async runRepro(): Promise<SandboxRun> {
    const idx = this.reproCalls++;
    const r = this.script.runRepro?.[idx];
    if (!r) throw new Error(`unscripted runRepro #${idx}`);
    return r;
  }
  runTests(): Promise<SandboxRun> {
    throw new Error('nyi');
  }
  async runPython(snippet: string): Promise<SandboxRun> {
    this.pythonCalls.push(snippet);
    const idx = this.pythonCalls.length - 1;
    const r = this.script.runPython?.[idx];
    if (!r) return mkRun({ stdout: 'BUILDER_IMPORT_OK\n', exitCode: 0 });
    return r;
  }
  async pipInstall(spec: string): Promise<SandboxRun> {
    this.pipCalls.push(spec);
    const idx = this.pipCalls.length - 1;
    const r = this.script.pipInstall?.[idx];
    if (!r) return mkRun({ exitCode: 0 });
    return r;
  }
  pythonModuleCheck(): Promise<{ importable: boolean }> {
    return Promise.resolve({ importable: true });
  }
  listPackages(): Promise<{ name: string; version: string }[]> {
    return Promise.resolve([]);
  }
}

function mkArgs(
  dossier: DossierSnapshot,
  script: SandboxScript = {},
  env: NodeJS.ProcessEnv = {}
): ReproBuilderArgs & { workspace: FakeWorkspace; sandbox: FakeSandbox } {
  const repo: RepoHandle = {
    fullName: 'foo/bar',
    forkFullName: 'agent/bar',
    branch: 'main',
    baselineSha: 'sha',
    affectedModule: 'mod',
    language: 'python',
  };
  const workspace = new FakeWorkspace();
  const sandbox = new FakeSandbox(script);
  return {
    attemptId: 'a1',
    dossierSnapshot: dossier,
    repo,
    workspace,
    sandbox,
    env,
  };
}

describe('runReproBuilder', () => {
  it('returns no_candidate when dossier has none', async () => {
    const d = snap();
    delete (d.body as { candidateRepro?: unknown }).candidateRepro;
    const args = mkArgs(d);
    const out = await runReproBuilder(args);
    expect(out.ok).toBe(false);
    expect(out.rejectStage).toBe('no_candidate');
  });

  it('rejects on missing credentials', async () => {
    const d = snap({}, { requiresCredentials: ['OPENAI_API_KEY'] });
    const args = mkArgs(d, {}, {});
    const out = await runReproBuilder(args);
    expect(out.ok).toBe(false);
    expect(out.missingCredentials).toEqual(['OPENAI_API_KEY']);
  });

  it('rejects unknown precondition id', async () => {
    const d = snap({ preconditions: [] }, { preconditionsSatisfied: ['pc-missing'] });
    const args = mkArgs(d);
    const out = await runReproBuilder(args);
    expect(out.rejectStage).toBe('precondition_unknown');
  });

  it('rejects when no suspect symbol referenced', async () => {
    const d = snap({}, { setup: 'x = 1', exerciseCall: 'x.attr()' });
    const args = mkArgs(d);
    const out = await runReproBuilder(args);
    expect(out.rejectStage).toBe('symbol_not_referenced');
  });

  it('rejects on path outside test roots', async () => {
    const d = snap({}, { candidateTestPath: '../escape.py' });
    const args = mkArgs(d);
    const out = await runReproBuilder(args);
    expect(out.rejectStage).toBe('path_invalid');
  });

  it('rejects on unsafe import (static check)', async () => {
    const d = snap({}, { imports: ['import os; os.system("rm -rf /")'] });
    const args = mkArgs(d);
    const out = await runReproBuilder(args);
    expect(out.rejectStage).toBe('import_unsafe_static');
  });

  it('rejects on pip install failure', async () => {
    const d = snap({}, { pipInstalls: [{ package: 'badpkg==99', editable: false }] });
    const args = mkArgs(d, { pipInstall: [mkRun({ exitCode: 1, stderr: 'no match' })] });
    const out = await runReproBuilder(args);
    expect(out.rejectStage).toBe('pip_install_failed');
    expect(out.pipInstallFailure?.spec).toBe('badpkg==99');
    expect(args.sandbox.pipCalls).toEqual(['badpkg==99']);
  });

  it('renders -e prefix for editable installs', async () => {
    const d = snap({}, { pipInstalls: [{ package: 'python/openinference-instrumentation-smolagents', editable: true }] });
    const args = mkArgs(d, {
      pipInstall: [mkRun({ exitCode: 0 })],
      runRepro: [
        mkRun({ exitCode: 1, stderr: SENTINEL }),
        mkRun({ exitCode: 1, stderr: SENTINEL }),
      ],
    });
    await runReproBuilder(args);
    expect(args.sandbox.pipCalls).toEqual(['-e python/openinference-instrumentation-smolagents']);
  });

  it('rejects when import probe fails in sandbox', async () => {
    const d = snap({}, { imports: ['from x import y'] });
    // first runPython is the import probe — make it fail
    const args = mkArgs(d, {
      runPython: [mkRun({ exitCode: 1, stderr: 'SyntaxError' })],
    });
    const out = await runReproBuilder(args);
    expect(out.rejectStage).toBe('import_ast_parse_failed');
  });

  it('builds a recipe on a successful 2/2 sentinel run', async () => {
    const d = snap();
    const args = mkArgs(d, {
      runRepro: [
        mkRun({ exitCode: 1, stderr: `boom ${SENTINEL}`, durationMs: 12 }),
        mkRun({ exitCode: 1, stderr: `boom ${SENTINEL}`, durationMs: 14 }),
      ],
    });
    const out = await runReproBuilder(args);
    expect(out.ok).toBe(true);
    expect(out.recipe).toBeDefined();
    expect(out.recipe?.sentinelString).toBe(SENTINEL);
    expect(out.recipe?.testSource).toContain(SENTINEL);
    expect(out.recipe?.approach).toMatch(/^builder:unexpected_exception:direct_call$/);
    expect(out.recipe?.provenance.observedProbe?.sentinelObserved).toBe(true);
    expect(args.workspace.writes).toHaveLength(1);
    expect(args.workspace.writes[0].path).toBe('tests/test_repro_46.py');
    expect(args.sandbox.reproPath).toBe('tests/test_repro_46.py');
    expect(args.workspace.reverts).toHaveLength(0);
  });

  it('rejects when test passes (bug not triggered) and reverts', async () => {
    const d = snap();
    const args = mkArgs(d, {
      runRepro: [mkRun({ exitCode: 0 }), mkRun({ exitCode: 0 })],
    });
    const out = await runReproBuilder(args);
    expect(out.rejectStage).toBe('run_repro_pass');
    expect(args.workspace.reverts).toEqual(['tests/test_repro_46.py']);
  });

  it('rejects when runs fail without sentinel and reverts', async () => {
    const d = snap();
    const args = mkArgs(d, {
      runRepro: [
        mkRun({ exitCode: 1, stderr: 'pre-existing ImportError' }),
        mkRun({ exitCode: 1, stderr: 'pre-existing ImportError' }),
      ],
    });
    const out = await runReproBuilder(args);
    expect(out.rejectStage).toBe('sentinel_absent');
    expect(args.workspace.reverts).toEqual(['tests/test_repro_46.py']);
  });

  it('tiebreaks on disagreement: 2/3 fail-w-sentinel passes', async () => {
    const d = snap();
    const args = mkArgs(d, {
      runRepro: [
        mkRun({ exitCode: 1, stderr: SENTINEL }),
        mkRun({ exitCode: 0 }),
        mkRun({ exitCode: 1, stderr: SENTINEL }),
      ],
    });
    const out = await runReproBuilder(args);
    expect(out.ok).toBe(true);
    expect(out.runs).toHaveLength(3);
  });

  it('tiebreaks on disagreement: 1/3 fail-w-sentinel rejected as flaky', async () => {
    const d = snap();
    const args = mkArgs(d, {
      runRepro: [
        mkRun({ exitCode: 1, stderr: SENTINEL }),
        mkRun({ exitCode: 0 }),
        mkRun({ exitCode: 0 }),
      ],
    });
    const out = await runReproBuilder(args);
    expect(out.rejectStage).toBe('run_repro_flaky');
    expect(args.workspace.reverts).toEqual(['tests/test_repro_46.py']);
  });

  it('reverts and surfaces sandbox_error if writeTest throws', async () => {
    const d = snap();
    const args = mkArgs(d, {
      runRepro: [
        mkRun({ exitCode: 1, stderr: SENTINEL }),
        mkRun({ exitCode: 1, stderr: SENTINEL }),
      ],
    });
    args.workspace.writeShouldThrow = true;
    const out = await runReproBuilder(args);
    expect(out.rejectStage).toBe('write_test_failed');
    // didn't write so no revert
    expect(args.workspace.reverts).toEqual([]);
  });

  it('records preconditionsSatisfied + imports in provenance', async () => {
    const d = snap(
      {
        preconditions: [
          {
            id: 'pc-0',
            condition: 'no provider',
            kind: 'config_absence',
            evidenceRefs: [],
            satisfactionModes: [],
            threats: [],
          },
        ],
      },
      { preconditionsSatisfied: ['pc-0'], imports: ['import json', 'from collections import OrderedDict'] }
    );
    const args = mkArgs(d, {
      runRepro: [
        mkRun({ exitCode: 1, stderr: SENTINEL }),
        mkRun({ exitCode: 1, stderr: SENTINEL }),
      ],
    });
    const out = await runReproBuilder(args);
    expect(out.ok).toBe(true);
    expect(out.recipe?.provenance.preconditionsSatisfied).toEqual(['pc-0']);
    expect(out.recipe?.provenance.exerciseImports).toEqual(['import json', 'from collections import OrderedDict']);
    expect(out.recipe?.provenance.proberAttempts).toBe(0);
  });

  it('accepts legacy precondition condition text and records canonical ids', async () => {
    const d = snap(
      {
        preconditions: [
          {
            id: 'pc-0',
            condition: 'no provider',
            kind: 'config_absence',
            evidenceRefs: [],
            satisfactionModes: [],
            threats: [],
          },
        ],
      },
      { preconditionsSatisfied: ['no provider'] }
    );
    const args = mkArgs(d, {
      runRepro: [
        mkRun({ exitCode: 1, stderr: SENTINEL }),
        mkRun({ exitCode: 1, stderr: SENTINEL }),
      ],
    });

    const out = await runReproBuilder(args);

    expect(out.ok).toBe(true);
    expect(out.recipe?.provenance.preconditionsSatisfied).toEqual(['pc-0']);
  });
});
