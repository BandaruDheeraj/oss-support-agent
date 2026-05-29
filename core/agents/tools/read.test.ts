import type { GrepMatch } from './handles';
import { extractSymbolSearchCandidates, findCallers, findSymbol } from './read';
import type { ToolContext } from './types';

function makeCtx(
  grepImpl: (pattern: string, paths: string[] | undefined, flags: { caseInsensitive?: boolean }) => Promise<GrepMatch[]>
): ToolContext {
  return {
    agentName: 'TEST',
    attemptId: 'attempt-1',
    issueNumber: 46,
    handles: {
      workspace: {
        grep: grepImpl,
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
});
