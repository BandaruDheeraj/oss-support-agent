/**
 * Introspection email review loop (US-106).
 */

import type { DraftAdapter, RepoSignals } from './agents/introspection-types';
import type { EmailThread, GmailClient, GmailReply, ReplyHandler } from './gmail-types';

import {
  SUBJECT_PREFIX,
} from './gmail-types';

import {
  appendAgentMessageToThread,
  createEmailThread,
  sendEmail,
} from './gmail-mcp';

import type { LLMClientLike } from './llm/test-utils';

import {
  IntrospectionEmailLoopConfig,
  IntrospectionEmailLoopResult,
  IntrospectionEmailState,
  IntrospectionStateStore,
  IntrospectionEmailLoopError,
} from './introspection-email-types';

import { encodeRunIdForLocalPart } from './resend-mail';

const DEFAULT_MAX_ITERATIONS = 10;

export function formatIntrospectionSubject(repoFullName: string): string {
  return `${SUBJECT_PREFIX} introspection: ${repoFullName}`;
}

export function formatIntrospectionDraftEmail(draft: DraftAdapter, options: {
  repoFullName: string;
  approvalKeywords: string[];
  iteration: number;
  maxIterations: number;
}): string {
  const { repoFullName, approvalKeywords, iteration, maxIterations } = options;

  const rationaleLines = Object.keys(draft.rationale || {}).length > 0
    ? Object.entries(draft.rationale)
        .map(([k, v]) => `- **${k}**: ${v}`)
        .join('\n')
    : '- (none)';

  const openItemsLines = draft.openItems && draft.openItems.length > 0
    ? draft.openItems.map((i) => `- ${i}`).join('\n')
    : '- (none)';

  return [
    `## Introspection Draft Review\n`,
    `Repo: **${repoFullName}**\n`,
    `Iteration: **${iteration}** (max revisions: ${maxIterations})\n`,
    `---\n`,
    `### manifest.yaml\n`,
    '```yaml',
    (draft.manifestYaml || '').trim(),
    '```\n',
    `### adapter.ts\n`,
    '```ts',
    (draft.adapterTs || '').trim(),
    '```\n',
    `### Rationale\n${rationaleLines}\n`,
    `### Open Items\n${openItemsLines}\n`,
    `---\n`,
    `Reply with one of the approval keywords to activate: ${approvalKeywords.join(', ')}\n`,
    `Or reply with corrections (what to change and why).\n`,
  ].join('\n');
}

export function stripQuotedReplyText(body: string): string {
  const lines = (body || '').split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Common reply-quote separators.
    if (/^On .+wrote:\s*$/i.test(trimmed)) break;
    if (/^-----Original Message-----\s*$/i.test(trimmed)) break;
    if (/^From:\s+/i.test(trimmed) || /^Sent:\s+/i.test(trimmed) || /^Subject:\s+/i.test(trimmed) || /^To:\s+/i.test(trimmed)) {
      // In many clients, headers mark the start of quoted content.
      break;
    }

    // Traditional quoted line.
    if (/^\s*>/.test(trimmed)) continue;

    kept.push(trimmed);
  }

  return kept.join('\n').trim();
}

export function isApproval(body: string, approvalKeywords: string[]): boolean {
  const stripped = stripQuotedReplyText(body);
  const haystack = stripped.toLowerCase();

  for (const keyword of approvalKeywords) {
    const k = (keyword || '').trim();
    if (!k) continue;
    if (haystack.includes(k.toLowerCase())) return true;
  }

  return false;
}

export function detectApprovalIgnoringQuotes(
  body: string,
  approvalKeywords: string[]
): { approved: boolean; matchedKeyword: string | null; replyBody: string } {
  const stripped = stripQuotedReplyText(body);
  const haystack = stripped.toLowerCase();

  for (const keyword of approvalKeywords) {
    const k = (keyword || '').trim();
    if (!k) continue;
    if (haystack.includes(k.toLowerCase())) {
      return { approved: true, matchedKeyword: keyword, replyBody: body };
    }
  }

  return { approved: false, matchedKeyword: null, replyBody: body };
}

const draftSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['adapterTs', 'manifestYaml', 'rationale', 'openItems'],
  properties: {
    adapterTs: { type: 'string' },
    manifestYaml: { type: 'string' },
    rationale: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    openItems: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} as const;

export async function reviseDraft(
  llm: LLMClientLike,
  current: DraftAdapter,
  replyBody: string,
  signals: RepoSignals
): Promise<DraftAdapter> {
  const prompt = [
    'You are revising a repo adapter + manifest draft based on PM feedback.',
    'Return a full replacement draft, not a patch.',
    '',
    'PM reply (unquoted, user-authored portion may be mixed with quoted content):',
    replyBody,
    '',
    'Current draft manifest.yaml:',
    current.manifestYaml,
    '',
    'Current draft adapter.ts:',
    current.adapterTs,
    '',
    'Repo signals (for reference):',
    JSON.stringify(signals, null, 2),
    '',
    'Constraints:',
    '- Keep manifest config-only fields consistent with harness schema.',
    '- adapter.ts must be a valid TypeScript module and should export `export default class ...`.',
    '- Preserve or improve rationale/openItems to reflect updated decisions.',
  ].join('\n');

  const { data } = await llm.chatJson<DraftAdapter>(
    [{ role: 'user', content: prompt }],
    draftSchema,
    { agent: 'INTROSPECTION', temperature: 0 }
  );

  return data;
}

async function sendOrAppendIntrospectionEmail(
  client: GmailClient,
  config: IntrospectionEmailLoopConfig,
  body: string,
  threadId?: string,
  existingThread?: EmailThread
): Promise<EmailThread> {
  const subject = formatIntrospectionSubject(config.repoFullName);

  const result = await sendEmail(client, {
    to: config.pmEmail,
    subject,
    body,
    replyTo: config.replyToAddress,
    threadId,
  });

  const timestamp = new Date().toISOString();

  if (existingThread) {
    return appendAgentMessageToThread(existingThread, body, result.messageId, timestamp);
  }

  return createEmailThread(
    config.repoFullName,
    result.threadId,
    subject,
    body,
    result.messageId,
    timestamp
  );
}

export async function sendIntrospectionEmail(
  client: GmailClient,
  watcher: { registerThread: (t: EmailThread) => void; getThread: (id: string) => EmailThread | undefined },
  config: IntrospectionEmailLoopConfig,
  draft: DraftAdapter,
  stateStore: IntrospectionStateStore
): Promise<IntrospectionEmailLoopResult> {
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const iteration = 0;

  const body = formatIntrospectionDraftEmail(draft, {
    repoFullName: config.repoFullName,
    approvalKeywords: config.approvalKeywords,
    iteration,
    maxIterations,
  });

  const existingThread = config.existingThreadId
    ? watcher.getThread(config.existingThreadId)
    : undefined;

  const thread = await sendOrAppendIntrospectionEmail(
    client,
    config,
    body,
    config.existingThreadId,
    existingThread
  );

  watcher.registerThread(thread);

  stateStore.saveState(config.repoFullName, {
    repoFullName: config.repoFullName,
    thread,
    draft,
    iteration,
  });

  return { action: 'email_sent', thread, iteration };
}

