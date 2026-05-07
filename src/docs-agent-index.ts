/**
 * Barrel exports for the docs agent module (US-010).
 */

export {
  DocsAgentInput,
  DocsAgentResult,
  DocsGenerator,
  DocsGeneratorOutput,
  DocsAgentError,
  DOC_FILE_PATTERNS,
  APP_CODE_EXTENSIONS,
  ConfirmedIssue,
  ModuleCommit,
  ModuleFile,
  FileChange,
  ForkCommitter,
  RepoFileReader,
} from './docs-agent-types';

export {
  formatDocsCommitMessage,
  isDocumentationFile,
  isApplicationCode,
  validateDocsOnly,
  verifyForkOnlyAccess,
  readDocFiles,
  runDocsAgent,
} from './docs-agent';
