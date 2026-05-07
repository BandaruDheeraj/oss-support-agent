/**
 * Unit tests for manifest schema versioning and multi-repo support (US-018).
 * Covers: old version rejection, multi-repo dispatch, single-thread email aggregation.
 */

import {
  SUPPORTED_SCHEMA_VERSIONS,
  CURRENT_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  MultiRepoCoordinationError,
  SCHEMA_MIGRATIONS,
} from './multi-repo-types';

import {
  validateSchemaVersion,
  validateVersionedManifest,
  validateCoordinatedRepos,
  createMultiRepoRun,
  buildMultiRepoEmailSubject,
  createSharedEmailThread,
  aggregateMultiRepoEval,
  getMigrationPath,
  needsMigration,
  generateMigrationInstructions,
} from './multi-repo';

import { ManifestLoadError } from './manifest/types';

const VALID_BASE = {
  repo: 'Arize-ai/openinference',
  fork_org: 'oss-fix-bot',
  test_command: 'pytest tests/',
  pm_email: 'pm@example.com',
};

const VALID_V2_MANIFEST = {
  ...VALID_BASE,
  schema_version: '2',
};

const VALID_MULTI_REPO_MANIFEST = {
  ...VALID_BASE,
  schema_version: '2',
  coordinated_repos: [
    { repo: 'Arize-ai/phoenix', test_command: 'pytest tests/' },
    { repo: 'Arize-ai/arize-otel', fork_org: 'custom-org' },
  ],
};

