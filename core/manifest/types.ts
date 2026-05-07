/**
 * Manifest types for the OSS Autonomous Fix Loop.
 */
export interface Manifest {
  repo: string;
  trigger_label: string;
  fork_org: string;
  branch_prefix: string;
  test_command: string;
  approval_keywords: string[];
  pm_email: string;
  issue_types: Array<'bug_fix' | 'new_feature' | 'docs'>;
  sandbox_services: string[];
  max_retries: number;
  skip_pm_gate: boolean;
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
