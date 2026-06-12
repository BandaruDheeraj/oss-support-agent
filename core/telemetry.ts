/**
 * Shared telemetry wrapper for the OSS Fix Loop.
 *
 * Wraps every LLM call so the same trace is fanned out to all registered
 * observability platforms (Arize AX, LangSmith, Braintrust) in parallel.
 *
 * Design goals:
 *   - Non-blocking: a downed platform never affects the agent. Each platform
 *     call is wrapped in its own try/catch and errors are logged, not rethrown.
 *   - Provider-agnostic input/output: the wrapper takes Anthropic-style inputs
 *     and returns an Anthropic-style response so call sites stay portable.
 *   - Pluggable platforms: adding a fourth platform means creating one file in
 *     evals/platforms/ and calling registerPlatform() before tracedAnthropic.
 *
 * Internally, the wrapper uses @anthropic-ai/sdk when ANTHROPIC_API_KEY is set
 * and falls back to the existing OpenRouter-backed LLMClient otherwise. This
 * lets the eval runner work against either provider; the trace payload is the
 * same either way.
 */

import type { LLMMessage } from './llm/types';
import { ChatClient } from './llm/v2/chat-client';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PipelineStage =
  | 'triage'
  | 'pm'
  | 'fix'
  | 'build'
  | 'eval'
  | 'introspection';

export interface TelemetryContext {
  agent_name: string;
  run_id: string;
  issue_number: number;
  repo_name: string;
  stage: PipelineStage;
  /** Optional parent span id, for nested pipeline stages. */
  parent_span_id?: string;
  /** Free-form tags forwarded to each platform that supports them. */
  tags?: Record<string, string | number | boolean | null>;
}

