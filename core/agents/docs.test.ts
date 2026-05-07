/**
 * Unit tests for the docs agent (US-010).
 */

import {
  formatDocsCommitMessage,
  isDocumentationFile,
  isApplicationCode,
  validateDocsOnly,
  verifyForkOnlyAccess,
  readDocFiles,
  runDocsAgent,
} from './docs';
import {
  DocsAgentInput,
  DocsGenerator,
  DocsGeneratorOutput,
  DocsAgentError,
  FileChange,
  ForkCommitter,
  RepoFileReader,
} from './docs-types';

// --- Helpers ---

function makeInput(overrides: Partial<DocsAgentInput> = {}): DocsAgentInput {
  return {
    confirmedIssues: [{ number: 42, title: 'Fix typo in README', body: null, labels: ['docs'] }],
    affectedModule: 'docs/',
    docFiles: [{ path: 'docs/guide.md', content: '# Guide\nOld content' }],
    recentCommits: [],
    forkFullName: 'my-org/my-repo',
    branchName: 'agent/scope-42',
    triageSummary: 'docs: fix typo in README',
    ...overrides,
  };
}

function makeMockCommitter(scopes: string[] = []): ForkCommitter {
  return {
    commitChanges: jest.fn().mockResolvedValue('abc123'),
    getTokenScopes: jest.fn().mockResolvedValue(scopes),
  };
}

function makeMockReader(files: string[] = [], contents: Record<string, string> = {}): RepoFileReader {
  return {
    listFiles: jest.fn().mockResolvedValue(files),
    readFile: jest.fn().mockImplementation((_f, _b, path) =>
      Promise.resolve(contents[path] || '')
    ),
  };
}

function makeMockGenerator(output: DocsGeneratorOutput): DocsGenerator {
  return {
    generateDocs: jest.fn().mockResolvedValue(output),
  };
}

// --- formatDocsCommitMessage ---

describe('formatDocsCommitMessage', () => {
  it('formats with single issue ID', () => {
    expect(formatDocsCommitMessage('fix typo in README', [42]))
      .toBe('docs: fix typo in README — closes #42');
  });

  it('formats with multiple issue IDs', () => {
    expect(formatDocsCommitMessage('update API docs', [10, 20, 30]))
      .toBe('docs: update API docs — closes #10, #20, #30');
  });

  it('does not include module name (unlike fix agent)', () => {
    const msg = formatDocsCommitMessage('clarify installation steps', [5]);
    expect(msg).toBe('docs: clarify installation steps — closes #5');
    expect(msg).not.toMatch(/docs\(.+\):/);
  });
});

// --- isDocumentationFile ---

describe('isDocumentationFile', () => {
  it('recognizes .md files', () => {
    expect(isDocumentationFile('README.md')).toBe(true);
    expect(isDocumentationFile('docs/guide.md')).toBe(true);
    expect(isDocumentationFile('path/to/CHANGELOG.md')).toBe(true);
  });

  it('recognizes .rst files', () => {
    expect(isDocumentationFile('docs/index.rst')).toBe(true);
  });

  it('recognizes .txt files', () => {
    expect(isDocumentationFile('CHANGES.txt')).toBe(true);
  });

  it('recognizes .adoc files', () => {
    expect(isDocumentationFile('guide.adoc')).toBe(true);
  });

  it('recognizes .mdx files', () => {
    expect(isDocumentationFile('docs/tutorial.mdx')).toBe(true);
  });

  it('recognizes files in docs/ directory', () => {
    expect(isDocumentationFile('docs/api.yaml')).toBe(true);
    expect(isDocumentationFile('docs/images/diagram.png')).toBe(true);
  });

  it('recognizes named doc files (README, CHANGELOG, etc.)', () => {
    expect(isDocumentationFile('README')).toBe(true);
    expect(isDocumentationFile('CHANGELOG')).toBe(true);
    expect(isDocumentationFile('CONTRIBUTING')).toBe(true);
    expect(isDocumentationFile('SECURITY.md')).toBe(true);
  });

  it('rejects application code files', () => {
    expect(isDocumentationFile('src/index.ts')).toBe(false);
    expect(isDocumentationFile('lib/utils.py')).toBe(false);
    expect(isDocumentationFile('main.go')).toBe(false);
  });

  it('rejects unknown file types', () => {
    expect(isDocumentationFile('config.yaml')).toBe(false);
    expect(isDocumentationFile('data.json')).toBe(false);
  });
});

// --- isApplicationCode ---

