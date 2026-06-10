/**
 * OpenRouter-backed triage classifier (US-100).
 *
 * Drives an action loop ("tool use") so the LLM can browse the repo
 * (list_dir, read_file, search_code) before deciding both the issue type
 * AND whether the issue is even applicable to this codebase.
 *
 * Falls back to the deterministic heuristic classifier when:
 *   - OPENROUTER_API_KEY is not set, or
 *   - no browser context is provided, or
 *   - the LLM call fails.
 */

import type {
  TriageClassification,
  TriageTypeClassifier,
  TriageInput,
} from '../agents/triage-types';
import { DefaultIssueTypeClassifier } from '../agents/triage';
import type { LLMMessage } from './types';
import { ChatClient } from './v2/chat-client';

export interface TriageBrowserContext {
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
      required: ['action', 'issueType', 'relevance', 'relevanceReason'],
      properties: {
        action: { const: 'classify' },
        issueType: { type: 'string', enum: ['bug_fix', 'new_feature', 'docs'] },
        relevance: { type: 'string', enum: ['applicable', 'not_applicable'] },
        relevanceReason: { type: 'string', minLength: 1 },
      },
    },
  ],
} as const;

type Action =
  | { action: 'list_dir'; path: string }
  | { action: 'read_file'; path: string }
  | { action: 'search_code'; query: string }
  | {
      action: 'classify';
      issueType: 'bug_fix' | 'new_feature' | 'docs';
      relevance: 'applicable' | 'not_applicable';
      relevanceReason: string;
    };

const MAX_ITERATIONS = 6;
const MAX_TOTAL_FILE_BYTES = 150_000;

const SYSTEM_PROMPT = (repo: string, ref: string | undefined, hasBrowser: boolean) =>
  `You are the triage agent for an autonomous OSS-fix bot operating on the repository ${repo}${ref ? ` (ref ${ref})` : ''}.\n\n` +
  `Your job for each incoming issue is to decide TWO things:\n` +
  `  1. issueType: one of "bug_fix" | "new_feature" | "docs"\n` +
  `  2. relevance: "applicable" if the issue is about something this codebase plausibly does or could do; "not_applicable" if it is off-topic for this repo (vendor pitch, unrelated tool, marketing/spam, wrong-repo report, etc.)\n\n` +
  (hasBrowser
    ? `You have repository tools. Use them BEFORE classifying. You may issue UP TO ${MAX_ITERATIONS} actions total:\n` +
      `  { "action": "list_dir",     "path": "<dir path>"            }   // list a directory's contents\n` +
      `  { "action": "read_file",    "path": "<file path>"           }   // read a single file (truncated to 50KB)\n` +
      `  { "action": "search_code",  "query": "<github code search>" }   // text search across the repo\n\n` +
      `Suggested workflow:\n` +
      `  - Start with list_dir on "" or a top-level directory you saw in repoTree to ground yourself.\n` +
      `  - If the issue mentions a module, library, or feature, search_code or list_dir it. Try BOTH the literal name and a lowercased / hyphenated variant (e.g. "LangChain" -> also try "langchain").\n` +
      `  - "no exact match" does NOT mean "not_applicable" — feature requests are valid even when the feature does not exist yet. Only mark not_applicable if the issue clearly belongs to a different project, is spam, or asks the bot to do something outside this repo's domain.\n\n` +
      `When you have enough context, emit the final classify action.\n\n`
    : `Tools are NOT available — classify from the issue text and repoTree alone. Default to "applicable" unless the issue is obviously off-topic (spam, vendor pitch).\n\n`) +
  `Final action shape:\n` +
  `  { "action": "classify",\n` +
  `    "issueType":       "bug_fix" | "new_feature" | "docs",\n` +
  `    "relevance":       "applicable" | "not_applicable",\n` +
  `    "relevanceReason": "<one-sentence justification, citing files or behaviour you observed>"\n` +
  `  }\n\n` +
  `Always return a single JSON object — exactly one of the four action shapes — with no commentary, fences, or markdown around it.`;

export class OpenRouterTriageClassifier implements TriageTypeClassifier {
  private readonly client: ChatClient;
  private readonly browserCtx?: TriageBrowserContext;

  constructor(client?: ChatClient, browserCtx?: TriageBrowserContext) {
    this.client = client ?? new ChatClient();
    this.browserCtx = browserCtx;
  }

  async classifyIssueType(input: TriageInput): Promise<TriageClassification> {
    const { browserCtx } = this;
    const initialUser = {
      title: input.title,
      body: input.body,
      labels: input.labels,
      author: input.author,
      allowedIssueTypes: input.moduleTaxonomy,
      repoTree: input.repoTree,
      hasSkipPmGate: input.hasSkipPmGate,
    };

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: SYSTEM_PROMPT(browserCtx?.repo ?? '<unknown>', browserCtx?.ref, !!browserCtx),
      },
      { role: 'user', content: JSON.stringify(initialUser, null, 2) },
    ];

    let bytesFetched = 0;

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const { data } = await this.client.chatJson<Action>(messages, ACTION_SCHEMA, {
          agent: 'TRIAGE',
          temperature: 0,
        });

        if (data.action === 'classify') {
          return {
            issueType: data.issueType,
            relevance: data.relevance,
            relevanceReason: data.relevanceReason,
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
                  notice: 'Total fetched bytes exceeded budget. Stop reading and emit the final classify action.',
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

      // Out of iterations — force a classify.
      messages.push({
        role: 'user',
        content:
          'You have exhausted your tool budget. Emit the final {"action":"classify",...} object now using what you have learned.',
      });
      const { data: forced } = await this.client.chatJson<Action>(messages, ACTION_SCHEMA, {
        agent: 'TRIAGE',
        temperature: 0,
      });
      if (forced.action === 'classify') {
        return {
          issueType: forced.issueType,
          relevance: forced.relevance,
          relevanceReason: forced.relevanceReason,
        };
      }
      return this.fallback(input, 'LLM still attempted a tool action after budget exhaustion.');
    } catch (err) {
      return this.fallback(input, err instanceof Error ? err.message : String(err));
    }
  }

  private async fallback(input: TriageInput, _reason: string): Promise<TriageClassification> {
    const heuristic = await new DefaultIssueTypeClassifier().classifyIssueType(input);
    return {
      issueType: heuristic.issueType,
      relevance: 'applicable',
      relevanceReason: 'Fell back to heuristic classifier; relevance not evaluated.',
    };
  }
}

/**
 * Default triage classifier selection:
 * - If ANTHROPIC_API_KEY or OPENROUTER_API_KEY is set, use the LLM classifier.
 * - Otherwise, use the deterministic heuristic implementation.
 */
export function createDefaultTriageClassifier(
  browserCtx?: TriageBrowserContext
): TriageTypeClassifier {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENROUTER_API_KEY) {
    return new DefaultIssueTypeClassifier();
  }
  return new OpenRouterTriageClassifier(undefined, browserCtx);
}
