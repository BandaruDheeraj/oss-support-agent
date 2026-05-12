import {
  runReproLoop,
  computeFailureDirective,
  preloadIssueSymbols,
  type ReproLoopOptions,
} from './repro-loop';
import {
  type IterativeReproGenerator,
  type IterativeReproGeneratorInput,
  type ReproAgentInput,
  type ReproAttemptHistoryEntry,
  type ReproGeneratorAction,
  type ReproWorkspace,
  type BaselineRunResult,
  type ContextResult,
  ReproUnreproducibleError,
  ReproCredentialsRequiredError,
} from './repro-types';

const baseInput: ReproAgentInput = {
  confirmedIssues: [],
  affectedModule: 'src/foo',
  moduleSource: [],
  language: 'python',
  preferredTestDir: 'tests/',
};

const validOutput = (overrides: Partial<{ content: string; sentinel: string; path: string }> = {}) => ({
  path: overrides.path ?? 'tests/test_repro.py',
  content: overrides.content ?? 'print("EXPECTED_REPRO_FAILURE:bug")\nimport sys\nsys.exit(1)\n',
  failureSentinel: overrides.sentinel ?? 'EXPECTED_REPRO_FAILURE:bug',
  summary: 'reproduces the bug',
});

class StubWorkspace implements ReproWorkspace {
  readFile(_req?: any): ContextResult {
    return { op: 'read_file', path: 'x', status: 'not_found' };
  }
  listDir(_req?: any): ContextResult {
    return { op: 'list_dir', path: '/', status: 'ok', entries: [] };
  }
  findFile(_req?: any): ContextResult {
    return { op: 'find_file', suffix: '', status: 'ok', matches: [] };
  }
  grep(_req?: any): ContextResult {
    return { op: 'grep', query: '', status: 'ok', hits: [] };
  }
  repoTreeSummary() {
    return 'repo/';
  }
}

class ScriptedGenerator implements IterativeReproGenerator {
  private i = 0;
  constructor(private readonly steps: ReproGeneratorAction[]) {}
  async generate(): Promise<ReproGeneratorAction> {
    if (this.i >= this.steps.length) {
      throw new Error(`scripted generator exhausted after ${this.steps.length} steps`);
    }
    return this.steps[this.i++];
  }
}

const okBaseline = (): BaselineRunResult => ({
  ok: true,
  exitCode: 1,
  stdout: 'EXPECTED_REPRO_FAILURE:bug',
  stderr: '',
});

const failBaseline = (reason: string): BaselineRunResult => ({
  ok: false,
  stage: 'baseline_failed_to_repro',
  reason,
  exitCode: 0,
  stdout: '',
  stderr: 'something went wrong',
});

const opts: ReproLoopOptions = { maxIterations: 4, maxBaselineAttempts: 3, maxContextRequestRounds: 2 };

