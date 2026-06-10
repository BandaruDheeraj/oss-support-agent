/**
 * OpenRouter-backed DocsGenerator.
 */

import type { DocsAgentInput, DocsGenerator, DocsGeneratorOutput } from '../../core/agents/docs-types';
import type { LLMMessage } from '../../core/llm/types';
import { ChatClient } from '../../core/llm/v2/chat-client';

const DOCS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['changes', 'summary'],
  properties: {
    changes: {
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

export class OpenRouterDocsGenerator implements DocsGenerator {
  private readonly client: ChatClient;
  constructor(client?: ChatClient) {
    this.client = client ?? new ChatClient();
  }

  async generateDocs(input: DocsAgentInput): Promise<DocsGeneratorOutput> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a documentation engineer. Update only documentation files (README, docs/, *.md). ' +
          'Never modify application source code or tests. Return JSON with changes[] and a summary.',
      },
      {
        role: 'user',
        content: JSON.stringify(input, null, 2),
      },
    ];
    const { data } = await this.client.chatJson<DocsGeneratorOutput>(messages, DOCS_OUTPUT_SCHEMA, {
      agent: 'DOCS',
      temperature: 0,
    });
    return data;
  }
}
