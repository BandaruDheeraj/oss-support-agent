/**
 * Orchestrator state machine types for the OSS Autonomous Fix Loop.
 */

export enum RunState {
  TRIGGERED = 'TRIGGERED',
  TRIAGING = 'TRIAGING',
  PM_SCORING = 'PM_SCORING',
  EMAIL_PENDING = 'EMAIL_PENDING',
  SWEEP_PENDING = 'SWEEP_PENDING',
  FORKING = 'FORKING',
  AGENT_RUNNING = 'AGENT_RUNNING',
  SANDBOX_RUNNING = 'SANDBOX_RUNNING',
  EVAL_RUNNING = 'EVAL_RUNNING',
  PR_OPEN = 'PR_OPEN',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  RunState.PR_OPEN,
  RunState.FAILED,
  RunState.SKIPPED,
]);

export const IN_FLIGHT_STATES: ReadonlySet<RunState> = new Set([
  RunState.TRIGGERED,
  RunState.TRIAGING,
  RunState.PM_SCORING,
  RunState.EMAIL_PENDING,
  RunState.SWEEP_PENDING,
  RunState.FORKING,
  RunState.AGENT_RUNNING,
  RunState.SANDBOX_RUNNING,
  RunState.EVAL_RUNNING,
]);

export function isTerminalState(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

export interface Run {
  id: string;
  repo: string;
  issue_ids: number[];
  state: RunState;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface TransitionLogEntry {
  id: number;
  run_id: string;
  from_state: RunState;
  to_state: RunState;
  timestamp: string;
}

export class IllegalTransitionError extends Error {
  public readonly runId: string;
  public readonly fromState: RunState;
  public readonly toState: RunState;

  constructor(runId: string, fromState: RunState, toState: RunState) {
    super(
      `Illegal transition for run '${runId}': ${fromState} → ${toState}`
    );
    this.name = 'IllegalTransitionError';
    this.runId = runId;
    this.fromState = fromState;
    this.toState = toState;
  }
}
