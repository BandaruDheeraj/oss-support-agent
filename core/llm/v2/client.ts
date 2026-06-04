/**
 * Phase E LLM provider — Vercel AI SDK.
 *
 * Provider priority:
 *   1. Anthropic direct (ANTHROPIC_API_KEY) — uses claude-3-5-sonnet-20241022 by default
 *   2. OpenRouter (OPENROUTER_API_KEY / OPENROUTER_API_KEYS)
 *
 * Set ANTHROPIC_API_KEY to bypass OpenRouter entirely. Both providers can
 * coexist; Anthropic routes appear first in the failover chain.
 */

import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import type { LanguageModelV1 } from 'ai';
import { resolveModelFromEnv, type OpenRouterAgent } from '../client';

const openrouterByKey = new Map<string, OpenAIProvider>();
let anthropicProvider: AnthropicProvider | undefined;

export interface ModelRoute {
  provider: 'anthropic' | 'openrouter';
  routeId: string;
  modelId: string;
  model: LanguageModelV1;
}

export class MissingLlmApiKeyError extends Error {
  constructor() {
    super(
      'No LLM API key configured. Set ANTHROPIC_API_KEY, or OPENROUTER_API_KEY / OPENROUTER_API_KEYS to enable Phase E loops.'
    );
    this.name = 'MissingLlmApiKeyError';
  }
}

/** @deprecated Use MissingLlmApiKeyError */
export class MissingOpenRouterApiKeyError extends MissingLlmApiKeyError {}

export function resetProviderForTests(): void {
  openrouterByKey.clear();
  anthropicProvider = undefined;
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

function openrouterProviderForKey(apiKey: string): OpenAIProvider {
  const cached = openrouterByKey.get(apiKey);
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
  openrouterByKey.set(apiKey, provider);
  return provider;
}

function getAnthropicProvider(): AnthropicProvider {
  if (!anthropicProvider) {
    anthropicProvider = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicProvider;
}

// Use a model known to work with @ai-sdk/anthropic@0.0.56.
// claude-sonnet-4-5 (Claude 4 series) is NOT in this SDK version's API surface
// and causes a silent failure that falls through to OpenRouter.
const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-20241022';

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
  const routes: ModelRoute[] = [];

  // Anthropic direct — highest priority when key is present.
  // Strip the "anthropic/" provider prefix from OpenRouter-format overrides
  // (e.g. "anthropic/claude-sonnet-4.5" → "claude-sonnet-4.5").
  // Also normalize dots to dashes in the version suffix so OpenRouter-style
  // model IDs like "claude-sonnet-4.5" become "claude-sonnet-4-5".
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    const rawOverride = override ?? DEFAULT_ANTHROPIC_MODEL;
    const stripped = rawOverride.startsWith('anthropic/')
      ? rawOverride.slice('anthropic/'.length)
      : rawOverride;
    // Dots in the version segment are not valid Anthropic model IDs.
    const modelId = stripped.replace(/(\d+)\.(\d+)/, '$1-$2');
    routes.push({
      provider: 'anthropic',
      routeId: 'anthropic:k1:m1',
      modelId,
      model: getAnthropicProvider()(modelId as Parameters<AnthropicProvider>[0]),
    });
  }

  // OpenRouter — fallback or primary when no Anthropic key.
  const openrouterKeys = resolveApiKeys();
  if (openrouterKeys.length > 0) {
    const modelIds = resolveModelIds(agent, override);
    for (let ki = 0; ki < openrouterKeys.length; ki += 1) {
      const provider = openrouterProviderForKey(openrouterKeys[ki]);
      for (let mi = 0; mi < modelIds.length; mi += 1) {
        routes.push({
          provider: 'openrouter',
          routeId: `openrouter:k${ki + 1}:m${mi + 1}`,
          modelId: modelIds[mi],
          model: provider(modelIds[mi]),
        });
      }
    }
  }

  if (routes.length === 0) throw new MissingLlmApiKeyError();
  return routes;
}

export function _modelForTests(modelId: string, injectedProvider: OpenAIProvider): LanguageModelV1 {
  return injectedProvider(modelId);
}
