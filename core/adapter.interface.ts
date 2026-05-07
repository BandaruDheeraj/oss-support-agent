/**
 * Repo adapter contract.
 *
 * Core agents must use this interface exclusively for repo-specific behaviour.
 * Per-repo adapters live outside core and implement these methods.
 */

/**
 * Contract version.
 *
 * Bump this number when you make any breaking change to RepoAdapter or its supporting types.
 */
export const ADAPTER_INTERFACE_VERSION = 1;


/** A GitHub issue (or issue-like) input used for routing decisions. */
export interface Issue {
  /** Issue number within the repository. */
  number: number;
  /** Issue title. */
  title: string;
  /** Issue body/description text. */
  body: string;
  /** Label names applied to the issue. */
  labels: string[];
  /** Optional URL to the issue. */
  url?: string;
}

/** Docker service configuration for sandbox runs. */
export interface ServiceConfig {
  /** Stable identifier used for logging and container naming. */
  name: string;
  /** Docker image (e.g. "postgres:16"). */
  image: string;
  /** Port mappings to expose service ports to the sandbox environment. */
  ports: Array<{
    hostPort: number;
    containerPort: number;
  }>;
  /** Optional env vars passed to the container. */
  env?: Record<string, string>;
  /** Optional HTTP URL used as a readiness/health check before tests run. */
  healthCheckUrl?: string;
}

/** Result for a single executed sandbox command. */
export interface SandboxCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Sandbox output consumed by eval.
 *
 * This is intentionally an array so custom eval logic can attribute failures
 * to specific commands.
 */
export type SandboxOutput = SandboxCommandResult[];

/** Eval output returned by adapter.runCustomEval(). */
export interface EvalResult {
  /** Overall pass/fail for the sandbox run. */
  passed: boolean;
  /** Human-readable summary for logs/PR body. */
  summary: string;
  /** Context used when deciding to retry (e.g. failure messages). */
  retryContext: string[];
}

/** Extra PR metadata returned by adapter.getPRMetadata(). */
export interface PRMetadata {
  /** Extra labels to apply to the PR in addition to harness defaults. */
  extraLabels: string[];
  /** Extra markdown sections appended to the PR body. */
  extraBodySections: string[];
}

/**
 * Stable adapter contract.
 *
 * All methods are async so implementations can do I/O without future interface changes.
 */
export interface RepoAdapter {
  /**
   * Called by triage/routing. Returns the affected module path relative to repo root.
   *
   * Example returns: "packages/foo", "python/instrumentation".
   */
  classifyModule(issue: Issue): Promise<string>;

  /** Called by the sandbox runner to determine which test commands to execute. */
  getTestCommands(): Promise<string[]>;

  /** Called by the sandbox runner to determine which services must be started. */
  getSandboxServices(): Promise<ServiceConfig[]>;

  /** Called by the eval agent to interpret sandbox output and decide pass/fail. */
  runCustomEval(output: SandboxOutput): Promise<EvalResult>;

  /** Called by the PR creator to add repo-specific labels/body sections. */
  getPRMetadata(issues: Issue[]): Promise<PRMetadata>;
}

/**
 * Base adapter with safe defaults.
 *
 * Repo adapters can extend this class and override only the methods they need.
 */
export class BaseRepoAdapter implements RepoAdapter {
  async classifyModule(_issue: Issue): Promise<string> {
    return '.';
  }

  async getTestCommands(): Promise<string[]> {
    return [];
  }

  async getSandboxServices(): Promise<ServiceConfig[]> {
    return [];
  }

  async runCustomEval(output: SandboxOutput): Promise<EvalResult> {
    const firstFailure = output.find((c) => c.exitCode !== 0);
    if (!firstFailure) {
      return {
        passed: true,
        summary: 'All sandbox commands passed',
        retryContext: [],
      };
    }

    const context = [firstFailure.stderr, firstFailure.stdout]
      .map((s) => (s ?? '').trim())
      .filter((s) => s.length > 0);

    return {
      passed: false,
      summary: `Sandbox command failed: ${firstFailure.command}`,
      retryContext: context,
    };
  }

  async getPRMetadata(_issues: Issue[]): Promise<PRMetadata> {
    return { extraLabels: [], extraBodySections: [] };
  }
}
