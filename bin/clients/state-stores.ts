/**
 * File-backed state stores. Persistence survives server restarts.
 * Stored as JSON files under data/state/<kind>/<key>.json.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { IntrospectionStateStore, IntrospectionEmailState } from '../../core/introspection-email-types';
import type { RetryStateStore, RetryHistory } from '../../core/retry-loop-types';
import type { EmailStateStore } from '../../core/pm-email-types';
import type { EmailThread } from '../../core/gmail-types';

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]+/g, '_');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

abstract class FileStore<T> {
  constructor(private readonly dir: string) {
    ensureDir(dir);
  }
  protected file(key: string): string {
    return path.join(this.dir, `${safeKey(key)}.json`);
  }
  protected save(key: string, value: T): void {
    fs.writeFileSync(this.file(key), JSON.stringify(value, null, 2), 'utf-8');
  }
  protected load(key: string): T | null {
    const f = this.file(key);
    if (!fs.existsSync(f)) return null;
    try {
      return JSON.parse(fs.readFileSync(f, 'utf-8')) as T;
    } catch {
      return null;
    }
  }
  protected remove(key: string): void {
    const f = this.file(key);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

export class FileIntrospectionStateStore
  extends FileStore<IntrospectionEmailState>
  implements IntrospectionStateStore
{
  constructor(rootDir: string) {
    super(path.join(rootDir, 'introspection'));
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

export class FileRetryStateStore
  extends FileStore<RetryHistory>
  implements RetryStateStore
{
  constructor(rootDir: string) {
    super(path.join(rootDir, 'retry'));
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

export class FilePMEmailStateStore
  extends FileStore<PMEmailPayload>
  implements EmailStateStore
{
  constructor(rootDir: string) {
    super(path.join(rootDir, 'pm-email'));
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

export class FilePipelineRunStateStore extends FileStore<PipelineRunRecord> {
  constructor(rootDir: string) {
    super(path.join(rootDir, 'pipeline-runs'));
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
      const updatedAt = Date.parse(existing.updatedAt);
      const isFresh =
        Number.isFinite(updatedAt) && now.getTime() - updatedAt < staleAfterMs;
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
}
