/**
 * Regression tests for sandbox-local helpers.
 *
 * The pip-install path-quoting bug (#46 fresh repro): when the Prober calls
 * `pip_install({spec: '-e python/instrumentation/foo'})`, the old code wrapped
 * the whole spec in one JSON.stringify and shell-passed `-e python/...` as a
 * single argv token. pip then parsed `-e` + ` python/...` (with leading space)
 * and rejected the path with "is not a valid editable requirement".
 *
 * The helper must split on whitespace and quote each token individually.
 */

import { buildPipInstallCommand } from './sandbox-local';

describe('buildPipInstallCommand', () => {
  it('splits the `-e <path>` form into two separate quoted argv tokens', () => {
    expect(buildPipInstallCommand('-e python/instrumentation/foo')).toBe(
      'pip install "-e" "python/instrumentation/foo"'
    );
  });

  it('handles a plain package spec', () => {
    expect(buildPipInstallCommand('opentelemetry-api')).toBe('pip install "opentelemetry-api"');
  });

  it('handles a version-pinned package spec', () => {
    expect(buildPipInstallCommand('opentelemetry-api==1.24.0')).toBe(
      'pip install "opentelemetry-api==1.24.0"'
    );
  });

  it('handles multiple packages on one spec', () => {
    expect(buildPipInstallCommand('a b c')).toBe('pip install "a" "b" "c"');
  });

  it('trims surrounding whitespace and collapses internal whitespace', () => {
    expect(buildPipInstallCommand('  -e   python/foo  ')).toBe(
      'pip install "-e" "python/foo"'
    );
  });

  it('handles the long-form --editable flag', () => {
    expect(buildPipInstallCommand('--editable python/foo')).toBe(
      'pip install "--editable" "python/foo"'
    );
  });

  it('preserves shell-special characters via JSON quoting (no injection)', () => {
    // JSON.stringify on `pkg; rm -rf /` yields `"pkg; rm -rf /"` so the shell
    // treats it as a single literal argv token, not a chained command.
    expect(buildPipInstallCommand('pkg; rm -rf /')).toBe(
      'pip install "pkg;" "rm" "-rf" "/"'
    );
  });
});
