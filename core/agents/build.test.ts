/**
 * Unit tests for the build agent (US-014).
 */

import {
  formatBuildCommitMessage,
  extractModuleName,
  verifyForkOnlyAccess,
  validateNoDocumentation,
  validateModuleScope,
  validateTestFilePresent,
  validateIndexUpdates,
  analyzeReferenceModules,
  runBuildAgent,
} from './build';
import {
  BuildAgentInput,
  BuildAgentError,
  ScaffoldGenerator,
  ScaffoldGeneratorOutput,
  ReferenceModule,
  ForkCommitter,
  RepoFileReader,
  FileChange,
} from './build-types';
import { UpstreamWriteAttemptError } from './fix-types';

// ---------- Helpers ----------

function mockCommitter(scopes: string[] = []): ForkCommitter {
  return {
    commitChanges: jest.fn().mockResolvedValue('abc123'),
    getTokenScopes: jest.fn().mockResolvedValue(scopes),
  };
}

function mockReader(): RepoFileReader {
  return {
    readFile: jest.fn().mockResolvedValue('file content'),
    listFiles: jest.fn().mockResolvedValue([]),
  };
}

function mockGenerator(output: ScaffoldGeneratorOutput): ScaffoldGenerator {
  return {
    generateScaffold: jest.fn().mockResolvedValue(output),
  };
}

function baseInput(overrides: Partial<BuildAgentInput> = {}): BuildAgentInput {
  return {
    designSummary: 'Add new caching module',
    confirmedIssues: [
      { number: 42, title: 'Add caching support', body: 'Need caching', labels: ['feature'] },
    ],
    affectedModule: 'src/cache',
    referenceModules: [
      {
        path: 'src/auth',
        files: [
          { path: 'src/auth/index.ts', content: 'export {}' },
          { path: 'src/auth/auth.ts', content: 'class Auth {}' },
          { path: 'src/auth/auth.test.ts', content: 'test("auth", () => {})' },
        ],
      },
    ],
    contributingGuide: '# Contributing\nFollow the existing patterns.',
    forkFullName: 'my-org/my-repo',
    branchName: 'agent/scope-42',
    ...overrides,
  };
}

function validScaffoldOutput(): ScaffoldGeneratorOutput {
  return {
    moduleFiles: [
      { path: 'src/cache/cache.ts', action: 'create', content: 'export class Cache {}' },
      { path: 'src/cache/index.ts', action: 'create', content: 'export { Cache } from "./cache";' },
    ],
    testFiles: [
      { path: 'src/cache/__tests__/cache.test.ts', action: 'create', content: 'test("cache", () => {})' },
    ],
    indexFiles: [
      { path: 'src/index.ts', action: 'modify', content: 'export * from "./cache";' },
    ],
    summary: 'Add caching module with LRU strategy',
  };
}

// ---------- formatBuildCommitMessage ----------

describe('formatBuildCommitMessage', () => {
  it('formats with single issue ID', () => {
    const msg = formatBuildCommitMessage('src/cache', 'add caching module', [42]);
    expect(msg).toBe('feat(cache): add caching module — closes #42');
  });

  it('formats with multiple issue IDs', () => {
    const msg = formatBuildCommitMessage('src/cache', 'add caching', [42, 56, 78]);
    expect(msg).toBe('feat(cache): add caching — closes #42, #56, #78');
  });

  it('strips src prefix from module', () => {
    const msg = formatBuildCommitMessage('src/auth/handlers', 'add handler', [10]);
    expect(msg).toBe('feat(auth/handlers): add handler — closes #10');
  });

  it('strips lib prefix from module', () => {
    const msg = formatBuildCommitMessage('lib/utils', 'add utility', [5]);
    expect(msg).toBe('feat(utils): add utility — closes #5');
  });

  it('keeps module name without src/lib prefix', () => {
    const msg = formatBuildCommitMessage('packages/core', 'add core feature', [1]);
    expect(msg).toBe('feat(packages/core): add core feature — closes #1');
  });
});

