/**
 * Manifest schema versioning and multi-repo coordination (US-018).
 * Provides version validation, multi-repo dispatch, and single-thread email aggregation.
 */

import { Manifest } from './manifest/types';
import { ManifestLoadError } from './manifest/types';
import { validateManifest } from './manifest/loader';
import {
  SUPPORTED_SCHEMA_VERSIONS,
  CURRENT_SCHEMA_VERSION,
  SchemaVersion,
  VersionedManifest,
  MultiRepoManifest,
  CoordinatedRepo,
  MultiRepoRun,
  RepoRunState,
  MultiRepoEvalVerdict,
  RepoVerdict,
  SharedEmailThread,
  UnsupportedSchemaVersionError,
  MultiRepoCoordinationError,
  SCHEMA_MIGRATIONS,
  SchemaMigration,
} from './multi-repo-types';

// --- Schema Version Validation ---

/**
 * Validate the schema_version field of a manifest.
 * If absent, treats it as version "1" for backward compatibility.
 * Rejects unknown versions with a clear error message.
 */
export function validateSchemaVersion(data: Record<string, unknown>): SchemaVersion {
  const version = data.schema_version;

  // No version declared: treat as version 1 (backward compat)
  if (version === undefined || version === null) {
    return '1';
  }

  const versionStr = String(version);

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(versionStr as SchemaVersion)) {
    throw new UnsupportedSchemaVersionError(versionStr);
  }

  return versionStr as SchemaVersion;
}

/**
 * Validate a versioned manifest, applying version-specific schema rules.
 * For v1: standard manifest validation (no multi-repo fields).
 * For v2: validates coordinated_repos if present.
 */
export function validateVersionedManifest(data: unknown): MultiRepoManifest {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ManifestLoadError([
      { field: '(root)', message: 'Manifest must be a JSON object' },
    ]);
  }

  const raw = data as Record<string, unknown>;
  const version = validateSchemaVersion(raw);

  // Extract multi-repo fields before base validation (which rejects additional properties)
  const { schema_version, coordinated_repos, ...baseFields } = raw;

  // For v2, validate coordinated_repos structure
  let validatedCoordinatedRepos: CoordinatedRepo[] | undefined;
  if (version === '2' && coordinated_repos !== undefined) {
    validatedCoordinatedRepos = validateCoordinatedRepos(coordinated_repos);
  } else if (version === '1' && coordinated_repos !== undefined) {
    throw new ManifestLoadError([
      { field: 'coordinated_repos', message: 'coordinated_repos requires schema_version "2"' },
    ]);
  }

  // Use the existing manifest validation for base fields
  const baseManifest: Manifest = validateManifest(baseFields);

  const result: MultiRepoManifest = {
    ...baseManifest,
    schema_version: version,
  };

  if (validatedCoordinatedRepos && validatedCoordinatedRepos.length > 0) {
    result.coordinated_repos = validatedCoordinatedRepos;
  }

  return result;
}

/**
 * Validate the coordinated_repos array.
 */
export function validateCoordinatedRepos(data: unknown): CoordinatedRepo[] {
  if (!Array.isArray(data)) {
    throw new ManifestLoadError([
      { field: 'coordinated_repos', message: 'coordinated_repos must be an array' },
    ]);
  }

  const errors: Array<{ field: string; message: string }> = [];
  const repos: CoordinatedRepo[] = [];

  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (typeof item !== 'object' || item === null) {
      errors.push({ field: `coordinated_repos[${i}]`, message: 'Each entry must be an object' });
      continue;
    }

    const entry = item as Record<string, unknown>;

    if (typeof entry.repo !== 'string' || !entry.repo.match(/^[\w.-]+\/[\w.-]+$/)) {
      errors.push({ field: `coordinated_repos[${i}].repo`, message: 'repo must be a valid owner/name string' });
      continue;
    }

    if (entry.fork_org !== undefined && typeof entry.fork_org !== 'string') {
      errors.push({ field: `coordinated_repos[${i}].fork_org`, message: 'fork_org must be a string' });
      continue;
    }

    if (entry.test_command !== undefined) {
      errors.push({ field: `coordinated_repos[${i}].test_command`, message: 'test_command is adapter-owned and no longer allowed' });
      continue;
    }

    if (entry.affected_module !== undefined && typeof entry.affected_module !== 'string') {
      errors.push({ field: `coordinated_repos[${i}].affected_module`, message: 'affected_module must be a string' });
      continue;
    }

    repos.push({
      repo: entry.repo,
      fork_org: entry.fork_org as string | undefined,
      affected_module: entry.affected_module as string | undefined,
    });
  }

  if (errors.length > 0) {
    throw new ManifestLoadError(errors);
  }

  return repos;
}

