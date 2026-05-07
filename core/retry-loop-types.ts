/**
 * Types for the retry loop with eval context injection (US-017).
 * Feeds eval retry_context back into the fix or build agent on failure
 * so the agent can correct its own mistakes up to max_retries.
 */

import { ConfirmedIssue } from './agents/fix-types';

/**
 * A single retry attempt record.
 */
export interface RetryAttempt {
  /** Attempt number (1-based) */
  attemptNumber: number;
  /** Structured retry context from the eval agent */
  retryContext: string;
  /** Timestamp of this attempt */
  timestamp: string;
  /** Agent type that was dispatched (fix or build) */
  agentType: 'fix' | 'build';
}

/**
 * Full retry history for a run.
 */
export interface RetryHistory {
  /** Run ID */
  runId: string;
  /** Max retries allowed (from manifest) */
  maxRetries: number;
  /** All retry attempts so far */
  attempts: RetryAttempt[];
}

/**
 * Configuration for the retry loop.
 */
export interface RetryLoopConfig {
  /** Run ID */
  runId: string;
  /** Max retries from manifest (default 3) */
  maxRetries: number;
  /** Agent type to re-dispatch */
  agentType: 'fix' | 'build';
  /** Upstream repo full name (owner/repo) */
  upstreamRepo: string;
  /** Primary issue number (for labeling) */
  primaryIssueNumber: number;
  /** PM email for failure notification */
  pmEmail: string;
  /** Reply-to address for the monitored mailbox */
  replyToAddress: string;
  /** Confirmed issues in scope */
  confirmedIssues: ConfirmedIssue[];
  /** Fork full name (org/repo) */
  forkFullName: string;
  /** Branch name on the fork */
  branchName: string;
}

/**
 * Input to re-dispatch to fix/build agent with retry context.
 */
export interface RetryDispatchInput {
  /** Current retry count (1-based after increment) */
  retryCount: number;
  /** Combined retry context from all previous attempts */
  combinedRetryContext: string;
  /** Latest retry context from the most recent failure */
  latestRetryContext: string;
  /** Agent type being retried */
  agentType: 'fix' | 'build';
}

/**
 * Result of the retry loop decision.
 */
export type RetryLoopResult =
  | { action: 'retry'; dispatch: RetryDispatchInput }
  | { action: 'max_retries_exceeded'; failureReport: FailureReport };

/**
 * Failure report sent to the user when max retries exceeded.
 */
export interface FailureReport {
  /** Run ID */
  runId: string;
  /** Upstream repo */
  upstreamRepo: string;
  /** Primary issue number */
  primaryIssueNumber: number;
  /** All retry contexts from each attempt */
  retryHistory: RetryAttempt[];
  /** Fork branch name (preserved for inspection) */
  forkBranch: string;
  /** Fork full name */
  forkFullName: string;
  /** Summary of what was attempted */
  summary: string;
}

/**
 * Interface for GitHub issue operations (allows mocking in tests).
 */
export interface IssueLabeler {
  /** Add a label to an upstream issue */
  addLabel(repo: string, issueNumber: number, label: string): Promise<void>;
}

/**
 * Interface for sending failure notification emails.
 */
export interface FailureNotifier {
  /** Send a failure notification email */
  sendEmail(to: string, subject: string, body: string, replyTo: string): Promise<void>;
}

/**
 * Interface for retry state persistence (survive restarts).
 */
export interface RetryStateStore {
  /** Save retry history */
  saveRetryHistory(history: RetryHistory): Promise<void>;
  /** Load retry history for a run */
  loadRetryHistory(runId: string): Promise<RetryHistory | null>;
  /** Delete retry history (on completion) */
  deleteRetryHistory(runId: string): Promise<void>;
}

export class RetryLoopError extends Error {
  public readonly phase: string;
  public readonly runId: string;

  constructor(message: string, phase: string, runId: string) {
    super(message);
    this.name = 'RetryLoopError';
    this.phase = phase;
    this.runId = runId;
  }
}

/** Label applied to upstream issues when max retries exceeded */
export const AGENT_FAILED_LABEL = 'agent-failed';

/** Subject prefix for failure notification emails */
export const FAILURE_EMAIL_SUBJECT_PREFIX = '[agent-fix] FAILED:';
