/**
 * OpenRouter-backed triage classifier (US-100).
 *
 * Falls back to the deterministic issue-type classifier when OPENROUTER_API_KEY is not set.
 */

import type { IssueType, TriageTypeClassifier, TriageInput } from '../agents/triage-types';
import { DefaultIssueTypeClassifier } from '../agents/triage';
import { LLMClient, type LLMMessage } from './client';

const TRIAGE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issueType'],
  properties: {
    issueType: { type: 'string', enum: ['bug_fix', 'new_feature', 'docs'] },
  },
} as const;

export class OpenRouterTriageClassifier implements TriageTypeClassifier {
  private readonly client: LLMClient;

  constructor(client?: LLMClient) {
    this.client = client ?? new LLMClient();
  }

  async classifyIssueType(input: TriageInput): Promise<IssueType> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a triage classifier for an OSS agent harness. ' +
          'Classify only the issue type; module routing is handled by the repo adapter. ' +
          'Output strictly JSON of the form {"issueType": "<value>"} where <value> is exactly one of: ' +
          '"bug_fix", "new_feature", or "docs". ' +
          'Do not invent other values. Use "bug_fix" for bugs, regressions, or fixes. ' +
          'Use "new_feature" for new functionality or enhancements. ' +
          'Use "docs" for documentation, typos, or README changes.',
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            title: input.title,
            body: input.body,
            labels: input.labels,
            author: input.author,
            allowedIssueTypes: input.moduleTaxonomy,
            repoTree: input.repoTree,
            hasSkipPmGate: input.hasSkipPmGate,
          },
          null,
          2
        ),
      },
    ];

    const { data } = await this.client.chatJson<{ issueType: IssueType }>(messages, TRIAGE_RESULT_SCHEMA, {
      agent: 'TRIAGE',
      temperature: 0,
    });

    return data.issueType;
  }
}

/**
 * Default triage classifier selection:
 * - If OPENROUTER_API_KEY is set, use OpenRouter.
 * - Otherwise, use the deterministic heuristic implementation.
 */
export function createDefaultTriageClassifier(): TriageTypeClassifier {
  if (!process.env.OPENROUTER_API_KEY) {
    return new DefaultIssueTypeClassifier();
  }
  return new OpenRouterTriageClassifier();
}
