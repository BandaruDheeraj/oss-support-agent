/**
 * State stores backed by a pluggable StorageBackend.
 *
 * Pass a string rootDir to use file-backed storage (FileBackend).
 * Pass a StorageBackend from GistStateStore.namespace() to use gist-backed storage.
 */

import * as path from 'path';

import type { IntrospectionStateStore, IntrospectionEmailState } from '../../core/introspection-email-types';
import type { RetryStateStore, RetryHistory } from '../../core/retry-loop-types';
import type { EmailStateStore } from '../../core/pm-email-types';
import type { EmailThread, GmailReply } from '../../core/gmail-types';
import type { ReplyMailbox, PrReviewApprovalHook } from '../../core/introspection-email-loop';
import { FileBackend, type StorageBackend } from './gist-state-store';

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]+/g, '_');
}

abstract class BaseStore<T> {
  private readonly backend: StorageBackend;

  constructor(backendOrDir: StorageBackend | string) {
    this.backend = typeof backendOrDir === 'string' ? new FileBackend(backendOrDir) : backendOrDir;
  }

  protected save(key: string, value: T): void {
    this.backend.save(safeKey(key), value);
  }

  protected load(key: string): T | null {
    return this.backend.load<T>(safeKey(key));
  }

  protected remove(key: string): void {
    this.backend.remove(safeKey(key));
  }

  protected allEntries(): [string, T][] {
    return this.backend.entries() as [string, T][];
  }
}

export class FileIntrospectionStateStore
  extends BaseStore<IntrospectionEmailState>
  implements IntrospectionStateStore
{
  constructor(backendOrRootDir: StorageBackend | string) {
    super(typeof backendOrRootDir === 'string' ? path.join(backendOrRootDir, 'introspection') : backendOrRootDir);
  }
  saveState(repoFullName: string, state: IntrospectionEmailState): void {
    this.save(repoFullName, state);
  }
  loadState(repoFullName: string): IntrospectionEmailState | null {
    return this.load(repoFullName);
  }
  deleteState(repoFullName: string): void {
    this.remove(repoFullName);
  }
}

export class FileRetryStateStore extends BaseStore<RetryHistory> implements RetryStateStore {
  constructor(backendOrRootDir: StorageBackend | string) {
    super(typeof backendOrRootDir === 'string' ? path.join(backendOrRootDir, 'retry') : backendOrRootDir);
  }
  async saveRetryHistory(history: RetryHistory): Promise<void> {
    this.save(history.runId, history);
  }
  async loadRetryHistory(runId: string): Promise<RetryHistory | null> {
    return this.load(runId);
  }
  async deleteRetryHistory(runId: string): Promise<void> {
    this.remove(runId);
  }
}

interface PMEmailPayload {
  thread: EmailThread;
  resolvedDecisions: string[];
  unresolvedQuestions: string[];
}

export class FilePMEmailStateStore extends BaseStore<PMEmailPayload> implements EmailStateStore {
  constructor(backendOrRootDir: StorageBackend | string) {
    super(typeof backendOrRootDir === 'string' ? path.join(backendOrRootDir, 'pm-email') : backendOrRootDir);
  }
  saveThreadState(
    runId: string,
    thread: EmailThread,
    resolvedDecisions: string[],
    unresolvedQuestions: string[]
  ): void {
    this.save(runId, { thread, resolvedDecisions, unresolvedQuestions });
  }
  loadThreadState(runId: string): PMEmailPayload | null {
    return this.load(runId);
  }
  deleteThreadState(runId: string): void {
    this.remove(runId);
  }
}

export type PipelineRunStatus = 'running' | 'completed' | 'failed';

export interface PipelineRunRecord {
  key: string;
  repoFullName: string;
  issueNumber: number;
  status: PipelineRunStatus;
  action: string;
  labelName?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  instanceId?: string;
  result?: unknown;
  error?: string;
}

export interface PipelineRunAcquireResult {
  acquired: boolean;
  record: PipelineRunRecord;
  reason?: 'already-running';
}

export class FilePipelineRunStateStore extends BaseStore<PipelineRunRecord> {
  constructor(backendOrRootDir: StorageBackend | string) {
    super(
      typeof backendOrRootDir === 'string' ? path.join(backendOrRootDir, 'pipeline-runs') : backendOrRootDir,
    );
  }

  acquireRun(
    input: {
      key: string;
      repoFullName: string;
      issueNumber: number;
      action: string;
      labelName?: string;
      instanceId?: string;
    },
    opts: { staleAfterMs?: number; now?: Date } = {}
  ): PipelineRunAcquireResult {
    const staleAfterMs = opts.staleAfterMs ?? 6 * 60 * 60 * 1000;
    const now = opts.now ?? new Date();
    const existing = this.load(input.key);
    if (existing?.status === 'running') {
      // A run owned by a different instance is dead — the process was killed
      // by a deploy or restart. Release it immediately rather than waiting
      // for the stale TTL (which defaults to 6 hours).
      const sameInstance =
        !input.instanceId ||
        !existing.instanceId ||
        existing.instanceId === input.instanceId;
      const updatedAt = Date.parse(existing.updatedAt);
      const isFresh =
        sameInstance &&
        Number.isFinite(updatedAt) &&
        now.getTime() - updatedAt < staleAfterMs;
      if (isFresh) {
        return { acquired: false, record: existing, reason: 'already-running' };
      }
    }

    const ts = now.toISOString();
    const record: PipelineRunRecord = {
      key: input.key,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      status: 'running',
      action: input.action,
      ...(input.labelName ? { labelName: input.labelName } : {}),
      startedAt: ts,
      updatedAt: ts,
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
    };
    this.save(input.key, record);
    return { acquired: true, record };
  }

