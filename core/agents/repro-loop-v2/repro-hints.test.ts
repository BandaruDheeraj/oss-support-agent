import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  discoverEditableInstallCandidates,
  extractIssueCodeSnippets,
  renderEditableInstallsBlock,
  renderIssueSnippetsBlock,
} from './repro-hints';

function makeTempRepo(layout: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-hints-'));
  for (const [rel, content] of Object.entries(layout)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('discoverEditableInstallCandidates', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmrf(dir);
    dir = null;
  });

  it('returns [] for nonexistent dir', () => {
    expect(discoverEditableInstallCandidates('/path/that/does/not/exist/xyz')).toEqual([]);
  });

  it('returns [] when no manifests are found', () => {
    dir = makeTempRepo({
      'README.md': '# hi',
      'src/foo.py': 'pass',
    });
    expect(discoverEditableInstallCandidates(dir)).toEqual([]);
  });

  it('walks up from affectedModule and prefers innermost manifest', () => {
    dir = makeTempRepo({
      'pyproject.toml': '[project]\nname="root"\n',
      'python/instrumentation/openinference-instrumentation-smolagents/pyproject.toml':
        '[project]\nname="oi-smolagents"\n',
      // Inner pyproject simulating a nested package — should be picked first.
      'python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/pyproject.toml':
        '[project]\nname="oi-smolagents-inner"\n',
      'python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py':
        '# stub',
    });
    const got = discoverEditableInstallCandidates(dir, {
      affectedModule:
        'python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py',
    });
    // Innermost manifest dir comes first; root "." is filtered out.
    expect(got[0]).toBe(
      'python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents'
    );
    // The outer instrumentation package dir should also be present.
    expect(got).toContain(
      'python/instrumentation/openinference-instrumentation-smolagents'
    );
  });

  it('falls back to repo-wide BFS when affectedModule has no manifest ancestors', () => {
    dir = makeTempRepo({
      // Triage gave us an import-style module path that doesn't exist on disk.
      'python/instrumentation/openinference-instrumentation-smolagents/pyproject.toml':
        '[project]\nname="oi-smolagents"\n',
      'python/instrumentation/openinference-instrumentation-other/setup.py':
        'from setuptools import setup\nsetup()',
    });
    const got = discoverEditableInstallCandidates(dir, {
      affectedModule:
        'openinference/instrumentation/smolagents/_wrappers.py', // import path, not on disk
    });
    expect(got.sort()).toEqual([
      'python/instrumentation/openinference-instrumentation-other',
      'python/instrumentation/openinference-instrumentation-smolagents',
    ]);
  });

  it('detects setup.py and setup.cfg, ignores ignored dirs', () => {
    dir = makeTempRepo({
      'pkg-a/setup.py': 'from setuptools import setup\nsetup()',
      'pkg-b/setup.cfg': '[metadata]\nname=pkg-b\n',
      'node_modules/pkg-c/pyproject.toml': '[project]\nname="ignored"\n',
      '.venv/pkg-d/pyproject.toml': '[project]\nname="ignored"\n',
    });
    const got = discoverEditableInstallCandidates(dir);
    expect(got.sort()).toEqual(['pkg-a', 'pkg-b']);
  });

  it('drops candidates that fail validateReproSetup (defensive)', () => {
    // Filenames with spaces / unsafe chars are not in this fixture because
    // the BFS won't surface them: validateReproSetup's regex would reject
    // entries like "weird dir" (contains space). Fixture is a sanity check
    // that valid entries survive.
    dir = makeTempRepo({
      'src/foo/pyproject.toml': '[project]\nname="foo"\n',
    });
    const got = discoverEditableInstallCandidates(dir);
    expect(got).toEqual(['src/foo']);
  });

  it('caps results at 5 entries (validator max)', () => {
    const layout: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      layout[`pkg${i}/pyproject.toml`] = `[project]\nname="pkg${i}"\n`;
    }
    dir = makeTempRepo(layout);
    const got = discoverEditableInstallCandidates(dir);
    expect(got.length).toBeLessThanOrEqual(5);
  });
});

