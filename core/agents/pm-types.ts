/**
 * PM agent types for the OSS Autonomous Fix Loop.
 * Phase 1: Design scoring only (no email loop).
 */

import { IssueType } from './triage-types';

/**
 * A related open issue found during PM agent analysis.
 */
export interface RelatedIssue {
  number: number;
  title: string;
  labels: string[];
  /** Why this issue is considered related */
  reason: string;
}

/**
 * A merged PR that touched the affected module.
 */
export interface RelatedPR {
  number: number;
  title: string;
  files_changed: string[];
  merged_at: string;
}

/**
 * A design/spec document found in the repo.
 */
export interface DesignDoc {
  path: string;
  /** Brief excerpt or title of the document */
  excerpt: string;
}

/**
 * Inputs provided to the PM agent for design scoring.
 */
export interface PMScoringInput {
  /** Classified issue type from triage */
  issueType: IssueType;
  /** Affected module path from triage */
  affectedModule: string;
  /** One-sentence summary from triage */
  summary: string;
  /** Issue title */
  title: string;
  /** Issue body */
  body: string | null;
  /** Issue labels */
  labels: string[];
  /** Related open issues for the same module/error/API */
  relatedIssues: RelatedIssue[];
  /** Last 30 merged PRs touching the affected module */
  recentPRs: RelatedPR[];
  /** Relevant spec/design docs found in the repo */
  designDocs: DesignDoc[];
}

/**
 * Output produced by the PM agent design scoring.
 */
export interface PMScoringResult {
  /** Whether a design review is needed before proceeding */
  designNeeded: boolean;
  /** Human-readable reasoning summary explaining the decision */
  reasoning: string;
  /** Individual heuristic signals that contributed to the decision */
  signals: DesignSignal[];
}

/**
 * A single heuristic signal contributing to the design_needed decision.
 */
export interface DesignSignal {
  /** Name of the heuristic rule */
  rule: string;
  /** Whether this signal triggered */
  triggered: boolean;
  /** Evidence or explanation */
  detail: string;
}

/**
 * Routing decision from the PM agent in Phase 1.
 */
export type PMRouting =
  | { action: 'route_forking'; result: PMScoringResult }
  | { action: 'route_failed'; result: PMScoringResult; note: string };

/**
 * Interface for searching open issues (allows mocking in tests).
 */
export interface IssueSearcher {
  searchRelatedIssues(
    repo: string,
    module: string,
    errorPattern: string | null,
    apiSurface: string | null
  ): Promise<RelatedIssue[]>;
}

/**
 * Interface for fetching recent merged PRs (allows mocking in tests).
 */
export interface PRFetcher {
  getRecentMergedPRs(
    repo: string,
    module: string,
    limit: number
  ): Promise<RelatedPR[]>;
}

/**
 * Interface for finding design/spec documents (allows mocking in tests).
 */
export interface DesignDocFinder {
  findDesignDocs(repo: string, module: string): Promise<DesignDoc[]>;
}
