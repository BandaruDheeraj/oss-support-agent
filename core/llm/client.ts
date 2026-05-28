/**
 * Shared LLM client backed by OpenRouter (US-100).
 *
 * OpenRouter exposes an OpenAI-compatible chat completions API.
 * This client provides:
 * - chat(): raw text response + token usage
 * - chatJson(): JSON response parsed + validated against a JSON Schema
 */

import Ajv from 'ajv';
import { currentSpan, getTracer } from '../observability';

export type LLMRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
  role: LLMRole;
  content: string;
  name?: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMChatResult {
  content: string;
  usage: LLMUsage | null;
  raw: unknown;
}

export type OpenRouterAgent =
  | 'TRIAGE'
  | 'PM'
  | 'FIX'
  | 'BUILD'
  | 'EVAL'
  | 'DOCS'
  | 'USABILITY'
  | 'INTROSPECTION'
  | 'REPRO';

export interface LLMChatOptions {
  /** Choose a model via env var mapping (e.g. OPENROUTER_MODEL_TRIAGE) */
  agent?: OpenRouterAgent;
  /** Explicit model override (takes precedence over env var mapping) */
  model?: string;
  /** Sampling temperature (default 0) */
  temperature?: number;
  /** Request timeout in milliseconds (default 90s) */
  timeoutMs?: number;
  /** Max HTTP retry attempts for 429/5xx (default 5) */
  maxAttempts?: number;
  /** Called with token usage when present */
  onUsage?: (usage: LLMUsage) => void;
  /** Cap on response tokens. Defaults to OPENROUTER_MAX_TOKENS env (or 16000). */
  maxTokens?: number;
}

export interface LLMChatJsonOptions extends LLMChatOptions {
  /** JSON parse/validation retries for malformed output (default 3) */
  parseRetries?: number;
}

export interface LLMClientOptions {
  apiKey?: string;
  baseUrl?: string;
  httpReferer?: string;
  xTitle?: string;
  defaultModel?: string;
  /** Injected fetch for tests */
  fetchFn?: (url: string, init: any) => Promise<any>;
  /** Injected sleep for tests */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injected RNG for deterministic jitter in tests */
  randomFn?: () => number;
}

export class MissingOpenRouterApiKeyError extends Error {
  constructor() {
    super('Missing OPENROUTER_API_KEY. Set it in the environment to enable OpenRouter-backed agents.');
    this.name = 'MissingOpenRouterApiKeyError';
  }
}

export class OpenRouterHTTPError extends Error {
  public readonly status: number;
  public readonly body: unknown;

  constructor(status: number, body: unknown) {
    let bodySnippet = '';
    try {
      const s = typeof body === 'string' ? body : JSON.stringify(body);
      if (s) bodySnippet = ` body=${s.length > 500 ? s.slice(0, 500) + '...' : s}`;
    } catch {
      // ignore
    }
    super(`OpenRouter request failed with HTTP ${status}${bodySnippet}`);
    this.name = 'OpenRouterHTTPError';
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PARSE_RETRIES = 3;
const DEFAULT_MODEL_FALLBACK = 'anthropic/claude-3.7-sonnet';

function envModelKey(agent: OpenRouterAgent): string {
  return `OPENROUTER_MODEL_${agent}`;
}

export function resolveModelFromEnv(agent?: OpenRouterAgent): string {
  const defaultModel = process.env.OPENROUTER_MODEL_DEFAULT || DEFAULT_MODEL_FALLBACK;
  if (!agent) return defaultModel;
  return process.env[envModelKey(agent)] || defaultModel;
}

function parseUsage(raw: any): LLMUsage | null {
  const usage = raw?.usage;
  if (!usage) return null;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  const totalTokens = usage.total_tokens;
  if (
    typeof promptTokens !== 'number' ||
    typeof completionTokens !== 'number' ||
    typeof totalTokens !== 'number'
  ) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function extractLikelyJson(text: string): string {
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return trimmed;
  }

  const firstObj = trimmed.indexOf('{');
  const lastObj = trimmed.lastIndexOf('}');
  if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) {
    return trimmed.slice(firstObj, lastObj + 1);
  }

  const firstArr = trimmed.indexOf('[');
  const lastArr = trimmed.lastIndexOf(']');
  if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
    return trimmed.slice(firstArr, lastArr + 1);
  }

  return trimmed;
}

