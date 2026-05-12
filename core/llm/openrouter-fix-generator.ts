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
    // Strip failureDirective from the JSON body — we'll promote it to a
    // dedicated preamble at the TOP of the user message so the LLM cannot
    // miss it, mirroring what we do in OpenRouterIterativeReproGenerator.
    const { failureDirective, ...inputForJson } = input;
    const userParts: string[] = [];
    if (failureDirective && failureDirective.trim().length > 0) {
      userParts.push(
        '‼️ DIRECTIVE FROM PREVIOUS ATTEMPT — READ FIRST, OBEY UNCONDITIONALLY:',
        failureDirective.trim(),
        '',
        '↑ If you ignore the directive above, this attempt will be rejected the same way the last one was. ' +
        'Read it, then read the rest of the input.',
        '',
      );
    }
    userParts.push(JSON.stringify(inputForJson, null, 2));

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
          'CRITICAL: When action="modify" you MUST reproduce the entire file verbatim, ' +
          'including every line that you are NOT changing. NEVER abbreviate, truncate, or ' +
          'replace existing code with placeholder comments such as "# ...existing code...", ' +
          '"# Other imports...", "# Existing logic...", "// ... rest of file ...", ' +
          '"# (unchanged)", "# omitted for brevity", or any ellipsis-based summary. ' +
          'If the file is too long to reproduce in full, prefer making no edit to that file ' +
          'and explaining the limitation in summary. ' +
          'Only touch files within the affected module and related tests. ' +
          'IMPORTANT: If sourceChanges is non-empty, testChanges MUST also be non-empty. ' +
          'For documentation-only fixes (README, AGENTS.md, CHANGELOG, etc.) where no executable test makes sense, ' +
          'add a trivial test entry such as a tests/test_docs_smoke.py with a single assertion that the doc file ' +
          'exists and is non-empty. Do not omit testChanges. ' +
          'REPRO TEST: If the input has a "reproTest" field, a reproduction test already exists ' +
          'on the branch at that path that currently FAILS on the bug. Your fix MUST make it ' +
          'pass (exit code 0). UNDER NO CIRCUMSTANCES include the reproTest path in sourceChanges ' +
          'or testChanges — it is read-only. Do not weaken its assertions, do not delete it, do ' +
          'not move it. Fix the underlying bug so the existing repro passes as-is. ' +
          'If the user message begins with a "‼️ DIRECTIVE FROM PREVIOUS ATTEMPT" block, ' +
          'that directive takes precedence over your own judgment about what to do next: ' +
          'the previous attempt was rejected for a specific reason and the directive tells ' +
          'you exactly how to avoid the same rejection. ' +
          'Do not include any properties other than path, action, content.',
      },
      {
        role: 'user',
        content: userParts.join('\n'),
      },
    ];

    const { data } = await this.client.chatJson<FixGeneratorOutput>(messages, FIX_OUTPUT_SCHEMA, {
      agent: 'FIX',
      temperature: 0,
    });

    return data;
  }
}