describe('extractIssueCodeSnippets', () => {
  it('returns [] for null/empty body', () => {
    expect(extractIssueCodeSnippets(null)).toEqual([]);
    expect(extractIssueCodeSnippets(undefined)).toEqual([]);
    expect(extractIssueCodeSnippets('')).toEqual([]);
  });

  it('returns [] when body has no fences', () => {
    expect(
      extractIssueCodeSnippets('I am hitting a NoneType crash in the foo bar baz module')
    ).toEqual([]);
  });

  it('extracts a tagged python snippet', () => {
    const body = '## repro\n\n```python\nimport foo\nfoo.bar()\n```\n';
    const got = extractIssueCodeSnippets(body);
    expect(got).toHaveLength(1);
    expect(got[0].language).toBe('python');
    expect(got[0].code).toContain('import foo');
    expect(got[0].code).toContain('foo.bar()');
  });

  it('extracts multiple snippets and prefers tagged languages first', () => {
    const body =
      'context\n\n```\nplain block\n```\n\nthen\n\n```python\nimport x\n```\n\nand\n\n```bash\npip install x\n```\n';
    const got = extractIssueCodeSnippets(body);
    expect(got.map((s) => s.language)).toEqual(['python', 'bash', '']);
  });

  it('caps at 3 snippets and dedupes identical bodies', () => {
    const block = '```python\nimport same\nsame.run()\n```';
    const body = `${block}\n\n${block}\n\n${block}\n\n\`\`\`bash\npip install x\n\`\`\`\n\n\`\`\`sh\necho hi\n\`\`\`\n\n\`\`\`go\npackage main\n\`\`\`\n`;
    const got = extractIssueCodeSnippets(body);
    expect(got.length).toBe(3);
    // First entry is the deduped python block
    expect(got[0].language).toBe('python');
    // No duplicate python entries
    expect(got.filter((s) => s.code.includes('import same')).length).toBe(1);
  });

  it('truncates oversize snippets', () => {
    const huge = 'x'.repeat(5_000);
    const body = '```python\n' + huge + '\n```\n';
    const got = extractIssueCodeSnippets(body);
    expect(got).toHaveLength(1);
    expect(got[0].code.length).toBeLessThan(huge.length);
    expect(got[0].code).toContain('truncated by repro-hints');
  });

  it('skips empty fences', () => {
    const body = '```python\n\n```\n\n```python\nimport real\n```\n';
    const got = extractIssueCodeSnippets(body);
    expect(got).toHaveLength(1);
    expect(got[0].code).toContain('import real');
  });
});

describe('renderIssueSnippetsBlock', () => {
  it('returns null for empty input', () => {
    expect(renderIssueSnippetsBlock([])).toBeNull();
  });

  it('renders a labelled block with the snippets', () => {
    const out = renderIssueSnippetsBlock([
      { language: 'python', code: 'import x\nx.run()' },
    ]);
    expect(out).toContain('Verbatim code snippets from the issue body');
    expect(out).toContain('Snippet 1');
    expect(out).toContain('```python');
    expect(out).toContain('import x');
  });
});

describe('renderEditableInstallsBlock', () => {
  it('returns null for empty input', () => {
    expect(renderEditableInstallsBlock([])).toBeNull();
  });

  it('renders a bullet list with the candidates', () => {
    const out = renderEditableInstallsBlock([
      'python/instrumentation/openinference-instrumentation-smolagents',
      'pkg/foo',
    ]);
    expect(out).toContain('Candidate editable-install dirs');
    expect(out).toContain('pip install -e <dir>');
    expect(out).toContain('- python/instrumentation/openinference-instrumentation-smolagents');
    expect(out).toContain('- pkg/foo');
  });
});
