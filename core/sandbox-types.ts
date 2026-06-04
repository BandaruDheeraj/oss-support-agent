/**
 * Types for the basic sandbox runner (US-008).
 * The sandbox runner executes adapter-provided commands on the fork branch
 * via GitHub Actions workflow_dispatch and captures stdout/stderr/exit code.
 */

import type { SandboxCommandResult, ServiceConfig } from './adapter.interface';

/**
 * Configuration for a sandbox run.
 *
 * - repoFullName: upstream repo identity (used for namespacing secrets in the shared workflow)
 * - forkFullName/branchName: fork location that will be cloned and tested
 * - workflowRepoFullName: repo that hosts the shared sandbox workflow
 */
export interface SandboxConfig {
  /** Upstream repo full name (owner/repo) that the run is for */
  repoFullName: string;
  /** Fork full name (org/repo) that contains the branch under test */
  forkFullName: string;
  /** Branch to check out in the sandbox */
  branchName: string;
  /** Repo hosting the shared sandbox workflow (defaults to HARNESS_REPO_FULL_NAME/GITHUB_REPOSITORY) */
  workflowRepoFullName: string;
  /** Optional explicit clone URL for the fork (defaults to https://github.com/<forkFullName>.git) */
  forkCloneUrl?: string;
  /** Test commands from the repo adapter */
  testCommands?: string[];
  /** Deprecated single command view kept for migration compatibility */
  testCommand?: string;
  /** Services required for sandbox runs */
  sandboxServices: Array<ServiceConfig | string>;
  /** Maximum run duration in minutes (default 15) */
  timeoutMinutes: number;
}

/**
 * Result of a sandbox run, structured for the eval agent.
 */
export interface SandboxResult {
  /** Whether the run completed (vs timed out or errored) */
  completed: boolean;
  /** Exit code of the test command (null if timed out or errored) */
  exitCode: number | null;
  /** Captured stdout from the test command */
  stdout: string;
  /** Captured stderr from the test command */
  stderr: string;
  /** Duration of the run in seconds */
  durationSeconds: number;
  /** URL to the workflow run for linking in PR body */
  workflowRunUrl: string;
  /** Whether the run timed out */
  timedOut: boolean;
  /** Workflow run ID for artifact retrieval */
  workflowRunId: number;
}

/**
 * Structured artifact output for the eval agent.
 */
export interface SandboxArtifact {
  /** The sandbox configuration used */
  config: SandboxConfig;
  /** The sandbox result */
  result: SandboxResult;
  /** Per-command sandbox outputs; this is the authoritative eval input. */
  commands: SandboxCommandResult[];
  /** Timestamp when the run started */
  startedAt: string;
  /** Timestamp when the run completed */
  completedAt: string;
}

/**
 * A single check run attached to a commit ref.
 */
export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  appSlug: string | null;
}

/**
 * Interface for GitHub Actions API interactions (for testability).
 */
export interface ActionsClient {
  /** Trigger a workflow_dispatch event on the fork */
  triggerWorkflowDispatch(
    forkFullName: string,
    workflowId: string,
    branch: string,
    inputs: Record<string, string>
  ): Promise<void>;

  /**
   * Best-effort branch existence check used for pre-dispatch setup validation.
   * Optional so lightweight test doubles do not need to implement it.
   */
  branchRefExists?(repoFullName: string, branch: string): Promise<boolean>;

  /** Get the most recent workflow run for a branch after a given time */
  getWorkflowRun(
    forkFullName: string,
    workflowId: string,
    branch: string,
    createdAfter: string
  ): Promise<WorkflowRun | null>;

  /** Poll a workflow run until it completes or times out */
  waitForWorkflowRun(
    forkFullName: string,
    runId: number,
    timeoutMs: number,
    pollIntervalMs?: number
  ): Promise<WorkflowRunStatus>;

  /**
   * Best-effort cancellation for a workflow run.
   * Optional so minimal clients and unit test fakes don't need to implement it.
   */
  cancelWorkflowRun?(forkFullName: string, runId: number): Promise<void>;

  /**
   * Download the raw content of a named workflow-run artifact.
   * For the shared sandbox workflow, this is used to fetch the emitted SandboxOutput JSON.
   * Returns null when the artifact doesn't exist.
   */
  downloadWorkflowRunArtifact?(
    forkFullName: string,
    runId: number,
    artifactName: string
  ): Promise<string | null>;

  /** Download workflow run logs (stdout + stderr) */
  getWorkflowRunLogs(
    forkFullName: string,
    runId: number
  ): Promise<WorkflowRunLogs>;

  /** Upload structured artifact for eval agent consumption */
  uploadArtifact(
    forkFullName: string,
    runId: number,
    name: string,
    content: string
  ): Promise<string>;

  /**
   * Fetch all check runs for a given commit ref (SHA or branch name).
   * Optional so minimal clients and test fakes don't need to implement it.
   */
  getCheckRuns?(repoFullName: string, ref: string): Promise<CheckRun[]>;

  /**
   * Download the raw log text for a single Actions job by job ID.
   * Optional so minimal clients and test fakes don't need to implement it.
   */
  downloadJobLog?(repoFullName: string, jobId: number): Promise<string>;
}

/**
 * A GitHub Actions workflow run.
 */
export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}

/**
 * Status of a completed or timed-out workflow run.
 */
export interface WorkflowRunStatus {
  completed: boolean;
  conclusion: string | null;
  timedOut: boolean;
}

/**
 * Logs extracted from a workflow run.
 */
export interface WorkflowRunLogs {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Optional structured command output emitted by newer sandbox workflows */
  commands?: SandboxCommandResult[];
}

/**
 * Workflow file ID for the shared sandbox workflow.
 */
export const SANDBOX_WORKFLOW_FILE = 'sandbox.yml';

/**
 * Default timeout in minutes if not specified.
 */
export const DEFAULT_TIMEOUT_MINUTES = 15;

/**
 * Default poll interval in milliseconds.
 */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

export class SandboxRunError extends Error {
  public readonly phase: string;
  public readonly forkFullName: string;

  constructor(message: string, phase: string, forkFullName: string) {
    super(message);
    this.name = 'SandboxRunError';
    this.phase = phase;
    this.forkFullName = forkFullName;
  }
}

export class SandboxTimeoutError extends Error {
  public readonly timeoutMinutes: number;
  public readonly workflowRunId: number;

  constructor(message: string, timeoutMinutes: number, workflowRunId: number) {
    super(message);
    this.name = 'SandboxTimeoutError';
    this.timeoutMinutes = timeoutMinutes;
    this.workflowRunId = workflowRunId;
  }
}