export class LLMClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly httpReferer: string;
  private readonly xTitle: string;
  private readonly defaultModel: string;
  private readonly fetchFn: (url: string, init: any) => Promise<any>;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;
  private readonly ajv: Ajv;

  constructor(options: LLMClientOptions = {}) {
    const apiKey = options.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new MissingOpenRouterApiKeyError();
    }

    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.httpReferer = options.httpReferer || process.env.OPENROUTER_HTTP_REFERER || 'https://github.com';
    this.xTitle = options.xTitle || process.env.OPENROUTER_X_TITLE || 'oss-support-agent';
    this.defaultModel = options.defaultModel || process.env.OPENROUTER_MODEL_DEFAULT || DEFAULT_MODEL_FALLBACK;

    this.fetchFn = options.fetchFn || (globalThis as any).fetch;
    if (!this.fetchFn) {
      throw new Error('Global fetch() is not available in this runtime.');
    }

    this.sleepFn = options.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.randomFn = options.randomFn || Math.random;

    this.ajv = new Ajv({ allErrors: true, strict: false });
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions = {}): Promise<LLMChatResult> {
    const model = options.model ?? (options.agent ? resolveModelFromEnv(options.agent) : this.defaultModel);
    const temperature = options.temperature ?? 0;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    // Pluggable observability span — selected by OBSERVABILITY_BACKEND.
    // Parent (phase) span flows via AsyncLocalStorage so we don't need to
    // thread it through call sites.
    const tracer = getTracer();
    const span = tracer.startSpan(`llm.${model}`, {
      kind: 'llm',
      parent: currentSpan(),
      attributes: {
        'llm.model_name': model,
        'llm.temperature': temperature,
        'llm.agent': options.agent ?? null,
        'llm.message_count': messages.length,
      },
    });
    span.setInput({ messages });
    const startMs = Date.now();

    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) })),
      temperature,
      stream: false,
    };

    const envMaxTokens = process.env.OPENROUTER_MAX_TOKENS
      ? Number(process.env.OPENROUTER_MAX_TOKENS)
      : NaN;
    const maxTokens = options.maxTokens ?? (Number.isFinite(envMaxTokens) ? envMaxTokens : 16000);
    if (Number.isFinite(maxTokens) && maxTokens > 0) {
      body.max_tokens = maxTokens;
    }

    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await this.fetchFn(this.baseUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': this.httpReferer,
            'X-Title': this.xTitle,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const status = res?.status;
        const isRetryable = status === 429 || (typeof status === 'number' && status >= 500);

        let raw: any = null;
        try {
          raw = await res.json();
        } catch {
          raw = await res.text?.();
        }

        if (!res.ok) {
          if (isRetryable && attempt < maxAttempts) {
            await this.backoff(attempt);
            continue;
          }
          throw new OpenRouterHTTPError(typeof status === 'number' ? status : -1, raw);
        }

        const content = raw?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new Error('OpenRouter response missing choices[0].message.content');
        }

        const usage = parseUsage(raw);
        if (usage && options.onUsage) {
          options.onUsage(usage);
        }

        span.setAttributes({
          'llm.token_count.prompt': usage?.promptTokens ?? null,
          'llm.token_count.completion': usage?.completionTokens ?? null,
          'llm.token_count.total': usage?.totalTokens ?? null,
          'llm.latency_ms': Date.now() - startMs,
          'llm.attempt_count': attempt,
        });
        span.setOutput({ content });
        span.end();
        return { content, usage, raw };
      } catch (err) {
        lastErr = err;

        if (err instanceof OpenRouterHTTPError) {
          const status = err.status;
          const retryable = status === 429 || status >= 500;
          if (!retryable) {
            span.recordError(err);
            span.setAttributes({ 'llm.latency_ms': Date.now() - startMs, 'llm.attempt_count': attempt });
            span.end();
            throw err;
          }
        }

        if (attempt < maxAttempts) {
          await this.backoff(attempt);
          continue;
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    span.recordError(lastErr);
    span.setAttributes({ 'llm.latency_ms': Date.now() - startMs, 'llm.attempt_count': maxAttempts });
    span.end();
    throw lastErr instanceof Error ? lastErr : new Error('OpenRouter request failed');
  }

  async chatJson<T>(
    messages: LLMMessage[],
    schema: any,
    options: LLMChatJsonOptions = {}
  ): Promise<{ data: T; usage: LLMUsage | null; raw: unknown }> {
    const parseRetries = options.parseRetries ?? DEFAULT_PARSE_RETRIES;

    const system: LLMMessage = {
      role: 'system',
      content:
        'Return ONLY valid JSON that matches the provided schema. ' +
        'Do not include backticks, markdown fences, or commentary.',
    };

    const validate = this.ajv.compile(schema);

    let lastErr: unknown = null;

    for (let i = 1; i <= parseRetries; i++) {
      try {
        const result = await this.chat([system, ...messages], options);
        const jsonText = extractLikelyJson(result.content);
        const parsed = JSON.parse(jsonText);

        const ok = validate(parsed);
        if (!ok) {
          const errText = this.ajv.errorsText(validate.errors, { separator: '\n' });
          // Diagnostic: log the raw model output so prompt/schema mismatches can be diagnosed in production.
          // Truncate to avoid log bloat.
          const preview = (result.content ?? '').slice(0, 500);
          // eslint-disable-next-line no-console
          console.warn(`[LLMClient.chatJson] schema validation failed (attempt ${i}/${parseRetries}). Raw response (truncated): ${preview}`);
          throw new Error(`LLM JSON failed schema validation:\n${errText}`);
        }

        return { data: parsed as T, usage: result.usage, raw: result.raw };
      } catch (err) {
        lastErr = err;
        if (i < parseRetries) continue;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error('LLM JSON parse failed');
  }

  private async backoff(attempt: number): Promise<void> {
    // Exponential backoff with jitter. attempt starts at 1.
    const base = 500;
    const max = 8000;
    const exp = Math.min(max, base * Math.pow(2, attempt - 1));
    const jitter = 0.2;
    const rand = (this.randomFn() * 2 - 1) * jitter; // [-0.2..0.2]
    const delay = Math.max(0, Math.floor(exp * (1 + rand)));
    await this.sleepFn(delay);
  }
}
