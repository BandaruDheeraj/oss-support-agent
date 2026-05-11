/**
 * Unit tests for the fix agent (US-007).
 */

import {
  formatCommitMessage,
  extractModuleName,
  validateChangeScope,
  verifyForkOnlyAccess,
  validateTestCoverage,
  readFullModule,
  runFixAgent,
  detectDestructiveRewrites,
} from './fix';
import {
  FixAgentInput,
  FileChange,
  FixGenerator,
  FixGeneratorOutput,
  ForkCommitter,
  RepoFileReader,
  FixAgentError,
  UpstreamWriteAttemptError,
} from './fix-types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<FixAgentInput> = {}): FixAgentInput {
  return {
    designSummary: 'Fix the null pointer in auth handler',
    confirmedIssues: [
      { number: 142, title: 'NPE in auth', body: 'Crash on null user', labels: ['bug'] },
      { number: 156, title: 'Auth handler NPE', body: null, labels: ['bug'] },
    ],
    affectedModule: 'src/auth',
    moduleSource: [
      { path: 'src/auth/handler.ts', content: 'export function handle() { /* ... */ }' },
    ],
    moduleTests: [
      { path: 'src/auth/__tests__/handler.test.ts', content: 'test("handler", () => {})' },
    ],
    recentCommits: [
      { sha: 'abc123', message: 'fix(auth): previous fix', files_changed: ['src/auth/handler.ts'] },
    ],
    forkFullName: 'my-org/openinference',
    branchName: 'agent/scope-142-156',
    ...overrides,
  };
}

function makeMockGenerator(output?: Partial<FixGeneratorOutput>): FixGenerator {
  return {
    generateFix: jest.fn().mockResolvedValue({
      sourceChanges: [
        { path: 'src/auth/handler.ts', action: 'modify', content: 'fixed code' },
      ],
      testChanges: [
        { path: 'src/auth/__tests__/handler.test.ts', action: 'modify', content: 'updated test' },
      ],
      summary: 'handle null user in auth handler',
      ...output,
    }),
  };
}

function makeMockCommitter(scopes: string[] = []): ForkCommitter {
  return {
    commitChanges: jest.fn().mockResolvedValue('sha-new-commit'),
    getTokenScopes: jest.fn().mockResolvedValue(scopes),
  };
}

function makeMockReader(): RepoFileReader {
  return {
    readFile: jest.fn().mockResolvedValue('file content'),
    listFiles: jest.fn().mockResolvedValue(['src/auth/handler.ts', 'src/auth/utils.ts']),
  };
}

// ─── formatCommitMessage ──────────────────────────────────────────────────────

describe('formatCommitMessage', () => {
  it('formats with single issue ID', () => {
    const msg = formatCommitMessage('src/auth', 'fix null pointer', [142]);
    expect(msg).toBe('fix(auth): fix null pointer — closes #142');
  });

  it('formats with multiple issue IDs', () => {
    const msg = formatCommitMessage('src/auth', 'fix null pointer', [142, 156, 203]);
    expect(msg).toBe('fix(auth): fix null pointer — closes #142, #156, #203');
  });

  it('strips src/ prefix from module path', () => {
    const msg = formatCommitMessage('src/webhook/router', 'fix routing', [10]);
    expect(msg).toBe('fix(webhook/router): fix routing — closes #10');
  });

  it('strips lib/ prefix from module path', () => {
    const msg = formatCommitMessage('lib/utils', 'fix helper', [5]);
    expect(msg).toBe('fix(utils): fix helper — closes #5');
  });

  it('keeps path as-is when no src/ or lib/ prefix', () => {
    const msg = formatCommitMessage('packages/core', 'update core', [1]);
    expect(msg).toBe('fix(packages/core): update core — closes #1');
  });
});

// ─── extractModuleName ────────────────────────────────────────────────────────

describe('extractModuleName', () => {
  it('strips src/ prefix', () => {
    expect(extractModuleName('src/auth')).toBe('auth');
  });

  it('strips lib/ prefix', () => {
    expect(extractModuleName('lib/core')).toBe('core');
  });

  it('preserves nested paths after src/', () => {
    expect(extractModuleName('src/webhook/router')).toBe('webhook/router');
  });

  it('returns as-is for other prefixes', () => {
    expect(extractModuleName('packages/core')).toBe('packages/core');
  });

  it('handles leading/trailing slashes', () => {
    expect(extractModuleName('/src/auth/')).toBe('auth');
  });
});

