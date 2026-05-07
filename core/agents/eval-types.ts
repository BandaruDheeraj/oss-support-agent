/**
 * Types for the eval agent (US-009).
 * The eval agent produces a pass/fail verdict from sandbox outputs
 * and, on pass, opens a PR from the fork to upstream.
 */

import { SandboxArtifact } from '../sandbox-types';
import { ConfirmedIssue } from './fix-types';
import type { RepoAdapter } from '../adapter.interface';

/**
 * Per-issue verdict: whether the fix for this issue passed or failed.
 */
export interface IssueVerdict {
  issueNumber: number;
  passed: boolean;
  reason: string;
}

/**
 * Inputs provided to the eval agent.
 */
export interface EvalAgentInput {
  /** Sandbox artifact with test results */
  sandboxArtifact: SandboxArtifact;
  /** Confirmed issues in scope */
  confirmedIssues: ConfirmedIssue[];
  /** One-line summary from the fix agent */
  fixSummary: string;
  /** Agreed design summary */
  designSummary: string;
  /** Fork full name (org/repo) */
  forkFullName: string;
  /** Branch name on the fork */
  branchName: string;
  /** Upstream repo full name (owner/repo) */
  upstreamRepo: string;
  /** Upstream default branch (e.g. "main") */
  upstreamDefaultBranch: string;
  /** Issue types addressed (for labels) */
  issueTypes: string[];
  /** Current retry count */
  retryCount: number;
  /** Max retries from manifest */
  maxRetries: number;
  /** Repo adapter for custom eval and PR metadata */
  adapter?: RepoAdapter;
}

/**
 * Result produced by the eval agent.
 */
export interface EvalAgentResult {
  /** Overall pass/fail verdict */
  overallPass: boolean;
  /** Per-issue verdict map */
  perIssueVerdicts: IssueVerdict[];
  /** Whether a regression was detected (false in Phase 1) */
  regressionDetected: boolean;
  /** Context for retry if failing */
  retryContext: string | null;
  /** Summary for the PR body */
  prSummary: string;
}

/**
 * Routing decision from the eval agent.
 */
export type EvalRouting =
  | { action: 'open_pr'; prUrl: string }
  | { action: 'retry'; retryContext: string }
  | { action: 'failed'; reason: string };

/**
 * PR details for creation.
 */
export interface PRDetails {
  /** PR title: [agent-fix] {one-line summary} */
  title: string;
  /** PR body with design summary, issues, verdicts, sandbox link */
  body: string;
  /** Labels to apply */
  labels: string[];
  /** Head branch (fork:branch) */
  head: string;
  /** Base branch (upstream default) */
  base: string;
}

/**
 * Interface for GitHub PR operations (allows mocking in tests).
 */
export interface PRClient {
  /** Create a PR from fork branch to upstream default branch */
  createPullRequest(
    upstreamRepo: string,
    details: PRDetails
  ): Promise<{ url: string; number: number }>;

  /** Add labels to a PR */
  addLabels(
    upstreamRepo: string,
    prNumber: number,
    labels: string[]
  ): Promise<void>;
}

export class EvalAgentError extends Error {
  public readonly phase: string;

  constructor(message: string, phase: string) {
    super(message);
    this.name = 'EvalAgentError';
    this.phase = phase;
  }
}
