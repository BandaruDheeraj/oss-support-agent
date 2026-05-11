/**
 * OpenRouter-backed FollowUpGenerator for the PM design email loop.
 *
 * Implements an action-loop ("tool use") so the LLM can browse the repo
 * before answering: list_dir, read_file, search_code, then a final reply.
 *
 * If no browser is provided the generator falls back to a one-shot
 * non-tool-using completion using the brief context only.
 */

import type {
  FollowUpGenerator,
  FollowUpInput,
  FollowUpResult,
} from '../pm-email-types';
import { LLMClient, type LLMMessage } from './client';
import { extractDecisions } from '../pm-email-loop';

export interface PMBrowserContext {
  browser: {
    listDirectory(repo: string, dirPath: string, ref?: string): Promise<Array<{ path: string; type: string; size: number }>>;
    readFile(repo: string, filePath: string, ref?: string): Promise<{ path: string; content: string; truncated: boolean; size: number }>;
    searchCode(repo: string, query: string): Promise<Array<{ path: string; matches: string[] }>>;
  };
  repo: string;
  ref?: string;
}

const ACTION_SCHEMA = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'path'],
      properties: {
        action: { const: 'list_dir' },
        path: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'path'],
      properties: {
        action: { const: 'read_file' },
        path: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'query'],
      properties: {
        action: { const: 'search_code' },
        query: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'responseBody', 'resolvedDecisions', 'unresolvedQuestions'],
      properties: {
        action: { const: 'reply' },
        responseBody: { type: 'string', minLength: 1 },
        resolvedDecisions: { type: 'array', items: { type: 'string', minLength: 1 } },
        unresolvedQuestions: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
  ],
} as const;

type Action =
  | { action: 'list_dir'; path: string }
  | { action: 'read_file'; path: string }
  | { action: 'search_code'; query: string }
  | { action: 'reply'; responseBody: string; resolvedDecisions: string[]; unresolvedQuestions: string[] };

const MAX_ITERATIONS = 8;
const MAX_TOTAL_FILE_BYTES = 200_000;

const SYSTEM_PROMPT = (repo: string, ref: string | undefined, hasBrowser: boolean) =>
  `You are a senior software-engineering PM agent driving a design conversation by email with a human PM about repo ${repo}${ref ? ` (ref ${ref})` : ''}.\n\n` +
  `For each turn you receive:\n` +
  `  - the original design brief context (related issues, recent PRs, design docs)\n` +
  `  - the full conversation history\n` +
  `  - the latest reply from the human\n` +
  `  - the prior cumulative resolvedDecisions and unresolvedQuestions\n\n` +
  (hasBrowser
    ? `You have repository tools. You may issue UP TO ${MAX_ITERATIONS} actions before responding:\n` +
      `  { "action": "list_dir",     "path": "<dir path>" }\n` +
      `  { "action": "read_file",    "path": "<file path>" }\n` +
      `  { "action": "search_code",  "query": "<github code search query>" }\n` +
      `Use them aggressively when the human references code, files, modules, or implementation details. ` +
      `Start by listing the affected module and reading the most relevant files. Cite paths and line ranges in your eventual reply.\n\n` +
      `When you have enough context, emit:\n`
    : `Tools are NOT available — respond from brief context alone. Do not promise to fetch code; if the human asks for code-level analysis, say plainly that you do not have repo access and suggest concrete questions instead.\n\n`) +
  `  { "action": "reply",\n` +
  `    "responseBody":        string,            // the email body to send (plain text / light markdown)\n` +
  `    "resolvedDecisions":   string[],          // updated cumulative list of decisions made so far\n` +
  `    "unresolvedQuestions": string[]           // updated list of design questions still open\n` +
  `  }\n\n` +
  `Rules for the reply body:\n` +
  `  1. Directly engage with what the human said. Quote relevant code snippets you read (\`\`\`-fenced) when useful.\n` +
  `  2. Acknowledge constraints they stated (e.g. library choices) and adjust the design accordingly.\n` +
  `  3. Surface ONLY questions still genuinely unresolved given the new information. Never re-ask resolved questions.\n` +
  `  4. Match the depth of their question — be substantive, not curt. End with a one-line nudge that they can keep iterating or reply with an approval keyword.\n\n` +
  `Always return a single JSON object — exactly one of the four action shapes — with no commentary, fences, or markdown around it.`;

