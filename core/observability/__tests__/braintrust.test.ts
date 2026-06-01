/**
 * Braintrust adapter contract — verifies span lifecycle calls into the mocked
 * braintrust SDK and that failures never escape.
 */
const logMock = jest.fn();
const endMock = jest.fn();
const childLogMock = jest.fn();
const childEndMock = jest.fn();
const startChildSpanMock = jest.fn(() => ({
  log: childLogMock,
  end: childEndMock,
  startSpan: jest.fn(),
}));
const initLoggerMock = jest.fn(() => ({
  log: logMock,
  end: endMock,
  startSpan: startChildSpanMock,
}));
const flushMock = jest.fn().mockResolvedValue(undefined);

jest.mock('braintrust', () => ({
  initLogger: initLoggerMock,
  flush: flushMock,
}));

import { BraintrustTracer } from '../braintrust';

describe('BraintrustTracer', () => {
  beforeEach(() => {
    logMock.mockClear();
    endMock.mockClear();
    childLogMock.mockClear();
    childEndMock.mockClear();
    startChildSpanMock.mockClear();
    initLoggerMock.mockClear();
    flushMock.mockClear();
    process.env.BRAINTRUST_API_KEY = 'test-key';
    process.env.BRAINTRUST_PROJECT = 'test-proj';
    delete process.env.OBSERVABILITY_REDACT_IO;
  });

  it('initLogger is called once per tracer with project + key', () => {
    new BraintrustTracer();
    expect(initLoggerMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: 'test-proj', apiKey: 'test-key' })
    );
  });

  it('startSpan emits a top-level span and logs input/output on end', async () => {
    const tracer = new BraintrustTracer();
    const span = tracer.startSpan('llm.foo', {
      kind: 'llm',
      attributes: { 'llm.model_name': 'foo' },
    });
    span.setInput({ messages: [{ role: 'user', content: 'q' }] });
    span.setOutput({ content: 'a' });
    span.end();
    expect(startChildSpanMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'llm.foo', type: 'llm' })
    );
    expect(childLogMock).toHaveBeenCalledTimes(1);
    const logged = childLogMock.mock.calls[0][0];
    expect(logged.input).toEqual({ messages: [{ role: 'user', content: 'q' }] });
    expect(logged.output).toEqual({ content: 'a' });
    expect((logged.metadata as any)['llm.model_name']).toBe('foo');
    expect(childEndMock).toHaveBeenCalled();
    await tracer.flush();
    expect(flushMock).toHaveBeenCalled();
  });

  it('nests child spans under their parent', () => {
    const tracer = new BraintrustTracer();
    const grandChildStart = jest.fn(() => ({
      log: jest.fn(),
      end: jest.fn(),
      startSpan: jest.fn(),
    }));
    startChildSpanMock.mockReturnValueOnce({
      log: childLogMock,
      end: childEndMock,
      startSpan: grandChildStart,
    } as any);
    const parent = tracer.startSpan('phase.repro', { kind: 'phase' });
    const child = tracer.startSpan('llm.x', { kind: 'llm', parent });
    expect(grandChildStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'llm.x', type: 'llm' })
    );
    child.end();
    parent.end();
  });

  it('warns once and returns inert spans when BRAINTRUST_API_KEY is missing', () => {
    delete process.env.BRAINTRUST_API_KEY;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tracer = new BraintrustTracer();
    const span = tracer.startSpan('llm.x', { kind: 'llm' });
    span.end();
    expect(startChildSpanMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BRAINTRUST_API_KEY'));
    warn.mockRestore();
  });

  it('retries log failures without throwing to the caller', async () => {
    childLogMock.mockImplementationOnce(() => {
      throw new Error('network down');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tracer = new BraintrustTracer();
    const span = tracer.startSpan('llm.y', { kind: 'llm' });
    expect(() => span.end()).not.toThrow();
    await tracer.flush();
    expect(childLogMock).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('log failed'));
    warn.mockRestore();
  });

  it('writes evaluation scores for evaluator spans', () => {
    const tracer = new BraintrustTracer();
    const span = tracer.startSpan('evaluator.fix', {
      kind: 'evaluator',
      attributes: {
        'evaluation.name': 'fix_passed',
        'evaluation.score': 0,
      },
    });
    span.end();

    expect(childLogMock).toHaveBeenCalledTimes(1);
    expect(childLogMock.mock.calls[0][0].scores).toEqual({ fix_passed: 0 });
  });
});
