/**
 * Live dependency bundle for production server.
 *
 * Wires real GitHub REST + real Gmail OAuth + file-backed state stores into
 * the introspection-orchestration entrypoint and the runPipeline call.
 *
 * Returns null if required Gmail env vars are not present, so the server can
 * still serve the skip-PM-gate path without Gmail (with degraded features).
 */

import * as path from 'path';

import { LLMClient } from '../../core/llm/client';
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

import { buildGmailClientFromEnv, RealGmailClient } from './gmail-real';
import { GitHubLabelClient } from './github-rest';
import {
  FileIntrospectionStateStore,
  FileRetryStateStore,
  FilePMEmailStateStore,
} from './state-stores';
import {
  GitHubIssueSearcher,
  GitHubPRFetcher,
  GitHubDesignDocFinder,
  GitHubIssueLabeler,
  GmailFailureNotifier,
} from './pm-deps';
import { OpenRouterDocsGenerator } from './openrouter-docs-generator';

export interface LiveDeps {
  gmail: RealGmailClient;
  watcher: GmailWatcher;
  /**
   * Single reply waiter shared by introspection AND pm-email loops.
   * Keyed by runId — repoFullName for introspection, run-specific id for PM email.
   */
  replyWaiter: IntrospectionReplyWaiter;
  introspectionStateStore: FileIntrospectionStateStore;
  retryStateStore: FileRetryStateStore;
  pmEmailStateStore: FilePMEmailStateStore;
  labelClient: GitHubLabelClient;
  issueSearcher: GitHubIssueSearcher;
  prFetcher: GitHubPRFetcher;
  designDocFinder: GitHubDesignDocFinder;
  failureNotifier: GmailFailureNotifier;
  issueLabeler: GitHubIssueLabeler;
  docsGenerator: OpenRouterDocsGenerator;
  llm: LLMClient;
  monitoredEmail: string;
  replyToAddress: string;
  /**
   * Closure compatible with adapter-loader's RunIntrospectionLike signature.
   * Performs the full live introspection flow (Gmail-driven approval).
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
  log: (msg: string) => void;
  /** Repo root used to write configs/<org>/<repo>/. Defaults to process.cwd(). */
  repoRoot?: string;
  /** Override poll interval for tests. */
  pollIntervalMs?: number;
}

/**
 * Build the live dependency bundle.
 *
 * Returns null if Gmail OAuth env vars are missing — caller should treat
 * that as "Gmail-dependent flows disabled".
 */
export function buildLiveDeps(
  env: NodeJS.ProcessEnv,
  options: BuildLiveDepsOptions
): LiveDeps | null {
  const gmail = buildGmailClientFromEnv(env);
  if (!gmail) {
    options.log(
      '[live-deps] Gmail env vars missing (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN/USER_EMAIL); Gmail-dependent flows disabled'
    );
    return null;
  }

  const monitoredEmail = env.GMAIL_USER_EMAIL!;
  const replyToAddress = env.REPLY_TO_ADDRESS ?? monitoredEmail;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const replyWaiter = new IntrospectionReplyWaiter();
  const watcher = new GmailWatcher(
    gmail,
    {
      pollIntervalMs,
      subjectPrefix: SUBJECT_PREFIX,
      monitoredAddress: monitoredEmail,
    },
    replyWaiter
  );

  const stateRoot = options.stateRoot;
  const introspectionStateStore = new FileIntrospectionStateStore(stateRoot);
  const retryStateStore = new FileRetryStateStore(stateRoot);
  const pmEmailStateStore = new FilePMEmailStateStore(stateRoot);

  const labelClient = new GitHubLabelClient(options.token);
  const issueSearcher = new GitHubIssueSearcher(options.token);
  const prFetcher = new GitHubPRFetcher(options.token);
  const designDocFinder = new GitHubDesignDocFinder(options.token);
  const failureNotifier = new GmailFailureNotifier(gmail);
  const issueLabeler = new GitHubIssueLabeler(options.token);
  const docsGenerator = new OpenRouterDocsGenerator();
  const llm = new LLMClient();

  const repoRoot = options.repoRoot ?? process.cwd();

  const runIntrospection: LiveDeps['runIntrospection'] = async (
    repo,
    pmEmail,
    forkOrg,
    opts
  ) => {
    const introspectionOptions: RunIntrospectionOptions = {
      repoRoot: opts?.repoRoot ?? repoRoot,
      replyToAddress,
      deps: {
        gmailClient: gmail,
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

  return {
    gmail,
    watcher,
    replyWaiter,
    introspectionStateStore,
    retryStateStore,
    pmEmailStateStore,
    labelClient,
    issueSearcher,
    prFetcher,
    designDocFinder,
    failureNotifier,
    issueLabeler,
    docsGenerator,
    llm,
    monitoredEmail,
    replyToAddress,
    runIntrospection,
  };
}

export function defaultStateRoot(): string {
  return path.join(process.cwd(), 'data', 'state');
}