export class OpenRouterPMFollowUpGenerator implements FollowUpGenerator {
  private readonly client: LLMClient;
  private readonly browserCtx?: PMBrowserContext;

  constructor(client?: LLMClient, browserCtx?: PMBrowserContext) {
    this.client = client ?? new LLMClient();
    this.browserCtx = browserCtx;
  }

  async generateFollowUp(input: FollowUpInput): Promise<FollowUpResult> {
    const { browserCtx } = this;
    const initialUser = {
      brief: {
        issueTitle: input.designBriefInput.issueTitle,
        issueSummary: input.designBriefInput.issueSummary,
        affectedModule: input.designBriefInput.affectedModule,
        relatedIssues: input.designBriefInput.relatedIssues,
        recentPRs: input.designBriefInput.recentPRs,
        designDocs: input.designBriefInput.designDocs,
      },
      conversationHistory: input.conversationHistory.map((e) => ({ role: e.role, body: e.body })),
      latestReply: input.latestReply,
      priorResolvedDecisions: input.resolvedDecisions,
      priorUnresolvedQuestions: input.unresolvedQuestions,
    };

    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT(browserCtx?.repo ?? '<unknown>', browserCtx?.ref, !!browserCtx) },
      { role: 'user', content: JSON.stringify(initialUser, null, 2) },
    ];

    let bytesFetched = 0;

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const { data } = await this.client.chatJson<Action>(messages, ACTION_SCHEMA, {
          agent: 'PM',
          temperature: 0.2,
        });

        if (data.action === 'reply') {
          return {
            responseBody: data.responseBody,
            resolvedDecisions: data.resolvedDecisions,
            unresolvedQuestions: data.unresolvedQuestions,
          };
        }

        if (!browserCtx) {
          return this.fallback(input, 'Tool use requested but no browser available.');
        }

        let toolResult: unknown;
        try {
          if (data.action === 'list_dir') {
            toolResult = await browserCtx.browser.listDirectory(browserCtx.repo, data.path, browserCtx.ref);
          } else if (data.action === 'read_file') {
            const file = await browserCtx.browser.readFile(browserCtx.repo, data.path, browserCtx.ref);
            bytesFetched += file.content.length;
            toolResult = file;
            if (bytesFetched > MAX_TOTAL_FILE_BYTES) {
              messages.push({ role: 'assistant', content: JSON.stringify(data) });
              messages.push({
                role: 'user',
                content: JSON.stringify({
                  toolResult,
                  notice: 'Total fetched bytes exceeded budget. Stop reading and reply.',
                }),
              });
              continue;
            }
          } else if (data.action === 'search_code') {
            toolResult = await browserCtx.browser.searchCode(browserCtx.repo, data.query);
          }
        } catch (err) {
          toolResult = { error: err instanceof Error ? err.message : String(err) };
        }

        messages.push({ role: 'assistant', content: JSON.stringify(data) });
        messages.push({ role: 'user', content: JSON.stringify({ toolResult }) });
      }

      // Out of iterations — force a reply by removing tool affordance.
      messages.push({
        role: 'user',
        content:
          'You have exhausted your tool budget. Reply now with a final {"action":"reply",...} object using what you have learned.',
      });
      const { data: forced } = await this.client.chatJson<Action>(messages, ACTION_SCHEMA, {
        agent: 'PM',
        temperature: 0.2,
      });
      if (forced.action === 'reply') {
        return {
          responseBody: forced.responseBody,
          resolvedDecisions: forced.resolvedDecisions,
          unresolvedQuestions: forced.unresolvedQuestions,
        };
      }
      return this.fallback(input, 'LLM still attempted a tool action after budget exhaustion.');
    } catch (err) {
      return this.fallback(input, err instanceof Error ? err.message : String(err));
    }
  }

  private fallback(input: FollowUpInput, _reason: string): FollowUpResult {
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
