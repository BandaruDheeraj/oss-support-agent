/**
 * Types for the GitHub webhook listener and event router.
 */

/**
 * Subset of GitHub issue webhook payload we care about.
 */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  user: { login: string } | null;
}

/**
 * GitHub webhook event payload for issue events.
 */
export interface IssueEvent {
  action: string;
  issue: GitHubIssue;
  label?: { name: string }; // Present on issue.labeled
  repository: {
    full_name: string; // e.g. "owner/repo"
  };
}

/**
 * Result of processing a webhook event.
 */
export type WebhookResult =
  | { status: 'accepted'; runId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'ignored'; reason: string };
