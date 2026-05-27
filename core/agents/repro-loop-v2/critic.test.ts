import { evaluatePreconditionEnforcement, expectedSignatureMatched, failureExercisesSuspectPath } from './critic';
import type { Precondition } from '../analyst/dossier';

function pcWithModes(modes: Array<{ description: string; markers: string[] }>): Precondition {
  return {
    id: 'pc-0',
    condition: 'no tracer provider configured',
    kind: 'config_absence',
    evidenceRefs: [],
    satisfactionModes: modes,
    threats: ['conftest.py autouse fixture installs TracerProvider'],
  };
}

describe('evaluatePreconditionEnforcement', () => {
  it('reports enforcedMode null when no markers match', () => {
    const src = 'def test_x():\n    assert True\n';
    const result = evaluatePreconditionEnforcement(src, [
      pcWithModes([{ description: 'direct NonRecordingSpan', markers: ['NonRecordingSpan('] }]),
    ]);
    expect(result[0].enforcedMode).toBeNull();
    expect(result[0].matchedMarkers).toEqual([]);
  });

  it('reports first matching mode with hit markers', () => {
    const src = `from opentelemetry.trace import NonRecordingSpan, INVALID_SPAN_CONTEXT\n\ndef test_x():\n    span = NonRecordingSpan(INVALID_SPAN_CONTEXT)\n`;
    const result = evaluatePreconditionEnforcement(src, [
      pcWithModes([
        { description: 'fixture reset', markers: ['monkeypatch.setattr'] },
        { description: 'direct NonRecordingSpan injection', markers: ['NonRecordingSpan(', 'INVALID_SPAN_CONTEXT'] },
      ]),
    ]);
    expect(result[0].enforcedMode).toBe('direct NonRecordingSpan injection');
    expect(result[0].matchedMarkers).toEqual(['NonRecordingSpan(', 'INVALID_SPAN_CONTEXT']);
  });

  it('handles preconditions with no satisfactionModes gracefully', () => {
    const result = evaluatePreconditionEnforcement('source', [pcWithModes([])]);
    expect(result[0].enforcedMode).toBeNull();
  });

  it('skips empty marker strings', () => {
    const src = 'whatever';
    const result = evaluatePreconditionEnforcement(src, [
      pcWithModes([{ description: 'empty markers', markers: ['', ''] }]),
    ]);
    expect(result[0].enforcedMode).toBeNull();
  });
});

describe('failureExercisesSuspectPath', () => {
  const suspects = [{ symbol: '_finalize_step_span' }];

  it('returns true when stderr mentions a suspect symbol', () => {
    const runs = [
      { result: { stderr: 'AttributeError in _finalize_step_span line 42', stdout: '' } },
    ];
    expect(failureExercisesSuspectPath(runs, suspects)).toBe(true);
  });

  it('returns false when no run mentions a suspect symbol', () => {
    const runs = [
      { result: { stderr: 'ImportError: cannot import smolagents', stdout: '' } },
      { result: { stderr: 'ImportError: cannot import smolagents', stdout: '' } },
    ];
    expect(failureExercisesSuspectPath(runs, suspects)).toBe(false);
  });

  it('returns true vacuously when there are no suspect symbols', () => {
    expect(failureExercisesSuspectPath([], [])).toBe(true);
  });

  it('checks both stderr and stdout', () => {
    const runs = [{ result: { stderr: '', stdout: 'traceback in _finalize_step_span' } }];
    expect(failureExercisesSuspectPath(runs, suspects)).toBe(true);
  });
});

describe('expectedSignatureMatched', () => {
  it('is vacuously true when no signature is specified', () => {
    expect(expectedSignatureMatched([], '')).toBe(true);
    expect(expectedSignatureMatched([], '   ')).toBe(true);
  });

  it('requires at least two runs containing the signature when specified', () => {
    const runs = [{ result: { stderr: 'AttributeError: NoneType', stdout: '' } }];
    expect(expectedSignatureMatched(runs, 'AttributeError')).toBe(false);
  });

  it('returns true when both runs contain the signature', () => {
    const runs = [
      { result: { stderr: 'AttributeError: NoneType has no attribute', stdout: '' } },
      { result: { stderr: 'AttributeError: NoneType has no attribute', stdout: '' } },
    ];
    expect(expectedSignatureMatched(runs, 'AttributeError')).toBe(true);
  });

  it('returns false when only one of two runs contains the signature', () => {
    const runs = [
      { result: { stderr: 'AttributeError: NoneType', stdout: '' } },
      { result: { stderr: 'TypeError: bad operand', stdout: '' } },
    ];
    expect(expectedSignatureMatched(runs, 'AttributeError')).toBe(false);
  });

  it('returns true when 2 of 3 runs contain the signature (diagnostic run tolerated)', () => {
    // Mirrors sentinel reliability: "at least two hits", not "every run".
    const runs = [
      { result: { stderr: 'ImportError on first attempt', stdout: '' } },
      { result: { stderr: 'AttributeError: NoneType', stdout: '' } },
      { result: { stderr: 'AttributeError: NoneType', stdout: '' } },
    ];
    expect(expectedSignatureMatched(runs, 'AttributeError')).toBe(true);
  });

  it('returns false when only 1 of 3 runs contains the signature', () => {
    const runs = [
      { result: { stderr: 'ImportError on first attempt', stdout: '' } },
      { result: { stderr: 'TypeError: bad operand', stdout: '' } },
      { result: { stderr: 'AttributeError: NoneType', stdout: '' } },
    ];
    expect(expectedSignatureMatched(runs, 'AttributeError')).toBe(false);
  });

  it('checks stdout in addition to stderr', () => {
    const runs = [
      { result: { stderr: '', stdout: 'AttributeError on line 42' } },
      { result: { stderr: 'AttributeError happened', stdout: '' } },
    ];
    expect(expectedSignatureMatched(runs, 'AttributeError')).toBe(true);
  });
});
