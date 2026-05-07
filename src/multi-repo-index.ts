/**
 * Barrel exports for manifest schema versioning and multi-repo support (US-018).
 */

export {
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

export {
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
