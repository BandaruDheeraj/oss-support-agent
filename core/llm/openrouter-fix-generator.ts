/**
 * OpenRouter-backed FixGenerator implementation (US-100).
 */

import type { FixAgentInput, FixGenerator, FixGeneratorOutput } from '../agents/fix-types';
import { LLMClient, type LLMMessage } from './client';

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
          'Return JSON with this exact shape:\n' +
          '{\n' +
          '  "sourceChanges": [{"path": string, "action": "modify"|"create", "content": string}],\n' +
          '  "testChanges":   [{"path": string, "action": "modify"|"create", "content": string}],\n' +
          '  "summary": string\n' +
          '}\n' +
          'Every entry in sourceChanges and testChanges MUST include all three fields: path, action, and content. ' +
          'The "action" field must be exactly the string "modify" (for existing files) or "create" (for new files). ' +
          'The "content" field is the COMPLETE file contents after your edit (not a diff). ' +
          'Only touch files within the affected module and related tests. ' +
          'IMPORTANT: If sourceChanges is non-empty, testChanges MUST also be non-empty. ' +
          'For documentation-only fixes (README, AGENTS.md, CHANGELOG, etc.) where no executable test makes sense, ' +
          'add a trivial test entry such as a tests/test_docs_smoke.py with a single assertion that the doc file ' +
          'exists and is non-empty. Do not omit testChanges. ' +
          'Do not include any properties other than path, action, content.',
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
