/**
 * OpenRouter-backed triage classifier (US-100).
 *
 * Falls back to the deterministic HeuristicClassifier when OPENROUTER_API_KEY is not set.
 */

import type { TriageClassifier, TriageInput, TriageResult } from './triage-types';
import { HeuristicClassifier } from './triage-agent';
import { LLMClient, type LLMMessage } from './llm-client';

const TRIAGE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issueType', 'affectedModule', 'confidence', 'summary'],
  properties: {
    issueType: { type: 'string', enum: ['bug_fix', 'new_feature', 'docs'] },
    affectedModule: { type: 'string', minLength: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string', minLength: 1 },
  },
} as const;

export class OpenRouterTriageClassifier implements TriageClassifier {
  private readonly client: LLMClient;

  constructor(client?: LLMClient) {
    this.client = client ?? new LLMClient();
  }

  async classify(input: TriageInput): Promise<TriageResult> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a triage classifier for an OSS agent harness. ' +
          'Classify the issue type and identify an affected module path. ' +
          'Output strictly JSON matching the schema.',
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

    const { data } = await this.client.chatJson<TriageResult>(messages, TRIAGE_RESULT_SCHEMA, {
      agent: 'TRIAGE',
      temperature: 0,
    });

    return data;
  }
}

/**
 * Default triage classifier selection:
 * - If OPENROUTER_API_KEY is set, use OpenRouter.
 * - Otherwise, use the deterministic heuristic implementation.
 */
export function createDefaultTriageClassifier(): TriageClassifier {
  if (!process.env.OPENROUTER_API_KEY) {
    return new HeuristicClassifier();
  }
  return new OpenRouterTriageClassifier();
}
