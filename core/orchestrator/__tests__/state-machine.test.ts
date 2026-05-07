import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { StateMachine, RunState, IllegalTransitionError } from '../index';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
  return path.join(dir, 'test.db');
}

describe('StateMachine', () => {
  let sm: StateMachine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    sm = new StateMachine(dbPath);
  });

  afterEach(() => {
    sm.close();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(dbPath + '-wal');
      fs.unlinkSync(dbPath + '-shm');
    } catch {
      // ignore cleanup errors
    }
  });

  describe('createRun', () => {
    it('creates a run in TRIGGERED state', () => {
      const run = sm.createRun('run-1', 'owner/repo', [42, 99]);
      expect(run.id).toBe('run-1');
      expect(run.repo).toBe('owner/repo');
      expect(run.issue_ids).toEqual([42, 99]);
      expect(run.state).toBe(RunState.TRIGGERED);
      expect(run.retry_count).toBe(0);
      expect(run.created_at).toBeDefined();
      expect(run.updated_at).toBeDefined();
    });

    it('persists the run to the database', () => {
      sm.createRun('run-2', 'org/lib', [1]);
      const retrieved = sm.getRun('run-2');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.state).toBe(RunState.TRIGGERED);
    });
  });

  describe('transition - happy path', () => {
    it('transitions through the full pipeline to PR_OPEN', () => {
      sm.createRun('run-full', 'org/repo', [10, 20]);

      sm.transition('run-full', RunState.TRIAGING);
      expect(sm.getRun('run-full')!.state).toBe(RunState.TRIAGING);

      sm.transition('run-full', RunState.PM_SCORING);
      expect(sm.getRun('run-full')!.state).toBe(RunState.PM_SCORING);

      sm.transition('run-full', RunState.FORKING);
      expect(sm.getRun('run-full')!.state).toBe(RunState.FORKING);

      sm.transition('run-full', RunState.AGENT_RUNNING);
      expect(sm.getRun('run-full')!.state).toBe(RunState.AGENT_RUNNING);

      sm.transition('run-full', RunState.SANDBOX_RUNNING);
      expect(sm.getRun('run-full')!.state).toBe(RunState.SANDBOX_RUNNING);

      sm.transition('run-full', RunState.EVAL_RUNNING);
      expect(sm.getRun('run-full')!.state).toBe(RunState.EVAL_RUNNING);

      sm.transition('run-full', RunState.PR_OPEN);
      expect(sm.getRun('run-full')!.state).toBe(RunState.PR_OPEN);
    });

    it('transitions through email loop path', () => {
      sm.createRun('run-email', 'org/repo', [5]);

      sm.transition('run-email', RunState.TRIAGING);
      sm.transition('run-email', RunState.PM_SCORING);
      sm.transition('run-email', RunState.EMAIL_PENDING);
      expect(sm.getRun('run-email')!.state).toBe(RunState.EMAIL_PENDING);

      sm.transition('run-email', RunState.SWEEP_PENDING);
      expect(sm.getRun('run-email')!.state).toBe(RunState.SWEEP_PENDING);

      sm.transition('run-email', RunState.FORKING);
      expect(sm.getRun('run-email')!.state).toBe(RunState.FORKING);
    });

    it('transitions from TRIAGING to FORKING (docs fast path / skip_pm_gate)', () => {
      sm.createRun('run-docs', 'org/repo', [100]);
      sm.transition('run-docs', RunState.TRIAGING);
      sm.transition('run-docs', RunState.FORKING);
      expect(sm.getRun('run-docs')!.state).toBe(RunState.FORKING);
    });

    it('transitions to SKIPPED from TRIGGERED', () => {
      sm.createRun('run-skip', 'org/repo', [1]);
      sm.transition('run-skip', RunState.SKIPPED);
      expect(sm.getRun('run-skip')!.state).toBe(RunState.SKIPPED);
    });

    it('transitions to FAILED from any non-terminal state', () => {
      const states: [RunState, RunState[]][] = [
        [RunState.TRIAGING, [RunState.TRIAGING]],
        [RunState.PM_SCORING, [RunState.TRIAGING, RunState.PM_SCORING]],
        [RunState.EMAIL_PENDING, [RunState.TRIAGING, RunState.PM_SCORING, RunState.EMAIL_PENDING]],
        [RunState.FORKING, [RunState.TRIAGING, RunState.FORKING]],
        [RunState.AGENT_RUNNING, [RunState.TRIAGING, RunState.FORKING, RunState.AGENT_RUNNING]],
        [RunState.SANDBOX_RUNNING, [RunState.TRIAGING, RunState.FORKING, RunState.AGENT_RUNNING, RunState.SANDBOX_RUNNING]],
        [RunState.EVAL_RUNNING, [RunState.TRIAGING, RunState.FORKING, RunState.AGENT_RUNNING, RunState.SANDBOX_RUNNING, RunState.EVAL_RUNNING]],
      ];

      for (const [targetState, path] of states) {
        const id = `run-fail-from-${targetState}`;
        sm.createRun(id, 'org/repo', [1]);
        for (const s of path) {
          sm.transition(id, s);
        }
        sm.transition(id, RunState.FAILED);
        expect(sm.getRun(id)!.state).toBe(RunState.FAILED);
      }
    });
  });

  describe('transition - retry path', () => {
    it('EVAL_RUNNING can transition back to AGENT_RUNNING and increments retry_count', () => {
      sm.createRun('run-retry', 'org/repo', [7]);
      sm.transition('run-retry', RunState.TRIAGING);
      sm.transition('run-retry', RunState.FORKING);
      sm.transition('run-retry', RunState.AGENT_RUNNING);
      sm.transition('run-retry', RunState.SANDBOX_RUNNING);
      sm.transition('run-retry', RunState.EVAL_RUNNING);

      expect(sm.getRun('run-retry')!.retry_count).toBe(0);

      sm.transition('run-retry', RunState.AGENT_RUNNING);
      expect(sm.getRun('run-retry')!.state).toBe(RunState.AGENT_RUNNING);
      expect(sm.getRun('run-retry')!.retry_count).toBe(1);

      // Second retry
      sm.transition('run-retry', RunState.SANDBOX_RUNNING);
      sm.transition('run-retry', RunState.EVAL_RUNNING);
      sm.transition('run-retry', RunState.AGENT_RUNNING);
      expect(sm.getRun('run-retry')!.retry_count).toBe(2);
    });
  });

  describe('transition - illegal transitions', () => {
    it('rejects transition from terminal state PR_OPEN', () => {
      sm.createRun('run-t1', 'org/repo', [1]);
      sm.transition('run-t1', RunState.TRIAGING);
      sm.transition('run-t1', RunState.FORKING);
      sm.transition('run-t1', RunState.AGENT_RUNNING);
      sm.transition('run-t1', RunState.SANDBOX_RUNNING);
      sm.transition('run-t1', RunState.EVAL_RUNNING);
      sm.transition('run-t1', RunState.PR_OPEN);

      expect(() => sm.transition('run-t1', RunState.FAILED)).toThrow(IllegalTransitionError);
      expect(sm.getRun('run-t1')!.state).toBe(RunState.PR_OPEN);
    });

    it('rejects transition from terminal state FAILED', () => {
      sm.createRun('run-t2', 'org/repo', [1]);
      sm.transition('run-t2', RunState.TRIAGING);
      sm.transition('run-t2', RunState.FAILED);

      expect(() => sm.transition('run-t2', RunState.TRIAGING)).toThrow(IllegalTransitionError);
      expect(sm.getRun('run-t2')!.state).toBe(RunState.FAILED);
    });

    it('rejects invalid forward transition (TRIGGERED → AGENT_RUNNING)', () => {
      sm.createRun('run-t3', 'org/repo', [1]);

      expect(() => sm.transition('run-t3', RunState.AGENT_RUNNING)).toThrow(IllegalTransitionError);
      expect(sm.getRun('run-t3')!.state).toBe(RunState.TRIGGERED);
    });

    it('does not create a transition log entry on illegal transition', () => {
      sm.createRun('run-t4', 'org/repo', [1]);

      try {
        sm.transition('run-t4', RunState.PR_OPEN);
      } catch {
        // expected
      }

      const log = sm.getTransitionLog('run-t4');
      expect(log).toHaveLength(0);
    });

    it('throws for non-existent run', () => {
      expect(() => sm.transition('no-such-run', RunState.TRIAGING)).toThrow(
        "Run 'no-such-run' not found"
      );
    });
  });

  describe('transition logging', () => {
    it('logs each transition with run_id, from_state, to_state, and timestamp', () => {
      sm.createRun('run-log', 'org/repo', [3]);
      sm.transition('run-log', RunState.TRIAGING);
      sm.transition('run-log', RunState.FORKING);

      const log = sm.getTransitionLog('run-log');
      expect(log).toHaveLength(2);

      expect(log[0].run_id).toBe('run-log');
      expect(log[0].from_state).toBe(RunState.TRIGGERED);
      expect(log[0].to_state).toBe(RunState.TRIAGING);
      expect(log[0].timestamp).toBeDefined();

      expect(log[1].run_id).toBe('run-log');
      expect(log[1].from_state).toBe(RunState.TRIAGING);
      expect(log[1].to_state).toBe(RunState.FORKING);
      expect(log[1].timestamp).toBeDefined();
    });
  });

  describe('restart-resume', () => {
    it('in-flight runs are discoverable after creating a new StateMachine instance', () => {
      // Create runs in various states
      sm.createRun('run-inflight-1', 'org/repo', [1]);
      sm.transition('run-inflight-1', RunState.TRIAGING);

      sm.createRun('run-inflight-2', 'org/repo', [2]);
      sm.transition('run-inflight-2', RunState.TRIAGING);
      sm.transition('run-inflight-2', RunState.FORKING);
      sm.transition('run-inflight-2', RunState.AGENT_RUNNING);

      sm.createRun('run-done', 'org/repo', [3]);
      sm.transition('run-done', RunState.TRIAGING);
      sm.transition('run-done', RunState.FAILED);

      sm.createRun('run-skipped', 'org/repo', [4]);
      sm.transition('run-skipped', RunState.SKIPPED);

      // Close and reopen with a fresh instance
      sm.close();
      const sm2 = new StateMachine(dbPath);

      const inFlight = sm2.getInFlightRuns();
      const ids = inFlight.map((r) => r.id).sort();
      expect(ids).toEqual(['run-inflight-1', 'run-inflight-2']);

      // Verify states persisted correctly
      expect(sm2.getRun('run-inflight-1')!.state).toBe(RunState.TRIAGING);
      expect(sm2.getRun('run-inflight-2')!.state).toBe(RunState.AGENT_RUNNING);
      expect(sm2.getRun('run-done')!.state).toBe(RunState.FAILED);
      expect(sm2.getRun('run-skipped')!.state).toBe(RunState.SKIPPED);

      // Can continue transitions on the resumed runs
      sm2.transition('run-inflight-1', RunState.FORKING);
      expect(sm2.getRun('run-inflight-1')!.state).toBe(RunState.FORKING);

      sm2.close();
      // Reassign for cleanup in afterEach
      sm = new StateMachine(dbPath);
    });

    it('transition log persists across restarts', () => {
      sm.createRun('run-persist', 'org/repo', [5]);
      sm.transition('run-persist', RunState.TRIAGING);
      sm.transition('run-persist', RunState.PM_SCORING);

      sm.close();
      const sm2 = new StateMachine(dbPath);

      const log = sm2.getTransitionLog('run-persist');
      expect(log).toHaveLength(2);
      expect(log[0].from_state).toBe(RunState.TRIGGERED);
      expect(log[1].to_state).toBe(RunState.PM_SCORING);

      sm2.close();
      sm = new StateMachine(dbPath);
    });
  });

  describe('getRunsByState', () => {
    it('returns only runs in the requested state', () => {
      sm.createRun('r1', 'org/a', [1]);
      sm.createRun('r2', 'org/b', [2]);
      sm.createRun('r3', 'org/c', [3]);

      sm.transition('r1', RunState.TRIAGING);
      sm.transition('r2', RunState.TRIAGING);

      const triggered = sm.getRunsByState(RunState.TRIGGERED);
      expect(triggered).toHaveLength(1);
      expect(triggered[0].id).toBe('r3');

      const triaging = sm.getRunsByState(RunState.TRIAGING);
      expect(triaging).toHaveLength(2);
    });
  });

  describe('schema migrations', () => {
    it('applies migrations on first open and is idempotent on reopen', () => {
      sm.createRun('m1', 'org/repo', [1]);
      sm.close();

      // Reopen should not fail (migrations already applied)
      const sm2 = new StateMachine(dbPath);
      const run = sm2.getRun('m1');
      expect(run).not.toBeNull();
      expect(run!.state).toBe(RunState.TRIGGERED);
      sm2.close();

      sm = new StateMachine(dbPath);
    });
  });
});
