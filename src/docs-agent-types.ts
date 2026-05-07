/**
 * Types for the docs agent (US-010).
 * The docs agent handles issues classified as docs without going through
 * the PM gate, updating only documentation files (never application code).
 */

import { ConfirmedIssue, ModuleCommit, ModuleFile, FileChange, ForkCommitter, RepoFileReader } from './fix-agent-types';

/**
 * Inputs provided to the docs agent.
 */
export interface DocsAgentInput {
  /** Confirmed issue list for this docs scope */
  confirmedIssues: ConfirmedIssue[];
  /** Affected module path from triage */
  affectedModule: string;
  /** Documentation files in the repo (READMEs, specs, docs/) */
  docFiles: ModuleFile[];
  /** Recent commits touching documentation */
  recentCommits: ModuleCommit[];
  /** Fork full name (org/repo) where writes go */
  forkFullName: string;
  /** Branch name to commit to */
  branchName: string;
  /** Summary from the triage agent */
  triageSummary: string;
}

/**
 * Result produced by the docs agent.
 */
export interface DocsAgentResult {
  /** Whether the docs change was successfully generated */
  success: boolean;
  /** Documentation file changes */
  changes: FileChange[];
  /** Commit message in the required format */
  commitMessage: string;
  /** One-line summary of what was changed */
  summary: string;
  /** Issue IDs that this change closes */
  closesIssues: number[];
}

/**
 * Interface for the docs generation logic (allows mocking in tests).
 */
export interface DocsGenerator {
  /** Generate documentation changes given the full context */
  generateDocs(input: DocsAgentInput): Promise<DocsGeneratorOutput>;
}

/**
 * Output from the docs generator.
 */
export interface DocsGeneratorOutput {
  /** Documentation changes */
  changes: FileChange[];
  /** One-line summary of what was changed */
  summary: string;
}

/** File extensions and paths considered documentation */
export const DOC_FILE_PATTERNS = [
  '.md',
  '.mdx',
  '.rst',
  '.txt',
  '.adoc',
  '.asciidoc',
  'docs/',
  'doc/',
  'documentation/',
  'README',
  'CHANGELOG',
  'CONTRIBUTING',
  'LICENSE',
  'AUTHORS',
  'HISTORY',
  'CHANGES',
  'MIGRATION',
  'UPGRADING',
  'SECURITY',
];

/** File extensions that are application code and must never be modified */
export const APP_CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyx', '.pyi',
  '.go',
  '.rs',
  '.java', '.kt', '.scala',
  '.c', '.cpp', '.h', '.hpp',
  '.rb',
  '.swift',
  '.cs',
  '.php',
  '.ex', '.exs',
  '.hs',
  '.lua',
  '.sh', '.bash', '.zsh',
];

export class DocsAgentError extends Error {
  public readonly phase: string;

  constructor(message: string, phase: string) {
    super(message);
    this.name = 'DocsAgentError';
    this.phase = phase;
  }
}

export { ConfirmedIssue, ModuleCommit, ModuleFile, FileChange, ForkCommitter, RepoFileReader };