export async function processIntrospectionReply(options: {
  client: GmailClient;
  watcher: { registerThread: (t: EmailThread) => void; unregisterThread: (id: string) => void };
  config: IntrospectionEmailLoopConfig;
  signals: RepoSignals;
  llm: LLMClientLike;
  replyBody: string;
  stateStore: IntrospectionStateStore;
}): Promise<IntrospectionEmailLoopResult> {
  const maxIterations = options.config.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const state = options.stateStore.loadState(options.config.repoFullName);
  if (!state) {
    throw new IntrospectionEmailLoopError(
      `No introspection email state found for ${options.config.repoFullName}`,
      'load_state',
      options.config.repoFullName
    );
  }

  const approval = detectApprovalIgnoringQuotes(options.replyBody, options.config.approvalKeywords);
  if (approval.approved) {
    options.stateStore.deleteState(options.config.repoFullName);
    options.watcher.unregisterThread(state.thread.threadId);
    return {
      action: 'approved',
      thread: state.thread,
      iteration: state.iteration,
      approvalResult: approval,
      finalDraft: state.draft,
    };
  }

  if (state.iteration >= maxIterations) {
    throw new IntrospectionEmailLoopError(
      `Max introspection email iterations exceeded (${maxIterations}) for ${options.config.repoFullName}`,
      'max_iterations',
      options.config.repoFullName
    );
  }

  const updatedDraft = await reviseDraft(options.llm, state.draft, options.replyBody, options.signals);
  const nextIteration = state.iteration + 1;

  const body = formatIntrospectionDraftEmail(updatedDraft, {
    repoFullName: options.config.repoFullName,
    approvalKeywords: options.config.approvalKeywords,
    iteration: nextIteration,
    maxIterations,
  });

  const updatedThread = await sendOrAppendIntrospectionEmail(
    options.client,
    options.config,
    body,
    state.thread.threadId,
    state.thread
  );

  options.watcher.registerThread(updatedThread);

  const newState: IntrospectionEmailState = {
    repoFullName: options.config.repoFullName,
    thread: updatedThread,
    draft: updatedDraft,
    iteration: nextIteration,
  };
  options.stateStore.saveState(options.config.repoFullName, newState);

  return {
    action: 'revised',
    thread: updatedThread,
    iteration: nextIteration,
    draft: updatedDraft,
  };
}

export function resumeIntrospectionEmailLoop(
  watcher: { registerThread: (t: EmailThread) => void },
  stateStore: IntrospectionStateStore,
  repoFullName: string
): IntrospectionEmailState | null {
  const state = stateStore.loadState(repoFullName);
  if (!state) return null;
  watcher.registerThread(state.thread);
  return state;
}

/**
 * A ReplyHandler implementation that allows blocking until a reply arrives.
 * Used to implement waitForEmailReply(repoFullName).
 *
 * Keys are normalized via encodeRunIdForLocalPart so that runIds containing
 * characters that get rewritten in plus-addressed reply-to local-parts
 * (slash, '#', uppercase, etc.) still match when the inbound webhook
 * dispatches the reply with the encoded form.
 */

/** Persists a reply when no active waiter exists; checked before creating a new Promise. */
export interface ReplyMailbox {
  store(runId: string, reply: GmailReply, thread: EmailThread): void;
  take(runId: string): { reply: GmailReply; thread: EmailThread } | null;
}

/** Called when a reply arrives with no active waiter; lets the approval store update itself. */
export interface PrReviewApprovalHook {
  resolveByRunId(prReviewRunId: string, replyBody: string): void;
}

export class IntrospectionReplyWaiter implements ReplyHandler {
  private readonly pending = new Map<string, { resolve: (v: { reply: GmailReply; thread: EmailThread }) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly mailbox?: ReplyMailbox,
    private readonly prReviewApprovalHook?: PrReviewApprovalHook,
  ) {}

  waitForEmailReply(runId: string): Promise<{ reply: GmailReply; thread: EmailThread }> {
    const key = encodeRunIdForLocalPart(runId);
    if (this.pending.has(key)) {
      return Promise.reject(new Error(`Already waiting for reply for ${runId}`));
    }
    const stored = this.mailbox?.take(runId);
    if (stored) return Promise.resolve(stored);
    return new Promise((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
    });
  }

  async onReply(runId: string, reply: GmailReply, thread: EmailThread): Promise<void> {
    const key = encodeRunIdForLocalPart(runId);
    const p = this.pending.get(key);
    if (!p) {
      this.mailbox?.store(runId, reply, thread);
      this.prReviewApprovalHook?.resolveByRunId(runId, reply.body);
      return;
    }
    this.pending.delete(key);
    p.resolve({ reply, thread });
  }
}

export function waitForEmailReply(
  waiter: IntrospectionReplyWaiter,
  repoFullName: string
): Promise<{ reply: GmailReply; thread: EmailThread }> {
  return waiter.waitForEmailReply(repoFullName);
}