describe('isApplicationCode', () => {
  it('detects TypeScript files', () => {
    expect(isApplicationCode('src/index.ts')).toBe(true);
    expect(isApplicationCode('components/App.tsx')).toBe(true);
  });

  it('detects JavaScript files', () => {
    expect(isApplicationCode('lib/utils.js')).toBe(true);
    expect(isApplicationCode('config.mjs')).toBe(true);
  });

  it('detects Python files', () => {
    expect(isApplicationCode('main.py')).toBe(true);
    expect(isApplicationCode('types.pyi')).toBe(true);
  });

  it('detects Go files', () => {
    expect(isApplicationCode('cmd/server.go')).toBe(true);
  });

  it('detects Rust files', () => {
    expect(isApplicationCode('src/lib.rs')).toBe(true);
  });

  it('does not flag documentation files', () => {
    expect(isApplicationCode('README.md')).toBe(false);
    expect(isApplicationCode('docs/guide.rst')).toBe(false);
    expect(isApplicationCode('CHANGELOG')).toBe(false);
  });
});

// --- validateDocsOnly ---

describe('validateDocsOnly', () => {
  it('passes when all changes are documentation files', () => {
    const changes: FileChange[] = [
      { path: 'README.md', action: 'modify', content: 'updated' },
      { path: 'docs/guide.md', action: 'create', content: 'new guide' },
      { path: 'CONTRIBUTING.md', action: 'modify', content: 'updated' },
    ];
    const result = validateDocsOnly(changes);
    expect(result.valid).toBe(true);
    expect(result.invalidFiles).toHaveLength(0);
  });

  it('rejects application code changes', () => {
    const changes: FileChange[] = [
      { path: 'README.md', action: 'modify', content: 'updated' },
      { path: 'src/index.ts', action: 'modify', content: 'code change' },
    ];
    const result = validateDocsOnly(changes);
    expect(result.valid).toBe(false);
    expect(result.invalidFiles).toContain('src/index.ts');
  });

  it('rejects unknown file types', () => {
    const changes: FileChange[] = [
      { path: 'config.yaml', action: 'modify', content: 'changes' },
    ];
    const result = validateDocsOnly(changes);
    expect(result.valid).toBe(false);
    expect(result.invalidFiles).toContain('config.yaml');
  });

  it('handles empty changes array', () => {
    const result = validateDocsOnly([]);
    expect(result.valid).toBe(true);
    expect(result.invalidFiles).toHaveLength(0);
  });

  it('reports all invalid files', () => {
    const changes: FileChange[] = [
      { path: 'src/index.ts', action: 'modify', content: 'a' },
      { path: 'lib/utils.py', action: 'modify', content: 'b' },
      { path: 'README.md', action: 'modify', content: 'c' },
    ];
    const result = validateDocsOnly(changes);
    expect(result.valid).toBe(false);
    expect(result.invalidFiles).toHaveLength(2);
    expect(result.invalidFiles).toContain('src/index.ts');
    expect(result.invalidFiles).toContain('lib/utils.py');
  });
});

// --- verifyForkOnlyAccess ---

describe('verifyForkOnlyAccess', () => {
  it('passes with narrow scopes', async () => {
    const committer = makeMockCommitter(['contents:write']);
    await expect(verifyForkOnlyAccess(committer)).resolves.not.toThrow();
  });

  it('passes with empty scopes', async () => {
    const committer = makeMockCommitter([]);
    await expect(verifyForkOnlyAccess(committer)).resolves.not.toThrow();
  });

  it('throws on public_repo scope', async () => {
    const committer = makeMockCommitter(['public_repo']);
    await expect(verifyForkOnlyAccess(committer)).rejects.toThrow(DocsAgentError);
  });

  it('throws on repo scope', async () => {
    const committer = makeMockCommitter(['repo']);
    await expect(verifyForkOnlyAccess(committer)).rejects.toThrow(DocsAgentError);
  });

  it('includes scope names in error message', async () => {
    const committer = makeMockCommitter(['public_repo', 'repo']);
    await expect(verifyForkOnlyAccess(committer)).rejects.toThrow('public_repo, repo');
  });
});

// --- readDocFiles ---

