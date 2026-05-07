/**
 * Types for the basic sandbox runner (US-008).
 * The sandbox runner executes the manifest test_command on the fork branch
 * via GitHub Actions workflow_dispatch and captures stdout/stderr/exit code.
 */

/**
 * Configuration for a sandbox run, derived from the manifest and fork context.
 */
export interface SandboxConfig {
  /** Fork full name (org/repo) where the workflow runs */
  forkFullName: string;
  /** Branch to check out in the sandbox */
  branchName: string;
  /** Test command from the manifest */
  testCommand: string;
  /** Allowed external services (e.g. ["postgres", "redis"]) */
  sandboxServices: string[];
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
  /** Timestamp when the run started */
  startedAt: string;
  /** Timestamp when the run completed */
  completedAt: string;
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
}

/**
 * Workflow file ID for the sandbox workflow.
 */
export const SANDBOX_WORKFLOW_FILE = 'sandbox-test.yml';

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
