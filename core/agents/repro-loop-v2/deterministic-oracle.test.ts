import { runDeterministicReproOracle } from './deterministic-oracle';
import type { ReproRecipe, ReproOracleSpec, SuspectSymbol } from '../analyst/dossier';
import type { SandboxResult as SandboxSessionResult } from '../../sandbox-session';

class FakeWorkspace {
  private readonly files = new Map<string, string>();
  writeTest(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }
  applyPatch(): Promise<{ patchId: string }> {
    return Promise.resolve({ patchId: 'noop' });
  }
  revertFile(): Promise<void> {
    return Promise.resolve();
  }
  commitAndPush(): Promise<{ sha: string; pushedFiles: string[] }> {
    return Promise.resolve({ sha: 'abc123', pushedFiles: [] });
  }
  testRoots(): string[] {
    return ['tests'];
  }
  affectedModule(): string {
    return 'src';
  }
  reproTestPath(): string | undefined {
    return undefined;
  }
}

class FakeSandbox {
  private runIndex = 0;
  constructor(
    private readonly reproRuns: Array<{ exitCode: number; stdout: string; stderr: string; throwError?: string }>,
    private readonly sandboxResult: SandboxSessionResult | null = null
  ) {}
  setReproTestPath(): void {}
  runRepro(): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
    const r =
      this.reproRuns[this.runIndex++] ??
      this.reproRuns[this.reproRuns.length - 1] ?? { exitCode: 1, stdout: '', stderr: 'fallback failure' };
    if (r.throwError) {
      throw new Error(r.throwError);
    }
    return Promise.resolve({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: 5 });
  }
  runTests(): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 5 });
  }
  runPython(): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 5 });
  }
  pipInstall(): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 5 });
  }
  pythonModuleCheck(): Promise<{ importable: boolean; version?: string; error?: string }> {
    return Promise.resolve({ importable: true, version: '1.0.0' });
  }
  listPackages(): Promise<{ name: string; version: string }[]> {
    return Promise.resolve([]);
  }
  getSandboxResult(): SandboxSessionResult | null {
    return this.sandboxResult;
  }
}

const baseRecipe: ReproRecipe = {
  version: 1,
  candidateTestPath: 'tests/test_repro.py',
  testSource: [
    'def _finalize_step_span():',
    '    return None',
    '',
    'def test_repro():',
    '    _finalize_step_span()',
    '    observed = {"openinference.span.kind": "agent"}',
    '    assert observed["openinference.span.kind"] == "chain"',
    '    marker_non_recording_span = "NonRecordingSpan("',
  ].join('\n'),
  sentinelString: 'REPRO_SENTINEL',
  expectedFailureSignature: 'AssertionError',
  requiresCredentials: [],
  pipInstalls: [],
  verbatimSnippetIncompatible: false,
  approach: 'direct assertion',
  provenance: {
    exerciseImports: [],
    preconditionsSatisfied: [],
    observedProbe: null,
    proberAttempts: 0,
    recordedAt: new Date().toISOString(),
  },
};

const baseOracleSpec: ReproOracleSpec = {
  suspect_path_assertions: [
    { kind: 'symbol', needle: '_finalize_step_span', file: 'src/tracing.py' },
    { kind: 'span_attribute', needle: 'openinference.span.kind' },
  ],
  precondition_assertions: [
    {
      condition: 'no tracer provider configured',
      markers: ['NonRecordingSpan('],
    },
  ],
};

const baseSuspects: SuspectSymbol[] = [
  {
    file: 'src/tracing.py',
    symbol: '_finalize_step_span',
    reasoning: 'failure stack points here',
  },
];