describe('readDocFiles', () => {
  it('lists and reads files from the module', async () => {
    const reader = makeMockReader(
      ['docs/guide.md', 'docs/api.md'],
      { 'docs/guide.md': '# Guide', 'docs/api.md': '# API' }
    );
    const result = await readDocFiles(reader, 'org/repo', 'branch', 'docs/');
    expect(result.files).toEqual(['docs/guide.md', 'docs/api.md']);
    expect(result.contents).toEqual(['# Guide', '# API']);
  });

  it('handles empty directory', async () => {
    const reader = makeMockReader([], {});
    const result = await readDocFiles(reader, 'org/repo', 'branch', 'docs/');
    expect(result.files).toEqual([]);
    expect(result.contents).toEqual([]);
  });
});

// --- runDocsAgent ---

describe('runDocsAgent', () => {
  const defaultOutput: DocsGeneratorOutput = {
    changes: [{ path: 'README.md', action: 'modify', content: '# Updated README' }],
    summary: 'fix typo in README',
  };

  it('produces a successful result on valid docs changes', async () => {
    const input = makeInput();
    const generator = makeMockGenerator(defaultOutput);
    const committer = makeMockCommitter([]);
    const reader = makeMockReader(['docs/guide.md'], { 'docs/guide.md': '# Guide' });

    const result = await runDocsAgent(input, generator, committer, reader);

    expect(result.success).toBe(true);
    expect(result.changes).toEqual(defaultOutput.changes);
    expect(result.summary).toBe('fix typo in README');
    expect(result.closesIssues).toEqual([42]);
  });

  it('formats commit message correctly', async () => {
    const input = makeInput();
    const generator = makeMockGenerator(defaultOutput);
    const committer = makeMockCommitter([]);
    const reader = makeMockReader([], {});

    const result = await runDocsAgent(input, generator, committer, reader);

    expect(result.commitMessage).toBe('docs: fix typo in README — closes #42');
  });

  it('handles multiple issue IDs in commit message', async () => {
    const input = makeInput({
      confirmedIssues: [
        { number: 10, title: 'Issue 10', body: null, labels: [] },
        { number: 20, title: 'Issue 20', body: null, labels: [] },
      ],
    });
    const generator = makeMockGenerator(defaultOutput);
    const committer = makeMockCommitter([]);
    const reader = makeMockReader([], {});

    const result = await runDocsAgent(input, generator, committer, reader);

    expect(result.commitMessage).toBe('docs: fix typo in README — closes #10, #20');
    expect(result.closesIssues).toEqual([10, 20]);
  });

  it('commits to the fork branch only', async () => {
    const input = makeInput();
    const generator = makeMockGenerator(defaultOutput);
    const committer = makeMockCommitter([]);
    const reader = makeMockReader([], {});

    await runDocsAgent(input, generator, committer, reader);

    expect(committer.commitChanges).toHaveBeenCalledWith(
      'my-org/my-repo',
      'agent/scope-42',
      defaultOutput.changes,
      expect.stringContaining('docs:')
    );
  });

  it('rejects upstream write access', async () => {
    const input = makeInput();
    const generator = makeMockGenerator(defaultOutput);
    const committer = makeMockCommitter(['public_repo']);
    const reader = makeMockReader([], {});

    await expect(runDocsAgent(input, generator, committer, reader))
      .rejects.toThrow(DocsAgentError);
  });

  it('rejects application code changes', async () => {
    const input = makeInput();
    const generator = makeMockGenerator({
      changes: [
        { path: 'README.md', action: 'modify', content: 'ok' },
        { path: 'src/index.ts', action: 'modify', content: 'code!' },
      ],
      summary: 'mixed changes',
    });
    const committer = makeMockCommitter([]);
    const reader = makeMockReader([], {});

    await expect(runDocsAgent(input, generator, committer, reader))
      .rejects.toThrow('must only modify documentation files');
  });

  it('error includes invalid file names', async () => {
    const input = makeInput();
    const generator = makeMockGenerator({
      changes: [{ path: 'lib/utils.py', action: 'modify', content: 'code' }],
      summary: 'bad change',
    });
    const committer = makeMockCommitter([]);
    const reader = makeMockReader([], {});

    await expect(runDocsAgent(input, generator, committer, reader))
      .rejects.toThrow('lib/utils.py');
  });

  it('returns failure when no changes generated', async () => {
    const input = makeInput();
    const generator = makeMockGenerator({ changes: [], summary: '' });
    const committer = makeMockCommitter([]);
    const reader = makeMockReader([], {});

    const result = await runDocsAgent(input, generator, committer, reader);

    expect(result.success).toBe(false);
    expect(result.changes).toHaveLength(0);
    expect(result.commitMessage).toBe('');
    expect(result.closesIssues).toHaveLength(0);
  });

  it('does not commit when no changes generated', async () => {
    const input = makeInput();
    const generator = makeMockGenerator({ changes: [], summary: '' });
    const committer = makeMockCommitter([]);
    const reader = makeMockReader([], {});

    await runDocsAgent(input, generator, committer, reader);

    expect(committer.commitChanges).not.toHaveBeenCalled();
  });

  it('reads docs files before generating changes', async () => {
    const input = makeInput();
    const generator = makeMockGenerator(defaultOutput);
    const committer = makeMockCommitter([]);
    const reader = makeMockReader(['docs/guide.md'], { 'docs/guide.md': '# Guide' });

    await runDocsAgent(input, generator, committer, reader);

    expect(reader.listFiles).toHaveBeenCalledWith('my-org/my-repo', 'agent/scope-42', 'docs/');
    expect(reader.readFile).toHaveBeenCalledWith('my-org/my-repo', 'agent/scope-42', 'docs/guide.md');
  });

  it('passes input to the generator', async () => {
    const input = makeInput();
    const generator = makeMockGenerator(defaultOutput);
    const committer = makeMockCommitter([]);
    const reader = makeMockReader([], {});

    await runDocsAgent(input, generator, committer, reader);

    expect(generator.generateDocs).toHaveBeenCalledWith(input);
  });

  it('allows changes to files in docs/ directory even if not .md', async () => {
    const input = makeInput();
    const generator = makeMockGenerator({
      changes: [
        { path: 'docs/openapi.yaml', action: 'modify', content: 'updated spec' },
        { path: 'docs/images/diagram.png', action: 'create', content: 'binary' },
      ],
      summary: 'update API spec and diagram',
    });
    const committer = makeMockCommitter([]);
    const reader = makeMockReader([], {});

    const result = await runDocsAgent(input, generator, committer, reader);

    expect(result.success).toBe(true);
  });

  it('allows CHANGELOG and CONTRIBUTING files', async () => {
    const input = makeInput();
    const generator = makeMockGenerator({
      changes: [
        { path: 'CHANGELOG.md', action: 'modify', content: 'new entry' },
        { path: 'CONTRIBUTING.md', action: 'modify', content: 'updated' },
      ],
      summary: 'update changelog and contributing guide',
    });
    const committer = makeMockCommitter([]);
    const reader = makeMockReader([], {});

    const result = await runDocsAgent(input, generator, committer, reader);

    expect(result.success).toBe(true);
  });

  it('skips PM agent (no design summary required)', async () => {
    // Docs agent input does NOT require designSummary (unlike fix agent)
    const input = makeInput({ triageSummary: 'docs issue triaged directly' });
    const generator = makeMockGenerator(defaultOutput);
    const committer = makeMockCommitter([]);
    const reader = makeMockReader([], {});

    const result = await runDocsAgent(input, generator, committer, reader);

    expect(result.success).toBe(true);
    // The fact that it completes without designSummary proves PM is skipped
  });

  it('DocsAgentError has correct phase for docs validation', async () => {
    const input = makeInput();
    const generator = makeMockGenerator({
      changes: [{ path: 'src/main.ts', action: 'modify', content: 'code' }],
      summary: 'bad',
    });
    const committer = makeMockCommitter([]);
    const reader = makeMockReader([], {});

    try {
      await runDocsAgent(input, generator, committer, reader);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DocsAgentError);
      expect((err as DocsAgentError).phase).toBe('docs_validation');
    }
  });

  it('DocsAgentError has correct phase for token verification', async () => {
    const input = makeInput();
    const generator = makeMockGenerator(defaultOutput);
    const committer = makeMockCommitter(['repo']);
    const reader = makeMockReader([], {});

    try {
      await runDocsAgent(input, generator, committer, reader);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DocsAgentError);
      expect((err as DocsAgentError).phase).toBe('token_verification');
    }
  });

  it('result routes to same sandbox + eval + PR flow (structured output)', async () => {
    const input = makeInput();
    const generator = makeMockGenerator(defaultOutput);
    const committer = makeMockCommitter([]);
    const reader = makeMockReader([], {});

    const result = await runDocsAgent(input, generator, committer, reader);

    // The result has the same shape needed for sandbox + eval + PR flow
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('changes');
    expect(result).toHaveProperty('commitMessage');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('closesIssues');
    // Compatible with eval agent input (fixSummary = summary, changes for PR body)
    expect(typeof result.summary).toBe('string');
    expect(Array.isArray(result.changes)).toBe(true);
    expect(Array.isArray(result.closesIssues)).toBe(true);
  });
});
