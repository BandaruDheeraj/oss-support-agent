/**
 * Triage agent types for the OSS Autonomous Fix Loop.
 */

/**
 * Classification of an issue's type.
 */
export type IssueType = 'bug_fix' | 'new_feature' | 'docs';

/**
 * Whether the issue is applicable to the target codebase at all.
 *
 * - `applicable`: the issue is about something this codebase actually does
 *   (or could plausibly do as a new feature).
 * - `not_applicable`: the issue is off-topic (vendor pitch, unrelated tool,
 *   wrong-repo report, marketing spam, etc.) and should not enter the
 *   fix/feature/PM phases.
 */
export type TriageRelevance = 'applicable' | 'not_applicable';

/**
 * Rich classification result returned by a TriageTypeClassifier.
 */
export interface TriageClassification {
  issueType: IssueType;
  relevance: TriageRelevance;
  /** One-sentence justification for the relevance verdict. */
  relevanceReason: string;
}

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
  /** Whether the issue applies to this codebase. */
  relevance: TriageRelevance;
  /** One-sentence justification for the relevance verdict. */
  relevanceReason: string;
}

/**
 * Routing decision after triage.
 */
export type TriageRouting =
  | { action: 'route_pm'; result: TriageResult }
  | { action: 'route_docs'; result: TriageResult }
  | { action: 'route_fork'; result: TriageResult }
  | { action: 'clarify'; result: TriageResult; comment: string }
  | { action: 'route_not_applicable'; result: TriageResult; comment: string };

/**
 * Interface for issue-type classifiers (allows mocking in tests).
 *
 * Returns a rich classification including a relevance verdict.
 */
export interface TriageTypeClassifier {
  classifyIssueType(input: TriageInput): Promise<TriageClassification>;
}

/**
 * Interface for posting comments on GitHub issues (allows mocking in tests).
 */
export interface IssueCommenter {
  postComment(repo: string, issueNumber: number, comment: string): Promise<void>;
}

/** Backward-compatible alias for older imports. */
export type TriageClassifier = TriageTypeClassifier;
