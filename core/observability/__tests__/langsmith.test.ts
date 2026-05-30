/**
 * LangSmith adapter contract — verifies span lifecycle calls into the mocked
 * langsmith Client and that telemetry failures never escape.
 */
const createRunMock = jest.fn().mockResolvedValue(undefined);
const updateRunMock = jest.fn().mockResolvedValue(undefined);
const createFeedbackMock = jest.fn().mockResolvedValue(undefined);
const awaitPendingMock = jest.fn().mockResolvedValue(undefined);

jest.mock('langsmith', () => ({
  Client: jest.fn().mockImplementation(() => ({
    createRun: createRunMock,
    updateRun: updateRunMock,
    createFeedback: createFeedbackMock,
    awaitPendingTraceBatches: awaitPendingMock,
  })),
}));

import { LangSmithTracer } from '../langsmith';

describe('LangSmithTracer', () => {
  beforeEach(() => {
    createRunMock.mockClear();
    createRunMock.mockResolvedValue(undefined);
    updateRunMock.mockClear();
    createFeedbackMock.mockClear();
    awaitPendingMock.mockClear();
    process.env.LANGSMITH_API_KEY = 'test-key';
    process.env.LANGSMITH_PROJECT = 'test-proj';
    delete process.env.OBSERVABILITY_REDACT_IO;
  });

  it('issues createRun and updateRun with the expected shape for an LLM span', async () => {
    const tracer = new LangSmithTracer();
    const span = tracer.startSpan('llm.test-model', {
      kind: 'llm',
      attributes: { 'llm.model_name': 'test-model', 'llm.temperature': 0.2 },
    });
    span.setInput({ messages: [{ role: 'user', content: 'hi' }] });
    span.setOutput({ content: 'hello' });
    span.setAttributes({ 'llm.token_count.prompt': 10 });
    span.end();

    await tracer.flush();

    expect(createRunMock).toHaveBeenCalledTimes(1);
    const createArgs = createRunMock.mock.calls[0][0];
    expect(createArgs.name).toBe('llm.test-model');
    expect(createArgs.run_type).toBe('llm');
    expect(createArgs.project_name).toBe('test-proj');
    expect(createArgs.parent_run_id).toBeUndefined();

    expect(updateRunMock).toHaveBeenCalledTimes(1);
    const [updatedId, patch] = updateRunMock.mock.calls[0];
    expect(updatedId).toBe(createArgs.id);
    expect((patch.outputs as any).value.content).toBe('hello');
    expect((patch.extra as any).metadata['llm.token_count.prompt']).toBe(10);

    expect(awaitPendingMock).toHaveBeenCalled();
  });

  it('emits LangSmith feedback entries for evaluator spans', async () => {
    const tracer = new LangSmithTracer();
    const span = tracer.startSpan('evaluator.repro', {
      kind: 'evaluator',
      attributes: {
        'evaluation.name': 'repro_passed',
        'evaluation.stage': 'repro',
        'evaluation.score': 1,
        'evaluation.label': 'pass',
      },
    });
    span.end();

    await tracer.flush();

    expect(createFeedbackMock).toHaveBeenCalledTimes(1);
    const [runId, key, payload] = createFeedbackMock.mock.calls[0];
    expect(runId).toBe(createRunMock.mock.calls[0][0].id);
    expect(key).toBe('repro_passed');
    expect(payload).toEqual(
      expect.objectContaining({
        score: 1,
        value: 'pass',
      })
    );
  });

  it('threads parent_run_id when a parent span is provided', () => {
    const tracer = new LangSmithTracer();
    const parent = tracer.startSpan('phase.repro', { kind: 'phase' });
    const child = tracer.startSpan('llm.foo', { kind: 'llm', parent });
    child.end();
    parent.end();

    const parentCall = createRunMock.mock.calls[0][0];
    const childCall = createRunMock.mock.calls[1][0];
    expect(childCall.parent_run_id).toBe(parentCall.id);
  });

  it('swallows createRun errors without throwing to the caller', async () => {
    createRunMock.mockRejectedValueOnce(new Error('network down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tracer = new LangSmithTracer();
    const span = tracer.startSpan('llm.x', { kind: 'llm' });
    span.end();
    await tracer.flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('createRun failed'));
    warn.mockRestore();
  });

  it('warns once and returns inert spans when LANGSMITH_API_KEY is missing', () => {
    delete process.env.LANGSMITH_API_KEY;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tracer = new LangSmithTracer();
    const span = tracer.startSpan('llm.x', { kind: 'llm' });
    span.end();
    expect(createRunMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('LANGSMITH_API_KEY'));
    warn.mockRestore();
  });
});
