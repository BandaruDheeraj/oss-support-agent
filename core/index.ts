export { loadManifest, validateManifest } from './manifest';
export { manifestSchema } from './manifest';
export type { Manifest, ManifestValidationError } from './manifest';
export { ManifestLoadError } from './manifest';

export type {
  RepoAdapter,
  Issue,
  ServiceConfig,
  SandboxCommandResult,
  SandboxOutput,
  EvalResult,
  PRMetadata,
} from './adapter.interface';
export { BaseRepoAdapter } from './adapter.interface';

export {
  StateMachine,
  RunStore,
  RunState,
  ALLOWED_TRANSITIONS,
  isTransitionAllowed,
  IllegalTransitionError,
  TERMINAL_STATES,
  IN_FLIGHT_STATES,
  isTerminalState,
} from './orchestrator';
export type { Run, TransitionLogEntry } from './orchestrator';

export {
  createWebhookServer,
  verifySignature,
  computeSignature,
  routeEvent,
} from './webhook';
export type {
  WebhookServerOptions,
  ManifestRegistry,
  IssueEvent,
  GitHubIssue,
  WebhookResult,
} from './webhook';

export {
  loadAdapter,
  AdapterContractError,
  AdapterBootstrapEnvError,
} from './adapter-loader';
export type { AdapterContractViolationCode } from './adapter-loader';

export { handleIssueEvent } from './handle-issue-event';
export type { RunPipeline } from './handle-issue-event';
