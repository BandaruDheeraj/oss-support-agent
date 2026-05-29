/**
 * Unit tests for the deterministic Executor's bare-package rewriter.
 * The full Executor is exercised end-to-end via the orchestrator suite; this
 * file focuses on resolveEditableInstallPackage which fixes the common
 * Prober-records-bare-package-name failure (see fix(prober) commit).
 */

import { resolveEditableInstallPackage, reproAstPreflight } from './executor';

describe('resolveEditableInstallPackage', () => {
  it('rewrites a bare package name to the matching fallback path', () => {
    const out = resolveEditableInstallPackage('openinference-instrumentation-smolagents', [
      'python/instrumentation/openinference-instrumentation-smolagents',
      'python/openinference-semantic-conventions',
    ]);
    expect(out).toBe('python/instrumentation/openinference-instrumentation-smolagents');
  });

  it('leaves a package alone when it already contains a path separator', () => {
    const out = resolveEditableInstallPackage('python/instrumentation/foo', [
      'other/path/foo',
    ]);
    expect(out).toBe('python/instrumentation/foo');
  });

  it('leaves a package alone when no fallback matches', () => {
    const out = resolveEditableInstallPackage('mystery-package', [
      'python/instrumentation/openinference-instrumentation-smolagents',
    ]);
    expect(out).toBe('mystery-package');
  });

  it('returns input unchanged when multiple fallbacks match (ambiguous)', () => {
    const out = resolveEditableInstallPackage('foo', ['a/foo', 'b/foo']);
    expect(out).toBe('foo');
  });

  it('leaves a package with a version constraint alone', () => {
    expect(resolveEditableInstallPackage('foo==1.2.3', ['a/foo'])).toBe('foo==1.2.3');
    expect(resolveEditableInstallPackage('foo>=1.2', ['a/foo'])).toBe('foo>=1.2');
  });

  it('leaves a VCS URL alone', () => {
    const url = 'git+https://github.com/x/foo.git@main';
    expect(resolveEditableInstallPackage(url, ['a/foo'])).toBe(url);
  });

  it('leaves a package with a dot (e.g. extras spec or namespaced) alone', () => {
    expect(resolveEditableInstallPackage('foo.bar', ['a/foo.bar'])).toBe('foo.bar');
  });

  it('handles trailing slashes on fallback paths', () => {
    const out = resolveEditableInstallPackage('smolagents', [
      'python/instrumentation/smolagents/',
    ]);
    expect(out).toBe('python/instrumentation/smolagents/');
  });

  it('handles Windows-style separators in fallback paths', () => {
    const out = resolveEditableInstallPackage('foo', ['python\\instrumentation\\foo']);
    expect(out).toBe('python\\instrumentation\\foo');
  });

  it('returns input unchanged when fallbacks list is empty', () => {
    expect(resolveEditableInstallPackage('foo', [])).toBe('foo');
  });
});

describe('reproAstPreflight', () => {
  it('allows try/except repro templates that use else: raise AssertionError', () => {
    const src = `
def test_repro():
    try:
        trigger_google_genai_failure()
    except TypeError as exc:
        assert False, "REPRO_GOOGLE_GENAI: " + str(exc)
    else:
        raise AssertionError("REPRO_GOOGLE_GENAI: expected TypeError")
`;
    const out = reproAstPreflight(
      'python',
      src,
      ['python/instrumentation/openinference-instrumentation-google-genai/src/openinference/instrumentation/google_genai/_wrapper.py'],
      ['trigger_google_genai_failure']
    );
    expect(out).toEqual({ ok: true });
  });

  it('rejects standalone top-level raises as trivial failures', () => {
    const src = `
def test_repro():
    trigger_google_genai_failure = None
    raise AssertionError("REPRO_GOOGLE_GENAI: forced failure")
`;
    const out = reproAstPreflight('python', src, [], ['trigger_google_genai_failure']);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('trivially fails');
  });
});
