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
} from './build-agent-types';

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
} from './build-agent';

export { OpenRouterScaffoldGenerator } from './openrouter-scaffold-generator';