  completeRun(
    key: string,
    status: Exclude<PipelineRunStatus, 'running'>,
    details: { result?: unknown; error?: string; now?: Date } = {}
  ): PipelineRunRecord {
    const now = details.now ?? new Date();
    const existing = this.load(key);
    const ts = now.toISOString();
    const record: PipelineRunRecord = {
      ...(existing ?? {
        key,
        repoFullName: 'unknown',
        issueNumber: 0,
        action: 'unknown',
        startedAt: ts,
      }),
      status,
      updatedAt: ts,
      completedAt: ts,
      ...(details.result !== undefined ? { result: details.result } : {}),
      ...(details.error ? { error: details.error } : {}),
    };
    this.save(key, record);
    return record;
  }

  loadRun(key: string): PipelineRunRecord | null {
    return this.load(key);
  }

  /** Remove completed/failed runs older than maxAgeMs (default 30 days). */
  pruneOldRuns(maxAgeMs = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [key, record] of this.allEntries()) {
      if (record.status === 'running') continue;
      const ts = Date.parse(record.completedAt ?? record.updatedAt);
      if (Number.isFinite(ts) && ts < cutoff) {
        this.remove(key);
        pruned++;
      }
    }
    return pruned;
  }
}

/** Stores email replies that arrive when no active waiter exists, so they can be picked up after a restart. */
export class FileReplyMailbox
  extends BaseStore<{ reply: GmailReply; thread: EmailThread }>
  implements ReplyMailbox
{
  constructor(backendOrRootDir: StorageBackend | string) {
    super(
      typeof backendOrRootDir === 'string' ? path.join(backendOrRootDir, 'reply-mailbox') : backendOrRootDir,
    );
  }
  store(runId: string, reply: GmailReply, thread: EmailThread): void {
    this.save(runId, { reply, thread });
  }
  take(runId: string): { reply: GmailReply; thread: EmailThread } | null {
    const stored = this.load(runId);
    if (stored) this.remove(runId);
    return stored;
  }
}

interface PrReviewRunIdRecord {
  repoFullName: string;
  issueNumber: number;
  approvalKeywords: string[];
}

export interface PrReviewApprovalRecord {
  status: 'approved';
  approvedAt: string;
}

const PR_REVIEW_APPROVAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Persists pre-PR review approvals so re-triggered runs skip the email gate.
 *
 * Uses a single backend with two key prefixes:
 *   "approval:{safeKey(repo)}_{issue}" → PrReviewApprovalRecord
 *   "runid:{safeKey(prReviewRunId)}"   → PrReviewRunIdRecord (maps runId → issue)
 */
export class FilePrReviewApprovalStore implements PrReviewApprovalHook {
  private readonly backend: StorageBackend;

  constructor(backendOrRootDir: StorageBackend | string) {
    this.backend =
      typeof backendOrRootDir === 'string'
        ? new FileBackend(path.join(backendOrRootDir, 'pr-review'))
        : backendOrRootDir;
  }

  writePending(
    prReviewRunId: string,
    repoFullName: string,
    issueNumber: number,
    approvalKeywords: string[],
  ): void {
    this.backend.save(`runid_${safeKey(prReviewRunId)}`, {
      repoFullName,
      issueNumber,
      approvalKeywords,
    } satisfies PrReviewRunIdRecord);
  }

  writeApproval(repoFullName: string, issueNumber: number): void {
    this.backend.save(`approval_${safeKey(repoFullName)}_${issueNumber}`, {
      status: 'approved',
      approvedAt: new Date().toISOString(),
    } satisfies PrReviewApprovalRecord);
  }

  resolveByRunId(prReviewRunId: string, replyBody: string): void {
    const record = this.backend.load<PrReviewRunIdRecord>(`runid_${safeKey(prReviewRunId)}`);
    if (!record) return;
    const matched = record.approvalKeywords.some((kw) =>
      replyBody.toLowerCase().includes(kw.toLowerCase()),
    );
    if (!matched) return;
    this.writeApproval(record.repoFullName, record.issueNumber);
  }

  loadApproval(repoFullName: string, issueNumber: number): PrReviewApprovalRecord | null {
    const key = `approval_${safeKey(repoFullName)}_${issueNumber}`;
    const record = this.backend.load<PrReviewApprovalRecord>(key);
    if (!record) return null;
    if (Date.now() - Date.parse(record.approvedAt) > PR_REVIEW_APPROVAL_MAX_AGE_MS) {
      this.backend.remove(key);
      return null;
    }
    return record;
  }

  clearApproval(repoFullName: string, issueNumber: number): void {
    this.backend.remove(`approval_${safeKey(repoFullName)}_${issueNumber}`);
  }
}
