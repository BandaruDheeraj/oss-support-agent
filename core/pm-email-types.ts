/**
 * Types for PM agent email conversation loop (US-012).
 * Multi-turn email design conversation until approval keyword is received.
 */

import { RelatedIssue, RelatedPR, DesignDoc, PMScoringResult } from './agents/pm-types';
import { EmailThread, ConversationEntry, GmailClient, ApprovalDetectionResult } from './gmail-types';

/**
 * Input context for generating the initial design brief.
 */
export interface DesignBriefInput {
  /** Issue summary from triage */
  issueSummary: string;
  /** Affected module path */
  affectedModule: string;
  /** Related open issues for context */
  relatedIssues: RelatedIssue[];
  /** Recent PR context (last 30 merged PRs touching the module) */
  recentPRs: RelatedPR[];
  /** Design/spec docs found in the repo */
  designDocs: DesignDoc[];
  /** Issue title */
  issueTitle: string;
  /** Issue body */
  issueBody: string | null;
  /** Issue labels */
  issueLabels: string[];
  /** PM scoring result that triggered design_needed */
  scoringResult: PMScoringResult;
}

/**
 * The 6 fields required in the design brief per PRD section 5.2.
 */
export interface DesignBrief {
  /** One-sentence issue summary */
  issueSummary: string;
  /** Affected module path and description */
  affectedModule: string;
  /** Summary of related open issues */
  relatedOpenIssues: string;
  /** Context from recent PRs touching the module */
  recentPRContext: string;
  /** 2-3 proposed approach options with tradeoffs */
  proposedApproaches: ApproachOption[];
  /** Open questions that need resolution */
  openQuestions: string[];
}

/**
 * A proposed approach option with tradeoffs.
 */
export interface ApproachOption {
  /** Short name for the approach */
  name: string;
  /** Description of what this approach entails */
  description: string;
  /** Advantages of this approach */
  pros: string[];
  /** Disadvantages of this approach */
  cons: string[];
}

/**
 * Input for generating a follow-up response to a user reply.
 */
export interface FollowUpInput {
  /** Full conversation history (read from thread) */
  conversationHistory: ConversationEntry[];
  /** The latest user reply to respond to */
  latestReply: string;
  /** Original design brief context */
  designBriefInput: DesignBriefInput;
  /** List of decisions already made (extracted from conversation) */
  resolvedDecisions: string[];
  /** List of still-unresolved questions */
  unresolvedQuestions: string[];
}

/**
 * Result of generating a follow-up response.
 */
export interface FollowUpResult {
  /** The response body to send */
  responseBody: string;
  /** Updated list of resolved decisions */
  resolvedDecisions: string[];
  /** Updated list of unresolved questions */
  unresolvedQuestions: string[];
}

/**
 * Configuration for the PM email conversation loop.
 */
export interface PMEmailLoopConfig {
  /** Recipient email (pm_email from manifest) */
  pmEmail: string;
  /** Reply-to address for the orchestrator */
  replyToAddress: string;
  /** Repo full name (owner/repo) */
  repo: string;
  /** Issue number (primary issue) */
  issueNumber: number;
  /** Issue title */
  issueTitle: string;
  /** Approval keywords from the manifest */
  approvalKeywords: string[];
  /** Run ID for state tracking */
  runId: string;
}

/**
 * Result of processing an email conversation loop step.
 */
export type PMEmailLoopResult =
  | { action: 'email_sent'; thread: EmailThread; briefSentAt: string }
  | { action: 'reply_processed'; thread: EmailThread; approved: false }
  | { action: 'approved'; thread: EmailThread; approvalResult: ApprovalDetectionResult; agreedDesign: string };

/**
 * Interface for generating design briefs (for testability).
 */
export interface DesignBriefGenerator {
  /** Generate the initial design brief from context */
  generateBrief(input: DesignBriefInput): DesignBrief;
}

/**
 * Interface for generating follow-up responses (for testability).
 */
export interface FollowUpGenerator {
  /** Generate a follow-up response to a user reply */
  generateFollowUp(input: FollowUpInput): FollowUpResult;
}

/**
 * Interface for persisting EMAIL_PENDING state across restarts.
 */
export interface EmailStateStore {
  /** Save the email thread state for a run */
  saveThreadState(runId: string, thread: EmailThread, resolvedDecisions: string[], unresolvedQuestions: string[]): void;
  /** Load the email thread state for a run */
  loadThreadState(runId: string): { thread: EmailThread; resolvedDecisions: string[]; unresolvedQuestions: string[] } | null;
  /** Delete thread state after approval or failure */
  deleteThreadState(runId: string): void;
}

/**
 * Error thrown during the PM email loop.
 */
export class PMEmailLoopError extends Error {
  public readonly phase: string;
  public readonly runId: string;

  constructor(message: string, phase: string, runId: string) {
    super(message);
    this.name = 'PMEmailLoopError';
    this.phase = phase;
    this.runId = runId;
  }
}
