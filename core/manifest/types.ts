/**
 * Manifest types for the OSS Autonomous Fix Loop.
 *
 * The manifest is config-only. Repo-specific executable logic lives in the adapter.
 */
export interface Manifest {
  /** Upstream repo in owner/name format */
  repo: string;
  /** Label that triggers runs when applied to an issue */
  trigger_label: string;
  /** Label that skips PM gate when present on the issue */
  skip_pm_gate_label: string;
  /** GitHub org/user where forks are created */
  fork_org: string;
  /** Prefix for agent branches on forks */
  branch_prefix: string;
  /** Keywords that count as approval in PM/introspection email replies */
  approval_keywords: string[];
  /** Email address of the PM / design reviewer */
  pm_email: string;
  /** Max retry attempts for fix/build agent */
  max_retries: number;
  /** Sandbox wall-time cap (minutes) */
  sandbox_timeout_mins: number;
}

export interface ManifestValidationError {
  field: string;
  message: string;
}

export class ManifestLoadError extends Error {
  public readonly errors: ManifestValidationError[];

  constructor(errors: ManifestValidationError[]) {
    const msg = errors
      .map((e) => `  ${e.field}: ${e.message}`)
      .join('\n');
    super(`Invalid manifest:\n${msg}`);
    this.name = 'ManifestLoadError';
    this.errors = errors;
  }
}
