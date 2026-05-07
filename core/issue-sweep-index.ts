/**
 * Barrel exports for issue sweep and scope confirmation (US-013).
 */

export {
  SweepIssue,
  SweepResult,
  SweepInput,
  ScopeConfirmationConfig,
  ScopeConfirmationResult,
  IssueSweeper,
  SweepStateStore,
  SweepError,
} from './issue-sweep-types';

export {
  HeuristicIssueSweeper,
  formatScopeEmail,
  parseScopeReply,
  sendScopeConfirmation,
  processScopeReply,
  resumeSweepLoop,
  runIssueSweep,
  createSweepReplyHandler,
} from './issue-sweep';
