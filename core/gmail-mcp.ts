/**
 * Gmail MCP integration (US-011).
 * Provides send and watcher capabilities for the PM agent email loop.
 *
 * - Send: posts emails via Gmail MCP with subject [agent-fix] {repo}/{issue_number}: {issue_title}
 * - Watcher: polls for unread replies on threads with [agent-fix] prefix every 60s
 * - Approval detection: case-insensitive substring match against manifest approval_keywords
 * - Threading: same subject and thread ID maintained across full conversation
 */

import {
  GmailMessage,
  GmailSendResult,
  GmailReply,
  GmailWatcherConfig,
  EmailThread,
  ConversationEntry,
  ApprovalDetectionResult,
  GmailClient,
  ReplyHandler,
  GmailSendError,
  GmailWatcherError,
  SUBJECT_PREFIX,
  DEFAULT_POLL_INTERVAL_MS,
} from './gmail-types';

/**
 * Format the email subject line per PRD spec.
 * Format: [agent-fix] {repo}/{issue_number}: {issue_title}
 */
export function formatSubject(
  repo: string,
  issueNumber: number,
  issueTitle: string
): string {
  return `${SUBJECT_PREFIX} ${repo}/#${issueNumber}: ${issueTitle}`;
}

/**
 * Build a GmailMessage for sending a design brief or follow-up.
 */
export function buildEmailMessage(options: {
  to: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  body: string;
  replyTo: string;
  threadId?: string;
}): GmailMessage {
  const subject = formatSubject(options.repo, options.issueNumber, options.issueTitle);
  return {
    to: options.to,
    subject,
    body: options.body,
    replyTo: options.replyTo,
    threadId: options.threadId,
  };
}

/**
 * Send an email via Gmail MCP.
 * Throws GmailSendError on failure.
 */
export async function sendEmail(
  client: GmailClient,
  message: GmailMessage
): Promise<GmailSendResult> {
  try {
    const result = await client.sendEmail(message);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new GmailSendError(
      `Failed to send email: ${msg}`,
      message.to,
      message.subject
    );
  }
}

/**
 * Detect approval keywords in a reply body.
 * Case-insensitive substring match against the provided keywords.
 */
export function detectApproval(
  replyBody: string,
  approvalKeywords: string[]
): ApprovalDetectionResult {
  const normalizedBody = stripQuotedReplyText(replyBody).toLowerCase();

  for (const keyword of approvalKeywords) {
    if (normalizedBody.includes(keyword.toLowerCase())) {
      return {
        approved: true,
        matchedKeyword: keyword,
        replyBody,
      };
    }
  }

  const impliedApproval = detectImpliedApproval(normalizedBody);
  if (impliedApproval) {
    return {
      approved: true,
      matchedKeyword: impliedApproval,
      replyBody,
    };
  }

  return {
    approved: false,
    matchedKeyword: null,
    replyBody,
  };
}

function stripQuotedReplyText(replyBody: string): string {
  const lines = replyBody.split(/\r?\n/);
  const visible: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      /^on .+wrote:$/i.test(trimmed) ||
      /^from:\s/i.test(trimmed) ||
      /^sent:\s/i.test(trimmed) ||
      /^to:\s/i.test(trimmed) ||
      /^subject:\s/i.test(trimmed) ||
      /^>+/.test(trimmed)
    ) {
      break;
    }
    visible.push(line);
  }
  return visible.join('\n').trim();
}