describe('runReproLoop', () => {
  test('returns success when first repro reproduces the bug', async () => {
    const gen = new ScriptedGenerator([
      { kind: 'repro', reasoning: 'first try', output: validOutput() },
    ]);
    let calls = 0;
    const baseline = async () => {
      calls++;
      return okBaseline();
    };
    const result = await runReproLoop(baseInput, gen, new StubWorkspace(), baseline, opts);
    expect(calls).toBe(1);
    expect(result.spec.path).toBe('tests/test_repro.py');
    expect(result.attempts.length).toBe(1);
  });

  test('retries with feedback after a baseline failure, then succeeds', async () => {
    const gen = new ScriptedGenerator([
      { kind: 'repro', reasoning: 'try 1', output: validOutput({ content: 'print("EXPECTED_REPRO_FAILURE:bug") # v1\n' }) },
      { kind: 'repro', reasoning: 'try 2', output: validOutput({ content: 'print("EXPECTED_REPRO_FAILURE:bug") # v2\n' }) },
    ]);
    let n = 0;
    const baseline = async () => (++n === 1 ? failBaseline('did not repro') : okBaseline());
    const result = await runReproLoop(baseInput, gen, new StubWorkspace(), baseline, opts);
    expect(n).toBe(2);
    expect(result.attempts.length).toBe(2);
    expect(result.attempts[0].reason).toMatch(/did not repro/);
  });

  test('dedups identical candidates without re-running baseline', async () => {
    const out = validOutput();
    const gen = new ScriptedGenerator([
      { kind: 'repro', reasoning: 'try 1', output: out },
      { kind: 'repro', reasoning: 'same again', output: out },
      { kind: 'repro', reasoning: 'changed', output: validOutput({ content: 'print("EXPECTED_REPRO_FAILURE:bug") # different\n' }) },
    ]);
    let n = 0;
    const baseline = async () => (++n === 1 ? failBaseline('nope') : okBaseline());
    const result = await runReproLoop(baseInput, gen, new StubWorkspace(), baseline, opts);
    expect(n).toBe(2); // duplicate did NOT trigger a baseline run
    const dupAttempt = result.attempts.find(a => /already tried/i.test(a.reason));
    expect(dupAttempt).toBeDefined();
  });

  test('throws ReproCredentialsRequiredError on terminal credentials signal', async () => {
    const gen = new ScriptedGenerator([
      { kind: 'repro', reasoning: 'needs creds', output: validOutput() },
    ]);
    const baseline = async (): Promise<BaselineRunResult> => ({
      ok: false,
      stage: 'baseline_failed_to_repro',
      reason: 'auth required',
      exitCode: 1,
      stdout: '',
      stderr: 'OPENAI_API_KEY missing',
      credentialsTerminal: { inferredEnvVars: ['OPENAI_API_KEY'], matchedPattern: 'OPENAI_API_KEY missing' },
    });
    await expect(runReproLoop(baseInput, gen, new StubWorkspace(), baseline, opts))
      .rejects.toBeInstanceOf(ReproCredentialsRequiredError);
  });

  test('throws ReproUnreproducibleError when iteration budget is exhausted', async () => {
    const gen = new ScriptedGenerator([
      { kind: 'repro', reasoning: 't1', output: validOutput({ content: 'print("EXPECTED_REPRO_FAILURE:bug") # 1\n' }) },
      { kind: 'repro', reasoning: 't2', output: validOutput({ content: 'print("EXPECTED_REPRO_FAILURE:bug") # 2\n' }) },
      { kind: 'repro', reasoning: 't3', output: validOutput({ content: 'print("EXPECTED_REPRO_FAILURE:bug") # 3\n' }) },
      { kind: 'repro', reasoning: 't4', output: validOutput({ content: 'print("EXPECTED_REPRO_FAILURE:bug") # 4\n' }) },
    ]);
    const baseline = async () => failBaseline('still does not repro');
    await expect(
      runReproLoop(baseInput, gen, new StubWorkspace(), baseline, { ...opts, maxIterations: 4, maxBaselineAttempts: 4 })
    ).rejects.toBeInstanceOf(ReproUnreproducibleError);
  });

  test('services context requests and feeds them to the next turn', async () => {
    const gen = new ScriptedGenerator([
      {
        kind: 'request_context',
        reasoning: 'need to see foo.py',
        requests: [{ op: 'read_file', path: 'src/foo.py', purpose: 'understand bug' }],
      },
      { kind: 'repro', reasoning: 'now I know', output: validOutput() },
    ]);
    let readCount = 0;
    class WS extends StubWorkspace {
      readFile(): ContextResult {
        readCount++;
        return { op: 'read_file', path: 'src/foo.py', status: 'ok', content: 'def foo(): pass\n', bytes: 16 };
      }
    }
    const baseline = async () => okBaseline();
    const result = await runReproLoop(baseInput, gen, new WS(), baseline, opts);
    expect(readCount).toBe(1);
    expect(result.spec.path).toBe('tests/test_repro.py');
  });

  test('passes a failureDirective and escalating temperatureHint after duplicates', async () => {
    const out = validOutput();
    const inputs: IterativeReproGeneratorInput[] = [];
    class CapturingGen implements IterativeReproGenerator {
      private i = 0;
      constructor(private readonly steps: ReproGeneratorAction[]) {}
      async generate(input: IterativeReproGeneratorInput): Promise<ReproGeneratorAction> {
        inputs.push(input);
        return this.steps[this.i++];
      }
    }
    // Sequence: first ok candidate -> baseline fails (no sentinel) -> duplicate -> duplicate -> different -> ok.
    const gen = new CapturingGen([
      { kind: 'repro', reasoning: 't1', output: out }, // baseline fails: no sentinel
      { kind: 'repro', reasoning: 't2 dup', output: out }, // duplicate -> dupCount=1
      { kind: 'repro', reasoning: 't3 dup', output: out }, // duplicate -> dupCount=2
      {
        kind: 'repro',
        reasoning: 't4 different',
        output: validOutput({ content: 'print("EXPECTED_REPRO_FAILURE:bug") # v4\n' }),
      }, // baseline ok
    ]);
    let n = 0;
    const baseline = async (): Promise<BaselineRunResult> => {
      n++;
      if (n === 1) {
        return {
          ok: false,
          stage: 'baseline_failed_to_repro',
          reason: 'repro exited 1 but did not print the failure sentinel (EXPECTED_REPRO_FAILURE:bug)',
          exitCode: 1,
          stdout: '',
          stderr: 'Traceback...\nValueError: bad input\n',
        };
      }
      return okBaseline();
    };
    await runReproLoop(baseInput, gen, new StubWorkspace(), baseline, {
      ...opts,
      maxIterations: 6,
      maxBaselineAttempts: 4,
    });

    // Turn 1 has no prior attempts -> no directive, default temperature.
    expect(inputs[0].failureDirective).toBeUndefined();
    expect(inputs[0].temperatureHint ?? 0).toBe(0);

    // Turn 2 follows a sentinel-miss baseline -> directive must mention sentinel + try/except.
    expect(inputs[1].failureDirective).toMatch(/sentinel/i);
    expect(inputs[1].failureDirective).toMatch(/try.*except/i);

    // Turn 3 follows 1 duplicate -> temperature escalates to 0.3.
    expect(inputs[2].temperatureHint).toBe(0.3);
    expect(inputs[2].failureDirective).toMatch(/STRUCTURALLY DIFFERENT/);

    // Turn 4 follows 2 consecutive duplicates -> temperature escalates to 0.6.
    expect(inputs[3].temperatureHint).toBe(0.6);
  });
});

