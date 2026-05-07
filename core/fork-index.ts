/**
 * Barrel exports for fork creation and branch management (US-006).
 */

export {
  ForkConfig,
  ForkResult,
  GitHubClient,
  ForkCreationError,
  BranchCreationError,
  UpstreamWriteGuardError,
} from './fork-types';

export {
  generateBranchName,
  deriveForkName,
  verifyNoUpstreamWriteAccess,
  createForkAndBranch,
} from './fork-manager';
