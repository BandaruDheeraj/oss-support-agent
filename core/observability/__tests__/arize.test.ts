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
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

describe('ArizeTracer', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    setAttribute.mockClear();
    setStatus.mockClear();
    recordException.mockClear();
    end.mockClear();
    startSpan.mockClear();
    forceFlush.mockClear();
    (OTLPTraceExporter as jest.Mock).mockClear();
    process.env.ARIZE_ENDPOINT = 'https://otlp.arize.com/v1';
    process.env.ARIZE_API_KEY = 'arize-key';
    process.env.ARIZE_SPACE_ID = 'space-id';
    process.env.ARIZE_PROJECT_NAME = 'oss-fix-loop';
    delete process.env.OBSERVABILITY_REDACT_IO;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('tags spans with OpenInference span.kind and input/output values', async () => {
    const tracer = new ArizeTracer();
    const span = tracer.startSpan('llm.foo', {
      kind: 'LLM',
      attributes: { 'llm.model_name': 'foo', 'llm.temperature': 0.0 },
    });
    span.setInput({ messages: [{ role: 'user', content: 'q' }] });
    span.setOutput({ content: 'a' });
    span.end();
    expect(startSpan).toHaveBeenCalledTimes(1);
    const startOpts = (startSpan.mock.calls as any[])[0][1];
    expect(startOpts.attributes['openinference.span.kind']).toBe('LLM');
    expect(setAttribute).toHaveBeenCalledWith('openinference.span.kind', 'LLM');
    expect(setAttribute).toHaveBeenCalledWith('input.value', expect.any(String));
    expect(setAttribute).toHaveBeenCalledWith('output.value', expect.any(String));
    expect(end).toHaveBeenCalled();
    expect(OTLPTraceExporter).toHaveBeenCalledWith({
      url: 'https://otlp.arize.com/v1/traces',
      headers: {
        'arize-api-key': 'arize-key',
        'arize-space-id': 'space-id',
      },
    });
    await tracer.flush();
    expect(forceFlush).toHaveBeenCalled();
  });

  it('maps phase/tool/evaluator span kinds to CHAIN/TOOL/EVALUATOR', () => {
    const tracer = new ArizeTracer();
    tracer.startSpan('phase.repro', { kind: 'phase' }).end();
    tracer.startSpan('tool.read_file', { kind: 'TOOL' }).end();
    tracer.startSpan('evaluator.fix', { kind: 'EVALUATOR' }).end();
    const kinds = setAttribute.mock.calls
      .filter((c) => c[0] === 'openinference.span.kind')
      .map((c) => c[1]);
    expect(kinds).toEqual(['CHAIN', 'TOOL', 'EVALUATOR']);
  });

  it('emits every OpenInference kind without collapsing Arize attributes', () => {
    const tracer = new ArizeTracer();
    const kinds = [
      'CHAIN',
      'AGENT',
      'LLM',
      'TOOL',
      'RETRIEVER',
      'EMBEDDING',
      'RERANKER',
      'GUARDRAIL',
      'EVALUATOR',
    ] as const;

    for (const kind of kinds) {
      tracer.startSpan(`span.${kind.toLowerCase()}`, { kind }).end();
    }

    const emittedKinds = setAttribute.mock.calls
      .filter((c) => c[0] === 'openinference.span.kind')
      .map((c) => c[1]);
    expect(emittedKinds).toEqual(kinds);
  });

  it('prefers an explicit OpenInference attribute over a legacy kind', () => {
    const tracer = new ArizeTracer();
    tracer.startSpan('evaluator.fix', {
      kind: 'tool',
      attributes: { 'openinference.span.kind': 'EVALUATOR' },
    }).end();
    expect(setAttribute).toHaveBeenCalledWith('openinference.span.kind', 'EVALUATOR');
  });

  it('records exception + ERROR status when recordError is called', () => {
    const tracer = new ArizeTracer();
    const span = tracer.startSpan('llm.x', { kind: 'llm' });
    span.recordError(new Error('boom'));
    span.end();
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(recordException).toHaveBeenCalled();
  });

  it('warns and returns inert spans when required AX config is missing', () => {
    delete process.env.ARIZE_API_KEY;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tracer = new ArizeTracer();
    const span = tracer.startSpan('llm.x', { kind: 'llm' });
    span.setInput({ a: 1 });
    span.end();
    expect(startSpan).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ARIZE_API_KEY'));
    warn.mockRestore();
  });
});
