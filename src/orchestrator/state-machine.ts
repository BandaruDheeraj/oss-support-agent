import { Run, RunState, TransitionLogEntry, IllegalTransitionError } from './types';
import { isTransitionAllowed } from './transitions';
import { RunStore } from './persistence';

/**
 * Orchestrator state machine.
 * Validates transitions, persists state to SQLite, and logs every transition.
 */
export class StateMachine {
  private store: RunStore;

  constructor(dbPath: string) {
    this.store = new RunStore(dbPath);
  }

  /**
   * Create a new run in TRIGGERED state.
   */
  createRun(id: string, repo: string, issueIds: number[]): Run {
    return this.store.createRun(id, repo, issueIds);
  }

  /**
   * Transition a run to a new state.
   * Validates the transition, persists atomically, and logs.
   * Throws IllegalTransitionError if the transition is not allowed.
   */
  transition(runId: string, toState: RunState): Run {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new Error(`Run '${runId}' not found`);
    }

    if (!isTransitionAllowed(run.state, toState)) {
      throw new IllegalTransitionError(runId, run.state, toState);
    }

    const now = new Date().toISOString();
    // Increment retry_count when transitioning back to AGENT_RUNNING from EVAL_RUNNING (retry)
    const incrementRetry =
      run.state === RunState.EVAL_RUNNING && toState === RunState.AGENT_RUNNING;

    this.store.transitionAtomic(runId, run.state, toState, now, incrementRetry);

    return this.store.getRun(runId)!;
  }

  /**
   * Get a run by ID.
   */
  getRun(runId: string): Run | null {
    return this.store.getRun(runId);
  }

  /**
   * Get all runs in a specific state.
   */
  getRunsByState(state: RunState): Run[] {
    return this.store.getRunsByState(state);
  }

  /**
   * Get all in-flight (non-terminal) runs for restart-resume.
   */
  getInFlightRuns(): Run[] {
    return this.store.getInFlightRuns();
  }

  /**
   * Get the full transition log for a run.
   */
  getTransitionLog(runId: string): TransitionLogEntry[] {
    return this.store.getTransitionLog(runId);
  }

  /**
   * Close the underlying database connection.
   */
  close(): void {
    this.store.close();
  }
}
