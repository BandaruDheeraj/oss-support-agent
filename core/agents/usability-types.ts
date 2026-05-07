/**
 * Types for the usability agent (US-015).
 * The usability agent exercises the change as a real user would,
 * surfacing developer-experience problems that tests miss.
 */

import { ActionsClient } from '../sandbox-types';
import { ConfirmedIssue } from './fix-types';

/**
 * Configuration for a usability run.
 */
export interface UsabilityConfig {
  /** Fork full name (org/repo) where the change lives */
  forkFullName: string;
  /** Branch with the changes to exercise */
  branchName: string;
  /** The affected API/module path */
  affectedModule: string;
  /** Sandbox services from the manifest */
  sandboxServices: string[];
  /** Timeout in minutes (default 15) */
  timeoutMinutes: number;
}

/**
 * A single usability check performed by the agent.
 */
export interface UsabilityCheck {
  /** Category of the check */
  category: UsabilityCategory;
  /** What was tested */
  description: string;
  /** Pass/fail/warning */
  status: UsabilityStatus;
  /** Details about findings */
  details: string;
  /** Severity: how impactful the finding is */
  severity: UsabilitySeverity;
}

/**
 * Categories of usability checks.
 */
export type UsabilityCategory =
  | 'import_paths'
  | 'error_messages'
  | 'common_workflows'
  | 'installation'
  | 'documentation_examples';

/**
 * Status of a usability check.
 */
export type UsabilityStatus = 'pass' | 'fail' | 'warning';

/**
 * Severity levels for findings.
 */
export type UsabilitySeverity = 'critical' | 'major' | 'minor' | 'info';

/**
 * Inputs provided to the usability agent.
 */
export interface UsabilityAgentInput {
  /** Fork full name (org/repo) */
  forkFullName: string;
  /** Branch with the changes */
  branchName: string;
  /** Affected module path */
  affectedModule: string;
  /** Confirmed issues in scope */
  confirmedIssues: ConfirmedIssue[];
  /** Sandbox services from manifest */
  sandboxServices: string[];
  /** Timeout in minutes */
  timeoutMinutes: number;
  /** Package install command (e.g. "npm install", "pip install -e .") */
  installCommand: string;
  /** Entry point patterns for the affected API (import paths to exercise) */
  entryPoints: string[];
}

/**
 * Structured result from the usability agent.
 * Consumed by the eval agent and included in the PR body.
 */
export interface UsabilityAgentResult {
  /** Whether the usability run completed */
  completed: boolean;
  /** Overall DX score (0-100) */
  dxScore: number;
  /** Individual check results */
  checks: UsabilityCheck[];
  /** Human-readable summary for the PR body */
  summary: string;
  /** Duration of the run in seconds */
  durationSeconds: number;
  /** Whether the run timed out */
  timedOut: boolean;
  /** URL to the workflow run */
  workflowRunUrl: string;
  /** Critical issues that should block the PR */
  blockers: string[];
  /** Suggestions for improvement (non-blocking) */
  suggestions: string[];
}

/**
 * Interface for exercising the API in the sandbox (for testability).
 */
export interface UsabilityExerciser {
  /** Run the usability checks in the sandbox and return results */
  exercise(input: UsabilityAgentInput): Promise<UsabilityExerciserOutput>;
}

/**
 * Output from the exerciser (raw data before scoring).
 */
export interface UsabilityExerciserOutput {
  /** Individual check results */
  checks: UsabilityCheck[];
  /** Whether installation succeeded */
  installSuccess: boolean;
  /** Install output (stdout+stderr) */
  installOutput: string;
}

/**
 * Workflow file for the usability sandbox.
 */
export const USABILITY_WORKFLOW_FILE = 'usability-test.yml';

/**
 * Default timeout for usability runs.
 */
export const DEFAULT_USABILITY_TIMEOUT_MINUTES = 15;

export class UsabilityAgentError extends Error {
  public readonly phase: string;
  public readonly forkFullName: string;

  constructor(message: string, phase: string, forkFullName: string) {
    super(message);
    this.name = 'UsabilityAgentError';
    this.phase = phase;
    this.forkFullName = forkFullName;
  }
}
