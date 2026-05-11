import { decideVerificationOutcome, summarizeVerificationFailure } from '../bin/run-pipeline';

describe('decideVerificationOutcome', () => {
  test('returns ok=true with empty retryContext when no regression and no blockers', () => {
    const r = decideVerificationOutcome({
      regressionDetected: false,
      regressionDiffs: [],
      blockers: [],
    });
    expect(r.ok).toBe(true);
    expect(r.retryContext).toBe('');
  });

  test('returns ok=false when regression detected, includes diff details', () => {
    const r = decideVerificationOutcome({
      regressionDetected: true,
      regressionDiffs: [
        { category: 'exit_code', description: 'fork=1 main=0' },
        { category: 'stderr', description: 'new traceback' },
      ],
      blockers: [],
    });
    expect(r.ok).toBe(false);
    expect(r.retryContext).toContain('Regression guard');
    expect(r.retryContext).toContain('[exit_code] fork=1 main=0');
    expect(r.retryContext).toContain('[stderr] new traceback');
  });

  test('returns ok=false when usability blockers present, includes blocker lines', () => {
    const r = decideVerificationOutcome({
      regressionDetected: false,
      blockers: [
        'installation failed: pip install -e . returned non-zero exit',
        'import_paths: module openinference-instrumentation-foo not importable',
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.retryContext).toContain('Usability blockers');
    expect(r.retryContext).toContain('installation failed');
    expect(r.retryContext).toContain('import_paths');
  });

  test('returns ok=false and combines both sections when both signals fail', () => {
    const r = decideVerificationOutcome({
      regressionDetected: true,
      regressionDiffs: [{ category: 'timeout', description: 'fork timed out at 15m' }],
      blockers: ['installation failed: setup.py missing'],
    });
    expect(r.ok).toBe(false);
    expect(r.retryContext).toContain('Regression guard');
    expect(r.retryContext).toContain('Usability blockers');
    expect(r.retryContext).toContain('[timeout]');
    expect(r.retryContext).toContain('setup.py missing');
  });

  test('handles missing regressionDiffs gracefully when regressionDetected=true', () => {
    const r = decideVerificationOutcome({
      regressionDetected: true,
      blockers: [],
    });
    expect(r.ok).toBe(false);
    expect(r.retryContext).toContain('0 diff(s)');
  });
});

describe('summarizeVerificationFailure', () => {
  test('counts regressions from the diff(s) marker', () => {
    const r = decideVerificationOutcome({
      regressionDetected: true,
      regressionDiffs: [
        { category: 'exit_code', description: 'fork=1 main=0' },
        { category: 'stderr', description: 'new traceback' },
      ],
      blockers: [],
    });
    expect(summarizeVerificationFailure(r.retryContext)).toBe(
      'verification-failed: 2 regression'
    );
  });

  test('counts usability blockers separately from regression diffs', () => {
    const r = decideVerificationOutcome({
      regressionDetected: false,
      blockers: ['installation failed', 'import_paths broken'],
    });
    expect(summarizeVerificationFailure(r.retryContext)).toBe(
      'verification-failed: 2 usability blockers'
    );
  });

  test('combines both counts when both signals fail', () => {
    const r = decideVerificationOutcome({
      regressionDetected: true,
      regressionDiffs: [{ category: 'timeout', description: 'fork timed out' }],
      blockers: ['setup.py missing'],
    });
    expect(summarizeVerificationFailure(r.retryContext)).toBe(
      'verification-failed: 1 regression, 1 usability blocker'
    );
  });

  test('falls back to bare verification-failed for empty/unstructured context', () => {
    expect(summarizeVerificationFailure('')).toBe('verification-failed');
    expect(summarizeVerificationFailure('something else entirely')).toBe(
      'verification-failed'
    );
  });
});
