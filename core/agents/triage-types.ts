/**
 * Triage agent types for the OSS Autonomous Fix Loop.
 */

/**
 * Classification of an issue's type.
 */
export type IssueType = 'bug_fix' | 'new_feature' | 'docs';

/**
 * Inputs provided to the triage agent.
 */
export interface TriageInput {
  /** Issue number within the repository */
  number?: number;
  /** Issue title */
  title: string;
  /** Issue body/description */
  body: string | null;
  /** Labels attached to the issue */
  labels: string[];
  /** Issue author login */
  author: string;
  /** Allowed issue types (defaults to all). Previously derived from manifest.issue_types. */
  moduleTaxonomy?: IssueType[];
  /** Shallow repo tree (top two directory levels) */
  repoTree: string[];
  /** Whether the issue has skip_pm_gate label */
  hasSkipPmGate: boolean;
  /** Local cloned fork root used to validate adapter module routing */
  clonedRepoRoot?: string;
  /** Optional URL to the issue */
  url?: string;
}

/**
 * Output produced by the triage agent.
 */
export interface TriageResult {
  /** Classified issue type */
  issueType: IssueType;
  /** Path of the affected module */
  affectedModule: string;
  /** Confidence score 0-1 */
  confidence: number;
  /** One-sentence summary */
  summary: string;
}

/**
 * Routing decision after triage.
 */
export type TriageRouting =
  | { action: 'route_pm'; result: TriageResult }
  | { action: 'route_docs'; result: TriageResult }
  | { action: 'route_fork'; result: TriageResult }
  | { action: 'clarify'; result: TriageResult; comment: string };

/**
 * Interface for issue-type classifiers (allows mocking in tests).
 */
export interface TriageTypeClassifier {
  classifyIssueType(input: TriageInput): Promise<IssueType>;
}

/**
 * Interface for posting comments on GitHub issues (allows mocking in tests).
 */
export interface IssueCommenter {
  postComment(repo: string, issueNumber: number, comment: string): Promise<void>;
}

/** Backward-compatible alias for older imports. */
export type TriageClassifier = TriageTypeClassifier;