describe('US-018: Manifest schema versioning and multi-repo support', () => {
  // --- Schema Version Validation ---
  describe('validateSchemaVersion', () => {
    it('returns "1" when schema_version is absent', () => {
      expect(validateSchemaVersion({})).toBe('1');
    });

    it('returns "1" when schema_version is null', () => {
      expect(validateSchemaVersion({ schema_version: null })).toBe('1');
    });

    it('returns "1" when schema_version is "1"', () => {
      expect(validateSchemaVersion({ schema_version: '1' })).toBe('1');
    });

    it('returns "2" when schema_version is "2"', () => {
      expect(validateSchemaVersion({ schema_version: '2' })).toBe('2');
    });

    it('rejects unknown version "3" with clear error', () => {
      expect(() => validateSchemaVersion({ schema_version: '3' }))
        .toThrow(UnsupportedSchemaVersionError);
    });

    it('rejects unknown version "0" with clear error', () => {
      expect(() => validateSchemaVersion({ schema_version: '0' }))
        .toThrow(UnsupportedSchemaVersionError);
    });

    it('rejects non-numeric version strings', () => {
      expect(() => validateSchemaVersion({ schema_version: 'latest' }))
        .toThrow(UnsupportedSchemaVersionError);
    });

    it('error message includes declared version', () => {
      try {
        validateSchemaVersion({ schema_version: '99' });
        fail('should have thrown');
      } catch (e: any) {
        expect(e.declaredVersion).toBe('99');
        expect(e.message).toContain('99');
      }
    });

    it('error message includes supported versions', () => {
      try {
        validateSchemaVersion({ schema_version: '99' });
        fail('should have thrown');
      } catch (e: any) {
        expect(e.supportedVersions).toEqual(SUPPORTED_SCHEMA_VERSIONS);
        expect(e.message).toContain('1');
        expect(e.message).toContain('2');
      }
    });

    it('converts numeric version to string for comparison', () => {
      // schema_version: 2 (number) should be treated as "2"
      expect(validateSchemaVersion({ schema_version: 2 })).toBe('2');
    });
  });

  // --- Versioned Manifest Validation ---
  describe('validateVersionedManifest', () => {
    it('validates a v1 manifest (no schema_version field)', () => {
      const result = validateVersionedManifest(VALID_BASE);
      expect(result.schema_version).toBe('1');
      expect(result.repo).toBe('Arize-ai/openinference');
    });

    it('validates a v2 manifest without coordinated_repos', () => {
      const result = validateVersionedManifest(VALID_V2_MANIFEST);
      expect(result.schema_version).toBe('2');
      expect(result.repo).toBe('Arize-ai/openinference');
      expect(result.coordinated_repos).toBeUndefined();
    });

    it('validates a v2 manifest with coordinated_repos', () => {
      const result = validateVersionedManifest(VALID_MULTI_REPO_MANIFEST);
      expect(result.schema_version).toBe('2');
      expect(result.coordinated_repos).toHaveLength(2);
      expect(result.coordinated_repos![0].repo).toBe('Arize-ai/phoenix');
      expect(result.coordinated_repos![1].fork_org).toBe('custom-org');
    });

    it('rejects coordinated_repos on v1 manifest', () => {
      const invalid = {
        ...VALID_BASE,
        schema_version: '1',
        coordinated_repos: [{ repo: 'org/repo' }],
      };
      expect(() => validateVersionedManifest(invalid)).toThrow(ManifestLoadError);
      try {
        validateVersionedManifest(invalid);
      } catch (e: any) {
        expect(e.errors[0].field).toBe('coordinated_repos');
        expect(e.errors[0].message).toContain('schema_version "2"');
      }
    });

    it('rejects unknown schema version', () => {
      const invalid = { ...VALID_BASE, schema_version: '99' };
      expect(() => validateVersionedManifest(invalid)).toThrow(UnsupportedSchemaVersionError);
    });

    it('rejects non-object manifests', () => {
      expect(() => validateVersionedManifest(null)).toThrow(ManifestLoadError);
      expect(() => validateVersionedManifest('string')).toThrow(ManifestLoadError);
      expect(() => validateVersionedManifest([1, 2])).toThrow(ManifestLoadError);
    });

    it('still validates base manifest fields (missing repo)', () => {
      const { repo, ...noRepo } = VALID_V2_MANIFEST;
      expect(() => validateVersionedManifest(noRepo)).toThrow(ManifestLoadError);
    });

    it('applies defaults for optional fields', () => {
      const result = validateVersionedManifest(VALID_V2_MANIFEST);
      expect(result.trigger_label).toBe('agent-fix');
      expect(result.branch_prefix).toBe('agent/scope-');
      expect(result.max_retries).toBe(3);
    });
  });

  // --- Coordinated Repos Validation ---
  describe('validateCoordinatedRepos', () => {
    it('validates a valid array of repos', () => {
      const repos = validateCoordinatedRepos([
        { repo: 'org/repo1' },
        { repo: 'org/repo2', fork_org: 'custom-org', test_command: 'npm test' },
      ]);
      expect(repos).toHaveLength(2);
      expect(repos[0].repo).toBe('org/repo1');
      expect(repos[1].fork_org).toBe('custom-org');
    });

    it('rejects non-array input', () => {
      expect(() => validateCoordinatedRepos('not-array')).toThrow(ManifestLoadError);
    });

    it('rejects entries without valid repo field', () => {
      expect(() => validateCoordinatedRepos([{ repo: 'invalid' }])).toThrow(ManifestLoadError);
    });

    it('rejects entries with non-string fork_org', () => {
      expect(() => validateCoordinatedRepos([{ repo: 'org/repo', fork_org: 123 }]))
        .toThrow(ManifestLoadError);
    });

    it('rejects entries with non-string test_command', () => {
      expect(() => validateCoordinatedRepos([{ repo: 'org/repo', test_command: true }]))
        .toThrow(ManifestLoadError);
    });

    it('rejects non-object entries', () => {
      expect(() => validateCoordinatedRepos(['not-an-object'])).toThrow(ManifestLoadError);
    });

    it('returns empty array for empty input', () => {
      expect(validateCoordinatedRepos([])).toEqual([]);
    });

    it('includes affected_module when provided', () => {
      const repos = validateCoordinatedRepos([
        { repo: 'org/repo', affected_module: 'src/core' },
      ]);
      expect(repos[0].affected_module).toBe('src/core');
    });
  });

  // --- Multi-Repo Run Creation ---
  describe('createMultiRepoRun', () => {
    it('creates a run with only the primary repo when no coordinated_repos', () => {
      const manifest = {
        ...VALID_BASE,
        schema_version: '2' as const,
        trigger_label: 'agent-fix',
        branch_prefix: 'agent/scope-',
        approval_keywords: ['approved'],
        issue_types: ['bug_fix' as const],
        sandbox_services: [] as string[],
        max_retries: 3,
        skip_pm_gate: false,
      };
      const run = createMultiRepoRun('run-1', manifest, [42, 10], 'agent/scope-');
      expect(run.groupRunId).toBe('run-1');
      expect(run.primaryRepo).toBe('Arize-ai/openinference');
      expect(run.repos).toHaveLength(1);
      expect(run.repos[0].branchName).toBe('agent/scope-10-42'); // sorted
    });

    it('creates a run with coordinated repos', () => {
      const manifest = {
        ...VALID_BASE,
        schema_version: '2' as const,
        trigger_label: 'agent-fix',
        branch_prefix: 'agent/scope-',
        approval_keywords: ['approved'],
        issue_types: ['bug_fix' as const],
        sandbox_services: [] as string[],
        max_retries: 3,
        skip_pm_gate: false,
        coordinated_repos: [
          { repo: 'Arize-ai/phoenix' },
          { repo: 'Arize-ai/arize-otel', fork_org: 'custom-org' },
        ],
      };
      const run = createMultiRepoRun('run-2', manifest, [100], 'agent/scope-');
      expect(run.repos).toHaveLength(3);
      expect(run.repos[0].repo).toBe('Arize-ai/openinference');
      expect(run.repos[0].forkFullName).toBe('oss-fix-bot/openinference');
      expect(run.repos[1].repo).toBe('Arize-ai/phoenix');
      expect(run.repos[1].forkFullName).toBe('oss-fix-bot/phoenix');
      expect(run.repos[2].repo).toBe('Arize-ai/arize-otel');
      expect(run.repos[2].forkFullName).toBe('custom-org/arize-otel');
    });

    it('uses same branch name across all repos', () => {
      const manifest = {
        ...VALID_BASE,
        schema_version: '2' as const,
        trigger_label: 'agent-fix',
        branch_prefix: 'agent/scope-',
        approval_keywords: ['approved'],
        issue_types: ['bug_fix' as const],
        sandbox_services: [] as string[],
        max_retries: 3,
        skip_pm_gate: false,
        coordinated_repos: [{ repo: 'org/other' }],
      };
      const run = createMultiRepoRun('run-3', manifest, [5, 3, 9], 'agent/scope-');
      const branchNames = run.repos.map((r) => r.branchName);
      expect(new Set(branchNames).size).toBe(1);
      expect(branchNames[0]).toBe('agent/scope-3-5-9');
    });

    it('sorts issue IDs numerically for deterministic branch name', () => {
      const manifest = {
        ...VALID_BASE,
        schema_version: '2' as const,
        trigger_label: 'agent-fix',
        branch_prefix: 'agent/scope-',
        approval_keywords: ['approved'],
        issue_types: ['bug_fix' as const],
        sandbox_services: [] as string[],
        max_retries: 3,
        skip_pm_gate: false,
      };
      const run = createMultiRepoRun('run-4', manifest, [200, 10, 3], 'agent/scope-');
      expect(run.repos[0].branchName).toBe('agent/scope-3-10-200');
    });
  });

  // --- Email Thread Aggregation ---
  describe('buildMultiRepoEmailSubject', () => {
    it('formats single-repo subject normally', () => {
      const subject = buildMultiRepoEmailSubject(['org/repo'], 42, 'Fix the bug');
      expect(subject).toBe('[agent-fix] org/repo/#42: Fix the bug');
    });

    it('formats multi-repo subject with count', () => {
      const subject = buildMultiRepoEmailSubject(
        ['org/repo1', 'org/repo2', 'org/repo3'],
        42,
        'Fix the bug',
      );
      expect(subject).toBe('[agent-fix] org/repo1 +2 repos/#42: Fix the bug');
    });

    it('formats two-repo subject with +1', () => {
      const subject = buildMultiRepoEmailSubject(['org/repo1', 'org/repo2'], 10, 'Update');
      expect(subject).toBe('[agent-fix] org/repo1 +1 repos/#10: Update');
    });
  });

  describe('createSharedEmailThread', () => {
    it('creates a shared thread for a multi-repo run', () => {
      const thread = createSharedEmailThread(
        'run-1',
        'thread-abc',
        ['org/repo1', 'org/repo2'],
        42,
        'Fix the bug',
      );
      expect(thread.groupRunId).toBe('run-1');
      expect(thread.threadId).toBe('thread-abc');
      expect(thread.repos).toEqual(['org/repo1', 'org/repo2']);
      expect(thread.subject).toContain('[agent-fix]');
      expect(thread.subject).toContain('+1 repos');
    });

    it('uses single-repo format for one repo', () => {
      const thread = createSharedEmailThread('run-2', 'thread-xyz', ['org/repo'], 10, 'Title');
      expect(thread.subject).toBe('[agent-fix] org/repo/#10: Title');
    });
  });

  // --- Multi-Repo Eval Aggregation ---
  describe('aggregateMultiRepoEval', () => {
    it('returns overallPass=true when all repos pass', () => {
      const result = aggregateMultiRepoEval([
        { repo: 'org/repo1', passed: true, reason: 'Tests passed' },
        { repo: 'org/repo2', passed: true, reason: 'Tests passed' },
      ]);
      expect(result.overallPass).toBe(true);
      expect(result.perRepoVerdicts).toHaveLength(2);
      expect(result.combinedSummary).toContain('All 2 repos passed');
    });

    it('returns overallPass=false when any repo fails', () => {
      const result = aggregateMultiRepoEval([
        { repo: 'org/repo1', passed: true, reason: 'Tests passed' },
        { repo: 'org/repo2', passed: false, reason: 'Test timeout' },
      ]);
      expect(result.overallPass).toBe(false);
      expect(result.combinedSummary).toContain('1/2 repos passed');
      expect(result.combinedSummary).toContain('org/repo2');
    });

    it('returns overallPass=false when all repos fail', () => {
      const result = aggregateMultiRepoEval([
        { repo: 'org/repo1', passed: false, reason: 'Compile error' },
        { repo: 'org/repo2', passed: false, reason: 'Test failure' },
      ]);
      expect(result.overallPass).toBe(false);
      expect(result.combinedSummary).toContain('0/2 repos passed');
    });

    it('includes per-repo verdicts with reasons', () => {
      const result = aggregateMultiRepoEval([
        { repo: 'org/repo1', passed: true, reason: 'All tests passed' },
      ]);
      expect(result.perRepoVerdicts[0]).toEqual({
        repo: 'org/repo1',
        passed: true,
        reason: 'All tests passed',
      });
    });

    it('single repo eval works correctly', () => {
      const result = aggregateMultiRepoEval([
        { repo: 'org/repo', passed: true, reason: 'OK' },
      ]);
      expect(result.overallPass).toBe(true);
      expect(result.combinedSummary).toContain('All 1 repos passed');
    });
  });

  // --- Migration ---
  describe('getMigrationPath', () => {
    it('returns migration from v1 to v2', () => {
      const migration = getMigrationPath('1', '2');
      expect(migration).toBeDefined();
      expect(migration!.from).toBe('1');
      expect(migration!.to).toBe('2');
      expect(migration!.breakingChanges.length).toBeGreaterThan(0);
      expect(migration!.steps.length).toBeGreaterThan(0);
    });

    it('returns undefined for non-existent migration path', () => {
      expect(getMigrationPath('2', '3')).toBeUndefined();
    });
  });

  describe('needsMigration', () => {
    it('returns true when schema_version is absent (implicitly v1)', () => {
      expect(needsMigration({})).toBe(true);
    });

    it('returns true when schema_version is "1"', () => {
      expect(needsMigration({ schema_version: '1' })).toBe(true);
    });

    it('returns false when schema_version is current', () => {
      expect(needsMigration({ schema_version: CURRENT_SCHEMA_VERSION })).toBe(false);
    });
  });

  describe('generateMigrationInstructions', () => {
    it('returns empty array when already at current version', () => {
      expect(generateMigrationInstructions({ schema_version: CURRENT_SCHEMA_VERSION }))
        .toEqual([]);
    });

    it('returns migration steps from v1 to current', () => {
      const steps = generateMigrationInstructions({});
      expect(steps.length).toBeGreaterThan(0);
      expect(steps[0]).toContain('schema_version');
    });

    it('returns migration steps from explicit v1', () => {
      const steps = generateMigrationInstructions({ schema_version: '1' });
      expect(steps.length).toBeGreaterThan(0);
    });
  });

  // --- Error types ---
  describe('UnsupportedSchemaVersionError', () => {
    it('has correct name and fields', () => {
      const err = new UnsupportedSchemaVersionError('99');
      expect(err.name).toBe('UnsupportedSchemaVersionError');
      expect(err.declaredVersion).toBe('99');
      expect(err.supportedVersions).toEqual(SUPPORTED_SCHEMA_VERSIONS);
      expect(err.message).toContain('99');
      expect(err.message).toContain('Supported versions');
    });
  });

  describe('MultiRepoCoordinationError', () => {
    it('has correct name and fields', () => {
      const err = new MultiRepoCoordinationError('dispatch failed', 'dispatch', 'run-1');
      expect(err.name).toBe('MultiRepoCoordinationError');
      expect(err.phase).toBe('dispatch');
      expect(err.groupRunId).toBe('run-1');
      expect(err.message).toBe('dispatch failed');
    });
  });

  // --- Constants ---
  describe('constants', () => {
    it('SUPPORTED_SCHEMA_VERSIONS includes 1 and 2', () => {
      expect(SUPPORTED_SCHEMA_VERSIONS).toContain('1');
      expect(SUPPORTED_SCHEMA_VERSIONS).toContain('2');
    });

    it('CURRENT_SCHEMA_VERSION is "2"', () => {
      expect(CURRENT_SCHEMA_VERSION).toBe('2');
    });

    it('SCHEMA_MIGRATIONS has at least one migration', () => {
      expect(SCHEMA_MIGRATIONS.length).toBeGreaterThan(0);
    });

    it('migration documents breaking changes and steps', () => {
      const migration = SCHEMA_MIGRATIONS[0];
      expect(migration.breakingChanges.length).toBeGreaterThan(0);
      expect(migration.steps.length).toBeGreaterThan(0);
    });
  });
});
