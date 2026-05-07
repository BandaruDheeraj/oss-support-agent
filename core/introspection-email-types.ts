/**
 * Types for the introspection email review loop (US-106).
 *
 * This loop sends the generated manifest.yaml + adapter.ts to the PM for approval.
 * On reply:
 *  - If approved (keyword, ignoring quoted text) -> loop ends.
 *  - Otherwise -> revise the draft via the shared LLMClient and send an updated email.
 */

import type { DraftAdapter, RepoSignals } from './agents/introspection-types';
import type { EmailThread, GmailClient, ApprovalDetectionResult } from './gmail-types';

export interface IntrospectionEmailLoopConfig {
  /** Recipient email (pm_email from manifest) */
  pmEmail: string;
  /** Reply-to address for the orchestrator */
  replyToAddress: string;
  /** Repo full name (owner/repo) */
  repoFullName: string;
  /** Approval keywords from the manifest */
  approvalKeywords: string[];
  /** Maximum number of revision iterations before failing (default 10) */
  maxIterations?: number;
  /** Optional existing Gmail thread ID to reuse for this repo's introspection */
  existingThreadId?: string;
}

export interface IntrospectionEmailState {
  repoFullName: string;
  thread: EmailThread;
  draft: DraftAdapter;
  /** Number of non-approval revisions performed so far. */
  iteration: number;
}

export type IntrospectionEmailLoopResult =
  | { action: 'email_sent'; thread: EmailThread; iteration: number }
  | { action: 'revised'; thread: EmailThread; iteration: number; draft: DraftAdapter }
  | { action: 'approved'; thread: EmailThread; iteration: number; approvalResult: ApprovalDetectionResult; finalDraft: DraftAdapter };

export interface IntrospectionStateStore {
  saveState(repoFullName: string, state: IntrospectionEmailState): void;
  loadState(repoFullName: string): IntrospectionEmailState | null;
  deleteState(repoFullName: string): void;
}

export interface DraftReviser {
  reviseDraft(current: DraftAdapter, replyBody: string, signals: RepoSignals): Promise<DraftAdapter>;
}

export class IntrospectionEmailLoopError extends Error {
  public readonly phase: string;
  public readonly repoFullName: string;

  constructor(message: string, phase: string, repoFullName: string) {
    super(message);
    this.name = 'IntrospectionEmailLoopError';
    this.phase = phase;
    this.repoFullName = repoFullName;
  }
}

export interface IntrospectionEmailDependencies {
  gmailClient: GmailClient;
}
