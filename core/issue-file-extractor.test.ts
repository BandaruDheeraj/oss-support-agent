import { extractFilePaths, extractFilePathsFromAll } from './issue-file-extractor';

describe('extractFilePaths', () => {
  it('extracts Python traceback paths', () => {
    const body = `Traceback (most recent call last):
  File "python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py", line 243, in _finalize_step_span
    span.status = trace_api.StatusCode.OK
AttributeError: 'NonRecordingSpan' object has no attribute 'status'`;
    const paths = extractFilePaths(body);
    expect(paths).toContain(
      'python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py'
    );
  });

  it('extracts backticked paths with known extensions', () => {
    const body = 'The bug is in `src/utils/parser.ts` around the tokenizer.';
    expect(extractFilePaths(body)).toContain('src/utils/parser.ts');
  });

  it('extracts **File:** headers', () => {
    const body = `**File:** packages/core/index.js
Some description.`;
    expect(extractFilePaths(body)).toContain('packages/core/index.js');
  });

  it('extracts narrative mentions', () => {
    const body = 'The error happens in src/auth/login.py on a failed retry.';
    expect(extractFilePaths(body)).toContain('src/auth/login.py');
  });

  it('strips line:col suffixes', () => {
    const body = 'See `src/parser.ts:42:11` for the failing assertion.';
    expect(extractFilePaths(body)).toContain('src/parser.ts');
  });

  it('rejects parent-traversal paths', () => {
    const body = 'File "../../etc/passwd.py", line 1';
    expect(extractFilePaths(body)).toEqual([]);
  });

  it('rejects unknown extensions', () => {
    const body = 'See `mystery.xyz` for details.';
    expect(extractFilePaths(body)).toEqual([]);
  });

  it('rejects pure URLs without file extensions', () => {
    const body = 'See https://example.com/docs/api for more info.';
    expect(extractFilePaths(body)).not.toContain('https://example.com/docs/api');
  });

  it('recovers repo-relative path from site-packages absolute path', () => {
    const body =
      'File "/Users/foo/.venv/lib/python3.11/site-packages/openinference/instrumentation/smolagents/_wrappers.py", line 243';
    const paths = extractFilePaths(body);
    expect(paths.some((p) => p.endsWith('_wrappers.py'))).toBe(true);
    expect(paths.every((p) => !p.startsWith('/'))).toBe(true);
  });

  it('drops site-packages/ prefix so the result is the import-path suffix', () => {
    const body =
      'File "/x/.venv/lib/python3.11/site-packages/openinference/instrumentation/smolagents/_wrappers.py", line 42';
    const paths = extractFilePaths(body);
    expect(paths).toContain(
      'openinference/instrumentation/smolagents/_wrappers.py'
    );
    expect(paths.every((p) => !p.includes('site-packages'))).toBe(true);
  });

  it('drops dist-packages/ prefix (Debian-flavored venvs)', () => {
    const body =
      'File "/usr/lib/python3/dist-packages/openinference/instrumentation/smolagents/_wrappers.py", line 17';
    const paths = extractFilePaths(body);
    expect(paths).toContain(
      'openinference/instrumentation/smolagents/_wrappers.py'
    );
  });

  it('prefers repo marker (python/) over install-root strip when both present', () => {
    const body =
      'File "/home/user/repo/python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py", line 99';
    const paths = extractFilePaths(body);
    expect(paths).toContain(
      'python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py'
    );
  });

  it('dedupes across multiple mentions', () => {
    const body = `See \`src/auth.py\`.
File "src/auth.py", line 10
And again in src/auth.py.`;
    const paths = extractFilePaths(body);
    expect(paths.filter((p) => p === 'src/auth.py')).toHaveLength(1);
  });

  it('handles null/empty', () => {
    expect(extractFilePaths(null)).toEqual([]);
    expect(extractFilePaths('')).toEqual([]);
    expect(extractFilePaths(undefined)).toEqual([]);
  });

  it('extractFilePathsFromAll merges and dedupes across fragments', () => {
    const a = 'In `src/a.ts`';
    const b = 'See `src/b.ts` and `src/a.ts` again';
    const paths = extractFilePathsFromAll([a, b, null]);
    expect(paths.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
