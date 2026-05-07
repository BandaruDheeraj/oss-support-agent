/**
 * Barrel exports for the fix agent module (US-007).
 */

export {
  FixAgentInput,
  FixAgentResult,
  FileChange,
  ConfirmedIssue,
  ModuleCommit,
  ModuleFile,
  FixGenerator,
  FixGeneratorOutput,
  ForkCommitter,
  RepoFileReader,
  FixAgentError,
  UpstreamWriteAttemptError,
} from './fix-types';

export {
  formatCommitMessage,
  extractModuleName,
  validateChangeScope,
  verifyForkOnlyAccess,
  validateTestCoverage,
  readFullModule,
  runFixAgent,
} from './fix';

export { OpenRouterFixGenerator } from '../llm/openrouter-fix-generator';
