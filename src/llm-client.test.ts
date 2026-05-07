/**
 * Unit tests for the shared LLM client via OpenRouter (US-100).
 */

import {
  LLMClient,
  MissingOpenRouterApiKeyError,
  OpenRouterHTTPError,
  resolveModelFromEnv,
  type LLMMessage,
} from './llm-client';

function okResponse(json: any) {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  };
}

function errResponse(status: number, json: any) {
  return {
    ok: false,
    status,
    json: async () => json,
  };
}

describe('LLMClient (OpenRouter)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    (globalThis as any).fetch = undefined;
  });

  test('fails fast with a clear error when OPENROUTER_API_KEY is missing', () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(() => new LLMClient({ fetchFn: async () => okResponse({}) })).toThrow(MissingOpenRouterApiKeyError);
    expect(() => new LLMClient({ fetchFn: async () => okResponse({}) })).toThrow(/OPENROUTER_API_KEY/);
  });

  test('resolves per-agent model env vars with OPENROUTER_MODEL_DEFAULT fallback', () => {
    process.env.OPENROUTER_MODEL_DEFAULT = 'openai/gpt-4.1-mini';
    process.env.OPENROUTER_MODEL_TRIAGE = 'anthropic/claude-3.7-sonnet';

    expect(resolveModelFromEnv('TRIAGE')).toBe('anthropic/claude-3.7-sonnet');
    expect(resolveModelFromEnv('PM')).toBe('openai/gpt-4.1-mini');
    expect(resolveModelFromEnv()).toBe('openai/gpt-4.1-mini');
  });

  test('includes OpenRouter headers (HTTP-Referer, X-Title) and OpenAI-style body shape', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';

    const calls: any[] = [];
    (globalThis as any).fetch = async (url: string, init: any) => {
      calls.push({ url, init });
      return okResponse({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
    };

    const client = new LLMClient({
      httpReferer: 'https://example.com',
      xTitle: 'oss-support-agent-tests',
    });

    const messages: LLMMessage[] = [{ role: 'user', content: 'hi' }];
    const result = await client.chat(messages, { agent: 'TRIAGE', temperature: 0 });

    expect(result.content).toBe('hello');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');

    const headers = calls[0].init.headers;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['HTTP-Referer']).toBe('https://example.com');
    expect(headers['X-Title']).toBe('oss-support-agent-tests');

    const body = JSON.parse(calls[0].init.body);
    expect(body).toMatchObject({
      model: expect.any(String),
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      temperature: 0,
    });
  });

  test('retries with backoff on 429 and succeeds', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';

    const statuses = [429, 429, 200];
    const sleepCalls: number[] = [];

    const fetchFn = async () => {
      const status = statuses.shift();
      if (status === 200) {
        return okResponse({ choices: [{ message: { content: 'ok' } }] });
      }
      return errResponse(status!, { error: 'rate_limited' });
    };

    const client = new LLMClient({
      fetchFn: fetchFn as any,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
      randomFn: () => 0.5,
    });

    const result = await client.chat([{ role: 'user', content: 'hi' }], { maxAttempts: 5 });
    expect(result.content).toBe('ok');
    expect(sleepCalls.length).toBeGreaterThanOrEqual(2);
  });

  test('chatJson retries on malformed JSON and then validates schema', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';

    const responses = [
      okResponse({ choices: [{ message: { content: 'not json' } }] }),
      okResponse({ choices: [{ message: { content: '{"answer": 42}' } }] }),
    ];

    const fetchFn = async () => responses.shift();

    const client = new LLMClient({ fetchFn: fetchFn as any });

    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['answer'],
      properties: { answer: { type: 'number' } },
    };

    const { data } = await client.chatJson<{ answer: number }>(
      [{ role: 'user', content: 'give me json' }],
      schema,
      { parseRetries: 3 }
    );

    expect(data.answer).toBe(42);
  });

  test('forwards token usage via onUsage callback', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';

    const fetchFn = async () =>
      okResponse({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

    const client = new LLMClient({ fetchFn: fetchFn as any });

    const seen: any[] = [];
    await client.chat([{ role: 'user', content: 'hi' }], {
      onUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ promptTokens: 10, completionTokens: 5, totalTokens: 15 }]);
  });

  test('throws OpenRouterHTTPError on non-retryable 4xx', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';

    const fetchFn = async () => errResponse(401, { error: 'unauthorized' });
    const client = new LLMClient({ fetchFn: fetchFn as any, sleepFn: async () => {} });

    await expect(client.chat([{ role: 'user', content: 'hi' }], { maxAttempts: 2 })).rejects.toBeInstanceOf(
      OpenRouterHTTPError
    );
  });
});
