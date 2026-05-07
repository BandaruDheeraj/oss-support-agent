/**
 * Types for the regression guard (US-016).
 * The regression guard diffs observable behaviour of the fork branch
 * against upstream main to flag any behavioural change before the PR is opened.
 */

import { ActionsClient, SandboxConfig, SandboxResult } from './sandbox-types';

/**
 * Configuration for a regression guard run.
 */
export interface RegressionConfig {
  /** Fork full name (org/repo) */
  forkFullName: string;
  /** Fork branch with the fix */
  forkBranchName: string;
  /** Upstream repo full name (owner/repo) */
  upstreamRepo: string;
  /** Upstream default branch (e.g. "main") */
  upstreamDefaultBranch: string;
  /** Test command from the manifest */
  testCommand: string;
  /** Allowed external services */
  sandboxServices: string[];
  /** Maximum run duration in minutes per job */
  timeoutMinutes: number;
}

/**
 * Result of running the same tests on a single branch.
 */
export interface BranchTestResult {
  /** Which branch was tested */
  branch: string;
  /** Whether the run completed */
  completed: boolean;
  /** Exit code of the test command */
  exitCode: number | null;
  /** Captured stdout */
  stdout: string;
  /** Captured stderr */
  stderr: string;
  /** Duration of the run in seconds */
  durationSeconds: number;
  /** Whether the run timed out */
  timedOut: boolean;
  /** URL to the workflow run */
  workflowRunUrl: string;
}

/**
 * A single observable difference between fork and upstream runs.
 */
export interface OutputDiff {
  /** Category of the difference */
  category: 'exit_code' | 'stdout' | 'stderr' | 'timeout';
  /** Human-readable description of the difference */
  description: string;
  /** Value from upstream main */
  upstream: string;
  /** Value from fork branch */
  fork: string;
}

/**
 * Complete result of the regression guard.
 */
export interface RegressionResult {
  /** Whether a regression was detected */
  regressionDetected: boolean;
  /** Detailed differences found between fork and upstream */
  diffs: OutputDiff[];
  /** Test results from the fork branch */
  forkResult: BranchTestResult;
  /** Test results from upstream main */
  upstreamResult: BranchTestResult;
  /** Human-readable summary for the PR body */
  summary: string;
}

/**
 * Workflow file for regression guard parallel runs.
 */
export const REGRESSION_WORKFLOW_FILE = 'regression-test.yml';

/**
 * Default timeout for each regression test run.
 */
export const DEFAULT_REGRESSION_TIMEOUT_MINUTES = 15;

export class RegressionGuardError extends Error {
  public readonly phase: string;
  public readonly branch: string;

  constructor(message: string, phase: string, branch: string) {
    super(message);
    this.name = 'RegressionGuardError';
    this.phase = phase;
    this.branch = branch;
  }
}