/** Anthropic messages-API style input. */
export interface AnthropicMessageInput {
  model: string;
  max_tokens?: number;
  temperature?: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** Anthropic messages-API style output. */
export interface AnthropicMessageOutput {
  id: string;
  model: string;
  role: 'assistant';
  content: Array<{ type: 'text'; text: string }>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface TraceEvent {
  ctx: TelemetryContext;
  span_id: string;
  span_name: string;
  start_time_ms: number;
  end_time_ms: number;
  latency_ms: number;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  prompt: AnthropicMessageInput;
  response: AnthropicMessageOutput | null;
  error: { message: string; stack?: string } | null;
  /** Stage-level (non-LLM) spans set this; LLM spans leave it false. */
  is_llm: boolean;
}

export interface PerIssueResult {
  issue_number: number;
  title: string;
  difficulty: string;
  triage_result: {
    issue_type: string;
    module: string;
    latency_ms: number;
    input_tokens: number | null;
    output_tokens: number | null;
  };
  pm_result: {
    design_needed: boolean;
    reasoning: string;
    latency_ms: number;
    input_tokens: number | null;
    output_tokens: number | null;
  };
  scores: { triage_accuracy: number; pm_accuracy: number };
}

export interface RunSummary {
  run_id: string;
  repo_name: string;
  total_issues: number;
  start_time_ms: number;
  end_time_ms: number;
  duration_ms: number;
  aggregate: {
    triage_accuracy_overall: number;
    pm_accuracy_overall: number;
    triage_accuracy_by_difficulty: Record<string, number>;
    avg_latency_by_stage: { triage: number; pm: number };
    total_input_tokens: number;
    total_output_tokens: number;
  };
  per_issue: PerIssueResult[];
}

export interface PingResult {
  platform: string;
  connected: boolean;
  latency_ms: number;
  error?: string;
}

export interface PlatformAdapter {
  readonly name: string;
  connect(): Promise<void>;
  ping(): Promise<PingResult>;
  logTrace(trace: TraceEvent): Promise<void>;
  logRun(run: RunSummary): Promise<void>;
  /** Friction encountered during integration. Populated at implementation time. */
  getSetupNotes(): string[];
}

// ---------------------------------------------------------------------------
// Platform registry
// ---------------------------------------------------------------------------

const platforms: PlatformAdapter[] = [];

export function registerPlatform(adapter: PlatformAdapter): void {
  if (platforms.some((p) => p.name === adapter.name)) {
    return;
  }
  platforms.push(adapter);
}

export function getRegisteredPlatforms(): readonly PlatformAdapter[] {
  return platforms;
}

export function clearRegisteredPlatforms(): void {
  platforms.length = 0;
}

// ---------------------------------------------------------------------------
// Fan-out helpers
// ---------------------------------------------------------------------------

interface FanOutErrors {
  [platformName: string]: string;
}

async function fanOut<T>(
  op: string,
  perPlatform: (p: PlatformAdapter) => Promise<T>
): Promise<FanOutErrors> {
  const errors: FanOutErrors = {};
  await Promise.all(
    platforms.map(async (p) => {
      try {
        await perPlatform(p);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors[p.name] = msg;
        // eslint-disable-next-line no-console
        console.error(`[telemetry] ${op} failed for ${p.name}: ${msg}`);
      }
    })
  );
  return errors;
}

export async function fanOutTrace(trace: TraceEvent): Promise<FanOutErrors> {
  return fanOut('logTrace', (p) => p.logTrace(trace));
}

export async function fanOutRun(run: RunSummary): Promise<FanOutErrors> {
  return fanOut('logRun', (p) => p.logRun(run));
}

export async function pingAll(): Promise<PingResult[]> {
  return Promise.all(
    platforms.map(async (p) => {
      try {
        return await p.ping();
      } catch (err) {
        return {
          platform: p.name,
          connected: false,
          latency_ms: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );
}

export async function connectAll(): Promise<{ platform: string; ok: boolean; error?: string }[]> {
  return Promise.all(
    platforms.map(async (p) => {
      try {
        await p.connect();
        return { platform: p.name, ok: true };
      } catch (err) {
        return {
          platform: p.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );
}

// ---------------------------------------------------------------------------
// LLM call wrapper
// ---------------------------------------------------------------------------

let cachedAnthropic: any | null = null;
let triedAnthropic = false;

async function getAnthropicClient(): Promise<any | null> {
  if (triedAnthropic) return cachedAnthropic;
  triedAnthropic = true;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    // Optional dynamic import — the SDK is a regular dep but loading it lazily
    // means processes that never trace don't pay the import cost.
    const mod = await import('@anthropic-ai/sdk');
    const Anthropic = (mod as any).default ?? (mod as any).Anthropic;
    cachedAnthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return cachedAnthropic;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[telemetry] ANTHROPIC_API_KEY set but @anthropic-ai/sdk failed to load; ` +
        `falling back to OpenRouter. Reason: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

let cachedChatClient: ChatClient | null = null;

function getChatClient(): ChatClient {
  if (cachedChatClient) return cachedChatClient;
  cachedChatClient = new ChatClient();
  return cachedChatClient;
}

function newSpanId(): string {
  return `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function flattenContent(content: AnthropicMessageOutput['content']): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

function buildAnthropicShapedResponse(
  model: string,
  text: string,
  inputTokens: number | null,
  outputTokens: number | null
): AnthropicMessageOutput {
  return {
    id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    model,
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: inputTokens ?? 0,
      output_tokens: outputTokens ?? 0,
    },
  };
}

function anthropicMessagesToLLMMessages(input: AnthropicMessageInput): LLMMessage[] {
  const out: LLMMessage[] = [];
  if (input.system) out.push({ role: 'system', content: input.system });
  for (const m of input.messages) {
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/**
 * Run an LLM call and fan trace events out to all registered platforms.
 *
 * The call is NEVER blocked by telemetry failures. Returns the original
 * Anthropic-shaped response so callers can swap raw SDK usage for this
 * wrapper with no further changes.
 */
export async function tracedAnthropic(
  input: AnthropicMessageInput,
  ctx: TelemetryContext
): Promise<AnthropicMessageOutput> {
  const spanId = newSpanId();
  const startMs = Date.now();
  let response: AnthropicMessageOutput | null = null;
  let error: { message: string; stack?: string } | null = null;

  try {
    const anthropic = await getAnthropicClient();
    if (anthropic) {
      const raw = await anthropic.messages.create({
        model: input.model,
        max_tokens: input.max_tokens ?? 4096,
        temperature: input.temperature ?? 0,
        system: input.system,
        messages: input.messages,
      });
      response = {
        id: raw.id ?? `msg_${spanId}`,
        model: raw.model ?? input.model,
        role: 'assistant',
        content: Array.isArray(raw.content)
          ? raw.content
              .filter((b: any) => b?.type === 'text')
              .map((b: any) => ({ type: 'text' as const, text: String(b.text ?? '') }))
          : [{ type: 'text' as const, text: '' }],
        stop_reason: raw.stop_reason ?? null,
        usage: {
          input_tokens: raw.usage?.input_tokens ?? 0,
          output_tokens: raw.usage?.output_tokens ?? 0,
        },
      };
    } else {
      const result = await getChatClient().chat(anthropicMessagesToLLMMessages(input), {
        model: input.model,
        temperature: input.temperature ?? 0,
        maxTokens: input.max_tokens,
      });
      response = buildAnthropicShapedResponse(
        input.model,
        result.content,
        result.usage?.promptTokens ?? null,
        result.usage?.completionTokens ?? null
      );
    }
  } catch (err) {
    error = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
  }

  const endMs = Date.now();
  const trace: TraceEvent = {
    ctx,
    span_id: spanId,
    span_name: `llm.${input.model}`,
    start_time_ms: startMs,
    end_time_ms: endMs,
    latency_ms: endMs - startMs,
    model: input.model,
    input_tokens: response?.usage.input_tokens ?? null,
    output_tokens: response?.usage.output_tokens ?? null,
    prompt: input,
    response,
    error,
    is_llm: true,
  };

  // Fire and forget — telemetry failures never block the agent. We still
  // await Promise.all so trace ordering is predictable in the eval runner,
  // but errors are swallowed inside fanOut().
  await fanOutTrace(trace);

  if (error) {
    const err = new Error(error.message);
    if (error.stack) err.stack = error.stack;
    throw err;
  }
  return response!;
}

/**
 * Emit a pipeline-stage span that did NOT call the LLM (e.g. PM heuristic
 * scoring). Useful for getting a fair cross-platform comparison of how each
 * platform renders non-LLM spans inside an otherwise LLM-heavy trace tree.
 */
export async function tracedStage<T>(
  ctx: TelemetryContext,
  spanName: string,
  fn: () => Promise<T> | T,
  meta?: { inputSummary?: unknown; outputExtractor?: (r: T) => unknown }
): Promise<T> {
  const spanId = newSpanId();
  const startMs = Date.now();
  let result: T | undefined;
  let error: { message: string; stack?: string } | null = null;
  try {
    result = await fn();
  } catch (err) {
    error = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
  }
  const endMs = Date.now();

  const promptShim: AnthropicMessageInput = {
    model: 'n/a:non-llm-stage',
    messages: [
      {
        role: 'user',
        content: JSON.stringify(meta?.inputSummary ?? { stage: ctx.stage }, null, 2),
      },
    ],
  };
  const responseShim: AnthropicMessageOutput | null = error
    ? null
    : buildAnthropicShapedResponse(
        'n/a:non-llm-stage',
        JSON.stringify(meta?.outputExtractor ? meta.outputExtractor(result as T) : (result ?? null), null, 2),
        0,
        0
      );

  const trace: TraceEvent = {
    ctx,
    span_id: spanId,
    span_name: spanName,
    start_time_ms: startMs,
    end_time_ms: endMs,
    latency_ms: endMs - startMs,
    model: null,
    input_tokens: null,
    output_tokens: null,
    prompt: promptShim,
    response: responseShim,
    error,
    is_llm: false,
  };
  await fanOutTrace(trace);

  if (error) {
    const err = new Error(error.message);
    if (error.stack) err.stack = error.stack;
    throw err;
  }
  return result as T;
}
