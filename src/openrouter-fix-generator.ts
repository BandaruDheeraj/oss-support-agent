/**
 * OpenRouter-backed FixGenerator implementation (US-100).
 */

import type { FixAgentInput, FixGenerator, FixGeneratorOutput } from './fix-agent-types';
import { LLMClient, type LLMMessage } from './llm-client';

const FIX_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceChanges', 'testChanges', 'summary'],
  properties: {
    sourceChanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'action', 'content'],
        properties: {
          path: { type: 'string', minLength: 1 },
          action: { type: 'string', enum: ['modify', 'create'] },
          content: { type: 'string' },
        },
      },
    },
    testChanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'action', 'content'],
        properties: {
          path: { type: 'string', minLength: 1 },
          action: { type: 'string', enum: ['modify', 'create'] },
          content: { type: 'string' },
        },
      },
    },
    summary: { type: 'string', minLength: 1 },
  },
} as const;

export class OpenRouterFixGenerator implements FixGenerator {
  private readonly client: LLMClient;

  constructor(client?: LLMClient) {
    this.client = client ?? new LLMClient();
  }

  async generateFix(input: FixAgentInput): Promise<FixGeneratorOutput> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a software engineer agent generating a targeted patch. ' +
          'Return JSON matching the schema with sourceChanges, testChanges, and summary. ' +
          'Only touch files within the affected module and related tests.',
      },
      {
        role: 'user',
        content: JSON.stringify(input, null, 2),
      },
    ];

    const { data } = await this.client.chatJson<FixGeneratorOutput>(messages, FIX_OUTPUT_SCHEMA, {
      agent: 'FIX',
      temperature: 0,
    });

    return data;
  }
}
