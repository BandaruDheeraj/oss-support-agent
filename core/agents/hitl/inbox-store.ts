/**
 * HITL inbox state machine. SQLite-backed via better-sqlite3 in production;
 * the same shape works in-memory for tests.
 *
 * Status transitions are compare-and-swap. `inbound_message_id` UNIQUE
 * prevents double-processing of webhook replays.
 */

import Database from 'better-sqlite3';

export type InboxStatus =
  | 'sent'
  | 'reply_received'
  | 'mapped'
  | 'needs_clarification'
  | 'resumed'
  | 'superseded'
  | 'expired';

export type InboxKind =
  | 'triage_unrelated'
  | 'need_credentials'
  | 'repro_unreachable'
  | 'fix_proposal'
  | 'fix_failed'
  | 'regression_blocker'
  | 'human_decision_needed'
  | 'pr_opened';

export interface InboxEntry {
  id: string;
  inbound_message_id: string | null;
  attempt_id: string;
  dossier_snapshot_id: string | null;
  kind: InboxKind;
  nonce: string;
  expected_actions: string;       // JSON-stringified string[]
  status: InboxStatus;
  mapping_confidence: number | null;
  raw_reply: string | null;
  stripped_reply: string | null;
  mapped_action: string | null;
  mapping_error: string | null;
  sent_at: string;
  reply_received_at: string | null;
  mapped_at: string | null;
  resumed_at: string | null;
  superseded_at: string | null;
  expires_at: string;
}

export class InboxStore {
  private readonly db: Database.Database;

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_entries (
        id TEXT PRIMARY KEY,
        inbound_message_id TEXT UNIQUE,
        attempt_id TEXT NOT NULL,
        dossier_snapshot_id TEXT,
        kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        expected_actions TEXT NOT NULL,
        status TEXT NOT NULL,
        mapping_confidence REAL,
        raw_reply TEXT,
        stripped_reply TEXT,
        mapped_action TEXT,
        mapping_error TEXT,
        sent_at TEXT NOT NULL,
        reply_received_at TEXT,
        mapped_at TEXT,
        resumed_at TEXT,
        superseded_at TEXT,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_attempt ON inbox_entries(attempt_id);
      CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_entries(status);
      CREATE INDEX IF NOT EXISTS idx_inbox_expires ON inbox_entries(expires_at);

      CREATE TABLE IF NOT EXISTS consumed_tokens (
        token_id TEXT PRIMARY KEY,
        consumed_at TEXT NOT NULL,
        inbox_entry_id TEXT NOT NULL,
        action TEXT NOT NULL,
        recipient TEXT NOT NULL
      );
    `);
  }

  create(entry: Omit<InboxEntry, 'status' | 'sent_at' | 'reply_received_at' | 'mapped_at' | 'resumed_at' | 'superseded_at' | 'mapping_confidence' | 'raw_reply' | 'stripped_reply' | 'mapped_action' | 'mapping_error'> & { sent_at?: string }): InboxEntry {
    const sentAt = entry.sent_at ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO inbox_entries (id, inbound_message_id, attempt_id, dossier_snapshot_id, kind, nonce, expected_actions, status, sent_at, expires_at)
         VALUES (@id, @inbound_message_id, @attempt_id, @dossier_snapshot_id, @kind, @nonce, @expected_actions, 'sent', @sent_at, @expires_at)`
      )
      .run({
        id: entry.id,
        inbound_message_id: entry.inbound_message_id,
        attempt_id: entry.attempt_id,
        dossier_snapshot_id: entry.dossier_snapshot_id,
        kind: entry.kind,
        nonce: entry.nonce,
        expected_actions: entry.expected_actions,
        sent_at: sentAt,
        expires_at: entry.expires_at,
      });
    return this.get(entry.id)!;
  }

  get(id: string): InboxEntry | null {
    const row = this.db.prepare(`SELECT * FROM inbox_entries WHERE id = ?`).get(id) as InboxEntry | undefined;
    return row ?? null;
  }

  byInboundMessageId(id: string): InboxEntry | null {
    return (this.db.prepare(`SELECT * FROM inbox_entries WHERE inbound_message_id = ?`).get(id) as InboxEntry | undefined) ?? null;
  }

  pending(): InboxEntry[] {
    return this.db
      .prepare(`SELECT * FROM inbox_entries WHERE status IN ('sent','reply_received','needs_clarification') ORDER BY sent_at ASC`)
      .all() as InboxEntry[];
  }

  /** CAS update: only succeeds if current status matches `from`. Returns true on success. */
  transition(id: string, from: InboxStatus, to: InboxStatus, extras: Partial<InboxEntry> = {}): boolean {
    const now = new Date().toISOString();
    const setClauses: string[] = ['status = @to'];
    const params: Record<string, unknown> = { id, from, to };
    for (const [k, v] of Object.entries(extras)) {
      setClauses.push(`${k} = @${k}`);
      params[k] = v;
    }
    if (to === 'reply_received' && !('reply_received_at' in extras)) {
      setClauses.push('reply_received_at = @reply_received_at');
      params.reply_received_at = now;
    }
    if (to === 'mapped' && !('mapped_at' in extras)) {
      setClauses.push('mapped_at = @mapped_at');
      params.mapped_at = now;
    }
    if (to === 'resumed' && !('resumed_at' in extras)) {
      setClauses.push('resumed_at = @resumed_at');
      params.resumed_at = now;
    }
    if (to === 'superseded' && !('superseded_at' in extras)) {
      setClauses.push('superseded_at = @superseded_at');
      params.superseded_at = now;
    }
    const result = this.db
      .prepare(`UPDATE inbox_entries SET ${setClauses.join(', ')} WHERE id = @id AND status = @from`)
      .run(params);
    return result.changes > 0;
  }

  /** Mark older sibling entries for the same attempt superseded when a new decision-point is sent. */
  supersedeOpenForAttempt(attemptId: string, exceptId: string): number {
    const result = this.db
      .prepare(
        `UPDATE inbox_entries SET status='superseded', superseded_at=? WHERE attempt_id=? AND id != ? AND status IN ('sent','reply_received','needs_clarification')`
      )
      .run(new Date().toISOString(), attemptId, exceptId);
    return result.changes;
  }

  /** Sweep entries past expiry. Returns the rows that just expired. */
  expireDue(now: Date = new Date()): InboxEntry[] {
    const due = this.db
      .prepare(
        `SELECT * FROM inbox_entries WHERE status IN ('sent','reply_received','needs_clarification') AND expires_at <= ?`
      )
      .all(now.toISOString()) as InboxEntry[];
    if (due.length === 0) return [];
    const ids = due.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(`UPDATE inbox_entries SET status='expired' WHERE id IN (${placeholders})`)
      .run(...ids);
    return due;
  }

  isTokenConsumed(tokenId: string): boolean {
    const row = this.db.prepare(`SELECT token_id FROM consumed_tokens WHERE token_id = ?`).get(tokenId);
    return !!row;
  }

  consumeToken(tokenId: string, inboxEntryId: string, action: string, recipient: string): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO consumed_tokens (token_id, consumed_at, inbox_entry_id, action, recipient) VALUES (?, ?, ?, ?, ?)`
        )
        .run(tokenId, new Date().toISOString(), inboxEntryId, action, recipient);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }
}
