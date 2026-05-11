import { runReproAgent, buildReproSpec } from './repro';
import { ReproAgentError, type ReproGenerator, type ReproGeneratorOutput } from './repro-types';

function mockGenerator(out: ReproGeneratorOutput): ReproGenerator {
  return { generate: async () => out };
}

const baseInput = {
  confirmedIssues: [{ number: 1, title: 't', body: 'b', labels: [] }],
  affectedModule: '.',
  moduleSource: [],
  language: 'python' as const,
  preferredTestDir: 'tests',
};

describe('runReproAgent', () => {
  it('returns a spec with python runCommand', async () => {
    const out: ReproGeneratorOutput = {
      path: 'tests/test_repro_issue_1.py',
      content: '# print("REPRO_FAIL_X"); raise SystemExit(1)\nprint("REPRO_FAIL_X")\n',
      failureSentinel: 'REPRO_FAIL_X',
      summary: 's',
    };
    const spec = await runReproAgent(baseInput, mockGenerator(out));
    expect(spec.path).toBe('tests/test_repro_issue_1.py');
    expect(spec.runCommand).toBe('python tests/test_repro_issue_1.py');
    expect(spec.failureSentinel).toBe('REPRO_FAIL_X');
  });

  it('rejects parent-traversal paths', async () => {
    const out: ReproGeneratorOutput = {
      path: 'tests/../etc/passwd.py',
      content: 'REPRO_FAIL_X',
      failureSentinel: 'REPRO_FAIL_X',
      summary: 's',
    };
    await expect(runReproAgent(baseInput, mockGenerator(out))).rejects.toThrow(ReproAgentError);
  });

  it('rejects absolute paths', async () => {
    const out: ReproGeneratorOutput = {
      path: '/etc/passwd.py',
      content: 'REPRO_FAIL_X',
      failureSentinel: 'REPRO_FAIL_X',
      summary: 's',
    };
    await expect(runReproAgent(baseInput, mockGenerator(out))).rejects.toThrow(/repo-relative/);
  });

  it('rejects paths outside preferred dir', async () => {
    const out: ReproGeneratorOutput = {
      path: 'src/sneaky.py',
      content: 'REPRO_FAIL_X',
      failureSentinel: 'REPRO_FAIL_X',
      summary: 's',
    };
    await expect(runReproAgent(baseInput, mockGenerator(out))).rejects.toThrow(/must be under tests\//);
  });

  it('rejects non-.py paths', async () => {
    const out: ReproGeneratorOutput = {
      path: 'tests/foo.js',
      content: 'REPRO_FAIL_X',
      failureSentinel: 'REPRO_FAIL_X',
      summary: 's',
    };
    await expect(runReproAgent(baseInput, mockGenerator(out))).rejects.toThrow(/\.py/);
  });

  it.each([
    'tests/test_x.py; rm -rf /',
    'tests/test x.py',
    'tests/$(whoami).py',
    'tests/`id`.py',
    'tests/test|pwn.py',
    'tests\\evil.py',
    'tests/test_x.py && curl http://evil',
    "tests/'.py",
  ])('rejects shell-injectable path: %s', async (badPath) => {
    const out: ReproGeneratorOutput = {
      path: badPath,
      content: 'REPRO_FAIL_X',
      failureSentinel: 'REPRO_FAIL_X',
      summary: 's',
    };
    await expect(runReproAgent(baseInput, mockGenerator(out))).rejects.toThrow(ReproAgentError);
  });

  it('rejects when sentinel is not in content', async () => {
    const out: ReproGeneratorOutput = {
      path: 'tests/test_x.py',
      content: '# nothing to see',
      failureSentinel: 'REPRO_FAIL_X',
      summary: 's',
    };
    await expect(runReproAgent(baseInput, mockGenerator(out))).rejects.toThrow(/Sentinel/i);
  });

  it('rejects too-short sentinel', async () => {
    const out: ReproGeneratorOutput = {
      path: 'tests/test_x.py',
      content: 'X',
      failureSentinel: 'X',
      summary: 's',
    };
    await expect(runReproAgent(baseInput, mockGenerator(out))).rejects.toThrow();
  });

  it('rejects non-python language', async () => {
    const input = { ...baseInput, language: 'go' as any };
    const out: ReproGeneratorOutput = {
      path: 'tests/test_x.py',
      content: 'REPRO_FAIL_X',
      failureSentinel: 'REPRO_FAIL_X',
      summary: 's',
    };
    await expect(runReproAgent(input, mockGenerator(out))).rejects.toThrow(/unsupported language/);
  });

  it('buildReproSpec adds python runCommand', () => {
    const spec = buildReproSpec({
      path: 'tests/test_y.py',
      content: 'REPRO_FAIL_X',
      failureSentinel: 'REPRO_FAIL_X',
      summary: 's',
    });
    expect(spec.runCommand).toBe('python tests/test_y.py');
  });
});
