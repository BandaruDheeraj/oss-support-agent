import {
  CandidateReproSchema,
  normalizeCandidateReproInput,
  renderTestSource,
  looksLikeSafeImport,
  buildImportSafetyProbe,
} from './candidate-repro';

describe('normalizeCandidateReproInput', () => {
  it('returns null for missing exerciseCall', () => {
    expect(
      normalizeCandidateReproInput({
        failureMode: 'unexpected_exception',
        candidateTestPath: 'tests/test_x.py',
        sentinel: 'SENTINEL_REPRO_X',
      })
    ).toBeNull();
  });

  it('returns null for missing sentinel', () => {
    expect(
      normalizeCandidateReproInput({
        failureMode: 'unexpected_exception',
        candidateTestPath: 'tests/test_x.py',
        exerciseCall: 'foo()',
      })
    ).toBeNull();
  });

  it('returns null for too-short sentinel', () => {
    expect(
      normalizeCandidateReproInput({
        failureMode: 'unexpected_exception',
        candidateTestPath: 'tests/test_x.py',
        exerciseCall: 'foo()',
        sentinel: 'short',
      })
    ).toBeNull();
  });

  it('returns null for unknown failureMode', () => {
    expect(
      normalizeCandidateReproInput({
        failureMode: 'something_else',
        candidateTestPath: 'tests/test_x.py',
        exerciseCall: 'foo()',
        sentinel: 'SENTINEL_REPRO_X',
      })
    ).toBeNull();
  });

  it('returns null for wrong_return without expectedValueExpression', () => {
    expect(
      normalizeCandidateReproInput({
        failureMode: 'wrong_return',
        candidateTestPath: 'tests/test_x.py',
        exerciseCall: 'foo()',
        sentinel: 'SENTINEL_REPRO_X',
      })
    ).toBeNull();
  });

  it('rejects pipInstalls whose package starts with "-e"', () => {
    const result = normalizeCandidateReproInput({
      failureMode: 'unexpected_exception',
      candidateTestPath: 'tests/test_x.py',
      exerciseCall: 'foo()',
      sentinel: 'SENTINEL_REPRO_X',
      expectedExceptionType: 'AttributeError',
      pipInstalls: [{ package: '-e python/foo', editable: true }],
    });
    expect(result?.pipInstalls).toEqual([]);
  });

  it('coerces failureMode case + dashes', () => {
    const result = normalizeCandidateReproInput({
      failureMode: 'Unexpected-Exception',
      candidateTestPath: 'tests/test_x.py',
      exerciseCall: 'foo()',
      sentinel: 'SENTINEL_REPRO_X',
      expectedExceptionType: 'AttributeError',
    });
    expect(result?.failureMode).toBe('unexpected_exception');
  });

  it('produces a strict-schema-compatible object on the happy path', () => {
    const result = normalizeCandidateReproInput({
      failureMode: 'unexpected_exception',
      source: 'direct_call',
      candidateTestPath: 'tests/test_x.py',
      imports: ['from x import y', 'import os'],
      setup: 'val = 1',
      exerciseCall: 'foo(val)',
      sentinel: 'SENTINEL_REPRO_X',
      expectedExceptionType: 'AttributeError',
      pipInstalls: [{ package: 'python/foo', editable: true }, { package: 'requests' }],
      requiresCredentials: ['OPENAI_API_KEY'],
      preconditionsSatisfied: ['pc-0'],
      expectedFailureSignature: 'AttributeError',
      rationale: 'because reasons',
    });
    expect(result).not.toBeNull();
    expect(() => CandidateReproSchema.parse(result)).not.toThrow();
    expect(result?.pipInstalls).toEqual([
      { package: 'python/foo', editable: true },
      { package: 'requests', editable: false },
    ]);
  });

  it('defaults source to direct_call when unknown', () => {
    const result = normalizeCandidateReproInput({
      failureMode: 'unexpected_exception',
      candidateTestPath: 'tests/test_x.py',
      exerciseCall: 'foo()',
      sentinel: 'SENTINEL_REPRO_X',
      expectedExceptionType: 'AttributeError',
      source: 'made_up',
    });
    expect(result?.source).toBe('direct_call');
  });

  it('accepts common LLM-emitted alias field names (sentinelString, setupCode, exerciseImports, expectedReturnRepr)', () => {
    // Mirrors the field names the Analyst emitted in the first live run
    // of issue #46 before the prompt was tightened. Belt-and-suspenders
    // path: even if the prompt drifts, normalize recovers.
    const result = normalizeCandidateReproInput({
      failureMode: 'unexpected_exception',
      candidateTestPath: 'tests/test_x.py',
      sentinelString: 'REPRO_46_SENTINEL_XYZ',
      exerciseImports: [
        { module: 'opentelemetry.trace', names: ['NonRecordingSpan', 'SpanContext'] },
        { module: 'os' },
      ],
      setupCode: 'span = NonRecordingSpan(SpanContext(0,0,False))',
      exerciseCall: '_finalize_step_span(span, None)',
      expectedExceptionType: 'AttributeError',
    });
    expect(result).not.toBeNull();
    expect(result?.sentinel).toBe('REPRO_46_SENTINEL_XYZ');
    expect(result?.imports).toEqual([
      'from opentelemetry.trace import NonRecordingSpan, SpanContext',
      'import os',
    ]);
    expect(result?.setup).toContain('NonRecordingSpan');
  });

  it('rejects unexpected_exception when expectedExceptionType is missing or literal "None"', () => {
    // No expectedExceptionType at all.
    expect(
      normalizeCandidateReproInput({
        failureMode: 'unexpected_exception',
        candidateTestPath: 'tests/test_x.py',
        exerciseCall: 'foo()',
        sentinel: 'SENTINEL_REPRO_X',
      })
    ).toBeNull();
    // Literal "None" string — the Analyst meant "no exception expected",
    // which is the FIXED state, not a reproducible bug. Reject so the
    // Builder fallback (Prober) takes over.
    expect(
      normalizeCandidateReproInput({
        failureMode: 'unexpected_exception',
        candidateTestPath: 'tests/test_x.py',
        exerciseCall: 'foo()',
        sentinel: 'SENTINEL_REPRO_X',
        expectedExceptionType: 'None',
      })
    ).toBeNull();
  });
});

