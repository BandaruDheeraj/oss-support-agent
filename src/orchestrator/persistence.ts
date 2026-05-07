import Database from 'better-sqlite3';
import { Run, RunState, TransitionLogEntry } from './types';

const CURRENT_SCHEMA_VERSION = 1;

interface RunRow {
  id: string;
  repo: string;
  issue_ids: string;
  state: RunState;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    repo: row.repo,
    issue_ids: JSON.parse(row.issue_ids),
    state: row.state,
    retry_count: row.retry_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const MIGRATIONS: Record<number, string[]> = {
  1: [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      issue_ids TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'TRIGGERED','TRIAGING','PM_SCORING','EMAIL_PENDING','SWEEP_PENDING',
        'FORKING','AGENT_RUNNING','SANDBOX_RUNNING','EVAL_RUNNING',
        'PR_OPEN','FAILED','SKIPPED'
      )),
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state)`,
    `CREATE TABLE IF NOT EXISTS transition_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_transition_log_run_id ON transition_log(run_id)`,
  ],
};

export class RunStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    // Ensure schema_migrations table exists for bootstrapping
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`
    );

    const currentVersion = this.db
      .prepare('SELECT MAX(version) as v FROM schema_migrations')
      .get() as { v: number | null };
    const appliedVersion = currentVersion?.v ?? 0;

    for (let v = appliedVersion + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
      const statements = MIGRATIONS[v];
      if (!statements) continue;

      const applyMigration = this.db.transaction(() => {
        for (const sql of statements) {
          this.db.exec(sql);
        }
        this.db
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(v, new Date().toISOString());
      });
      applyMigration();
    }
  }

  createRun(id: string, repo: string, issueIds: number[]): Run {
    const now = new Date().toISOString();
    const state = RunState.TRIGGERED;
    this.db
      .prepare(
        `INSERT INTO runs (id, repo, issue_ids, state, retry_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .run(id, repo, JSON.stringify(issueIds), state, now, now);

    return { id, repo, issue_ids: issueIds, state, retry_count: 0, created_at: now, updated_at: now };
  }

  getRun(id: string): Run | null {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE id = ?')
      .get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  getRunsByState(state: RunState): Run[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE state = ?')
      .all(state) as RunRow[];
    return rows.map((r) => rowToRun(r));
  }

  getInFlightRuns(): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE state NOT IN ('PR_OPEN', 'FAILED', 'SKIPPED')`
      )
      .all() as RunRow[];
    return rows.map((r) => rowToRun(r));
  }

  updateState(id: string, newState: RunState, now: string): void {
    this.db
      .prepare('UPDATE runs SET state = ?, updated_at = ? WHERE id = ?')
      .run(newState, now, id);
  }

  incrementRetryCount(id: string, now: string): void {
    this.db
      .prepare('UPDATE runs SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?')
      .run(now, id);
  }

  insertTransitionLog(runId: string, fromState: RunState, toState: RunState, timestamp: string): void {
    this.db
      .prepare(
        `INSERT INTO transition_log (run_id, from_state, to_state, timestamp)
         VALUES (?, ?, ?, ?)`
      )
      .run(runId, fromState, toState, timestamp);
  }

  getTransitionLog(runId: string): TransitionLogEntry[] {
    return this.db
      .prepare('SELECT * FROM transition_log WHERE run_id = ? ORDER BY id ASC')
      .all(runId) as TransitionLogEntry[];
  }

  /**
   * Execute a state update and log insertion atomically.
   */
  transitionAtomic(
    runId: string,
    fromState: RunState,
    toState: RunState,
    now: string,
    incrementRetry: boolean
  ): void {
    const txn = this.db.transaction(() => {
      if (incrementRetry) {
        this.db
          .prepare('UPDATE runs SET state = ?, retry_count = retry_count + 1, updated_at = ? WHERE id = ?')
          .run(toState, now, runId);
      } else {
        this.db
          .prepare('UPDATE runs SET state = ?, updated_at = ? WHERE id = ?')
          .run(toState, now, runId);
      }
      this.db
        .prepare(
          `INSERT INTO transition_log (run_id, from_state, to_state, timestamp)
           VALUES (?, ?, ?, ?)`
        )
        .run(runId, fromState, toState, now);
    });
    txn();
  }

  close(): void {
    this.db.close();
  }
}
