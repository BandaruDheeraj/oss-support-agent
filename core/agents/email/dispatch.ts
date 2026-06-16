/**
 * dispatchTypedHaltEmail — bridge between the typed-kind composer
 * (composeEmail) and the existing GmailFailureNotifier interface used by
 * the pipeline. Produces a structured EmailPayload via composeEmail, then
 * sends through the legacy notifier.sendEmail(to, subject, body, replyTo)
 * surface so callers don't need to know about EmailPayload directly.
 *
 * Designed for informational/halt emails (no inbound reply binding). For
 * approval flows that need a real InboxStore entry, build the context
 * with a stored inboxEntryId/nonce/replyTo from InboxStore.create.
 */

import { composeEmail, type EmailKind, type EmailPayload } from './composer';
import type { EmailContext } from './context';
import type { DossierSnapshot } from '../analyst/dossier';

export interface FailureNotifierLike {
  sendEmail(to: string, subject: string, body: string, replyTo: string): Promise<void>;
}

export interface DispatchOptions {
  kind: EmailKind;
  context: EmailContext;
  notifier: FailureNotifierLike;
  log?: (msg: string) => void;
  /**
   * Optional markdown appended after the composed body. Used to preserve
   * existing rich halt details (action instructions, links, env vars)
   * that don't yet map to typed context fields.
   */
  appendBody?: string;
}

export async function dispatchTypedHaltEmail(
  opts: DispatchOptions
): Promise<{ ok: boolean; payload: EmailPayload; error?: string }> {
  const composed = composeEmail({ kind: opts.kind, context: opts.context });
  const bodyMarkdown = opts.appendBody
    ? `${composed.bodyMarkdown}\n\n---\n\n${opts.appendBody}`
    : composed.bodyMarkdown;
  const payload: EmailPayload = { ...composed, bodyMarkdown };
  const to = payload.to[0] ?? opts.context.recipient;
  const replyTo = payload.replyTo ?? opts.context.replyTo;
  try {
    await opts.notifier.sendEmail(to, payload.subject, payload.bodyMarkdown, replyTo);
    opts.log?.(`[email] sent kind=${payload.kind} to=${to}`);
    return { ok: true, payload };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    opts.log?.(`[email] send failed kind=${payload.kind}: ${msg}`);
    return { ok: false, payload, error: msg };
  }
}

/**
 * buildSuccessContext — typed context for the `pr_opened` informational email.
 * Includes dossier + fix details so the recipient can see what was changed
 * and why without opening the PR.
 */
export function buildSuccessContext(args: {
  attemptId: string;
  recipient: string;
  issueNumber: number;
  issueUrl: string | null;
  prNumber: number;
  prUrl: string;
  summary?: string;
  fixApproach?: string;
  diffSummary?: string;
  changedFiles?: string[];
  testsRunOutside?: string[];
  failureSnippet?: string;
  reproTestPath?: string;
  reproTestUrl?: string | null;
  reproMethodNote?: string | null;
  arizeReproTraceUrl?: string | null;
  sandboxRunUrl?: string | null;
  localReproSnippet?: string | null;
  dossier?: DossierSnapshot | null;
}): EmailContext {
  return {
    to: [args.recipient],
    recipient: args.recipient,
    attemptId: args.attemptId,
    issueNumber: args.issueNumber,
    issueUrl: args.issueUrl,
    prNumber: args.prNumber,
    prUrl: args.prUrl,
    dossier: args.dossier ?? null,
    fixNotes: null,
    inboxEntryId: `${args.attemptId}-success`,
    nonce: '',
    replyTo: args.recipient,
    expectedActions: ['review PR', 'merge or request changes'],
    links: {
      arize: null,
      braintrust: null,
      pr: args.prUrl,
      issue: args.issueUrl,
    },
    context: {
      summary: args.summary,
      fixApproach: args.fixApproach,
      diffSummary: args.diffSummary,
      changedFiles: args.changedFiles,
      testsRunOutside: args.testsRunOutside,
      failureSnippet: args.failureSnippet,
      reproTestPath: args.reproTestPath,
      reproTestUrl: args.reproTestUrl ?? undefined,
      reproMethodNote: args.reproMethodNote ?? undefined,
      arizeReproTraceUrl: args.arizeReproTraceUrl ?? undefined,
      sandboxRunUrl: args.sandboxRunUrl ?? undefined,
      localReproSnippet: args.localReproSnippet ?? undefined,
    },
  };
}

