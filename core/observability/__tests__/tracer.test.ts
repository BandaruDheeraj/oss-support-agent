/**
 * Tracer factory + NoopTracer behavior.
 */
import {
  _resetTracer,
  activeBackend,
  assertObservabilityConfigured,
  currentSpan,
  getObservabilityConfigErrors,
  getTracer,
  normalizeOpenInferenceSpanKind,
  NoopTracer,
  runWithSpan,
  withOpenInferenceSpanKind,
} from '../tracer';

describe('tracer factory', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    _resetTracer();
    delete process.env.OBSERVABILITY_BACKEND;
    delete process.env.LANGSMITH_API_KEY;
    delete process.env.ARIZE_ENDPOINT;
    delete process.env.ARIZE_API_KEY;
    delete process.env.ARIZE_SPACE_ID;
    delete process.env.ARIZE_PROJECT_NAME;
    delete process.env.BRAINTRUST_API_KEY;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    _resetTracer();
  });

  it('returns NoopTracer by default when OBSERVABILITY_BACKEND is unset', () => {
    const tracer = getTracer();
    expect(tracer).toBeInstanceOf(NoopTracer);
    expect(activeBackend()).toBe('none');
  });

  it('returns NoopTracer for explicit "none"', () => {
    process.env.OBSERVABILITY_BACKEND = 'none';
    expect(getTracer()).toBeInstanceOf(NoopTracer);
  });

  it('caches the resolved tracer across calls', () => {
    const a = getTracer();
    const b = getTracer();
    expect(a).toBe(b);
  });

  it('falls back to NoopTracer + warns on unknown backend names', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.OBSERVABILITY_BACKEND = 'wandb';
    const tracer = getTracer();
    expect(tracer).toBeInstanceOf(NoopTracer);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown OBSERVABILITY_BACKEND'));
    warn.mockRestore();
  });

  it('NoopTracer span methods are no-ops and do not throw', async () => {
    const tracer = new NoopTracer();
    const span = (tracer as any).startSpan('phase.foo', { kind: 'phase' });
    expect(() => {
      span.setAttributes({ a: 1 });
      span.setInput({ messages: [] });
      span.setOutput({ content: 'ok' });
      span.recordError(new Error('x'));
      span.end();
    }).not.toThrow();
    await expect(tracer.flush()).resolves.toBeUndefined();
  });

  it('reports missing backend config for OBSERVABILITY_BACKEND=all', () => {
    process.env.OBSERVABILITY_BACKEND = 'all';
    expect(getObservabilityConfigErrors()).toEqual(
      expect.arrayContaining([
        'langsmith: LANGSMITH_API_KEY (or LANGCHAIN_API_KEY)',
        'arize: ARIZE_API_KEY',
        'arize: ARIZE_SPACE_ID',
        'arize: ARIZE_PROJECT_NAME',
        'braintrust: BRAINTRUST_API_KEY',
      ])
    );
  });

  it('throws on unknown OBSERVABILITY_BACKEND values', () => {
    process.env.OBSERVABILITY_BACKEND = 'wandb';
    expect(() => assertObservabilityConfigured()).toThrow(
      /Unknown OBSERVABILITY_BACKEND/
    );
  });

  it('passes config validation when all required keys are present', () => {
    process.env.OBSERVABILITY_BACKEND = 'all';
    process.env.LANGSMITH_API_KEY = 'x';
    process.env.ARIZE_API_KEY = 'arize-key';
    process.env.ARIZE_SPACE_ID = 'space-id';
    process.env.ARIZE_PROJECT_NAME = 'oss-fix-loop';
    process.env.BRAINTRUST_API_KEY = 'y';
    expect(() => assertObservabilityConfigured()).not.toThrow();
  });
});

describe('currentSpan + runWithSpan', () => {
  it('returns undefined outside an enclosing runWithSpan', () => {
    expect(currentSpan()).toBeUndefined();
  });

  it('exposes the active span to nested async work', async () => {
    const tracer = new NoopTracer();
    const parent = (tracer as any).startSpan('phase.parent', { kind: 'phase' });
    const seen = await runWithSpan(parent, async () => {
      await Promise.resolve();
      return currentSpan();
    });
    expect(seen).toBe(parent);
    expect(currentSpan()).toBeUndefined();
  });
});

describe('OpenInference span kind normalization', () => {
  it('normalizes legacy internal kinds', () => {
    expect(normalizeOpenInferenceSpanKind('phase')).toBe('CHAIN');
    expect(normalizeOpenInferenceSpanKind('llm')).toBe('LLM');
    expect(normalizeOpenInferenceSpanKind('tool')).toBe('TOOL');
    expect(normalizeOpenInferenceSpanKind('evaluator')).toBe('EVALUATOR');
  });

  it('preserves full OpenInference kinds', () => {
    expect(normalizeOpenInferenceSpanKind('AGENT')).toBe('AGENT');
    expect(normalizeOpenInferenceSpanKind('RETRIEVER')).toBe('RETRIEVER');
    expect(normalizeOpenInferenceSpanKind('EMBEDDING')).toBe('EMBEDDING');
    expect(normalizeOpenInferenceSpanKind('RERANKER')).toBe('RERANKER');
    expect(normalizeOpenInferenceSpanKind('GUARDRAIL')).toBe('GUARDRAIL');
  });

  it('lets explicit OpenInference attributes override legacy kind values', () => {
    expect(
      normalizeOpenInferenceSpanKind('tool', { 'openinference.span.kind': 'EVALUATOR' })
    ).toBe('EVALUATOR');
    expect(withOpenInferenceSpanKind({ a: 1 }, 'retriever')).toEqual({
      a: 1,
      'openinference.span.kind': 'RETRIEVER',
    });
  });
});
