/**
 * Types for Gmail MCP integration (US-011).
 * Provides send and watcher capabilities for the PM agent email loop.
 */

/**
 * An email message to be sent via Gmail MCP.
 */
export interface GmailMessage {
  /** Recipient email address */
  to: string;
  /** Email subject line */
  subject: string;
  /** Email body (plain text) */
  body: string;
  /** Reply-to address that routes back to the orchestrator */
  replyTo: string;
  /** Thread ID for maintaining conversation threading (optional for first message) */
  threadId?: string;
}

/**
 * Result of sending an email via Gmail MCP.
 */
export interface GmailSendResult {
  /** Whether the send was successful */
  success: boolean;
  /** The message ID assigned by Gmail */
  messageId: string;
  /** The thread ID (new or existing) */
  threadId: string;
}

/**
 * A reply detected by the Gmail watcher.
 */
export interface GmailReply {
  /** The message ID of the reply */
  messageId: string;
  /** The thread ID this reply belongs to */
  threadId: string;
  /** The extracted body text of the reply */
  body: string;
  /** The sender of the reply */
  from: string;
  /** When the reply was received */
  receivedAt: string;
  /** The subject line */
  subject: string;
}

/**
 * Configuration for the Gmail watcher.
 */
export interface GmailWatcherConfig {
  /** Poll interval in milliseconds (default 60000 = 60 seconds) */
  pollIntervalMs: number;
  /** Subject prefix to filter on */
  subjectPrefix: string;
  /** Monitored reply-to address */
  monitoredAddress: string;
}

/**
 * A tracked email thread for a run.
 */
export interface EmailThread {
  /** The run ID this thread belongs to */
  runId: string;
  /** The Gmail thread ID */
  threadId: string;
  /** The subject line used throughout the conversation */
  subject: string;
  /** Full conversation history (ordered by time) */
  conversationHistory: ConversationEntry[];
}

/**
 * A single entry in the conversation history.
 */
export interface ConversationEntry {
  /** Who sent this message (agent or user) */
  role: 'agent' | 'user';
  /** The message body */
  body: string;
  /** Timestamp */
  timestamp: string;
  /** Message ID for reference */
  messageId: string;
}

/**
 * Result of approval keyword detection.
 */
export interface ApprovalDetectionResult {
  /** Whether an approval keyword was found */
  approved: boolean;
  /** The keyword that matched (if any) */
  matchedKeyword: string | null;
  /** The reply body that was checked */
  replyBody: string;
}

/**
 * Interface for Gmail MCP client (for testability).
 */
export interface GmailClient {
  /** Send an email */
  sendEmail(message: GmailMessage): Promise<GmailSendResult>;

  /** List unread messages matching a query */
  listUnreadMessages(query: string): Promise<GmailReply[]>;

  /** Mark a message as read */
  markAsRead(messageId: string): Promise<void>;
}

/**
 * Callback interface for when a reply is detected.
 */
export interface ReplyHandler {
  /** Called when a reply is detected for a tracked thread */
  onReply(runId: string, reply: GmailReply, thread: EmailThread): Promise<void>;
}

/**
 * Default poll interval: 60 seconds.
 */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Subject prefix for agent-fix emails.
 */
export const SUBJECT_PREFIX = '[agent-fix]';

export class GmailSendError extends Error {
  public readonly to: string;
  public readonly subject: string;

  constructor(message: string, to: string, subject: string) {
    super(message);
    this.name = 'GmailSendError';
    this.to = to;
    this.subject = subject;
  }
}

export class GmailWatcherError extends Error {
  public readonly phase: string;

  constructor(message: string, phase: string) {
    super(message);
    this.name = 'GmailWatcherError';
    this.phase = phase;
  }
}
