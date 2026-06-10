/**
 * Live dependency bundle for production server.
 *
 * Wires real GitHub REST + real Resend mail (send via API, inbound via
 * webhook with plus-addressed runId routing) + file-backed state stores
 * into the introspection-orchestration entrypoint and the runPipeline call.
 *
 * Returns null if required Resend env vars are not present, so the server
 * can still serve the skip-PM-gate path without mail (with degraded
 * features).
 */

import * as path from 'path';

import { ChatClient } from '../../core/llm/v2/chat-client';
import {
  GmailWatcher,
} from '../../core/gmail-mcp';
import {
  DEFAULT_POLL_INTERVAL_MS,
  SUBJECT_PREFIX,
} from '../../core/gmail-types';
import { IntrospectionReplyWaiter } from '../../core/introspection-email-loop';
import {
  runIntrospection as coreRunIntrospection,
  type RunIntrospectionResult,
  type RunIntrospectionOptions,
} from '../../core/agents/introspection-orchestration';
import { formatPlusReplyTo } from '../../core/resend-mail';

import { buildResendDepsFromEnv, type ResendDeps } from './resend-real';
import { type GistStateStore } from './gist-state-store';
import { GitHubLabelClient } from './github-rest';
import {
  FileIntrospectionStateStore,
  FileRetryStateStore,
  FilePMEmailStateStore,
  FileReplyMailbox,
  FilePrReviewApprovalStore,
  type PrReviewApprovalRecord,
} from './state-stores';
import {
  GitHubIssueSearcher,
  GitHubPRFetcher,
  GitHubDesignDocFinder,
  GitHubIssueLabeler,
  GmailFailureNotifier,
} from './pm-deps';
import { GitHubCodeBrowser } from './github-code-browser';
import { OpenRouterDocsGenerator } from './openrouter-docs-generator';

export interface LiveDeps {
  /** Mail client. Named `gmail` for backward compat with consumers typed against GmailClient. */
  gmail: ResendDeps['client'];
  /** Watcher exists for type compat with sendAndTrack/registerThread; never started (push-based inbound). */
  watcher: GmailWatcher;
  /**
   * Single reply waiter shared by introspection AND pm-email loops.
   * Keyed by runId — repoFullName for introspection, run-specific id for PM email.
   * Inbound webhook deliveries fan into this via dispatchInbound().
   */
  replyWaiter: IntrospectionReplyWaiter;
  introspectionStateStore: FileIntrospectionStateStore;
  retryStateStore: FileRetryStateStore;
  pmEmailStateStore: FilePMEmailStateStore;
  prReviewApprovalStore?: FilePrReviewApprovalStore;
  labelClient: GitHubLabelClient;
  issueSearcher: GitHubIssueSearcher;
  prFetcher: GitHubPRFetcher;
  designDocFinder: GitHubDesignDocFinder;
  codeBrowser: GitHubCodeBrowser;
  failureNotifier: GmailFailureNotifier;
  issueLabeler: GitHubIssueLabeler;
  docsGenerator: OpenRouterDocsGenerator;
  llm: ChatClient;
  /** From: address on outbound mail. */
  monitoredEmail: string;
  /** Base reply-to address (no plus tag); use replyToFor(runId) for the per-run address. */
  replyToBase: string;
  /** Build a per-runId reply-to using plus-addressing. */
  replyToFor: (runId: string) => string;
  /**
   * Simple one-shot mail sender. Useful for lightweight notification emails
   * that don't require a reply-waiter gate (e.g. pre-PR simple notifications).
   */
  sendMail: (args: { to: string; subject: string; body: string }) => Promise<void>;
  /** HTTP /inbound dispatcher: caller passes raw body + svix headers. */
  dispatchInbound: (
    rawBody: string,
    headers: { 'svix-id'?: string; 'svix-timestamp'?: string; 'svix-signature'?: string }
  ) => Promise<{ status: number; body: any }>;
  /**
   * Closure compatible with adapter-loader's RunIntrospectionLike signature.
   * Performs the full live introspection flow (mail-driven approval).
   */
  runIntrospection: (
    repo: string,
    pmEmail: string,
    forkOrg: string,
    opts?: { repoRoot?: string }
  ) => Promise<RunIntrospectionResult>;
}

export interface BuildLiveDepsOptions {
  token: string;
  stateRoot: string;
  /** When set, all state stores use gist-backed storage instead of the local filesystem. */
  gistStore?: GistStateStore;
  log: (msg: string) => void;
  /** Repo root used to write configs/<org>/<repo>/. Defaults to process.cwd(). */
  repoRoot?: string;
  /** Override poll interval (legacy; never used since we don't poll). */
  pollIntervalMs?: number;
}

