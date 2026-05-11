import {
  runReproLoop,
  type ReproLoopOptions,
} from './repro-loop';
import {
  type IterativeReproGenerator,
  type ReproAgentInput,
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
  readFile(): ContextResult {
    return { op: 'read_file', path: 'x', status: 'not_found' };
  }
  listDir(): ContextResult {
    return { op: 'list_dir', path: '/', status: 'ok', entries: [] };
  }
  findFile(): ContextResult {
    return { op: 'find_file', suffix: '', status: 'ok', matches: [] };
  }
  grep(): ContextResult {
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
});
