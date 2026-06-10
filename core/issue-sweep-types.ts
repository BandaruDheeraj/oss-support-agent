/**
 * Types for issue sweep and scope confirmation (US-013).
 * After design approval, the PM agent searches all open issues against the
 * agreed design and sends a scope confirmation email for user to confirm
 * the final issue set before fork creation.
 */

import { RelatedIssue } from './agents/pm-types';
import { EmailThread, GmailClient } from './gmail-types';

/**
 * An issue categorized by sweep confidence.
 */
export interface SweepIssue {
  /** Issue number */
  number: number;
  /** Issue title */
  title: string;
  /** Issue labels */
  labels: string[];
  /** One-sentence reason this issue is related to the agreed design */
  reason: string;
  /** Issue body (possibly truncated); used for plain-language summaries in the scope email */
  body?: string;
  /** Detailed relevance analysis shown in the scope-confirmation email */
  analysis?: SweepAnalysis;
}

/**
 * Full reasoning behind an issue's inclusion in the sweep result, so the
 * scope-confirmation email can show the complete thought process.
 */
export interface SweepAnalysis {
  /** 0–1 relevance score from the heuristic sweeper */
  score: number;
  /** Plain-language sentences describing each scoring signal and its point value */
  scoreSignals: string[];
  /** Plain-language summary of what the issue is about (LLM-written when available) */
  plainSummary?: string;
  /** Reasons the issue might be related to the agreed fix (LLM-written) */
  whyRelated?: string[];
  /** Reasons the issue might NOT be related to the agreed fix (LLM-written) */
  whyNotRelated?: string[];
}

/**
 * Result of the issue sweep analysis.
 */
export interface SweepResult {
  /** Issues the design directly closes (high confidence) */
  highConfidence: SweepIssue[];
  /** Issues with partial overlap (maybe in scope) */
  maybeInScope: SweepIssue[];
}

/**
 * Input to the issue sweep.
 */
export interface SweepInput {
  /** The agreed design summary from the PM email loop */
  agreedDesign: string;
  /** The affected module from triage */
  affectedModule: string;
  /** All open issues in the repo (pre-fetched) */
  openIssues: SweepIssue[];
  /** The primary issue that triggered the run */
  primaryIssueNumber: number;
}

/**
 * Configuration for the scope confirmation email flow.
 */
export interface ScopeConfirmationConfig {
  /** Recipient email */
  pmEmail: string;
  /** Reply-to address for the orchestrator */
  replyToAddress: string;
  /** Repo full name (owner/repo) */
  repo: string;
  /** Primary issue number */
  issueNumber: number;
  /** Issue title */
  issueTitle: string;
  /** Run ID for state tracking */
  runId: string;
}

/**
 * Result of the scope confirmation step.
 */
export type ScopeConfirmationResult =
  | { action: 'scope_email_sent'; thread: EmailThread; sweepResult: SweepResult }
  | { action: 'scope_confirmed'; confirmedIssueNumbers: number[] };

/**
 * Interface for searching open issues against the agreed design (for testability).
 */
export interface IssueSweeper {
  /** Search all open issues and categorize by relevance to the agreed design */
  sweepIssues(input: SweepInput): SweepResult;
}

/**
 * Interface for persisting SWEEP_PENDING state across restarts.
 */
export interface SweepStateStore {
  /** Save the sweep state for a run */
  saveSweepState(runId: string, thread: EmailThread, sweepResult: SweepResult): void;
  /** Load the sweep state for a run */
  loadSweepState(runId: string): { thread: EmailThread; sweepResult: SweepResult } | null;
  /** Delete sweep state after confirmation or failure */
  deleteSweepState(runId: string): void;
}

/**
 * Error thrown during the issue sweep or scope confirmation.
 */
export class SweepError extends Error {
  public readonly phase: string;
  public readonly runId: string;

  constructor(message: string, phase: string, runId: string) {
    super(message);
    this.name = 'SweepError';
    this.phase = phase;
    this.runId = runId;
  }
}
