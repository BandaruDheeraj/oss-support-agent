/**
 * Manifest JSON Schema for the OSS Autonomous Fix Loop.
 * Covers all fields from PRD section 3.1.
 * Base schema (used for v1 base validation without schema_version/coordinated_repos).
 */
export const manifestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'OSS Fix Loop Manifest',
  type: 'object',
  required: ['repo', 'fork_org', 'pm_email'],
  properties: {
    repo: {
      type: 'string',
      description: 'GitHub repo in owner/name format',
      pattern: '^[\\w.-]+/[\\w.-]+$',
    },
    trigger_label: {
      type: 'string',
      description: 'Label that triggers the agent pipeline',
      default: 'agent-fix',
    },
    skip_pm_gate_label: {
      type: 'string',
      description: 'Label on an issue that skips PM gate for trivial fixes',
      default: 'trivial-fix',
    },
    fork_org: {
      type: 'string',
      description: 'GitHub org/user where forks are created',
    },
    branch_prefix: {
      type: 'string',
      description: 'Prefix for agent branches on the fork',
      default: 'agent/scope-',
    },
    approval_keywords: {
      type: 'array',
      items: { type: 'string' },
      description: 'Keywords in PM email replies that signal design approval',
      default: ['approved', 'lgtm', 'ship it'],
    },
    pm_email: {
      type: 'string',
      format: 'email',
      description: 'Email address of the PM / design reviewer',
    },
    max_retries: {
      type: 'integer',
      minimum: 0,
      description: 'Max retry attempts for fix/build agent',
      default: 3,
    },
    sandbox_timeout_mins: {
      type: 'integer',
      minimum: 1,
      description: 'Sandbox wall-time cap (minutes)',
      default: 15,
    },
    sandbox_runner: {
      type: 'string',
      enum: ['local', 'gha'],
      description:
        'Sandbox runner. "local" runs subprocess on the harness host (default). "gha" dispatches to GitHub Actions; required for macOS/iOS targets and for regression-guard/usability cross-branch runs.',
      default: 'local',
    },
  },
  additionalProperties: false,
} as const;

/**
 * Extended schema for v2 manifests that includes schema_version and coordinated_repos.
 * Used by the versioned manifest loader (multi-repo.ts).
 */
export const versionedManifestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'OSS Fix Loop Manifest (Versioned)',
  type: 'object',
  required: ['repo', 'fork_org', 'pm_email'],
  properties: {
    ...manifestSchema.properties,
    schema_version: {
      type: 'string',
      description: 'Schema version declared by this manifest',
      enum: ['1', '2'],
    },
    coordinated_repos: {
      type: 'array',
      description: 'Additional repos for multi-repo coordinated runs (v2 only)',
      items: {
        type: 'object',
        required: ['repo'],
        properties: {
          repo: {
            type: 'string',
            pattern: '^[\\w.-]+/[\\w.-]+$',
            description: 'GitHub repo in owner/name format',
          },
          fork_org: {
            type: 'string',
            description: 'Fork org for this repo (defaults to parent fork_org)',
          },
          affected_module: {
            type: 'string',
            description: 'Affected module path in this repo',
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;
