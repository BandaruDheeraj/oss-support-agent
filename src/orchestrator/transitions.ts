import { RunState } from './types';

/**
 * Allowed state transitions for the orchestrator pipeline.
 * Each key maps to the set of valid target states.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<RunState, ReadonlySet<RunState>>> = {
  [RunState.TRIGGERED]: new Set([RunState.TRIAGING, RunState.SKIPPED]),
  [RunState.TRIAGING]: new Set([RunState.PM_SCORING, RunState.FORKING, RunState.SKIPPED, RunState.FAILED]),
  [RunState.PM_SCORING]: new Set([RunState.EMAIL_PENDING, RunState.FORKING, RunState.FAILED]),
  [RunState.EMAIL_PENDING]: new Set([RunState.SWEEP_PENDING, RunState.FAILED]),
  [RunState.SWEEP_PENDING]: new Set([RunState.FORKING, RunState.FAILED]),
  [RunState.FORKING]: new Set([RunState.AGENT_RUNNING, RunState.FAILED]),
  [RunState.AGENT_RUNNING]: new Set([RunState.SANDBOX_RUNNING, RunState.FAILED]),
  [RunState.SANDBOX_RUNNING]: new Set([RunState.EVAL_RUNNING, RunState.FAILED]),
  [RunState.EVAL_RUNNING]: new Set([RunState.PR_OPEN, RunState.AGENT_RUNNING, RunState.FAILED]),
  [RunState.PR_OPEN]: new Set([]),
  [RunState.FAILED]: new Set([]),
  [RunState.SKIPPED]: new Set([]),
};

export function isTransitionAllowed(from: RunState, to: RunState): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}
