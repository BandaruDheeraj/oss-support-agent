/**
 * Unified chat client backed by the v2 provider routing (Anthropic-first).
 *
 * Implements the same chat()/chatJson() interface as the legacy LLMClient so
 * all consumers (triage, docs, scaffold, introspection) can migrate without
 * changing call-site signatures. Uses generateText from the Vercel AI SDK and
 * delegates provider selection to getModel() — Anthropic when ANTHROPIC_API_KEY
 * is set, OpenRouter otherwise.
 */

import { generateText } from 'ai';
import Ajv from 'ajv';

import { currentSpan, getTracer } from '../../observability';
import type {
  LLMChatJsonOptions,
  LLMChatOptions,
  LLMChatResult,
  LLMMessage,
  LLMUsage,
} from '../types';
import { getModel, type PhaseEAgent } from './client';

const DEFAULT_MAX_TOKENS = 16000;
const DEFAULT_PARSE_RETRIES = 3;

function extractLikelyJson(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
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

export class ChatClient {
  private readonly ajv: Ajv;

  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions = {}): Promise<LLMChatResult> {
    const agent: PhaseEAgent | undefined = options.agent;
    const model = getModel(agent ?? 'TRIAGE', options.model);
    const temperature = options.temperature ?? 0;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

    const tracer = getTracer();
    const span = tracer.startSpan('llm.chat', {
      kind: 'LLM',
      parent: currentSpan(),
      attributes: {
        'llm.temperature': temperature,
        'llm.agent': options.agent ?? null,
        'llm.message_count': messages.length,
      },
    });
    span.setInput({ messages });
    const startMs = Date.now();

    try {
      const result = await generateText({
        model,
        messages: messages.map((m) => ({
          role: m.role as 'system' | 'user' | 'assistant',
          content: m.content,
        })),
        temperature,
        maxTokens,
      });

      const content = result.text;
      const usage: LLMUsage | null = result.usage
        ? {
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
          }
        : null;

      if (usage && options.onUsage) options.onUsage(usage);

      span.setAttributes({
        'llm.token_count.prompt': usage?.promptTokens ?? null,
        'llm.token_count.completion': usage?.completionTokens ?? null,
        'llm.token_count.total': usage?.totalTokens ?? null,
        'llm.latency_ms': Date.now() - startMs,
      });
      span.setOutput({ content });
      span.end();

      return { content, usage, raw: result };
    } catch (err) {
      span.recordError(err);
      span.setAttributes({ 'llm.latency_ms': Date.now() - startMs });
      span.end();
      throw err;
    }
  }

  async chatJson<T>(
    messages: LLMMessage[],
    schema: any,
    options: LLMChatJsonOptions = {}
  ): Promise<{ data: T; usage: LLMUsage | null; raw: unknown }> {
    const parseRetries = options.parseRetries ?? DEFAULT_PARSE_RETRIES;
    const JSON_INSTRUCTION =
      'Return ONLY valid JSON that matches the provided schema. ' +
      'Do not include backticks, markdown fences, or commentary.';
    // Merge JSON instruction into an existing system message rather than introducing a second one,
    // since Anthropic treats multiple system messages as separate content blocks.
    let messagesWithInstruction: LLMMessage[];
    if (messages[0]?.role === 'system') {
      messagesWithInstruction = [
        { ...messages[0], content: `${messages[0].content}\n\n${JSON_INSTRUCTION}` },
        ...messages.slice(1),
      ];
    } else {
      messagesWithInstruction = [{ role: 'system', content: JSON_INSTRUCTION }, ...messages];
    }
    const validate = this.ajv.compile(schema);
    let lastErr: unknown = null;

    for (let i = 1; i <= parseRetries; i++) {
      try {
        const result = await this.chat(messagesWithInstruction, options);
        const jsonText = extractLikelyJson(result.content);
        const parsed = JSON.parse(jsonText);
        const ok = validate(parsed);
        if (!ok) {
          const errText = this.ajv.errorsText(validate.errors, { separator: '\n' });
          const preview = (result.content ?? '').slice(0, 500);
          // eslint-disable-next-line no-console
          console.warn(
            `[ChatClient.chatJson] schema validation failed (attempt ${i}/${parseRetries}). Raw response (truncated): ${preview}`
          );
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
}
