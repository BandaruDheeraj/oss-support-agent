import { generateText } from 'ai';
import { z } from 'zod';
import { runAgentLoop } from './agent-loop';
import { ToolRegistry } from './tools/registry';
import { getModelRoutes } from '../llm/v2/client';

jest.mock('ai', () => ({
  generateText: jest.fn(),
  tool: (opts: unknown) => opts,
}));

jest.mock('../llm/v2/client', () => ({
  getModelRoutes: jest.fn(),
}));

jest.mock('../observability/spans', () => ({
  withAgentSpan: async (_agent: string, _attrs: Record<string, unknown>, fn: () => Promise<unknown>) => fn(),
  withToolSpan: async (_name: string, _tier: string, _attrs: Record<string, unknown>, fn: (span: { setAttribute: () => void }) => Promise<unknown>) => fn({ setAttribute: () => {} }),
}));

function makeRegistry() {
  return new ToolRegistry(
    {
      budgets: {
        total: 10,
        perTier: { read: 10, note: 10, 'write-test': 0, mutation: 0, sandbox: 0, meta: 0 },
      },
      maxTurns: 5,
    },
    {
      agentName: 'ANALYST',
      attemptId: 'attempt-1',
      issueNumber: 48,
      handles: {},
    },
  );
}

function makeRegistryWithReadTool() {
  return makeRegistry().register({
    name: 'read_note',
    tier: 'read',
    description: 'read a note',
    parameters: z.object({}),
    execute: async () => ({ ok: true, note: 'observed context' }),
  });
}

describe('runAgentLoop provider failover', () => {
  const mockedGenerateText = generateText as jest.MockedFunction<typeof generateText>;
  const mockedGetModelRoutes = getModelRoutes as jest.MockedFunction<typeof getModelRoutes>;

  beforeEach(() => {
    mockedGenerateText.mockReset();
    mockedGetModelRoutes.mockReset();
    mockedGetModelRoutes.mockReturnValue([
      {
        provider: 'openrouter',
        routeId: 'openrouter:k1:m1',
        modelId: 'anthropic/claude-sonnet-4.5',
        model: {} as any,
      },
      {
        provider: 'openrouter',
        routeId: 'openrouter:k1:m2',
        modelId: 'openai/gpt-4.1',
        model: {} as any,
      },
    ]);
  });

  test('fails over to the next route on credits exhaustion before any tool calls', async () => {
    mockedGenerateText
      .mockRejectedValueOnce(new Error('402 Payment Required: insufficient credit balance'))
      .mockResolvedValueOnce({ text: 'done', finishReason: 'stop' } as any);

    const result = await runAgentLoop({
      agent: 'ANALYST',
      registry: makeRegistry(),
      system: 'system',
      user: 'user',
      attemptId: 'attempt-1',
      issueNumber: 48,
    });

    expect(mockedGenerateText).toHaveBeenCalledTimes(2);
    expect(result.terminated).toBe('finished');
    expect(result.text).toBe('done');
  });

  test('does not fail over for non-provider validation errors', async () => {
    mockedGenerateText.mockRejectedValue(new Error('400 invalid request: malformed input'));

    const result = await runAgentLoop({
      agent: 'ANALYST',
      registry: makeRegistry(),
      system: 'system',
      user: 'user',
      attemptId: 'attempt-1',
      issueNumber: 48,
    });

    // Non-provider validation errors should trigger at most a same-route
    // corrective retry, never a failover route change.
    expect(mockedGenerateText).toHaveBeenCalledTimes(2);
    expect(mockedGenerateText.mock.calls[0]?.[0]?.model).toBe(mockedGenerateText.mock.calls[1]?.[0]?.model);
    expect(result.terminated).toBe('error');
    expect(result.reason).toContain('[invalid-request]');
  });

  test('fails over after provider errors even when tool calls already happened', async () => {
    mockedGenerateText
      .mockImplementationOnce(async (opts: any) => {
        await opts.tools.read_note.execute({});
        throw new Error('429 rate limit exceeded');
      })
      .mockResolvedValueOnce({ text: 'resumed', finishReason: 'stop' } as any);

    const result = await runAgentLoop({
      agent: 'ANALYST',
      registry: makeRegistryWithReadTool(),
      system: 'system',
      user: 'user',
      attemptId: 'attempt-1',
      issueNumber: 48,
    });

    expect(mockedGenerateText).toHaveBeenCalledTimes(2);
    expect(result.terminated).toBe('finished');
    expect(result.text).toBe('resumed');
    const secondCallMessages = mockedGenerateText.mock.calls[1]?.[0]?.messages as any[];
    expect(secondCallMessages?.[0]?.content).toContain('[ORCHESTRATOR RESUME]');
    expect(secondCallMessages?.[0]?.content).toContain('read_note');
  });
});