describe('runDeterministicReproOracle', () => {
  it('accepts assertion-false failures as valid when all oracle criteria pass', async () => {
    const workspace = new FakeWorkspace();
    const sandbox = new FakeSandbox([
      {
        exitCode: 1,
        stdout: '',
        stderr:
          "AssertionError: assert span.attributes.get('openinference.span.kind') == 'chain' at _finalize_step_span",
      },
      {
        exitCode: 1,
        stdout: '',
        stderr:
          "AssertionError: assert span.attributes.get('openinference.span.kind') == 'chain' at _finalize_step_span",
      },
    ]);

    const result = await runDeterministicReproOracle({
      attemptId: 'attempt-1',
      recipe: baseRecipe,
      oracleSpec: baseOracleSpec,
      suspectSymbols: baseSuspects,
      repoLanguage: 'python',
      workspace,
      sandbox,
      env: {},
    });

    expect(result.verdict).toBe('valid');
    expect(result.criteria).toEqual({
      baseline_head_fails: true,
      reliable_failures: true,
      suspect_path_assertions: true,
      precondition_assertions: true,
      ast_preflight: true,
    });
  });

  it('rejects candidate when suspect_path_assertions are absent from failure output', async () => {
    const workspace = new FakeWorkspace();
    const sandbox = new FakeSandbox([
      { exitCode: 1, stdout: '', stderr: 'AssertionError: telemetry shape mismatch' },
      { exitCode: 1, stdout: '', stderr: 'AssertionError: telemetry shape mismatch' },
    ]);

    const result = await runDeterministicReproOracle({
      attemptId: 'attempt-1',
      recipe: baseRecipe,
      oracleSpec: baseOracleSpec,
      suspectSymbols: baseSuspects,
      repoLanguage: 'python',
      workspace,
      sandbox,
      env: {},
      semanticConfidence: { top_score: 0.9, low_confidence: false, diagnostics: 'high confidence' },
    });

    expect(result.verdict).toBe('invalid');
    expect(result.criteria.suspect_path_assertions).toBe(false);
    expect(result.suspectPathAssertionResult.missing.map((m) => m.needle)).toEqual([
      '_finalize_step_span',
      'openinference.span.kind',
    ]);
  });

  it('soft-checks suspect_path_assertions when semantic confidence is low', async () => {
    const workspace = new FakeWorkspace();
    const sandbox = new FakeSandbox([
      { exitCode: 1, stdout: '', stderr: 'AssertionError: telemetry shape mismatch' },
      { exitCode: 1, stdout: '', stderr: 'AssertionError: telemetry shape mismatch' },
    ]);

    const result = await runDeterministicReproOracle({
      attemptId: 'attempt-1',
      recipe: baseRecipe,
      oracleSpec: baseOracleSpec,
      suspectSymbols: baseSuspects,
      repoLanguage: 'python',
      workspace,
      sandbox,
      env: {},
      semanticConfidence: {
        top_score: 0.41,
        low_confidence: true,
        diagnostics: 'semantic top_score=0.410 below threshold 0.600; suspects are low-confidence',
      },
    });

    expect(result.verdict).toBe('valid');
    expect(result.criteria.suspect_path_assertions).toBe(true);
    expect(result.suspectPathAssertionResult.passed).toBe(false);
    expect(result.message).toContain('soft-check');
  });

  it('rejects candidate when precondition markers are missing in test source', async () => {
    const workspace = new FakeWorkspace();
    const sandbox = new FakeSandbox([
      {
        exitCode: 1,
        stdout: '',
        stderr: 'AssertionError: openinference.span.kind mismatch at _finalize_step_span',
      },
      {
        exitCode: 1,
        stdout: '',
        stderr: 'AssertionError: openinference.span.kind mismatch at _finalize_step_span',
      },
    ]);
    const recipeWithoutMarker: ReproRecipe = {
      ...baseRecipe,
      testSource: baseRecipe.testSource.replace('NonRecordingSpan(', 'TracerProvider('),
    };

    const result = await runDeterministicReproOracle({
      attemptId: 'attempt-1',
      recipe: recipeWithoutMarker,
      oracleSpec: baseOracleSpec,
      suspectSymbols: baseSuspects,
      repoLanguage: 'python',
      workspace,
      sandbox,
      env: {},
    });

    expect(result.verdict).toBe('invalid');
    expect(result.criteria.precondition_assertions).toBe(false);
    expect(result.preconditionAssertionResult.missingMarkers).toEqual(['NonRecordingSpan(']);
  });

  it('rejects candidate when AST preflight fails', async () => {
    const workspace = new FakeWorkspace();
    const sandbox = new FakeSandbox([
      {
        exitCode: 1,
        stdout: '',
        stderr: 'AssertionError: openinference.span.kind mismatch at _finalize_step_span',
      },
      {
        exitCode: 1,
        stdout: '',
        stderr: 'AssertionError: openinference.span.kind mismatch at _finalize_step_span',
      },
    ]);
    const recipeMissingSuspectSymbol: ReproRecipe = {
      ...baseRecipe,
      testSource: [
        'def helper():',
        '    return None',
        '',
        'def test_repro():',
        '    helper()',
        '    marker_non_recording_span = "NonRecordingSpan("',
        '    assert 1 == 2',
      ].join('\n'),
    };

    const result = await runDeterministicReproOracle({
      attemptId: 'attempt-1',
      recipe: recipeMissingSuspectSymbol,
      oracleSpec: baseOracleSpec,
      suspectSymbols: baseSuspects,
      repoLanguage: 'python',
      workspace,
      sandbox,
      env: {},
    });

    expect(result.verdict).toBe('invalid');
    expect(result.criteria.ast_preflight).toBe(false);
  });

  it('returns credentials_required when recipe-declared credentials are missing', async () => {
    const workspace = new FakeWorkspace();
    const sandbox = new FakeSandbox([]);
    const recipeRequiringCreds: ReproRecipe = {
      ...baseRecipe,
      requiresCredentials: ['OPENAI_API_KEY'],
    };

    const result = await runDeterministicReproOracle({
      attemptId: 'attempt-1',
      recipe: recipeRequiringCreds,
      oracleSpec: baseOracleSpec,
      suspectSymbols: baseSuspects,
      repoLanguage: 'python',
      workspace,
      sandbox,
      env: {},
    });

    expect(result.verdict).toBe('credentials_required');
    expect(result.credentialsTerminal?.inferredEnvVars).toEqual(['OPENAI_API_KEY']);
  });

  it('returns sandbox_failed when SandboxSession reports not_executed/errored repro status', async () => {
    const workspace = new FakeWorkspace();
    const sandboxResult: SandboxSessionResult = {
      ok: false,
      reproStatus: 'not_executed',
      failureOutput: '',
      sentinelMatched: false,
      suspectPathHit: false,
      installManifest: [],
      phaseFailures: [
        {
          ok: false,
          phase: 'workflow',
          reason: 'workflow_unreachable',
          diagnostics: { httpStatus: 404 },
        },
      ],
      rawLogs: 'dispatch failed',
    };
    const sandbox = new FakeSandbox(
      [{ exitCode: 1, stdout: '', stderr: '', throwError: 'sandbox dispatch failed' }],
      sandboxResult
    );

    const result = await runDeterministicReproOracle({
      attemptId: 'attempt-sandbox-failed',
      recipe: baseRecipe,
      oracleSpec: baseOracleSpec,
      suspectSymbols: baseSuspects,
      repoLanguage: 'python',
      workspace,
      sandbox,
      env: {},
    });

    expect(result.verdict).toBe('sandbox_failed');
    expect(result.sandboxResult?.reproStatus).toBe('not_executed');
    expect(result.sandboxResult?.phaseFailures[0]?.reason).toBe('workflow_unreachable');
  });
});
