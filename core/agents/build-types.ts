/**
 * Types for the build agent (US-014).
 * The build agent scaffolds new modules or features mirroring existing
 * patterns in the repo, for new_feature issues.
 */

import { ConfirmedIssue, ModuleCommit, ModuleFile, FileChange, ForkCommitter, RepoFileReader } from './fix-types';

export { ConfirmedIssue, ModuleCommit, ModuleFile, FileChange, ForkCommitter, RepoFileReader };

/**
 * A reference module used as a structural template.
 */
export interface ReferenceModule {
  /** Module path (e.g. "src/auth") */
  path: string;
  /** Files in the module with their content */
  files: ModuleFile[];
}

/**
 * Inputs provided to the build agent.
 */
export interface BuildAgentInput {
  /** Agreed design summary (from PM agent) */
  designSummary: string;
  /** Confirmed issue list for this feature scope */
  confirmedIssues: ConfirmedIssue[];
  /** Affected module path (where the new feature will live) */
  affectedModule: string;
  /** Two most similar existing modules (identified by triage) */
  referenceModules: ReferenceModule[];
  /** CONTRIBUTING.md or equivalent if present */
  contributingGuide: string | null;
  /** Fork full name (org/repo) where writes go */
  forkFullName: string;
  /** Branch name to commit to */
  branchName: string;
}

/**
 * Result produced by the build agent.
 */
export interface BuildAgentResult {
  /** Whether the scaffolding was successfully generated */
  success: boolean;
  /** Module files created */
  moduleFiles: FileChange[];
  /** Test files created */
  testFiles: FileChange[];
  /** Index/registry files updated */
  indexFiles: FileChange[];
  /** Commit message in the required format */
  commitMessage: string;
  /** One-line summary of what was scaffolded */
  summary: string;
  /** Issue IDs that this feature closes */
  closesIssues: number[];
}

/**
 * Interface for the scaffold generation logic (allows mocking the LLM in tests).
 */
export interface ScaffoldGenerator {
  /** Generate scaffolding based on reference modules and design */
  generateScaffold(input: BuildAgentInput): Promise<ScaffoldGeneratorOutput>;
}

/**
 * Output from the scaffold generator.
 */
export interface ScaffoldGeneratorOutput {
  /** New module source files */
  moduleFiles: FileChange[];
  /** New test files */
  testFiles: FileChange[];
  /** Updated index/registry files */
  indexFiles: FileChange[];
  /** One-line summary of what was scaffolded */
  summary: string;
}

export class BuildAgentError extends Error {
  public readonly phase: string;

  constructor(message: string, phase: string) {
    super(message);
    this.name = 'BuildAgentError';
    this.phase = phase;
  }
}