// --- Multi-Repo Run Coordination ---

/**
 * Create a multi-repo coordinated run from a manifest with coordinated_repos.
 */
export function createMultiRepoRun(
  groupRunId: string,
  manifest: MultiRepoManifest,
  issueIds: number[],
  branchPrefix: string,
): MultiRepoRun {
  const sortedIds = [...issueIds].sort((a, b) => a - b);
  const branchSuffix = sortedIds.join('-');

  const repos: RepoRunState[] = [
    // Primary repo
    {
      repo: manifest.repo,
      forkFullName: `${manifest.fork_org}/${manifest.repo.split('/')[1]}`,
      branchName: `${branchPrefix}${branchSuffix}`,
    },
  ];

  // Add coordinated repos
  if (manifest.coordinated_repos) {
    for (const coord of manifest.coordinated_repos) {
      const forkOrg = coord.fork_org || manifest.fork_org;
      const repoName = coord.repo.split('/')[1];
      repos.push({
        repo: coord.repo,
        forkFullName: `${forkOrg}/${repoName}`,
        branchName: `${branchPrefix}${branchSuffix}`,
      });
    }
  }

  return {
    groupRunId,
    primaryRepo: manifest.repo,
    repos,
  };
}

/**
 * Build a shared email subject for a multi-repo run.
 */
export function buildMultiRepoEmailSubject(
  repos: string[],
  issueNumber: number,
  title: string,
): string {
  if (repos.length === 1) {
    return `[agent-fix] ${repos[0]}/#${issueNumber}: ${title}`;
  }
  return `[agent-fix] ${repos[0]} +${repos.length - 1} repos/#${issueNumber}: ${title}`;
}

/**
 * Create a shared email thread configuration for a multi-repo run.
 */
export function createSharedEmailThread(
  groupRunId: string,
  threadId: string,
  repos: string[],
  issueNumber: number,
  title: string,
): SharedEmailThread {
  return {
    groupRunId,
    threadId,
    repos,
    subject: buildMultiRepoEmailSubject(repos, issueNumber, title),
  };
}

/**
 * Aggregate individual repo sandbox results into a single eval verdict.
 */
export function aggregateMultiRepoEval(
  repoResults: Array<{ repo: string; passed: boolean; reason: string }>,
): MultiRepoEvalVerdict {
  const perRepoVerdicts: RepoVerdict[] = repoResults.map((r) => ({
    repo: r.repo,
    passed: r.passed,
    reason: r.reason,
  }));

  const overallPass = perRepoVerdicts.every((v) => v.passed);

  const passedCount = perRepoVerdicts.filter((v) => v.passed).length;
  const totalCount = perRepoVerdicts.length;

  let combinedSummary: string;
  if (overallPass) {
    combinedSummary = `All ${totalCount} repos passed evaluation.`;
  } else {
    const failedRepos = perRepoVerdicts.filter((v) => !v.passed).map((v) => v.repo);
    combinedSummary = `${passedCount}/${totalCount} repos passed. Failed: ${failedRepos.join(', ')}.`;
  }

  return {
    overallPass,
    perRepoVerdicts,
    combinedSummary,
  };
}

/**
 * Get the migration path between two schema versions.
 */
export function getMigrationPath(from: string, to: string): SchemaMigration | undefined {
  return SCHEMA_MIGRATIONS.find((m) => m.from === from && m.to === to);
}

/**
 * Check if a manifest needs migration to the current schema version.
 */
export function needsMigration(data: Record<string, unknown>): boolean {
  const version = data.schema_version;
  if (version === undefined || version === null) {
    return true; // Implicitly v1, needs migration to v2
  }
  return String(version) !== CURRENT_SCHEMA_VERSION;
}

/**
 * Generate migration instructions for a manifest.
 */
export function generateMigrationInstructions(data: Record<string, unknown>): string[] {
  const currentVersion = data.schema_version ? String(data.schema_version) : '1';
  if (currentVersion === CURRENT_SCHEMA_VERSION) {
    return [];
  }

  const migration = getMigrationPath(currentVersion, CURRENT_SCHEMA_VERSION);
  if (!migration) {
    return [`No migration path from version "${currentVersion}" to "${CURRENT_SCHEMA_VERSION}".`];
  }

  return migration.steps;
}