describe('renderTestSource', () => {
  const base = {
    version: 1 as const,
    source: 'direct_call' as const,
    candidateTestPath: 'tests/test_x.py',
    imports: ['from opentelemetry.trace import NonRecordingSpan'],
    setup: 'span = NonRecordingSpan()',
    exerciseCall: '_finalize_step_span(span=span, step=None, result=None)',
    sentinel: 'SENTINEL_REPRO_46_NRS',
    pipInstalls: [],
    requiresCredentials: [],
    preconditionsSatisfied: [],
    rationale: '',
  };

  it('renders an unexpected_exception template with try/except/else and sentinel-bearing assertion', () => {
    const result = renderTestSource({
      ...base,
      failureMode: 'unexpected_exception',
      expectedExceptionType: 'AttributeError',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toContain('def test_repro():');
    expect(result.source).toContain('try:');
    expect(result.source).toContain('except Exception as exc:');
    expect(result.source).toContain('SENTINEL_REPRO_46_NRS');
    expect(result.source).toContain('expected AttributeError but no exception raised');
    expect(result.source).toContain('_finalize_step_span(span=span, step=None, result=None)');
    expect(result.source).toContain('span = NonRecordingSpan()');
    expect(result.source).toContain('from opentelemetry.trace import NonRecordingSpan');
    // Sanity: every `assert False` line MUST carry a trailing comma-and-
    // message so it doesn't match the executor's `reproAstPreflight`
    // trivial-assertion regex (`/^\s*assert\s+False\s*[,;]?\s*$/m`).
    const bareAssert = result.source.match(/^\s*assert\s+False\s*[,;]?\s*$/m);
    expect(bareAssert).toBeNull();
    // It also MUST NOT contain a line-starting `raise` outside the
    // first try/except branch — the executor's strip+detect would catch
    // it. Our template uses `assert False, "..."` in both else and except
    // branches to avoid this.
    const stripped = result.source.replace(/^\s*try:[\s\S]*?except[\s\S]*?raise\b/g, '');
    expect(stripped).not.toMatch(/^\s*raise\b/m);
  });

  it('renders a wrong_return template with == assertion and sentinel', () => {
    const result = renderTestSource({
      ...base,
      failureMode: 'wrong_return',
      expectedValueExpression: '42',
      exerciseCall: 'foo()',
      setup: '',
      imports: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toContain('_actual = foo()');
    expect(result.source).toContain('_expected = 42');
    expect(result.source).toContain('assert _actual == _expected');
    expect(result.source).toContain('SENTINEL_REPRO_46_NRS');
    expect(result.source).toContain('# (no setup)');
    expect(result.source).toContain('# (no imports)');
  });

  it('rejects sentinels containing quotes or newlines', () => {
    const result = renderTestSource({ ...base, failureMode: 'unexpected_exception', sentinel: 'has"quote' });
    expect(result).toEqual({ ok: false, reason: 'sentinel_unsafe' });
  });

  it('rejects empty exerciseCall', () => {
    const result = renderTestSource({ ...base, failureMode: 'unexpected_exception', exerciseCall: '   ' });
    expect(result).toEqual({ ok: false, reason: 'exercise_empty' });
  });

  it('indents multi-line setup correctly', () => {
    const result = renderTestSource({
      ...base,
      failureMode: 'unexpected_exception',
      setup: 'a = 1\nb = 2',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toMatch(/    a = 1\n    b = 2/);
  });

  it('reports too_large when rendered source exceeds the 4096-char cap', () => {
    const huge = 'x'.repeat(5000);
    const result = renderTestSource({ ...base, failureMode: 'unexpected_exception', setup: huge });
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('looksLikeSafeImport', () => {
  it.each([
    ['from x import y', true],
    ['from x.y.z import a, b, c', true],
    ['import os', true],
    ['import os.path', true],
    ['import x as y', true],
    ['from x import (a, b, c)', true],
  ])('accepts %p', (stmt, expected) => {
    expect(looksLikeSafeImport(stmt)).toBe(expected);
  });

  it.each([
    ['import os; os.system("x")'],
    ['from x import y\nimport os'],
    ['import os # noqa'],
    ['__import__("os")'],
    ['from x import *'],
    [''],
    ['x = 1'],
  ])('rejects %p', (stmt) => {
    expect(looksLikeSafeImport(stmt)).toBe(false);
  });
});

describe('buildImportSafetyProbe', () => {
  it('contains an ast.parse loop and embeds the imports as JSON', () => {
    const snippet = buildImportSafetyProbe(['from x import y', 'import z']);
    expect(snippet).toContain('import ast');
    expect(snippet).toContain('ast.parse(stmt)');
    expect(snippet).toContain('isinstance(node, (ast.Import, ast.ImportFrom))');
    // The imports list is embedded as a JSON string, which is then
    // json.loads'd at runtime.
    expect(snippet).toContain('from x import y');
    expect(snippet).toContain('import z');
    expect(snippet).toContain('BUILDER_IMPORT_OK');
  });
});