/**
 * buildFixReadyContext — context for the `fix_ready_for_review` email.
 * Sent when the executor committed a fix to the branch but GHA sandbox
 * verification could not run (e.g. dispatch timeout). The recipient reviews
 * the diff and merges manually.
 */
export function buildFixReadyContext(args: {
  attemptId: string;
  recipient: string;
  issueNumber: number;
  issueUrl: string | null;
  branchUrl: string;
  commitSha: string;
  summary?: string;
  fixApproach?: string;
  changedFiles?: string[];
  diff?: string;
  reproTestPath?: string;
  reproTestUrl?: string | null;
  reproMethodNote?: string | null;
  dossier?: DossierSnapshot | null;
}): EmailContext {
  return {
    to: [args.recipient],
    recipient: args.recipient,
    attemptId: args.attemptId,
    issueNumber: args.issueNumber,
    issueUrl: args.issueUrl,
    prNumber: null,
    prUrl: null,
    dossier: args.dossier ?? null,
    fixNotes: null,
    inboxEntryId: `${args.attemptId}-fix-ready`,
    nonce: '',
    replyTo: args.recipient,
    expectedActions: ['review diff on branch', 'merge or request changes'],
    links: {
      arize: null,
      braintrust: null,
      pr: null,
      issue: args.issueUrl,
    },
    context: {
      summary: args.summary,
      fixApproach: args.fixApproach,
      changedFiles: args.changedFiles,
      diff: args.diff,
      branchUrl: args.branchUrl,
      commitSha: args.commitSha,
      reproTestPath: args.reproTestPath,
      reproTestUrl: args.reproTestUrl ?? undefined,
      reproMethodNote: args.reproMethodNote ?? undefined,
    },
  };
}

/**
 * buildHaltContext — minimal EmailContext for informational halt emails.
 * inboxEntryId/nonce are placeholders (no reply expected); callers wanting
 * real reply binding should build the context themselves after
 * InboxStore.create.
 */
export function buildHaltContext(args: {
  attemptId: string;
  recipient: string;
  issueNumber: number;
  issueUrl: string | null;
  prUrl?: string | null;
  failureSnippet?: string;
  summary?: string;
  missingCredential?: string;
  regressionStatus?: 'green' | 'red' | 'infra_error';
  failureKind?: string;
  changedFiles?: string[];
  fixApproach?: string;
  dossier?: DossierSnapshot | null;
}): EmailContext {
  return {
    to: [args.recipient],
    recipient: args.recipient,
    attemptId: args.attemptId,
    issueNumber: args.issueNumber,
    issueUrl: args.issueUrl,
    prNumber: null,
    prUrl: args.prUrl ?? null,
    dossier: args.dossier ?? null,
    fixNotes: null,
    inboxEntryId: `${args.attemptId}-halt`,
    nonce: '',
    replyTo: args.recipient,
    expectedActions: ['reply with guidance'],
    links: {
      arize: null,
      braintrust: null,
      pr: args.prUrl ?? null,
      issue: args.issueUrl,
    },
    context: {
      summary: args.summary,
      failureSnippet: args.failureSnippet,
      missingCredential: args.missingCredential,
      regressionStatus: args.regressionStatus,
      failureKind: args.failureKind,
      changedFiles: args.changedFiles,
      fixApproach: args.fixApproach,
    },
  };
}
