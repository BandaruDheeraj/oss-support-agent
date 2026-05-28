/**
 * Tracer factory + NoopTracer behavior.
 */
import { _resetTracer, activeBackend, currentSpan, getTracer, NoopTracer, runWithSpan } from '../tracer';

describe('tracer factory', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    _resetTracer();
    delete process.env.OBSERVABILITY_BACKEND;
    delete process.env.LANGSMITH_API_KEY;
    delete process.env.ARIZE_ENDPOINT;
    delete process.env.PHOENIX_OTLP_ENDPOINT;
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
