/**
 * Types for fork creation and branch management (US-006).
 */

export interface ForkConfig {
  /** Upstream repo in "owner/repo" format */
  upstream: string;
  /** Organization to create/use fork under */
  forkOrg: string;
  /** Branch prefix from manifest (e.g. "agent/scope-") */
  branchPrefix: string;
  /** Sorted issue IDs for this issue group */
  issueIds: number[];
  /**
   * When true, skip resetting an existing branch to baseline.
   * Use in fix-only mode where the branch already has a committed repro test.
   */
  skipReset?: boolean;
}

export interface ForkResult {
  /** Full name of the fork (org/repo) */
  forkFullName: string;
  /** Whether the fork was newly created (vs already existing) */
  forkCreated: boolean;
  /** Whether the fork was synced with upstream before branching */
  forkSynced: boolean;
  /** Name of the created/reset branch */
  branchName: string;
  /** Whether the branch was reset (already existed, treated as retry) */
  branchReset: boolean;
}

/**
 * Interface for GitHub API interactions (for testability).
 */
export interface GitHubClient {
  /** Check if a repo exists. Returns true if it does. */
  repoExists(fullName: string): Promise<boolean>;

  /** Create a fork of upstream under the given org. Returns the fork full name. */
  createFork(upstream: string, org: string): Promise<string>;

  /** Sync fork with upstream (merge upstream default branch into fork default branch). */
  syncFork(forkFullName: string): Promise<void>;

  /** Get the default branch name for a repo. */
  getDefaultBranch(fullName: string): Promise<string>;

  /** Get the SHA of a branch head. Returns null if branch doesn't exist. */
  getBranchSha(fullName: string, branch: string): Promise<string | null>;

  /** Create a branch at the given SHA. */
  createBranch(fullName: string, branch: string, sha: string): Promise<void>;

  /** Update (reset) a branch to point at the given SHA. */
  updateBranchRef(fullName: string, branch: string, sha: string): Promise<void>;

  /** Get the token scopes to verify no upstream write access. */
  getTokenScopes(): Promise<string[]>;
}

export class ForkCreationError extends Error {
  public readonly upstream: string;
  public readonly forkOrg: string;

  constructor(message: string, upstream: string, forkOrg: string) {
    super(message);
    this.name = 'ForkCreationError';
    this.upstream = upstream;
    this.forkOrg = forkOrg;
  }
}

export class BranchCreationError extends Error {
  public readonly forkFullName: string;
  public readonly branchName: string;

  constructor(message: string, forkFullName: string, branchName: string) {
    super(message);
    this.name = 'BranchCreationError';
    this.forkFullName = forkFullName;
    this.branchName = branchName;
  }
}

export class UpstreamWriteGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamWriteGuardError';
  }
}
