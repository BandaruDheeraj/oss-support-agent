/**
 * Phase E LLM provider — Vercel AI SDK pointed at OpenRouter.
 */

import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import type { LanguageModelV1 } from 'ai';
import { resolveModelFromEnv, type OpenRouterAgent } from '../client';

const providerByKey = new Map<string, OpenAIProvider>();

export interface ModelRoute {
  provider: 'openrouter';
  routeId: string;
  modelId: string;
  model: LanguageModelV1;
}

export class MissingOpenRouterApiKeyError extends Error {
  constructor() {
    super(
      'Missing OpenRouter API key. Set OPENROUTER_API_KEY (or OPENROUTER_API_KEYS / OPENROUTER_API_KEY_FALLBACKS) to enable Phase E loops.'
    );
    this.name = 'MissingOpenRouterApiKeyError';
  }
}

export function resetProviderForTests(): void {
  providerByKey.clear();
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function resolveApiKeys(): string[] {
  const candidates = [
    process.env.OPENROUTER_API_KEY ?? '',
    ...parseCsv(process.env.OPENROUTER_API_KEYS),
    ...parseCsv(process.env.OPENROUTER_API_KEY_FALLBACKS),
  ];
  return dedupe(candidates.filter(Boolean));
}

function fallbackModelsEnvVar(agent: PhaseEAgent): string {
  return `OPENROUTER_MODEL_FALLBACKS_${agent}`;
}

function resolveModelIds(agent: PhaseEAgent, override?: string): string[] {
  const primary = override ?? resolveModelFromEnv(agent as OpenRouterAgent);
  return dedupe([
    primary,
    ...parseCsv(process.env[fallbackModelsEnvVar(agent)]),
    ...parseCsv(process.env.OPENROUTER_MODEL_FALLBACKS),
  ]);
}

function providerForApiKey(apiKey: string): OpenAIProvider {
  const cached = providerByKey.get(apiKey);
  if (cached) return cached;
  const provider = createOpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    compatibility: 'compatible',
    headers: {
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://github.com',
      'X-Title': process.env.OPENROUTER_X_TITLE || 'oss-support-agent',
    },
  });
  providerByKey.set(apiKey, provider);
  return provider;
}

export type PhaseEAgent =
  | OpenRouterAgent
  | 'ANALYST'
  | 'REPRO_PLANNER'
  | 'REPRO_EXECUTOR'
  | 'REPRO_PROBER'
  | 'REPRO_CRITIC'
  | 'FIX_INVESTIGATOR'
  | 'FIX_PLANNER'
  | 'FIX_EXECUTOR'
  | 'FIX_CRITIC'
  | 'EMAIL_COMPOSER'
  | 'REPLY_MAPPER';

export function getModel(agent: PhaseEAgent, override?: string): LanguageModelV1 {
  return getModelRoutes(agent, override)[0].model;
}

export function getModelRoutes(agent: PhaseEAgent, override?: string): ModelRoute[] {
  const apiKeys = resolveApiKeys();
  if (apiKeys.length === 0) throw new MissingOpenRouterApiKeyError();

  const modelIds = resolveModelIds(agent, override);
  const routes: ModelRoute[] = [];
  for (let keyIndex = 0; keyIndex < apiKeys.length; keyIndex += 1) {
    const key = apiKeys[keyIndex];
    const provider = providerForApiKey(key);
    for (let modelIndex = 0; modelIndex < modelIds.length; modelIndex += 1) {
      const modelId = modelIds[modelIndex];
      routes.push({
        provider: 'openrouter',
        routeId: `openrouter:k${keyIndex + 1}:m${modelIndex + 1}`,
        modelId,
        model: provider(modelId),
      });
    }
  }
  return routes;
}

export function _modelForTests(modelId: string, injectedProvider: OpenAIProvider): LanguageModelV1 {
  return injectedProvider(modelId);
}
