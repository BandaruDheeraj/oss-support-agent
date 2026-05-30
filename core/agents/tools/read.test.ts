import type { GrepMatch } from './handles';
import {
  extractSymbolSearchCandidates,
  findCallers,
  findSymbol,
  grepWithContext,
  readIssueRepoContext,
  readSymbolContext,
} from './read';
import type { ToolContext } from './types';

function makeCtx(
  grepImpl: (
    pattern: string,
    paths: string[] | undefined,
    flags: { caseInsensitive?: boolean },
  ) => Promise<GrepMatch[]>,
  readFileImpl?: (path: string) => Promise<string | null>,
): ToolContext {
  return {
    agentName: 'TEST',
    attemptId: 'attempt-1',
    issueNumber: 46,
    handles: {
      workspace: {
        grep: grepImpl,
        readFile: readFileImpl ?? (async () => null),
      },
      issue: {
        number: 46,
        title: 'bug title',
        body: 'issue body',
        labels: ['bug'],
        url: 'https://github.com/o/r/issues/46',
      },
      repo: {
        fullName: 'o/r',
        forkFullName: 'me/r',
        branch: 'agent/46',
        baselineSha: 'abc123',
        affectedModule: 'src',
        language: 'python',
      },
    },
    recordTranscript: () => {},
    getTranscript: () => [],
  };
}

describe('read-tier symbol lookup tools', () => {
  test('extractSymbolSearchCandidates normalizes qualified call-form symbols', () => {
    const candidates = extractSymbolSearchCandidates(
      'openinference.instrumentation.smolagents._wrappers._finalize_step_span(step_log)'
    );
    expect(candidates[0]).toBe('_finalize_step_span');
    expect(candidates).toContain('_wrappers');
    expect(candidates).toContain('smolagents');
  });

  test('find_symbol uses grep -E compatible patterns and finds normalized symbols', async () => {
    const grep = jest.fn(async (pattern: string) => {
      expect(pattern).not.toContain('?:');
      expect(pattern).not.toContain('\\b');
      expect(pattern).not.toContain('\\s');
      if (pattern.includes('_finalize_step_span')) {
        return [
          {
            path: 'python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py',
            line: 235,
            text: 'def _finalize_step_span(self, result: Any) -> None:',
          },
          {
            path: 'python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py',
            line: 235,
            text: 'def _finalize_step_span(self, result: Any) -> None:',
          },
        ];
      }
      return [];
    });
    const result = (await findSymbol.execute(
      { symbol: 'openinference.instrumentation.smolagents._wrappers._finalize_step_span(step_log)' },
      makeCtx(grep)
    )) as { matches: GrepMatch[] };
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].line).toBe(235);
  });

  test('find_callers falls back to non-call symbol lookup when needed', async () => {
    const grep = jest
      .fn<Promise<GrepMatch[]>, [string, string[] | undefined, { caseInsensitive?: boolean }]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          path: 'tests/repro/test_issue_46.py',
          line: 29,
          text: 'helper = _finalize_step_span',
        },
      ]);

    const result = (await findCallers.execute({ symbol: '_StepWrapper._finalize_step_span(step_log)' }, makeCtx(grep))) as {
      matches: GrepMatch[];
    };
    expect(result.matches).toHaveLength(1);
    expect(grep).toHaveBeenCalledTimes(2);
    expect(grep.mock.calls[0][0]).toContain('_finalize_step_span');
  });

  test('read_issue_repo_context returns issue + repo in one call', async () => {
    const result = (await readIssueRepoContext.execute({ includeBody: false }, makeCtx(async () => []))) as any;
    expect(result.issue.number).toBe(46);
    expect(result.issue.body).toBeUndefined();
    expect(result.repo.affectedModule).toBe('src');
  });

  test('grep_with_context returns contextual snippets around matches', async () => {
    const grep = jest.fn(async () => [{ path: 'src/module.py', line: 3, text: 'target()' }]);
    const readFile = jest.fn(async () => ['line1', 'line2', 'target()', 'line4', 'line5'].join('\n'));
    const result = (await grepWithContext.execute(
      { pattern: 'target\\(', contextLines: 1, maxMatches: 10 },
      makeCtx(grep, readFile),
    )) as any;
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].context).toContain('2: line2');
    expect(result.matches[0].context).toContain('3: target()');
    expect(result.matches[0].context).toContain('4: line4');
  });

  test('read_symbol_context batches definition + caller lookups', async () => {
    const grep = jest.fn(async (pattern: string) => {
      if (pattern.includes('(class|def|function|const|let|var|fn|interface|type)')) {
        return [{ path: 'src/wrappers.py', line: 3, text: 'def _finalize_step_span(...):' }];
      }
      if (pattern.includes('[[:space:]]*\\(')) {
        return [{ path: 'tests/test_wrappers.py', line: 3, text: '_finalize_step_span(step_log)' }];
      }
      return [];
    });
    const readFile = jest.fn(async (path: string) => {
      if (path === 'src/wrappers.py') return ['x', 'y', 'def _finalize_step_span(...):', 'z'].join('\n');
      if (path === 'tests/test_wrappers.py') return ['a', 'b', '_finalize_step_span(step_log)', 'c'].join('\n');
      return null;
    });

    const result = (await readSymbolContext.execute(
      {
        symbol: '_StepWrapper._finalize_step_span(step_log)',
        contextLines: 1,
        includeCallers: true,
        maxDefinitions: 10,
        maxCallers: 10,
      },
      makeCtx(grep, readFile),
    )) as any;

    expect(result.definitions).toHaveLength(1);
    expect(result.callers).toHaveLength(1);
    expect(result.definitions[0].context).toContain('3: def _finalize_step_span(...):');
    expect(result.callers[0].context).toContain('3: _finalize_step_span(step_log)');
  });
});
