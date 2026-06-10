/**
 * OpenRouter-backed ScaffoldGenerator implementation (US-100).
 */

import type { BuildAgentInput, ScaffoldGenerator, ScaffoldGeneratorOutput } from '../agents/build-types';
import type { LLMMessage } from './types';
import { ChatClient } from './v2/chat-client';

const SCAFFOLD_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['moduleFiles', 'testFiles', 'indexFiles', 'summary'],
  properties: {
    moduleFiles: {
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
    testFiles: {
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
    indexFiles: {
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

export class OpenRouterScaffoldGenerator implements ScaffoldGenerator {
  private readonly client: ChatClient;

  constructor(client?: ChatClient) {
    this.client = client ?? new ChatClient();
  }

  async generateScaffold(input: BuildAgentInput): Promise<ScaffoldGeneratorOutput> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a scaffolding generator for a new feature module. ' +
          'Return JSON matching the schema with moduleFiles, testFiles, indexFiles, and summary.',
      },
      {
        role: 'user',
        content: JSON.stringify(input, null, 2),
      },
    ];

    const { data } = await this.client.chatJson<ScaffoldGeneratorOutput>(messages, SCAFFOLD_OUTPUT_SCHEMA, {
      agent: 'BUILD',
      temperature: 0,
    });

    return data;
  }
}
