import { computeOutcomeResults, toBooleanOrNull } from './run-eval';

describe('run-eval outcomes aggregation', () => {
  test('keeps latest row per issue/backend and flags discrepancies', () => {
    const rows = [
      {
        ts: '2026-01-01T00:00:00.000Z',
        issue_number: 101,
        attempt_id: 'a-old',
        mode: 'pipeline',
        backend: 'arize',
        agent: 'pipeline',
        repro_passed: true,
        fix_passed: false,
        verification_gate_passed: false,
        verification_stage: 'fail',
        final_disposition: 'max-retries-exceeded',
        error_kind: null,
      },
      {
        ts: '2026-01-01T01:00:00.000Z',
        issue_number: 101,
        attempt_id: 'a-new',
        mode: 'pipeline',
        backend: 'arize',
        agent: 'pipeline',
        repro_passed: true,
        fix_passed: true,
        verification_gate_passed: true,
        verification_stage: 'pass',
        final_disposition: 'pr-opened',
        error_kind: null,
      },
      {
        ts: '2026-01-01T01:30:00.000Z',
        issue_number: 101,
        attempt_id: 'b-1',
        mode: 'pipeline',
        backend: 'braintrust',
        agent: 'pipeline',
        repro_passed: true,
        fix_passed: false,
        verification_gate_passed: null,
        verification_stage: 'not_reached',
        final_disposition: 'max-retries-exceeded',
        error_kind: null,
      },
      {
        ts: '2026-01-01T01:45:00.000Z',
        issue_number: 101,
        attempt_id: 'l-1',
        mode: 'pipeline',
        backend: 'langsmith',
        agent: 'pipeline',
        repro_passed: true,
        fix_passed: true,
        verification_gate_passed: true,
        verification_stage: 'pass',
        final_disposition: 'pr-opened',
        error_kind: null,
      },
    ];

    const results = computeOutcomeResults(rows, '.osa-evals.sqlite');
    expect(results.total_rows).toBe(3);
    expect(results.per_platform.arize?.issue_resolved_rate).toBe(1);
    expect(results.per_platform.braintrust?.issue_resolved_rate).toBe(0);

    const issue = results.per_issue.find((r) => r.issue_number === 101);
    expect(issue).toBeDefined();
    expect(issue!.by_platform.arize?.attempt_id).toBe('a-new');
    expect(issue!.discrepancies).toEqual(
      expect.arrayContaining(['fix_passed', 'verification_gate_passed', 'issue_resolved'])
    );
  });

  test('treats skipped verification as skipped and not pass', () => {
    const results = computeOutcomeResults(
      [
        {
          ts: '2026-01-01T02:00:00.000Z',
          issue_number: 202,
          attempt_id: 'a-202',
          mode: 'pipeline',
          backend: 'arize',
          agent: 'pipeline',
          repro_passed: true,
          fix_passed: true,
          verification_gate_passed: null,
          verification_stage: 'skipped_non_gha',
          final_disposition: 'pr-opened',
          error_kind: null,
        },
      ],
      '.osa-evals.sqlite'
    );

    expect(results.per_platform.arize?.verification_skipped).toBe(1);
    expect(results.per_platform.arize?.verification_pass_rate).toBeNull();
  });
});

describe('run-eval value coercion', () => {
  test('coerces booleans and nulls consistently', () => {
    expect(toBooleanOrNull(1)).toBe(true);
    expect(toBooleanOrNull(0)).toBe(false);
    expect(toBooleanOrNull('true')).toBe(true);
    expect(toBooleanOrNull('false')).toBe(false);
    expect(toBooleanOrNull('null')).toBeNull();
    expect(toBooleanOrNull(undefined)).toBeNull();
  });
});