// ---------- extractModuleName ----------

describe('extractModuleName', () => {
  it('strips src prefix', () => {
    expect(extractModuleName('src/webhook')).toBe('webhook');
  });

  it('strips lib prefix', () => {
    expect(extractModuleName('lib/utils')).toBe('utils');
  });

  it('handles nested paths', () => {
    expect(extractModuleName('src/auth/handlers')).toBe('auth/handlers');
  });

  it('handles leading/trailing slashes', () => {
    expect(extractModuleName('/src/cache/')).toBe('cache');
  });

  it('keeps paths without src or lib', () => {
    expect(extractModuleName('packages/core')).toBe('packages/core');
  });
});

// ---------- validateNoDocumentation ----------

describe('validateNoDocumentation', () => {
  it('passes for source files', () => {
    const changes: FileChange[] = [
      { path: 'src/cache/cache.ts', action: 'create', content: '' },
      { path: 'src/cache/cache.test.ts', action: 'create', content: '' },
    ];
    expect(validateNoDocumentation(changes)).toEqual({ valid: true, docFiles: [] });
  });

  it('rejects markdown files', () => {
    const changes: FileChange[] = [
      { path: 'src/cache/README.md', action: 'create', content: '' },
    ];
    const result = validateNoDocumentation(changes);
    expect(result.valid).toBe(false);
    expect(result.docFiles).toContain('src/cache/README.md');
  });

  it('rejects .rst files', () => {
    const changes: FileChange[] = [
      { path: 'docs/cache.rst', action: 'create', content: '' },
    ];
    expect(validateNoDocumentation(changes).valid).toBe(false);
  });

  it('rejects .txt files', () => {
    const changes: FileChange[] = [
      { path: 'docs/notes.txt', action: 'create', content: '' },
    ];
    expect(validateNoDocumentation(changes).valid).toBe(false);
  });

  it('rejects .adoc files', () => {
    const changes: FileChange[] = [
      { path: 'docs/guide.adoc', action: 'create', content: '' },
    ];
    expect(validateNoDocumentation(changes).valid).toBe(false);
  });

  it('rejects .mdx files', () => {
    const changes: FileChange[] = [
      { path: 'docs/component.mdx', action: 'create', content: '' },
    ];
    expect(validateNoDocumentation(changes).valid).toBe(false);
  });

  it('reports all documentation files found', () => {
    const changes: FileChange[] = [
      { path: 'src/cache/cache.ts', action: 'create', content: '' },
      { path: 'README.md', action: 'modify', content: '' },
      { path: 'docs/usage.rst', action: 'create', content: '' },
    ];
    const result = validateNoDocumentation(changes);
    expect(result.valid).toBe(false);
    expect(result.docFiles).toHaveLength(2);
  });

  it('handles empty array', () => {
    expect(validateNoDocumentation([])).toEqual({ valid: true, docFiles: [] });
  });
});

// ---------- validateModuleScope ----------

describe('validateModuleScope', () => {
  it('passes for files within the module', () => {
    const files: FileChange[] = [
      { path: 'src/cache/cache.ts', action: 'create', content: '' },
      { path: 'src/cache/types.ts', action: 'create', content: '' },
    ];
    expect(validateModuleScope(files, 'src/cache')).toEqual({ valid: true, outOfScope: [] });
  });

  it('rejects files outside the module', () => {
    const files: FileChange[] = [
      { path: 'src/auth/auth.ts', action: 'modify', content: '' },
    ];
    const result = validateModuleScope(files, 'src/cache');
    expect(result.valid).toBe(false);
    expect(result.outOfScope).toContain('src/auth/auth.ts');
  });

  it('handles empty array', () => {
    expect(validateModuleScope([], 'src/cache')).toEqual({ valid: true, outOfScope: [] });
  });

  it('handles module path with trailing slash', () => {
    const files: FileChange[] = [
      { path: 'src/cache/index.ts', action: 'create', content: '' },
    ];
    expect(validateModuleScope(files, 'src/cache/')).toEqual({ valid: true, outOfScope: [] });
  });
});

