/**
 * PM email conversation loop barrel exports (US-012).
 */

export {
  DesignBriefInput,
  DesignBrief,
  ApproachOption,
  FollowUpInput,
  FollowUpResult,
  PMEmailLoopConfig,
  PMEmailLoopResult,
  DesignBriefGenerator,
  FollowUpGenerator,
  EmailStateStore,
  PMEmailLoopError,
} from './pm-email-types';

export {
  HeuristicBriefGenerator,
  HeuristicFollowUpGenerator,
  formatDesignBriefEmail,
  extractDecisions,
  sendDesignBrief,
  processReply,
  resumeEmailLoop,
  summarizeAgreedDesign,
  createPMReplyHandler,
} from './pm-email-loop';