// ─── validateChangeScope ──────────────────────────────────────────────────────

describe('validateChangeScope', () => {
  it('accepts changes within the affected module', () => {
    const changes: FileChange[] = [
      { path: 'src/auth/handler.ts', action: 'modify', content: '' },
      { path: 'src/auth/utils.ts', action: 'modify', content: '' },
    ];
    const result = validateChangeScope(changes, 'src/auth');
    expect(result.valid).toBe(true);
    expect(result.outOfScope).toHaveLength(0);
  });

  it('accepts test file changes outside the module', () => {
    const changes: FileChange[] = [
      { path: 'src/auth/handler.ts', action: 'modify', content: '' },
      { path: 'src/auth/__tests__/handler.test.ts', action: 'modify', content: '' },
      { path: 'test/auth.spec.ts', action: 'create', content: '' },
      { path: 'tests/integration/auth.test.ts', action: 'create', content: '' },
    ];
    const result = validateChangeScope(changes, 'src/auth');
    expect(result.valid).toBe(true);
  });

  it('rejects changes outside the module and not tests', () => {
    const changes: FileChange[] = [
      { path: 'src/auth/handler.ts', action: 'modify', content: '' },
      { path: 'src/webhook/server.ts', action: 'modify', content: '' },
    ];
    const result = validateChangeScope(changes, 'src/auth');
    expect(result.valid).toBe(false);
    expect(result.outOfScope).toContain('src/webhook/server.ts');
  });

  it('rejects unrelated file changes', () => {
    const changes: FileChange[] = [
      { path: 'package.json', action: 'modify', content: '' },
    ];
    const result = validateChangeScope(changes, 'src/auth');
    expect(result.valid).toBe(false);
    expect(result.outOfScope).toContain('package.json');
  });

  it('handles empty changes array', () => {
    const result = validateChangeScope([], 'src/auth');
    expect(result.valid).toBe(true);
  });
});

// ─── validateTestCoverage ─────────────────────────────────────────────────────

describe('validateTestCoverage', () => {
  it('passes when test changes exist for source changes', () => {
    const source: FileChange[] = [{ path: 'src/auth/handler.ts', action: 'modify', content: '' }];
    const tests: FileChange[] = [{ path: 'src/auth/__tests__/handler.test.ts', action: 'modify', content: '' }];
    const result = validateTestCoverage(source, tests);
    expect(result.covered).toBe(true);
  });

  it('fails when source changes exist but no test changes', () => {
    const source: FileChange[] = [{ path: 'src/auth/handler.ts', action: 'modify', content: '' }];
    const result = validateTestCoverage(source, []);
    expect(result.covered).toBe(false);
    expect(result.uncoveredFiles).toContain('src/auth/handler.ts');
  });

  it('passes when no source changes exist', () => {
    const result = validateTestCoverage([], []);
    expect(result.covered).toBe(true);
  });
});

// ─── detectDestructiveRewrites ────────────────────────────────────────────────

