/**
 * OpenRouter-backed FollowUpGenerator for the PM design email loop.
 *
 * Replaces the canned HeuristicFollowUpGenerator with an LLM that actually
 * reads the user's latest reply, considers the full conversation history and
 * the original brief context, and produces a thoughtful, on-topic response.
 *
 * Output shape mirrors FollowUpResult so the rest of pm-email-loop is
 * unchanged.
 */

import type {
  FollowUpGenerator,
  FollowUpInput,
  FollowUpResult,
} from '../pm-email-types';
import { LLMClient, type LLMMessage } from './client';
import { extractDecisions } from '../pm-email-loop';

const FOLLOW_UP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['responseBody', 'resolvedDecisions', 'unresolvedQuestions'],
  properties: {
    responseBody: { type: 'string', minLength: 1 },
    resolvedDecisions: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    unresolvedQuestions: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
} as const;

interface RawFollowUp {
  responseBody: string;
  resolvedDecisions: string[];
  unresolvedQuestions: string[];
}

const SYSTEM_PROMPT =
  'You are a senior software-engineering PM agent driving a design conversation by email with a human PM. ' +
  'Your job for each turn: read the FULL conversation history, the original design brief context, and the latest reply. ' +
  'Then produce a focused, on-topic response that:\n' +
  '  1. Directly addresses any questions, concerns, or constraints raised in the latest reply.\n' +
  '  2. Acknowledges and incorporates any decisions or preferences the human stated (e.g. "we are using LangChain").\n' +
  '  3. Surfaces ONLY the design questions still genuinely unresolved given the new information.\n' +
  '  4. Never restates decisions that have already been made.\n' +
  '  5. Stays brief, plain-text, and ends with a one-line nudge that the human can either keep iterating or reply with an approval keyword to proceed.\n\n' +
  'Return JSON with this exact shape:\n' +
  '{\n' +
  '  "responseBody":        string,            // the email body to send (plain text / light markdown)\n' +
  '  "resolvedDecisions":   string[],          // updated cumulative list of decisions made so far\n' +
  '  "unresolvedQuestions": string[]           // updated list of questions still open\n' +
  '}\n' +
  'Use the supplied prior resolvedDecisions and unresolvedQuestions as the starting point and update them based on the latest reply. ' +
  'Do not invent new open questions that are not motivated by the brief or the latest reply.';

export class OpenRouterPMFollowUpGenerator implements FollowUpGenerator {
  private readonly client: LLMClient;

  constructor(client?: LLMClient) {
    this.client = client ?? new LLMClient();
  }

  async generateFollowUp(input: FollowUpInput): Promise<FollowUpResult> {
    const userPayload = {
      brief: {
        issueTitle: input.designBriefInput.issueTitle,
        issueSummary: input.designBriefInput.issueSummary,
        affectedModule: input.designBriefInput.affectedModule,
        relatedIssues: input.designBriefInput.relatedIssues,
        recentPRs: input.designBriefInput.recentPRs,
        designDocs: input.designBriefInput.designDocs,
      },
      conversationHistory: input.conversationHistory.map((e) => ({
        role: e.role,
        body: e.body,
      })),
      latestReply: input.latestReply,
      priorResolvedDecisions: input.resolvedDecisions,
      priorUnresolvedQuestions: input.unresolvedQuestions,
    };

    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(userPayload, null, 2) },
    ];

    try {
      const { data } = await this.client.chatJson<RawFollowUp>(
        messages,
        FOLLOW_UP_SCHEMA,
        { agent: 'PM', temperature: 0.2 }
      );
      return {
        responseBody: data.responseBody,
        resolvedDecisions: data.resolvedDecisions,
        unresolvedQuestions: data.unresolvedQuestions,
      };
    } catch (err) {
      // Safe fallback so a transient LLM failure does not strand the PM loop.
      const heuristicDecisions = extractDecisions(input.latestReply);
      const merged = [...input.resolvedDecisions, ...heuristicDecisions];
      const body =
        'Thanks for the reply — I had trouble drafting a tailored response just now. ' +
        'Could you restate your guidance, or reply with an approval keyword if you are ready to proceed?\n\n' +
        '---\nReply with your thoughts or an approval keyword to proceed.';
      return {
        responseBody: body,
        resolvedDecisions: merged,
        unresolvedQuestions: input.unresolvedQuestions,
      };
    }
  }
}
