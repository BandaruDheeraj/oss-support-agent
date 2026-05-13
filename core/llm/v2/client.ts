/**
 * Phase E LLM provider — Vercel AI SDK pointed at OpenRouter.
 */

import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import type { LanguageModelV1 } from 'ai';
import { resolveModelFromEnv, type OpenRouterAgent } from '../client';

let provider: OpenAIProvider | null = null;

export class MissingOpenRouterApiKeyError extends Error {
  constructor() {
    super('Missing OPENROUTER_API_KEY. Set it in the environment to enable Phase E loops.');
    this.name = 'MissingOpenRouterApiKeyError';
  }
}

export function resetProviderForTests(): void {
  provider = null;
}

function getProvider(): OpenAIProvider {
  if (provider) return provider;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new MissingOpenRouterApiKeyError();
  provider = createOpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    compatibility: 'compatible',
    headers: {
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://github.com',
      'X-Title': process.env.OPENROUTER_X_TITLE || 'oss-support-agent',
    },
  });
  return provider;
}

export type PhaseEAgent =
  | OpenRouterAgent
  | 'ANALYST'
  | 'REPRO_PLANNER'
  | 'REPRO_EXECUTOR'
  | 'REPRO_CRITIC'
  | 'FIX_INVESTIGATOR'
  | 'FIX_PLANNER'
  | 'FIX_EXECUTOR'
  | 'FIX_CRITIC'
  | 'EMAIL_COMPOSER'
  | 'REPLY_MAPPER';

export function getModel(agent: PhaseEAgent, override?: string): LanguageModelV1 {
  const modelId = override ?? resolveModelFromEnv(agent as OpenRouterAgent);
  return getProvider()(modelId);
}

export function _modelForTests(modelId: string, injectedProvider: OpenAIProvider): LanguageModelV1 {
  return injectedProvider(modelId);
}