// ---------- validateTestFilePresent ----------

describe('validateTestFilePresent', () => {
  it('passes when test files exist', () => {
    const files: FileChange[] = [
      { path: 'src/cache/cache.test.ts', action: 'create', content: '' },
    ];
    expect(validateTestFilePresent(files)).toEqual({ valid: true });
  });

  it('fails when no test files', () => {
    expect(validateTestFilePresent([])).toEqual({ valid: false });
  });
});

// ---------- validateIndexUpdates ----------

describe('validateIndexUpdates', () => {
  it('passes when no index files', () => {
    expect(validateIndexUpdates([], 'src/cache')).toEqual({ valid: true, reason: '' });
  });

  it('passes when index references the module', () => {
    const files: FileChange[] = [
      { path: 'src/index.ts', action: 'modify', content: 'export * from "./cache";' },
    ];
    expect(validateIndexUpdates(files, 'src/cache')).toEqual({ valid: true, reason: '' });
  });

  it('fails when index does not reference the module', () => {
    const files: FileChange[] = [
      { path: 'src/index.ts', action: 'modify', content: 'export * from "./auth";' },
    ];
    const result = validateIndexUpdates(files, 'src/cache');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('cache');
  });

  it('accepts full path reference', () => {
    const files: FileChange[] = [
      { path: 'src/index.ts', action: 'modify', content: 'import from "src/cache"' },
    ];
    expect(validateIndexUpdates(files, 'src/cache')).toEqual({ valid: true, reason: '' });
  });
});

// ---------- analyzeReferenceModules ----------

describe('analyzeReferenceModules', () => {
  it('detects file patterns from references', () => {
    const refs: ReferenceModule[] = [
      {
        path: 'src/auth',
        files: [
          { path: 'src/auth/index.ts', content: '' },
          { path: 'src/auth/auth.ts', content: '' },
          { path: 'src/auth/auth.test.ts', content: '' },
        ],
      },
    ];
    const result = analyzeReferenceModules(refs);
    expect(result.filePatterns.length).toBeGreaterThan(0);
    expect(result.hasTests).toBe(true);
    expect(result.hasIndex).toBe(true);
  });

  it('detects when references have no tests', () => {
    const refs: ReferenceModule[] = [
      {
        path: 'src/utils',
        files: [
          { path: 'src/utils/helpers.ts', content: '' },
        ],
      },
    ];
    const result = analyzeReferenceModules(refs);
    expect(result.hasTests).toBe(false);
    expect(result.hasIndex).toBe(false);
  });

  it('handles empty references', () => {
    const result = analyzeReferenceModules([]);
    expect(result.filePatterns).toEqual([]);
    expect(result.hasTests).toBe(false);
    expect(result.hasIndex).toBe(false);
  });

  it('deduplicates file patterns', () => {
    const refs: ReferenceModule[] = [
      {
        path: 'src/auth',
        files: [{ path: 'src/auth/index.ts', content: '' }],
      },
      {
        path: 'src/users',
        files: [{ path: 'src/users/index.ts', content: '' }],
      },
    ];
    const result = analyzeReferenceModules(refs);
    const indexPatterns = result.filePatterns.filter((p) => p === 'index.ts');
    expect(indexPatterns.length).toBe(1);
  });

  it('detects __tests__ pattern', () => {
    const refs: ReferenceModule[] = [
      {
        path: 'src/auth',
        files: [{ path: 'src/auth/__tests__/auth.test.ts', content: '' }],
      },
    ];
    expect(analyzeReferenceModules(refs).hasTests).toBe(true);
  });

  it('detects .spec. pattern', () => {
    const refs: ReferenceModule[] = [
      {
        path: 'src/auth',
        files: [{ path: 'src/auth/auth.spec.ts', content: '' }],
      },
    ];
    expect(analyzeReferenceModules(refs).hasTests).toBe(true);
  });
});

