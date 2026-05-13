/**
 * Retry-dossier carryforward: persist the latest dossier snapshot id +
 * transcript summary + last disposition keyed by (issue_number, attempt_id)
 * so the next outer retry can reload them and pass them into Analyst as
 * prior evidence rather than treating the next attempt as a fresh issue.
 */

import Database from 'better-sqlite3';

export interface CarryforwardRow {
  issue_number: number;
  attempt_id: string;
  dossier_snapshot_id: string | null;
  notes_id: string | null;
  transcript_summary: string;
  last_disposition: string;
  updated_at: string;
}

export class CarryforwardStore {
  private readonly db: Database.Database;
  constructor(filePath = '.osa-carry.sqlite') {
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS carryforward (
        issue_number INTEGER NOT NULL,
        attempt_id TEXT NOT NULL,
        dossier_snapshot_id TEXT,
        notes_id TEXT,
        transcript_summary TEXT NOT NULL,
        last_disposition TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (issue_number, attempt_id)
      );
      CREATE INDEX IF NOT EXISTS idx_carry_issue ON carryforward(issue_number);
    `);
  }

  upsert(row: Omit<CarryforwardRow, 'updated_at'>): void {
    this.db
      .prepare(
        `INSERT INTO carryforward (issue_number, attempt_id, dossier_snapshot_id, notes_id, transcript_summary, last_disposition, updated_at)
         VALUES (@issue_number, @attempt_id, @dossier_snapshot_id, @notes_id, @transcript_summary, @last_disposition, @updated_at)
         ON CONFLICT(issue_number, attempt_id) DO UPDATE SET
           dossier_snapshot_id = excluded.dossier_snapshot_id,
           notes_id = excluded.notes_id,
           transcript_summary = excluded.transcript_summary,
           last_disposition = excluded.last_disposition,
           updated_at = excluded.updated_at`
      )
      .run({ ...row, updated_at: new Date().toISOString() });
  }

  /** Get the most recent prior attempt for an issue (excluding the provided attempt id). */
  priorForIssue(issueNumber: number, excludeAttemptId: string): CarryforwardRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM carryforward WHERE issue_number = ? AND attempt_id != ? ORDER BY updated_at DESC LIMIT 1`
        )
        .get(issueNumber, excludeAttemptId) as CarryforwardRow | undefined) ?? null
    );
  }

  close(): void {
    this.db.close();
  }
}