/**
 * Build the live dependency bundle.
 *
 * Returns null if Resend env vars are missing — caller should treat that as
 * "mail-dependent flows disabled" (skip-PM-gate path still works).
 */
export function buildLiveDeps(
  env: NodeJS.ProcessEnv,
  options: BuildLiveDepsOptions
): LiveDeps | null {
  const built = buildResendDepsFromEnv(env, options.log);
  if (!built) return null;
  const resendDeps = built.deps;

  const monitoredEmail = resendDeps.fromAddress;
  const replyToBase = resendDeps.replyToBase;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const stateRoot = options.stateRoot;
  const g = options.gistStore;
  const replyMailbox = new FileReplyMailbox(g ? g.namespace('reply-mailbox') : stateRoot);
  const prReviewApprovalStore = new FilePrReviewApprovalStore(g ? g.namespace('pr-review') : stateRoot);
  const replyWaiter = new IntrospectionReplyWaiter(replyMailbox, prReviewApprovalStore);
  // Watcher is constructed for type/back-compat (sendAndTrack calls registerThread)
  // but never started — inbound is push-based via webhook.
  const watcher = new GmailWatcher(
    resendDeps.client,
    {
      pollIntervalMs,
      subjectPrefix: SUBJECT_PREFIX,
      monitoredAddress: monitoredEmail,
    },
    replyWaiter
  );

  const introspectionStateStore = new FileIntrospectionStateStore(g ? g.namespace('introspection') : stateRoot);
  const retryStateStore = new FileRetryStateStore(g ? g.namespace('retry') : stateRoot);
  const pmEmailStateStore = new FilePMEmailStateStore(g ? g.namespace('pm-email') : stateRoot);

  const labelClient = new GitHubLabelClient(options.token);
  const issueSearcher = new GitHubIssueSearcher(options.token);
  const prFetcher = new GitHubPRFetcher(options.token);
  const designDocFinder = new GitHubDesignDocFinder(options.token);
  const codeBrowser = new GitHubCodeBrowser(options.token);
  const failureNotifier = new GmailFailureNotifier(resendDeps.client);
  const issueLabeler = new GitHubIssueLabeler(options.token);
  const docsGenerator = new OpenRouterDocsGenerator();
  const llm = new ChatClient();

  const repoRoot = options.repoRoot ?? process.cwd();

  const replyToFor = (runId: string) => formatPlusReplyTo(replyToBase, runId);

  const runIntrospection: LiveDeps['runIntrospection'] = async (
    repo,
    pmEmail,
    forkOrg,
    opts
  ) => {
    const introspectionOptions: RunIntrospectionOptions = {
      repoRoot: opts?.repoRoot ?? repoRoot,
      // runId for introspection IS the repo full-name; encode it into reply-to
      replyToAddress: replyToFor(repo),
      deps: {
        gmailClient: resendDeps.client,
        watcher,
        stateStore: introspectionStateStore,
        replyWaiter,
        llm,
        labelClient,
      },
      logger: {
        info: (m, f) => options.log(`[introspection] ${m} ${f ? JSON.stringify(f) : ''}`),
        warn: (m, f) => options.log(`[introspection][warn] ${m} ${f ? JSON.stringify(f) : ''}`),
        error: (m, f) => options.log(`[introspection][error] ${m} ${f ? JSON.stringify(f) : ''}`),
      },
    };
    return coreRunIntrospection(repo, pmEmail, forkOrg, introspectionOptions);
  };

  const dispatchInbound: LiveDeps['dispatchInbound'] = (rawBody, headers) =>
    resendDeps.dispatchInbound(rawBody, headers, replyWaiter, options.log);

  const sendMail: LiveDeps['sendMail'] = async ({ to, subject, body }) => {
    await resendDeps.client.sendEmail({ to, subject, body, replyTo: replyToBase });
  };

  return {
    gmail: resendDeps.client,
    watcher,
    replyWaiter,
    introspectionStateStore,
    retryStateStore,
    pmEmailStateStore,
    prReviewApprovalStore,
    labelClient,
    issueSearcher,
    prFetcher,
    designDocFinder,
    codeBrowser,
    failureNotifier,
    issueLabeler,
    docsGenerator,
    llm,
    monitoredEmail,
    replyToBase,
    replyToFor,
    sendMail,
    dispatchInbound,
    runIntrospection,
  };
}

export function defaultStateRoot(): string {
  return path.join(process.cwd(), 'data', 'state');
}