// ---------- verifyForkOnlyAccess ----------

describe('verifyForkOnlyAccess', () => {
  it('passes with narrow scopes', async () => {
    const committer = mockCommitter(['contents:write']);
    await expect(verifyForkOnlyAccess(committer)).resolves.toBeUndefined();
  });

  it('passes with empty scopes', async () => {
    const committer = mockCommitter([]);
    await expect(verifyForkOnlyAccess(committer)).resolves.toBeUndefined();
  });

  it('throws on public_repo scope', async () => {
    const committer = mockCommitter(['public_repo']);
    await expect(verifyForkOnlyAccess(committer)).rejects.toThrow(UpstreamWriteAttemptError);
  });

  it('throws on repo scope', async () => {
    const committer = mockCommitter(['repo']);
    await expect(verifyForkOnlyAccess(committer)).rejects.toThrow(UpstreamWriteAttemptError);
  });
});

// ---------- runBuildAgent (integration) ----------

describe('runBuildAgent', () => {
  it('successfully scaffolds a new module', async () => {
    const input = baseInput();
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter([]);
    const reader = mockReader();

    const result = await runBuildAgent(input, generator, committer, reader);

    expect(result.success).toBe(true);
    expect(result.moduleFiles).toHaveLength(2);
    expect(result.testFiles).toHaveLength(1);
    expect(result.indexFiles).toHaveLength(1);
    expect(result.closesIssues).toEqual([42]);
  });

  it('produces correct commit message format', async () => {
    const input = baseInput();
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter([]);
    const reader = mockReader();

    const result = await runBuildAgent(input, generator, committer, reader);

    expect(result.commitMessage).toBe(
      'feat(cache): Add caching module with LRU strategy — closes #42'
    );
  });

  it('commits to fork branch only', async () => {
    const input = baseInput();
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter([]);
    const reader = mockReader();

    await runBuildAgent(input, generator, committer, reader);

    expect(committer.commitChanges).toHaveBeenCalledWith(
      'my-org/my-repo',
      'agent/scope-42',
      expect.any(Array),
      expect.any(String)
    );
  });

  it('rejects upstream write access', async () => {
    const input = baseInput();
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter(['public_repo']);
    const reader = mockReader();

    await expect(
      runBuildAgent(input, generator, committer, reader)
    ).rejects.toThrow(UpstreamWriteAttemptError);
  });

  it('rejects documentation file creation', async () => {
    const input = baseInput();
    const output: ScaffoldGeneratorOutput = {
      moduleFiles: [
        { path: 'src/cache/cache.ts', action: 'create', content: '' },
        { path: 'src/cache/README.md', action: 'create', content: '# Cache' },
      ],
      testFiles: [{ path: 'src/cache/cache.test.ts', action: 'create', content: '' }],
      indexFiles: [],
      summary: 'Add cache with docs',
    };
    const generator = mockGenerator(output);
    const committer = mockCommitter([]);
    const reader = mockReader();

    await expect(
      runBuildAgent(input, generator, committer, reader)
    ).rejects.toThrow(BuildAgentError);
  });

  it('rejects out-of-scope module files', async () => {
    const input = baseInput();
    const output: ScaffoldGeneratorOutput = {
      moduleFiles: [
        { path: 'src/auth/hack.ts', action: 'create', content: '' },
      ],
      testFiles: [{ path: 'src/cache/cache.test.ts', action: 'create', content: '' }],
      indexFiles: [],
      summary: 'hack',
    };
    const generator = mockGenerator(output);
    const committer = mockCommitter([]);
    const reader = mockReader();

    await expect(
      runBuildAgent(input, generator, committer, reader)
    ).rejects.toThrow(BuildAgentError);
  });

  it('rejects missing test files', async () => {
    const input = baseInput();
    const output: ScaffoldGeneratorOutput = {
      moduleFiles: [
        { path: 'src/cache/cache.ts', action: 'create', content: '' },
      ],
      testFiles: [],
      indexFiles: [],
      summary: 'no tests',
    };
    const generator = mockGenerator(output);
    const committer = mockCommitter([]);
    const reader = mockReader();

    await expect(
      runBuildAgent(input, generator, committer, reader)
    ).rejects.toThrow(BuildAgentError);
  });

  it('handles empty generator output', async () => {
    const input = baseInput();
    const output: ScaffoldGeneratorOutput = {
      moduleFiles: [],
      testFiles: [],
      indexFiles: [],
      summary: '',
    };
    const generator = mockGenerator(output);
    const committer = mockCommitter([]);
    const reader = mockReader();

    const result = await runBuildAgent(input, generator, committer, reader);

    expect(result.success).toBe(false);
    expect(result.summary).toBe('No scaffold generated');
    expect(committer.commitChanges).not.toHaveBeenCalled();
  });

  it('passes full input to generator', async () => {
    const input = baseInput();
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter([]);
    const reader = mockReader();

    await runBuildAgent(input, generator, committer, reader);

    expect(generator.generateScaffold).toHaveBeenCalledWith(input);
  });

  it('includes multiple issue IDs in commit', async () => {
    const input = baseInput({
      confirmedIssues: [
        { number: 42, title: 'Cache', body: '', labels: [] },
        { number: 56, title: 'LRU', body: '', labels: [] },
      ],
    });
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter([]);
    const reader = mockReader();

    const result = await runBuildAgent(input, generator, committer, reader);

    expect(result.closesIssues).toEqual([42, 56]);
    expect(result.commitMessage).toContain('#42, #56');
  });

  it('uses design summary context (passed to generator)', async () => {
    const input = baseInput({ designSummary: 'Implement LRU cache with TTL' });
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter([]);
    const reader = mockReader();

    await runBuildAgent(input, generator, committer, reader);

    const callArg = (generator.generateScaffold as jest.Mock).mock.calls[0][0];
    expect(callArg.designSummary).toBe('Implement LRU cache with TTL');
  });

  it('passes contributing guide to generator', async () => {
    const input = baseInput({ contributingGuide: '# Contributing\nUse conventional commits.' });
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter([]);
    const reader = mockReader();

    await runBuildAgent(input, generator, committer, reader);

    const callArg = (generator.generateScaffold as jest.Mock).mock.calls[0][0];
    expect(callArg.contributingGuide).toBe('# Contributing\nUse conventional commits.');
  });

  it('passes reference modules to generator', async () => {
    const input = baseInput();
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter([]);
    const reader = mockReader();

    await runBuildAgent(input, generator, committer, reader);

    const callArg = (generator.generateScaffold as jest.Mock).mock.calls[0][0];
    expect(callArg.referenceModules).toHaveLength(1);
    expect(callArg.referenceModules[0].path).toBe('src/auth');
  });

  it('works with null contributing guide', async () => {
    const input = baseInput({ contributingGuide: null });
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter([]);
    const reader = mockReader();

    const result = await runBuildAgent(input, generator, committer, reader);
    expect(result.success).toBe(true);
  });

  it('mirrors structure — creates module, test, and index files', async () => {
    const input = baseInput();
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter([]);
    const reader = mockReader();

    const result = await runBuildAgent(input, generator, committer, reader);

    expect(result.moduleFiles.some((f) => f.path.includes('cache.ts'))).toBe(true);
    expect(result.moduleFiles.some((f) => f.path.includes('index.ts'))).toBe(true);
    expect(result.testFiles.some((f) => f.path.includes('.test.ts'))).toBe(true);
    expect(result.indexFiles.some((f) => f.path.includes('index.ts'))).toBe(true);
  });

  it('all module file changes are creates', async () => {
    const input = baseInput();
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter([]);
    const reader = mockReader();

    const result = await runBuildAgent(input, generator, committer, reader);

    for (const f of result.moduleFiles) {
      expect(f.action).toBe('create');
    }
    for (const f of result.testFiles) {
      expect(f.action).toBe('create');
    }
  });

  it('error phase is correct for doc validation', async () => {
    const input = baseInput();
    const output: ScaffoldGeneratorOutput = {
      moduleFiles: [{ path: 'src/cache/CHANGELOG.md', action: 'create', content: '' }],
      testFiles: [{ path: 'src/cache/cache.test.ts', action: 'create', content: '' }],
      indexFiles: [],
      summary: 'bad',
    };
    const generator = mockGenerator(output);
    const committer = mockCommitter([]);
    const reader = mockReader();

    try {
      await runBuildAgent(input, generator, committer, reader);
      fail('Should have thrown');
    } catch (e: any) {
      expect(e.phase).toBe('doc_validation');
    }
  });

  it('error phase is correct for scope validation', async () => {
    const input = baseInput();
    const output: ScaffoldGeneratorOutput = {
      moduleFiles: [{ path: 'src/other/file.ts', action: 'create', content: '' }],
      testFiles: [{ path: 'src/cache/cache.test.ts', action: 'create', content: '' }],
      indexFiles: [],
      summary: 'out of scope',
    };
    const generator = mockGenerator(output);
    const committer = mockCommitter([]);
    const reader = mockReader();

    try {
      await runBuildAgent(input, generator, committer, reader);
      fail('Should have thrown');
    } catch (e: any) {
      expect(e.phase).toBe('scope_validation');
    }
  });

  it('error phase is correct for test validation', async () => {
    const input = baseInput();
    const output: ScaffoldGeneratorOutput = {
      moduleFiles: [{ path: 'src/cache/cache.ts', action: 'create', content: '' }],
      testFiles: [],
      indexFiles: [],
      summary: 'no tests',
    };
    const generator = mockGenerator(output);
    const committer = mockCommitter([]);
    const reader = mockReader();

    try {
      await runBuildAgent(input, generator, committer, reader);
      fail('Should have thrown');
    } catch (e: any) {
      expect(e.phase).toBe('test_validation');
    }
  });

  it('error phase is correct for index validation', async () => {
    const input = baseInput();
    const output: ScaffoldGeneratorOutput = {
      moduleFiles: [{ path: 'src/cache/cache.ts', action: 'create', content: '' }],
      testFiles: [{ path: 'src/cache/cache.test.ts', action: 'create', content: '' }],
      indexFiles: [{ path: 'src/index.ts', action: 'modify', content: 'nothing relevant' }],
      summary: 'bad index',
    };
    const generator = mockGenerator(output);
    const committer = mockCommitter([]);
    const reader = mockReader();

    try {
      await runBuildAgent(input, generator, committer, reader);
      fail('Should have thrown');
    } catch (e: any) {
      expect(e.phase).toBe('index_validation');
    }
  });

  it('does not update external documentation', async () => {
    // The build agent defers documentation to a follow-up docs agent pass
    const input = baseInput();
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter([]);
    const reader = mockReader();

    const result = await runBuildAgent(input, generator, committer, reader);

    const allFiles = [...result.moduleFiles, ...result.testFiles, ...result.indexFiles];
    for (const f of allFiles) {
      expect(f.path).not.toMatch(/\.(md|rst|txt|adoc|mdx)$/i);
    }
  });

  it('commit message uses feat prefix not fix', async () => {
    const input = baseInput();
    const generator = mockGenerator(validScaffoldOutput());
    const committer = mockCommitter([]);
    const reader = mockReader();

    const result = await runBuildAgent(input, generator, committer, reader);

    expect(result.commitMessage).toMatch(/^feat\(/);
    expect(result.commitMessage).not.toMatch(/^fix\(/);
  });
});
