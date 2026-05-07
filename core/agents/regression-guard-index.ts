/**
 * Barrel exports for the regression guard module (US-016).
 */

export {
  RegressionConfig,
  RegressionResult,
  BranchTestResult,
  OutputDiff,
  REGRESSION_WORKFLOW_FILE,
  DEFAULT_REGRESSION_TIMEOUT_MINUTES,
  RegressionGuardError,
} from './regression-guard-types';

export {
  validateRegressionConfig,
  createRegressionConfig,
  buildRegressionWorkflowInputs,
  normalizeOutput,
  diffOutputs,
  generateRegressionSummary,
  runRegressionGuard,
} from './regression-guard';