describe('detectDestructiveRewrites', () => {
  const longOriginal = Array(50).fill('def fn(): pass').join('\n'); // ~700 bytes

  it('flags a modify change containing a "# Other imports..." placeholder', () => {
    const source: FileChange[] = [
      {
        path: 'src/auth/handler.py',
        action: 'modify',
        content: 'from x import y# Other imports...\ndef fn(): return 1',
      },
    ];
    const findings = detectDestructiveRewrites(source, [
      { path: 'src/auth/handler.py', content: longOriginal },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe('src/auth/handler.py');
    expect(findings[0].reason).toMatch(/placeholder/);
  });

  it('flags a modify change containing a "# Existing logic..." placeholder', () => {
    const source: FileChange[] = [
      {
        path: 'a.py',
        action: 'modify',
        content: 'def f():\n    if x: return\n    # Existing logic...',
      },
    ];
    const findings = detectDestructiveRewrites(source, [
      { path: 'a.py', content: longOriginal },
    ]);
    expect(findings).toHaveLength(1);
  });

  it('flags a modify change containing "// ... rest of file ..."', () => {
    const source: FileChange[] = [
      {
        path: 'a.ts',
        action: 'modify',
        content: 'export function f() { return 1; }\n// ... rest of file ...',
      },
    ];
    const findings = detectDestructiveRewrites(source, [
      { path: 'a.ts', content: longOriginal },
    ]);
    expect(findings).toHaveLength(1);
  });

  it('flags a modify change that shrinks a large file by more than 50%', () => {
    const source: FileChange[] = [
      { path: 'a.py', action: 'modify', content: 'def f(): return 1\n' },
    ];
    const findings = detectDestructiveRewrites(source, [
      { path: 'a.py', content: longOriginal },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toMatch(/shrunk/);
  });

  it('does not flag a small original file even if heavily edited', () => {
    const source: FileChange[] = [
      { path: 'a.py', action: 'modify', content: 'def f(): return 1' },
    ];
    const findings = detectDestructiveRewrites(source, [
      { path: 'a.py', content: 'def f(): return 0' }, // <400B → exempt
    ]);
    expect(findings).toHaveLength(0);
  });

  it('does not flag a modify change that preserves most content', () => {
    const newContent = longOriginal + '\ndef extra(): return 2';
    const source: FileChange[] = [
      { path: 'a.py', action: 'modify', content: newContent },
    ];
    const findings = detectDestructiveRewrites(source, [
      { path: 'a.py', content: longOriginal },
    ]);
    expect(findings).toHaveLength(0);
  });

  it('does not flag a create action (no original to compare)', () => {
    const source: FileChange[] = [
      { path: 'new.py', action: 'create', content: 'def f(): pass' },
    ];
    const findings = detectDestructiveRewrites(source, []);
    expect(findings).toHaveLength(0);
  });

  it('does not flag a modify when path is absent from moduleSource', () => {
    const source: FileChange[] = [
      { path: 'unknown.py', action: 'modify', content: 'tiny' },
    ];
    const findings = detectDestructiveRewrites(source, [
      { path: 'other.py', content: longOriginal },
    ]);
    expect(findings).toHaveLength(0);
  });

  it('reproduces the live #17 destructive output (real-world regression)', () => {
    const destructive =
      'from opentelemetry.trace import NonRecordingSpan# Other imports...def _finalize_step_span(span):\n' +
      '    # Guard against NonRecordingSpan\n' +
      '    if isinstance(span, NonRecordingSpan):\n' +
      '        return\n' +
      '    if span.status.status_code != trace_api.StatusCode.ERROR:\n' +
      '        # Existing logic...\n';
    const findings = detectDestructiveRewrites(
      [{ path: '_wrappers.py', action: 'modify', content: destructive }],
      [{ path: '_wrappers.py', content: longOriginal }]
    );
    expect(findings).toHaveLength(1);
  });
});

// ─── verifyForkOnlyAccess ─────────────────────────────────────────────────────

describe('verifyForkOnlyAccess', () => {
  it('passes with narrow scopes', async () => {
    const committer = makeMockCommitter([]);
    await expect(verifyForkOnlyAccess(committer)).resolves.not.toThrow();
  });

  it('passes with fine-grained token (no classic scopes)', async () => {
    const committer = makeMockCommitter([]);
    await expect(verifyForkOnlyAccess(committer)).resolves.not.toThrow();
  });

  it('throws on public_repo scope', async () => {
    const committer = makeMockCommitter(['public_repo']);
    await expect(verifyForkOnlyAccess(committer)).rejects.toThrow(UpstreamWriteAttemptError);
  });

  it('throws on repo scope', async () => {
    const committer = makeMockCommitter(['repo']);
    await expect(verifyForkOnlyAccess(committer)).rejects.toThrow(UpstreamWriteAttemptError);
  });

  it('error message mentions the dangerous scope', async () => {
    const committer = makeMockCommitter(['repo', 'read:org']);
    await expect(verifyForkOnlyAccess(committer)).rejects.toThrow(/repo/);
  });
});

// ─── readFullModule ───────────────────────────────────────────────────────────

describe('readFullModule', () => {
  it('lists and reads all files in the module', async () => {
    const reader = makeMockReader();
    const result = await readFullModule(reader, 'my-org/repo', 'agent/scope-1', 'src/auth');
    expect(reader.listFiles).toHaveBeenCalledWith('my-org/repo', 'agent/scope-1', 'src/auth');
    expect(reader.readFile).toHaveBeenCalledTimes(2);
    expect(result.files).toEqual(['src/auth/handler.ts', 'src/auth/utils.ts']);
    expect(result.source).toHaveLength(2);
  });

  it('returns empty for empty module', async () => {
    const reader: RepoFileReader = {
      readFile: jest.fn(),
      listFiles: jest.fn().mockResolvedValue([]),
    };
    const result = await readFullModule(reader, 'org/repo', 'branch', 'src/empty');
    expect(result.files).toHaveLength(0);
    expect(result.source).toHaveLength(0);
  });
});

// ─── runFixAgent (integration) ────────────────────────────────────────────────

describe('runFixAgent', () => {
  it('succeeds with valid input and produces correct result', async () => {
    const input = makeInput();
    const generator = makeMockGenerator();
    const committer = makeMockCommitter([]);
    const reader = makeMockReader();

    const result = await runFixAgent(input, generator, committer, reader);

    expect(result.success).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.testChanges).toHaveLength(1);
    expect(result.closesIssues).toEqual([142, 156]);
    expect(result.commitMessage).toBe(
      'fix(auth): handle null user in auth handler — closes #142, #156'
    );
  });

  it('reads the full module before generating fix', async () => {
    const input = makeInput();
    const generator = makeMockGenerator();
    const committer = makeMockCommitter([]);
    const reader = makeMockReader();

    await runFixAgent(input, generator, committer, reader);

    expect(reader.listFiles).toHaveBeenCalledWith(
      'my-org/openinference',
      'agent/scope-142-156',
      'src/auth'
    );
  });

  it('rejects destructive whole-file rewrites with FixAgentError(destructive_rewrite)', async () => {
    const longOriginal = Array(50).fill('def fn(): pass').join('\n');
    const input = makeInput({
      moduleSource: [{ path: 'src/auth/handler.ts', content: longOriginal }],
    });
    const generator: FixGenerator = {
      generateFix: jest.fn().mockResolvedValue({
        sourceChanges: [
          {
            path: 'src/auth/handler.ts',
            action: 'modify',
            content: 'import x\n// ... rest of file ...',
          },
        ],
        testChanges: [
          { path: 'src/auth/__tests__/handler.test.ts', action: 'modify', content: 'updated test' },
        ],
        summary: 'collapsed file',
      }),
    };
    const committer = makeMockCommitter([]);
    const reader = makeMockReader();

    await expect(runFixAgent(input, generator, committer, reader)).rejects.toMatchObject({
      name: 'FixAgentError',
      phase: 'destructive_rewrite',
    });
    // Must not have committed anything
    expect(committer.commitChanges).not.toHaveBeenCalled();
  });

  it('commits changes to the fork branch only', async () => {
    const input = makeInput();
    const generator = makeMockGenerator();
    const committer = makeMockCommitter([]);
    const reader = makeMockReader();

    await runFixAgent(input, generator, committer, reader);

    expect(committer.commitChanges).toHaveBeenCalledWith(
      'my-org/openinference',
      'agent/scope-142-156',
      expect.any(Array),
      expect.stringContaining('fix(auth)')
    );
  });

  it('rejects when token has upstream write access', async () => {
    const input = makeInput();
    const generator = makeMockGenerator();
    const committer = makeMockCommitter(['repo']);
    const reader = makeMockReader();

    await expect(runFixAgent(input, generator, committer, reader)).rejects.toThrow(
      UpstreamWriteAttemptError
    );
    expect(committer.commitChanges).not.toHaveBeenCalled();
  });

  it('rejects when changes are out of scope', async () => {
    const input = makeInput();
    const generator = makeMockGenerator({
      sourceChanges: [
        { path: 'src/auth/handler.ts', action: 'modify', content: 'fix' },
        { path: 'src/webhook/unrelated.ts', action: 'modify', content: 'refactor' },
      ],
    });
    const committer = makeMockCommitter([]);
    const reader = makeMockReader();

    await expect(runFixAgent(input, generator, committer, reader)).rejects.toThrow(FixAgentError);
    await expect(runFixAgent(input, generator, committer, reader)).rejects.toThrow(/out-of-scope/);
  });

  it('rejects when no tests are generated for source changes', async () => {
    const input = makeInput();
    const generator = makeMockGenerator({
      testChanges: [],
    });
    const committer = makeMockCommitter([]);
    const reader = makeMockReader();

    await expect(runFixAgent(input, generator, committer, reader)).rejects.toThrow(FixAgentError);
    await expect(runFixAgent(input, generator, committer, reader)).rejects.toThrow(/tests/);
  });

  it('returns failure when generator produces no changes', async () => {
    const input = makeInput();
    const generator = makeMockGenerator({
      sourceChanges: [],
      testChanges: [],
      summary: '',
    });
    const committer = makeMockCommitter([]);
    const reader = makeMockReader();

    const result = await runFixAgent(input, generator, committer, reader);

    expect(result.success).toBe(false);
    expect(result.changes).toHaveLength(0);
    expect(committer.commitChanges).not.toHaveBeenCalled();
  });

  it('passes full input to the generator', async () => {
    const input = makeInput();
    const generator = makeMockGenerator();
    const committer = makeMockCommitter([]);
    const reader = makeMockReader();

    await runFixAgent(input, generator, committer, reader);

    expect(generator.generateFix).toHaveBeenCalledWith(input);
  });

  it('includes all issue IDs from confirmed issues in the commit', async () => {
    const input = makeInput({
      confirmedIssues: [
        { number: 10, title: 'A', body: null, labels: [] },
        { number: 20, title: 'B', body: null, labels: [] },
        { number: 30, title: 'C', body: null, labels: [] },
      ],
    });
    const generator = makeMockGenerator();
    const committer = makeMockCommitter([]);
    const reader = makeMockReader();

    const result = await runFixAgent(input, generator, committer, reader);

    expect(result.closesIssues).toEqual([10, 20, 30]);
    expect(result.commitMessage).toContain('#10');
    expect(result.commitMessage).toContain('#20');
    expect(result.commitMessage).toContain('#30');
  });

  it('includes design summary and recent commits in generator input', async () => {
    const input = makeInput({
      designSummary: 'Specific design approach',
      recentCommits: [
        { sha: 'aaa', message: 'first', files_changed: ['src/auth/x.ts'] },
        { sha: 'bbb', message: 'second', files_changed: ['src/auth/y.ts'] },
      ],
    });
    const generator = makeMockGenerator();
    const committer = makeMockCommitter([]);
    const reader = makeMockReader();

    await runFixAgent(input, generator, committer, reader);

    const call = (generator.generateFix as jest.Mock).mock.calls[0][0];
    expect(call.designSummary).toBe('Specific design approach');
    expect(call.recentCommits).toHaveLength(2);
  });

  it('creates new test files when module has no existing tests', async () => {
    const input = makeInput({ moduleTests: [] });
    const generator = makeMockGenerator({
      testChanges: [
        { path: 'src/auth/__tests__/handler.test.ts', action: 'create', content: 'new test' },
      ],
    });
    const committer = makeMockCommitter([]);
    const reader = makeMockReader();

    const result = await runFixAgent(input, generator, committer, reader);

    expect(result.success).toBe(true);
    expect(result.testChanges[0].action).toBe('create');
  });

  it('commit message format matches: fix({module}): {summary} — closes #{ids}', async () => {
    const input = makeInput({
      affectedModule: 'src/webhook/router',
      confirmedIssues: [{ number: 99, title: 'Issue', body: null, labels: [] }],
      moduleSource: [{ path: 'src/webhook/router.ts', content: 'export function route() {}' }],
      moduleTests: [{ path: 'src/webhook/__tests__/router.test.ts', content: 'test("route", () => {})' }],
    });
    const generator = makeMockGenerator({
      summary: 'fix route matching',
      sourceChanges: [{ path: 'src/webhook/router.ts', action: 'modify', content: 'fixed routing' }],
      testChanges: [{ path: 'src/webhook/__tests__/router.test.ts', action: 'modify', content: 'updated test' }],
    });
    const committer = makeMockCommitter([]);
    const reader: RepoFileReader = {
      readFile: jest.fn().mockResolvedValue('file content'),
      listFiles: jest.fn().mockResolvedValue(['src/webhook/router.ts']),
    };

    const result = await runFixAgent(input, generator, committer, reader);

    expect(result.commitMessage).toBe('fix(webhook/router): fix route matching — closes #99');
  });
});
