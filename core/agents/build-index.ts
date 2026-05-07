/**
 * Build agent barrel exports (US-014).
 */

export {
  BuildAgentInput,
  BuildAgentResult,
  BuildAgentError,
  ScaffoldGenerator,
  ScaffoldGeneratorOutput,
  ReferenceModule,
} from './build-types';

export {
  formatBuildCommitMessage,
  extractModuleName,
  verifyForkOnlyAccess,
  validateNoDocumentation,
  validateModuleScope,
  validateTestFilePresent,
  validateIndexUpdates,
  analyzeReferenceModules,
  runBuildAgent,
} from './build';

export { OpenRouterScaffoldGenerator } from '../llm/openrouter-scaffold-generator';
