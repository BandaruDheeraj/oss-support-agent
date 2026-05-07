/**
 * Barrel exports for introspection email review loop (US-106).
 */

export {
  IntrospectionEmailLoopConfig,
  IntrospectionEmailState,
  IntrospectionEmailLoopResult,
  IntrospectionStateStore,
  DraftReviser,
  IntrospectionEmailLoopError,
} from './introspection-email-types';

export {
  formatIntrospectionSubject,
  formatIntrospectionDraftEmail,
  stripQuotedReplyText,
  isApproval,
  reviseDraft,
  sendIntrospectionEmail,
  processIntrospectionReply,
  resumeIntrospectionEmailLoop,
  IntrospectionReplyWaiter,
  waitForEmailReply,
} from './introspection-email-loop';
