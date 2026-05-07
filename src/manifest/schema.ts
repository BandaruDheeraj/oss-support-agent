/**
 * Manifest JSON Schema for the OSS Autonomous Fix Loop.
 * Covers all fields from PRD section 3.1.
 * Base schema (used for v1 base validation without schema_version/coordinated_repos).
 */
export const manifestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'OSS Fix Loop Manifest',
  type: 'object',
  required: ['repo', 'fork_org', 'test_command', 'pm_email'],
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
    fork_org: {
      type: 'string',
      description: 'GitHub org/user where forks are created',
    },
    branch_prefix: {
      type: 'string',
      description: 'Prefix for agent branches on the fork',
      default: 'agent/scope-',
    },
    test_command: {
      type: 'string',
      description: 'Command to run in the sandbox to verify fixes',
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
    issue_types: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['bug_fix', 'new_feature', 'docs'],
      },
      description: 'Issue types this manifest handles',
      default: ['bug_fix', 'new_feature', 'docs'],
    },
    sandbox_services: {
      type: 'array',
      items: { type: 'string' },
      description: 'External services the sandbox is allowed to reach',
      default: [],
    },
    max_retries: {
      type: 'integer',
      minimum: 0,
      description: 'Max retry attempts for fix/build agent',
      default: 3,
    },
    skip_pm_gate: {
      type: 'boolean',
      description: 'If true, skip PM design review entirely',
      default: false,
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
  required: ['repo', 'fork_org', 'test_command', 'pm_email'],
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
          test_command: {
            type: 'string',
            description: 'Test command for this repo (defaults to parent test_command)',
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
