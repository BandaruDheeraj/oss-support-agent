/**
 * Arize adapter contract — verifies span lifecycle calls into a mocked OTel
 * provider and OpenInference-conformant attributes.
 */

const setAttribute = jest.fn();
const setStatus = jest.fn();
const recordException = jest.fn();
const end = jest.fn();
const startSpan = jest.fn(() => ({
  setAttribute,
  setStatus,
  recordException,
  end,
}));
const forceFlush = jest.fn().mockResolvedValue(undefined);

jest.mock('@opentelemetry/sdk-trace-base', () => ({
  BasicTracerProvider: jest.fn().mockImplementation(() => ({
    getTracer: () => ({ startSpan }),
    forceFlush,
  })),
  BatchSpanProcessor: jest.fn(),
}));

jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: jest.fn(),
}));

import { ArizeTracer } from '../arize';

describe('ArizeTracer', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    setAttribute.mockClear();
    setStatus.mockClear();
    recordException.mockClear();
    end.mockClear();
    startSpan.mockClear();
    forceFlush.mockClear();
    process.env.ARIZE_ENDPOINT = 'https://otlp.arize.com/v1';
    delete process.env.OBSERVABILITY_REDACT_IO;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('tags spans with OpenInference span.kind and input/output values', async () => {
    const tracer = new ArizeTracer();
    const span = tracer.startSpan('llm.foo', {
      kind: 'llm',
      attributes: { 'llm.model_name': 'foo', 'llm.temperature': 0.0 },
    });
    span.setInput({ messages: [{ role: 'user', content: 'q' }] });
    span.setOutput({ content: 'a' });
    span.end();
    expect(startSpan).toHaveBeenCalledTimes(1);
    expect(setAttribute).toHaveBeenCalledWith('openinference.span.kind', 'LLM');
    expect(setAttribute).toHaveBeenCalledWith('input.value', expect.any(String));
    expect(setAttribute).toHaveBeenCalledWith('output.value', expect.any(String));
    expect(end).toHaveBeenCalled();
    await tracer.flush();
    expect(forceFlush).toHaveBeenCalled();
  });

  it('maps phase span kind to CHAIN and tool to TOOL', () => {
    const tracer = new ArizeTracer();
    tracer.startSpan('phase.repro', { kind: 'phase' }).end();
    tracer.startSpan('tool.read_file', { kind: 'tool' }).end();
    const kinds = setAttribute.mock.calls
      .filter((c) => c[0] === 'openinference.span.kind')
      .map((c) => c[1]);
    expect(kinds).toEqual(['CHAIN', 'TOOL']);
  });

  it('records exception + ERROR status when recordError is called', () => {
    const tracer = new ArizeTracer();
    const span = tracer.startSpan('llm.x', { kind: 'llm' });
    span.recordError(new Error('boom'));
    span.end();
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(recordException).toHaveBeenCalled();
  });

  it('warns and returns inert spans when no endpoint is configured', () => {
    delete process.env.ARIZE_ENDPOINT;
    delete process.env.PHOENIX_OTLP_ENDPOINT;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tracer = new ArizeTracer();
    const span = tracer.startSpan('llm.x', { kind: 'llm' });
    span.setInput({ a: 1 });
    span.end();
    expect(startSpan).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ARIZE_ENDPOINT'));
    warn.mockRestore();
  });
});
