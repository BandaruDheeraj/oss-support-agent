/**
 * Eval recorder — one row per pipeline run summarising the outcome.
 *
 * Backend selected by env:
 *   OSA_EVAL_BACKEND=sqlite (default) | jsonl | noop
 *   OSA_EVAL_PATH=./osa-evals.sqlite or ./osa-evals.jsonl
 *
 * Shadow-mode comparison joins on (issue_number, attempt_id) with mode IN ('loop','oneshot').
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface EvalRow {
  ts: string;
  issue_number: number;
  attempt_id: string;
  mode: 'loop' | 'oneshot' | 'shadow_loop';
  agent: 'repro' | 'fix' | 'pipeline';
  repro_passed: boolean | null;
  fix_passed: boolean | null;
  regression_passed: boolean | null;
  tool_call_counts: Record<string, number>;
  total_cost_usd: number | null;
  final_disposition: string;
  dossier_snapshot_id: string | null;
  notes_id: string | null;
  trace_id: string | null;
  error_kind: string | null;
}

export interface EvalRecorder {
  record(row: Omit<EvalRow, 'ts'>): void;
  close(): void;
}

class NoopRecorder implements EvalRecorder {
  record(): void {}
  close(): void {}
}

class JsonlRecorder implements EvalRecorder {
  private fd: number;
  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    this.fd = fs.openSync(filePath, 'a');
  }
  record(row: Omit<EvalRow, 'ts'>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n';
    fs.writeSync(this.fd, line);
  }
  close(): void {
    try { fs.closeSync(this.fd); } catch {}
  }
}

class SqliteRecorder implements EvalRecorder {
  private readonly db: Database.Database;
  private readonly stmt: Database.Statement;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evals (
        ts TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        attempt_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        agent TEXT NOT NULL,
        repro_passed INTEGER,
        fix_passed INTEGER,
        regression_passed INTEGER,
        tool_call_counts TEXT NOT NULL,
        total_cost_usd REAL,
        final_disposition TEXT NOT NULL,
        dossier_snapshot_id TEXT,
        notes_id TEXT,
        trace_id TEXT,
        error_kind TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evals_attempt ON evals(issue_number, attempt_id);
      CREATE INDEX IF NOT EXISTS idx_evals_mode ON evals(mode);
    `);
    this.stmt = this.db.prepare(
      `INSERT INTO evals (ts, issue_number, attempt_id, mode, agent, repro_passed, fix_passed, regression_passed, tool_call_counts, total_cost_usd, final_disposition, dossier_snapshot_id, notes_id, trace_id, error_kind)
       VALUES (@ts, @issue_number, @attempt_id, @mode, @agent, @repro_passed, @fix_passed, @regression_passed, @tool_call_counts, @total_cost_usd, @final_disposition, @dossier_snapshot_id, @notes_id, @trace_id, @error_kind)`
    );
  }

  record(row: Omit<EvalRow, 'ts'>): void {
    this.stmt.run({
      ts: new Date().toISOString(),
      issue_number: row.issue_number,
      attempt_id: row.attempt_id,
      mode: row.mode,
      agent: row.agent,
      repro_passed: row.repro_passed === null ? null : row.repro_passed ? 1 : 0,
      fix_passed: row.fix_passed === null ? null : row.fix_passed ? 1 : 0,
      regression_passed: row.regression_passed === null ? null : row.regression_passed ? 1 : 0,
      tool_call_counts: JSON.stringify(row.tool_call_counts ?? {}),
      total_cost_usd: row.total_cost_usd,
      final_disposition: row.final_disposition,
      dossier_snapshot_id: row.dossier_snapshot_id,
      notes_id: row.notes_id,
      trace_id: row.trace_id,
      error_kind: row.error_kind,
    });
  }

  close(): void {
    this.db.close();
  }
}

let singleton: EvalRecorder | null = null;
export function getEvalRecorder(): EvalRecorder {
  if (singleton) return singleton;
  const backend = (process.env.OSA_EVAL_BACKEND || 'sqlite').toLowerCase();
  if (backend === 'noop') {
    singleton = new NoopRecorder();
  } else if (backend === 'jsonl') {
    singleton = new JsonlRecorder(process.env.OSA_EVAL_PATH || '.osa-evals.jsonl');
  } else {
    singleton = new SqliteRecorder(process.env.OSA_EVAL_PATH || '.osa-evals.sqlite');
  }
  return singleton;
}

export function _resetEvalRecorder(): void {
  if (singleton) singleton.close();
  singleton = null;
}