function detectImpliedApproval(bodyLower: string): string | null {
  if (!bodyLower) return null;

  if (/\b(do not|don't|dont|not)\s+(approve|proceed|ship|merge|go ahead)\b/.test(bodyLower)) {
    return null;
  }

  const impliedPatterns: Array<{ regex: RegExp; token: string }> = [
    {
      regex: /\b(go ahead|please proceed|proceed please|proceed with it|proceed with this)\b/,
      token: 'go ahead',
    },
    {
      regex: /\b(yes|yep|yeah|ok|okay|sure|sounds good)\b[\s,:-]{0,8}\b(proceed|go ahead|ship it|merge)\b/,
      token: 'yes proceed',
    },
  ];

  for (const pattern of impliedPatterns) {
    if (pattern.regex.test(bodyLower)) {
      return pattern.token;
    }
  }
  return null;
}

/**
 * Create a new EmailThread for tracking a conversation.
 */
export function createEmailThread(
  runId: string,
  threadId: string,
  subject: string,
  initialBody: string,
  messageId: string,
  timestamp: string
): EmailThread {
  return {
    runId,
    threadId,
    subject,
    conversationHistory: [
      {
        role: 'agent',
        body: initialBody,
        timestamp,
        messageId,
      },
    ],
  };
}

/**
 * Append a reply to an existing email thread.
 */
export function appendReplyToThread(
  thread: EmailThread,
  reply: GmailReply
): EmailThread {
  const entry: ConversationEntry = {
    role: 'user',
    body: reply.body,
    timestamp: reply.receivedAt,
    messageId: reply.messageId,
  };

  return {
    ...thread,
    conversationHistory: [...thread.conversationHistory, entry],
  };
}

/**
 * Append an agent response to a thread.
 */
export function appendAgentMessageToThread(
  thread: EmailThread,
  body: string,
  messageId: string,
  timestamp: string
): EmailThread {
  const entry: ConversationEntry = {
    role: 'agent',
    body,
    timestamp,
    messageId,
  };

  return {
    ...thread,
    conversationHistory: [...thread.conversationHistory, entry],
  };
}

/**
 * Build the Gmail search query for the watcher.
 * Searches for unread messages with the [agent-fix] subject prefix
 * sent to the monitored address.
 */
export function buildWatcherQuery(config: GmailWatcherConfig): string {
  return `is:unread subject:"${config.subjectPrefix}" to:${config.monitoredAddress}`;
}

/**
 * Gmail watcher that polls for unread replies.
 */
export class GmailWatcher {
  private client: GmailClient;
  private config: GmailWatcherConfig;
  private threads: Map<string, EmailThread>;
  private replyHandler: ReplyHandler;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    client: GmailClient,
    config: GmailWatcherConfig,
    replyHandler: ReplyHandler
  ) {
    this.client = client;
    this.config = config;
    this.threads = new Map();
    this.replyHandler = replyHandler;
  }

  /**
   * Register a thread to watch for replies.
   */
  registerThread(thread: EmailThread): void {
    this.threads.set(thread.threadId, thread);
  }

  /**
   * Unregister a thread (e.g., after approval detected).
   */
  unregisterThread(threadId: string): void {
    this.threads.delete(threadId);
  }

  /**
   * Get a registered thread by ID.
   */
  getThread(threadId: string): EmailThread | undefined {
    return this.threads.get(threadId);
  }

  /**
   * Get thread by run ID.
   */
  getThreadByRunId(runId: string): EmailThread | undefined {
    for (const thread of this.threads.values()) {
      if (thread.runId === runId) {
        return thread;
      }
    }
    return undefined;
  }

  /**
   * Get all registered threads.
   */
  getRegisteredThreads(): EmailThread[] {
    return Array.from(this.threads.values());
  }

  /**
   * Start polling for replies.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(
      () => this.poll(),
      this.config.pollIntervalMs
    );
  }

  /**
   * Stop polling.
   */
  stop(): void {
    this.running = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Whether the watcher is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Perform a single poll cycle. Called by the interval or manually for testing.
   */
  async poll(): Promise<GmailReply[]> {
    const query = buildWatcherQuery(this.config);

    let replies: GmailReply[];
    try {
      replies = await this.client.listUnreadMessages(query);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new GmailWatcherError(`Failed to poll for replies: ${msg}`, 'poll');
    }

    const matchedReplies: GmailReply[] = [];

    for (const reply of replies) {
      const thread = this.threads.get(reply.threadId);
      if (!thread) continue;

      // Append reply to thread
      const updatedThread = appendReplyToThread(thread, reply);
      this.threads.set(thread.threadId, updatedThread);

      // Mark as read
      try {
        await this.client.markAsRead(reply.messageId);
      } catch {
        // Non-fatal: we'll process it again next cycle
      }

      // Notify handler
      await this.replyHandler.onReply(thread.runId, reply, updatedThread);
      matchedReplies.push(reply);
    }

    return matchedReplies;
  }
}

/**
 * Full send-and-track flow: send an email and register the thread.
 */
export async function sendAndTrack(
  client: GmailClient,
  watcher: GmailWatcher,
  options: {
    runId: string;
    to: string;
    repo: string;
    issueNumber: number;
    issueTitle: string;
    body: string;
    replyTo: string;
    existingThreadId?: string;
    replyReferenceId?: string;
  }
): Promise<EmailThread> {
  // Check if we're continuing an existing thread.
  const existingThread = options.existingThreadId
    ? watcher.getThread(options.existingThreadId)
    : undefined;
  const inferredReplyReferenceId =
    options.replyReferenceId
    ?? getLatestUserMessageId(existingThread)
    ?? options.existingThreadId;

  const message = buildEmailMessage({
    to: options.to,
    repo: options.repo,
    issueNumber: options.issueNumber,
    issueTitle: options.issueTitle,
    body: options.body,
    replyTo: options.replyTo,
    threadId: inferredReplyReferenceId,
  });

  const result = await sendEmail(client, message);
  const timestamp = new Date().toISOString();

  if (existingThread) {
    const updated = appendAgentMessageToThread(
      existingThread,
      options.body,
      result.messageId,
      timestamp
    );
    watcher.registerThread(updated);
    return updated;
  }

  // New thread
  const thread = createEmailThread(
    options.runId,
    result.threadId,
    message.subject,
    options.body,
    result.messageId,
    timestamp
  );
  watcher.registerThread(thread);
  return thread;
}

function getLatestUserMessageId(thread: EmailThread | undefined): string | undefined {
  if (!thread) return undefined;
  for (let i = thread.conversationHistory.length - 1; i >= 0; i--) {
    const entry = thread.conversationHistory[i];
    if (entry.role === 'user' && entry.messageId) {
      return entry.messageId;
    }
  }
  return undefined;
}