describe('computeFailureDirective', () => {
  const baseAttempt = (overrides: Partial<ReproAttemptHistoryEntry>): ReproAttemptHistoryEntry => ({
    attempt: 1,
    stage: 'baseline_failed_to_repro',
    reason: '',
    ...overrides,
  });

  test('returns undefined for empty history', () => {
    expect(computeFailureDirective([], 'repo/')).toBeUndefined();
  });

  test('detects no-sentinel failure and prescribes try/except wrapper', () => {
    const dir = computeFailureDirective(
      [baseAttempt({
        reason: 'repro exited 1 but did not print the failure sentinel (X)',
        stderrTail: 'Traceback (most recent call last):\n  File "x.py"\nKeyError: \'foo\'',
        exitCode: 1,
      })],
      'repo/'
    );
    expect(dir).toMatch(/sentinel/i);
    expect(dir).toMatch(/try.*except.*KeyError/i);
    expect(dir).toMatch(/raise/);
  });

  test('detects ModuleNotFoundError and points to editableInstalls', () => {
    const tree = 'repo/\nCandidate editableInstalls:\n  - openinference-instrumentation/python\n  - openinference-core/python\n';
    const dir = computeFailureDirective(
      [baseAttempt({
        stage: 'baseline_failed_to_repro',
        reason: 'matched "ModuleNotFoundError"',
        stderrTail: "ModuleNotFoundError: No module named 'openinference.instrumentation'",
        exitCode: 1,
      })],
      tree
    );
    expect(dir).toMatch(/openinference\.instrumentation/);
    expect(dir).toMatch(/editableInstalls/);
    expect(dir).toMatch(/openinference-instrumentation\/python/);
  });

  test('detects SyntaxError and asks for re-emit', () => {
    const dir = computeFailureDirective(
      [baseAttempt({
        stage: 'workspace_setup',
        reason: 'Python SyntaxError: invalid syntax (line 12)',
        stderrTail: '  File "<stdin>", line 12\n    def foo(\n            ^\nSyntaxError: invalid syntax',
      })],
      'repo/'
    );
    expect(dir).toMatch(/parse error/i);
    expect(dir).toMatch(/Re-emit/);
  });

  test('escalates language when a duplicate has been emitted 3+ times', () => {
    const attempts = [
      baseAttempt({ attempt: 1, reason: 'already tried this exact candidate (hash=abc)' }),
      baseAttempt({ attempt: 2, reason: 'already tried (hash=abc)' }),
      baseAttempt({ attempt: 3, reason: 'already tried (hash=abc)' }),
    ];
    const dir = computeFailureDirective(attempts, 'repo/');
    expect(dir).toMatch(/CRITICAL/);
    expect(dir).toMatch(/STRUCTURALLY DIFFERENT/);
  });
});

describe('preloadIssueSymbols', () => {
  class TracebackWorkspace extends StubWorkspace {
    public readPaths: string[] = [];
    readFile(req: any): ContextResult {
      this.readPaths.push(req.path);
      if (req.path.endsWith('exporter.py')) {
        return { op: 'read_file', path: req.path, status: 'ok', content: 'def export(): raise ValueError\n', bytes: 32 };
      }
      return { op: 'read_file', path: req.path, status: 'not_found' };
    }
  }

  test('extracts traceback file paths and loads them into seeds', () => {
    const ws = new TracebackWorkspace();
    const seeds = preloadIssueSymbols(
      [
        {
          number: 1,
          title: 'crash on export',
          body: 'Traceback (most recent call last):\n  File "src/openinference/exporter.py", line 42, in export\n    raise ValueError\nValueError\n',
          labels: [],
        },
      ],
      ws,
      () => undefined
    );
    expect(ws.readPaths).toContain('src/openinference/exporter.py');
    expect(seeds.length).toBeGreaterThan(0);
    const exporterSeed = seeds.find((s) => s.req.op === 'read_file' && s.req.path.endsWith('exporter.py'));
    expect(exporterSeed).toBeDefined();
    expect(exporterSeed!.result.status).toBe('ok');
  });

  test('returns no seeds when issues mention no symbols or paths', () => {
    const ws = new TracebackWorkspace();
    const seeds = preloadIssueSymbols(
      [{ number: 1, title: 'docs typo', body: 'fix the README please', labels: [] }],
      ws,
      () => undefined
    );
    expect(seeds).toEqual([]);
    expect(ws.readPaths).toEqual([]);
  });
});
