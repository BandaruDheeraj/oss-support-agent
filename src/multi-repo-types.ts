/**
 * Types for manifest schema versioning and multi-repo support (US-018).
 * Enables schema evolution and coordinated runs across multiple repos.
 */

import { Manifest } from './manifest/types';

// --- Schema Versioning ---

/** Supported schema versions */
export const SUPPORTED_SCHEMA_VERSIONS = ['1', '2'] as const;
export type SchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];

/** Current/latest schema version */
export const CURRENT_SCHEMA_VERSION: SchemaVersion = '2';

/**
 * Extended manifest type that includes schema_version field.
 * Version 1: Original manifest (implicitly version 1 if field is absent).
 * Version 2: Adds schema_version + multi-repo support fields.
 */
export interface VersionedManifest extends Manifest {
  /** Schema version declared by this manifest */
  schema_version: SchemaVersion;
}

/**
 * Multi-repo manifest extending the versioned manifest with coordinated repo support.
 */
export interface MultiRepoManifest extends VersionedManifest {
  /** Additional repos that share a single logical issue scope */
  coordinated_repos?: CoordinatedRepo[];
}

/**
 * A repo that participates in a multi-repo coordinated run.
 */
export interface CoordinatedRepo {
  /** GitHub repo in owner/name format */
  repo: string;
  /** Fork org for this repo (defaults to parent manifest's fork_org) */
  fork_org?: string;
  /** Test command for this specific repo (defaults to parent manifest's test_command) */
  test_command?: string;
  /** Affected module path in this repo */
  affected_module?: string;
}

// --- Multi-Repo Run Coordination ---

/**
 * A coordinated run that spans multiple repos for a single issue scope.
 */
export interface MultiRepoRun {
  /** Unique run ID for the coordinated group */
  groupRunId: string;
  /** The primary repo (from the manifest) */
  primaryRepo: string;
  /** All repos participating in this coordinated run */
  repos: RepoRunState[];
  /** Single shared email thread ID for the group */
  sharedThreadId?: string;
  /** Single shared eval verdict for the group */
  sharedEvalVerdict?: MultiRepoEvalVerdict;
}

/**
 * State of a single repo within a multi-repo coordinated run.
 */
export interface RepoRunState {
  /** The repo (owner/name format) */
  repo: string;
  /** Fork full name for this repo */
  forkFullName: string;
  /** Branch name for this repo's changes */
  branchName: string;
  /** Individual sandbox result for this repo */
  sandboxPassed?: boolean;
  /** Individual fix/build result for this repo */
  agentCompleted?: boolean;
}

/**
 * A single eval verdict shared across all repos in a multi-repo run.
 */
export interface MultiRepoEvalVerdict {
  /** Overall pass/fail for the entire coordinated run */
  overallPass: boolean;
  /** Per-repo verdicts */
  perRepoVerdicts: RepoVerdict[];
  /** Combined summary for the PR body */
  combinedSummary: string;
}

/**
 * Verdict for a single repo in the multi-repo eval.
 */
export interface RepoVerdict {
  repo: string;
  passed: boolean;
  reason: string;
}

// --- Email Thread Aggregation ---

/**
 * Configuration for a shared email thread across multiple repos.
 */
export interface SharedEmailThread {
  /** The group run ID this thread belongs to */
  groupRunId: string;
  /** Thread ID from Gmail */
  threadId: string;
  /** All repos discussed in this thread */
  repos: string[];
  /** Subject line for the shared thread */
  subject: string;
}

// --- Errors ---

/**
 * Error thrown when a manifest declares an unsupported schema version.
 */
export class UnsupportedSchemaVersionError extends Error {
  public readonly declaredVersion: string;
  public readonly supportedVersions: readonly string[];

  constructor(declaredVersion: string) {
    super(
      `Unsupported manifest schema version "${declaredVersion}". ` +
      `Supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}. ` +
      `Please update your manifest or upgrade the agent.`
    );
    this.name = 'UnsupportedSchemaVersionError';
    this.declaredVersion = declaredVersion;
    this.supportedVersions = SUPPORTED_SCHEMA_VERSIONS;
  }
}

/**
 * Error thrown for multi-repo coordination failures.
 */
export class MultiRepoCoordinationError extends Error {
  public readonly phase: string;
  public readonly groupRunId: string;

  constructor(message: string, phase: string, groupRunId: string) {
    super(message);
    this.name = 'MultiRepoCoordinationError';
    this.phase = phase;
    this.groupRunId = groupRunId;
  }
}

// --- Migration ---

/**
 * Schema migration descriptor.
 */
export interface SchemaMigration {
  /** Source version */
  from: string;
  /** Target version */
  to: string;
  /** Description of breaking changes */
  breakingChanges: string[];
  /** Migration steps */
  steps: string[];
}

/** Documented migration paths */
export const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    from: '1',
    to: '2',
    breakingChanges: [
      'schema_version field is now required (defaults to "1" for backward compatibility)',
      'coordinated_repos field added (optional) for multi-repo support',
    ],
    steps: [
      'Add "schema_version": "2" to your manifest',
      'Optionally add "coordinated_repos" array for multi-repo coordination',
      'Existing fields remain unchanged; no other modifications needed',
    ],
  },
];
