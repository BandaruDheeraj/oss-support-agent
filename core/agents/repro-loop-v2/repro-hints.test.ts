import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  discoverEditableInstallCandidates,
  deriveEditableInstallsFromSuspectPaths,
  mergeEditableInstallCandidates,
  extractIssueCodeSnippets,
  renderEditableInstallsBlock,
  renderIssueSnippetsBlock,
  detectHeavyFrameworkSignal,
  type IssueCodeSnippet,
} from './repro-hints';
import type { SuspectSymbol } from '../analyst/dossier';

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

  it('caps results at 20 entries (validator max)', () => {
    const layout: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      layout[`pkg${i}/pyproject.toml`] = `[project]\nname="pkg${i}"\n`;
    }
    dir = makeTempRepo(layout);
    const got = discoverEditableInstallCandidates(dir);
    expect(got.length).toBeLessThanOrEqual(20);
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

describe('deriveEditableInstallsFromSuspectPaths', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmrf(dir);
    dir = null;
  });

  it('returns [] when workspace does not exist', () => {
    expect(deriveEditableInstallsFromSuspectPaths('/no/such/path/xyz', ['a/b.py'])).toEqual([]);
  });

  it('returns [] when filePaths is empty', () => {
    dir = makeTempRepo({ 'pkg/pyproject.toml': '[tool]\n' });
    expect(deriveEditableInstallsFromSuspectPaths(dir, [])).toEqual([]);
  });

  it('finds the nearest ancestor with a manifest for a suspect file', () => {
    dir = makeTempRepo({
      'python/instrumentation/openinference-instrumentation-smolagents/pyproject.toml': '[tool]\n',
      'python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py': 'pass\n',
    });
    const got = deriveEditableInstallsFromSuspectPaths(dir, [
      'python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py',
    ]);
    expect(got).toContain('python/instrumentation/openinference-instrumentation-smolagents');
  });

  it('de-duplicates across multiple suspect files in the same package', () => {
    dir = makeTempRepo({
      'pkg/pyproject.toml': '[tool]\n',
      'pkg/a.py': 'pass\n',
      'pkg/b.py': 'pass\n',
    });
    const got = deriveEditableInstallsFromSuspectPaths(dir, ['pkg/a.py', 'pkg/b.py']);
    expect(got).toEqual(['pkg']);
  });

  it('skips suspect paths whose ancestors have no manifest', () => {
    dir = makeTempRepo({ 'src/foo/bar.py': 'pass\n' });
    expect(deriveEditableInstallsFromSuspectPaths(dir, ['src/foo/bar.py'])).toEqual([]);
  });

  it('normalises backslashes and leading slashes in paths', () => {
    dir = makeTempRepo({ 'pkg/pyproject.toml': '[tool]\n', 'pkg/x.py': '' });
    const got = deriveEditableInstallsFromSuspectPaths(dir, ['\\pkg\\x.py']);
    expect(got).toEqual(['pkg']);
  });
});

describe('mergeEditableInstallCandidates', () => {
  it('prioritises prioritized entries first, de-duplicates, caps at 20', () => {
    const prioritized = ['a', 'b', 'a'];
    const fallback = Array.from({ length: 22 }, (_, i) => `pkg${i}`);
    const out = mergeEditableInstallCandidates(prioritized, fallback);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out[0]).toBe('a');
    expect(out[1]).toBe('b');
  });

  it('returns [] when both inputs are empty', () => {
    expect(mergeEditableInstallCandidates([], [])).toEqual([]);
  });

  it('rejects "." and empty entries', () => {
    expect(mergeEditableInstallCandidates(['.', '', 'pkg'], ['pkg2'])).toEqual(['pkg', 'pkg2']);
  });
});

function snip(code: string, language = 'python'): IssueCodeSnippet {
  return { language, code };
}
function suspect(file: string, symbol = 'fn', reasoning = 'r'): SuspectSymbol {
  return { file, symbol, reasoning };
}

describe('detectHeavyFrameworkSignal', () => {
  it('returns true when a snippet imports a heavy framework (snippet signal)', () => {
    expect(
      detectHeavyFrameworkSignal({ snippets: [snip('from smolagents import CodeAgent')] })
    ).toBe(true);
  });

  it('returns false when snippets have no heavy framework imports and no other signals', () => {
    expect(detectHeavyFrameworkSignal({ snippets: [snip('import json\nprint(1)')] })).toBe(false);
  });

  it('returns true on prose-only issue body with framework name near "Install"', () => {
    const body = `### Reproduction\n1. Install openinference-instrumentation-smolagents\n2. Do not configure OTel\n`;
    expect(detectHeavyFrameworkSignal({ issueBody: body })).toBe(true);
  });

  it('returns true when issue body uses pip + heavy framework within window', () => {
    const body = `Run \`pip install langchain\` then call the agent.`;
    expect(detectHeavyFrameworkSignal({ issueBody: body })).toBe(true);
  });

  it('returns false on casual mention of langchain without install-adjacent token', () => {
    const body = `I am using langchain in my stack but the bug is in our own router code at the /api/foo endpoint. The traceback was about JSON serialization.`;
    expect(detectHeavyFrameworkSignal({ issueBody: body })).toBe(false);
  });

  it('normalises framework aliases (llama-index / llama_index / llamaindex)', () => {
    for (const alias of ['llama-index', 'llama_index', 'llamaindex']) {
      const body = `pip install ${alias} then run`;
      expect(detectHeavyFrameworkSignal({ issueBody: body })).toBe(true);
    }
  });

  it('returns true on dossier suspectSymbol path matching instrumentation-<framework>', () => {
    const ss = [
      suspect(
        'python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py'
      ),
    ];
    expect(detectHeavyFrameworkSignal({ suspectSymbols: ss })).toBe(true);
  });

  it('returns true on dossier suspectSymbol path containing /<framework>/ segment', () => {
    const ss = [suspect('python/instrumentation/foo/src/openinference/instrumentation/autogen/wrappers.py')];
    expect(detectHeavyFrameworkSignal({ suspectSymbols: ss })).toBe(true);
  });

  it('returns false on unrelated suspect paths and bland body', () => {
    const ss = [suspect('src/router/handler.py')];
    expect(
      detectHeavyFrameworkSignal({ issueBody: 'plain bug, no frameworks', suspectSymbols: ss })
    ).toBe(false);
  });
});
