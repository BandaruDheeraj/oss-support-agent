/**
 * Types for the fix agent (US-007).
 * The fix agent patches existing code on the fork branch given
 * the agreed design and confirmed issue list as context.
 */

/**
 * A confirmed issue in the scope of this fix.
 */
export interface ConfirmedIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
}

/**
 * A recent commit for context.
 */
export interface ModuleCommit {
  sha: string;
  message: string;
  files_changed: string[];
}

/**
 * A file in the module with its content.
 */
export interface ModuleFile {
  path: string;
  content: string;
}

/**
 * Inputs provided to the fix agent.
 */
export interface FixAgentInput {
  /** Agreed design summary (from PM agent or auto-approved) */
  designSummary: string;
  /** Confirmed issue list for this fix scope */
  confirmedIssues: ConfirmedIssue[];
  /** Affected module path from triage */
  affectedModule: string;
  /** Source files of the affected module */
  moduleSource: ModuleFile[];
  /** Existing test files for the module */
  moduleTests: ModuleFile[];
  /** Last 20 commits touching the affected module */
  recentCommits: ModuleCommit[];
  /** Fork full name (org/repo) where writes go */
  forkFullName: string;
  /** Branch name to commit to */
  branchName: string;
  /**
   * Optional: a reproduction test that currently fails on baseline. The fix
   * agent MUST make this test pass and MUST NOT modify it. Surface its path
   * + content so the LLM knows what to satisfy.
   */
  reproTest?: ModuleFile;
}

/**
 * A file change produced by the fix agent.
 */
export interface FileChange {
  path: string;
  /** 'modify' for existing files, 'create' for new files */
  action: 'modify' | 'create';
  content: string;
}

/**
 * Result produced by the fix agent.
 */
export interface FixAgentResult {
  /** Whether the fix was successfully generated */
  success: boolean;
  /** Files changed by the fix (source + tests) */
  changes: FileChange[];
  /** Test file changes specifically */
  testChanges: FileChange[];
  /** Commit message in the required format */
  commitMessage: string;
  /** One-line summary of what was fixed */
  summary: string;
  /** Issue IDs that this fix closes */
  closesIssues: number[];
}

/**
 * Interface for reading files from the fork repo (allows mocking in tests).
 */
export interface RepoFileReader {
  /** Read the full content of a file from the fork branch */
  readFile(forkFullName: string, branch: string, path: string): Promise<string>;
  /** List files in a directory */
  listFiles(forkFullName: string, branch: string, dirPath: string): Promise<string[]>;
}

/**
 * Interface for writing/committing to the fork branch (allows mocking in tests).
 */
export interface ForkCommitter {
  /** Commit file changes to the fork branch */
  commitChanges(
    forkFullName: string,
    branch: string,
    changes: FileChange[],
    message: string
  ): Promise<string>; // returns commit SHA
  /** Verify the token only has write access to the fork, not upstream */
  getTokenScopes(): Promise<string[]>;
}

/**
 * Interface for the fix generation logic (allows mocking the LLM in tests).
 */
export interface FixGenerator {
  /** Generate code changes given the full context */
  generateFix(input: FixAgentInput): Promise<FixGeneratorOutput>;
}

/**
 * Output from the fix generator (LLM or heuristic).
 */
export interface FixGeneratorOutput {
  /** Source code changes */
  sourceChanges: FileChange[];
  /** Test changes (new or updated tests) */
  testChanges: FileChange[];
  /** One-line summary of what was fixed */
  summary: string;
}

export class FixAgentError extends Error {
  public readonly phase: string;

  constructor(message: string, phase: string) {
    super(message);
    this.name = 'FixAgentError';
    this.phase = phase;
  }
}

export class UpstreamWriteAttemptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamWriteAttemptError';
  }
}
