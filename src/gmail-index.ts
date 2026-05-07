/**
 * Barrel exports for Gmail MCP integration (US-011).
 */

export {
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

export {
  formatSubject,
  buildEmailMessage,
  sendEmail,
  detectApproval,
  createEmailThread,
  appendReplyToThread,
  appendAgentMessageToThread,
  buildWatcherQuery,
  GmailWatcher,
  sendAndTrack,
} from './gmail-mcp';
