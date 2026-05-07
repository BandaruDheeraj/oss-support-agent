/**
 * Introspection orchestration + activation (US-107).
 *
 * Runs the full approved-adapter activation flow and enforces per-repo serialization
 * so concurrent issue events for the same repo queue rather than run in parallel.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import type { DraftAdapter, RepoSignals } from './introspection-types';
import { gatherRepoSignals, generateDraftAdapter } from './introspection';

import type { LLMClientLike } from '../llm/test-utils';

import type {
  IntrospectionEmailLoopConfig,
  IntrospectionStateStore,
} from '../introspection-email-types';

import {
  sendIntrospectionEmail,
  processIntrospectionReply,
  IntrospectionReplyWaiter,
} from '../introspection-email-loop';

import { sendEmail } from '../gmail-mcp';
import type { GmailClient, EmailThread, GmailReply } from '../gmail-types';

export const REQUIRED_REPO_LABELS = ['agent-fix', 'trivial-fix', 'agent-failed', 'needs-design'] as const;
export type RequiredRepoLabel = (typeof REQUIRED_REPO_LABELS)[number];

export interface RepoLabelClient {
  getLabel(repoFullName: string, name: string): Promise<{ name: string } | null>;
  createLabel(
    repoFullName: string,
    label: { name: string; color?: string; description?: string }
  ): Promise<void>;
}

export interface IntrospectionEventQueue {
  enqueue(event: unknown): void;
}

export interface ActivationLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const consoleLogger: ActivationLogger = {
  info: (m, f) => console.log(m, f ?? ''),
  warn: (m, f) => console.warn(m, f ?? ''),
  error: (m, f) => console.error(m, f ?? ''),
};

export class IntrospectionActivationError extends Error {
  public readonly phase:
    | 'gather_signals'
    | 'generate_draft'
    | 'email_loop'
    | 'write_files'
    | 'add_labels'
    | 'notify_failure';
  public readonly repoFullName: string;

  constructor(message: string, phase: IntrospectionActivationError['phase'], repoFullName: string, cause?: unknown) {
    super(message);
    this.name = 'IntrospectionActivationError';
    this.phase = phase;
    this.repoFullName = repoFullName;
    if (cause) (this as any).cause = cause;
  }
}

function parseRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const parts = repoFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repoFullName (expected owner/repo): ${repoFullName}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function stableYamlStringify(obj: unknown): string {
  // Avoid js-yaml wrapping long lines.
  return yaml.dump(obj, { lineWidth: -1 }).trimEnd() + '\n';
}

export function ensureManifestBootstrapFields(
  manifestYaml: string,
  fields: { repoFullName: string; pmEmail: string; forkOrg: string }
): string {
  try {
    const parsed = yaml.load(manifestYaml);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return manifestYaml;
    }

    const updated = { ...(parsed as Record<string, unknown>) };
    updated.repo = fields.repoFullName;
    updated.pm_email = fields.pmEmail;
    updated.fork_org = fields.forkOrg;

    return stableYamlStringify(updated);
  } catch {
    // Don’t brick activation on YAML parse failures; let downstream validation catch it.
    return manifestYaml;
  }
}

type WrittenFile = { filePath: string; existedBefore: boolean };

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function writeAdapterFiles(options: {
  repoRoot: string;
  repoFullName: string;
  draft: DraftAdapter;
  force?: boolean;
}): Promise<{
  configDir: string;
  manifestPath: string;
  adapterPath: string;
  written: WrittenFile[];
  dirExistedBefore: boolean;
}> {
  const { owner, repo } = parseRepoFullName(options.repoFullName);
  const configDir = path.join(options.repoRoot, 'configs', owner, repo);

  const manifestPath = path.join(configDir, 'manifest.yaml');
  const adapterPath = path.join(configDir, 'adapter.ts');

  const dirExistedBefore = await fileExists(configDir);
  await fs.promises.mkdir(configDir, { recursive: true });

  const written: WrittenFile[] = [];

  const manifestExisted = await fileExists(manifestPath);
  if (manifestExisted && !options.force) {
    throw new Error(`Refusing to overwrite existing manifest: ${manifestPath}`);
  }

  const adapterExisted = await fileExists(adapterPath);
  if (adapterExisted && !options.force) {
    throw new Error(`Refusing to overwrite existing adapter: ${adapterPath}`);
  }

  await fs.promises.writeFile(manifestPath, (options.draft.manifestYaml || '').trimEnd() + '\n', 'utf-8');
  written.push({ filePath: manifestPath, existedBefore: manifestExisted });

  await fs.promises.writeFile(adapterPath, (options.draft.adapterTs || '').trimEnd() + '\n', 'utf-8');
  written.push({ filePath: adapterPath, existedBefore: adapterExisted });

  return { configDir, manifestPath, adapterPath, written, dirExistedBefore };
}

export async function rollbackWrittenAdapterFiles(info: {
  configDir: string;
  written: WrittenFile[];
  dirExistedBefore: boolean;
}): Promise<void> {
  for (const wf of info.written) {
    if (wf.existedBefore) continue;
    try {
      await fs.promises.rm(wf.filePath, { force: true });
    } catch {
      // best-effort
    }
  }

  if (!info.dirExistedBefore) {
    try {
      const remaining = await fs.promises.readdir(info.configDir);
      if (remaining.length === 0) {
        await fs.promises.rm(info.configDir, { recursive: true, force: true });
      }
    } catch {
      // best-effort
    }
  }
}

export async function addGitHubLabels(
  client: RepoLabelClient,
  repoFullName: string,
  labels: readonly string[] = REQUIRED_REPO_LABELS
): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const name of labels) {
    const existing = await client.getLabel(repoFullName, name);
    if (existing) {
      skipped.push(name);
      continue;
    }

    await client.createLabel(repoFullName, {
      name,
      color: 'ededed',
      description: 'Managed by oss-support-agent harness',
    });
    created.push(name);
  }

  return { created, skipped };
}

export interface IntrospectionWatcher {
  registerThread(thread: EmailThread): void;
  unregisterThread(threadId: string): void;
  getThread(threadId: string): EmailThread | undefined;
}

export interface IntrospectionReplyWaiterLike {
  waitForEmailReply(repoFullName: string): Promise<{ reply: GmailReply; thread: EmailThread }>;
}

export interface RunIntrospectionDependencies {
  gmailClient: GmailClient;
  watcher: IntrospectionWatcher;
  stateStore: IntrospectionStateStore;
  replyWaiter: IntrospectionReplyWaiterLike;
  llm: LLMClientLike;
  labelClient: RepoLabelClient;
}

export type IntrospectionApprovalLoop = (args: {
  repoFullName: string;
  pmEmail: string;
  forkOrg: string;
  draft: DraftAdapter;
  signals: RepoSignals;
  deps: RunIntrospectionDependencies;
  approvalKeywords: string[];
  replyToAddress: string;
}) => Promise<DraftAdapter>;

export async function runIntrospectionApprovalLoop(args: {
  repoFullName: string;
  pmEmail: string;
  forkOrg: string;
  draft: DraftAdapter;
  signals: RepoSignals;
  deps: RunIntrospectionDependencies;
  approvalKeywords: string[];
  replyToAddress: string;
  maxIterations?: number;
}): Promise<DraftAdapter> {
  const config: IntrospectionEmailLoopConfig = {
    pmEmail: args.pmEmail,
    replyToAddress: args.replyToAddress,
    repoFullName: args.repoFullName,
    approvalKeywords: args.approvalKeywords,
    maxIterations: args.maxIterations,
  };

  await sendIntrospectionEmail(
    args.deps.gmailClient,
    args.deps.watcher,
    config,
    args.draft,
    args.deps.stateStore
  );

  while (true) {
    const { reply } = await args.deps.replyWaiter.waitForEmailReply(args.repoFullName);

    const processed = await processIntrospectionReply({
      client: args.deps.gmailClient,
      watcher: args.deps.watcher,
      config,
      signals: args.signals,
      llm: args.deps.llm,
      replyBody: reply.body,
      stateStore: args.deps.stateStore,
    });

    if (processed.action === 'approved') {
      return processed.finalDraft;
    }
  }
}

type InFlight = Promise<RunIntrospectionResult>;
const inFlightByRepo = new Map<string, InFlight>();

export interface RunIntrospectionOptions {
  /** Repo root on disk where configs/ lives. Defaults to process.cwd(). */
  repoRoot?: string;
  /** Don’t overwrite existing configs unless forceWrite=true. */
  forceWrite?: boolean;
  /** Custom approval keywords (default approved/lgtm/ship it). */
  approvalKeywords?: string[];
  /** Reply-to address for introspection emails. */
  replyToAddress?: string;
  /** Dependency bundle; required unless approvalLoop is overridden. */
  deps?: RunIntrospectionDependencies;
  /** Override the approval loop for tests. */
  approvalLoop?: IntrospectionApprovalLoop;
  /** Allow tests to stub repo signal gathering. */
  gatherRepoSignals?: (repoFullName: string) => Promise<RepoSignals>;
  /** Allow tests to stub draft generation. */
  generateDraftAdapter?: (signals: RepoSignals, repoFullName: string) => Promise<DraftAdapter>;
  /** Optional triggering event to re-queue after activation. */
  triggeringEvent?: unknown;
  eventQueue?: IntrospectionEventQueue;
  /** Logger for activation. */
  logger?: ActivationLogger;
  /** Max email revision iterations (default 10 via email loop). */
  maxEmailIterations?: number;
}

export interface RunIntrospectionResult {
  repoFullName: string;
  activated: boolean;
  configDir: string;
  manifestPath: string;
  adapterPath: string;
  labels: { created: string[]; skipped: string[] };
}

async function sendFailureEmailBestEffort(options: {
  gmailClient: GmailClient;
  to: string;
  replyTo: string;
  repoFullName: string;
  error: Error;
}): Promise<void> {
  const subject = `[agent-fix] introspection FAILED: ${options.repoFullName}`;
  const body = [
    `Introspection failed for **${options.repoFullName}**.\n`,
    `Error: ${options.error.name}: ${options.error.message}\n`,
    'Please fix the issue and retry.',
  ].join('\n');

  await sendEmail(options.gmailClient, {
    to: options.to,
    subject,
    body,
    replyTo: options.replyTo,
  });
}

/**
 * Execute full introspection flow for a repo and activate it by writing configs and creating labels.
 * Concurrent calls for the same repo reuse the same in-flight promise.
 */
export async function runIntrospection(
  repoFullName: string,
  pmEmail: string,
  forkOrg: string,
  options: RunIntrospectionOptions = {}
): Promise<RunIntrospectionResult> {
  const existing = inFlightByRepo.get(repoFullName);
  if (existing) return existing;

  const p: InFlight = (async () => {
    const repoRoot = options.repoRoot ?? process.cwd();
    const approvalKeywords = options.approvalKeywords ?? ['approved', 'lgtm', 'ship it'];
    const replyToAddress = options.replyToAddress ?? 'noreply@example.com';
    const logger = options.logger ?? consoleLogger;

    const gather = options.gatherRepoSignals ?? gatherRepoSignals;

    let signals: RepoSignals;
    try {
      signals = await gather(repoFullName);
    } catch (err) {
      const e = new IntrospectionActivationError(
        `Failed to gather repo signals for ${repoFullName}`,
        'gather_signals',
        repoFullName,
        err
      );

      if (options.deps) {
        try {
          await sendFailureEmailBestEffort({
            gmailClient: options.deps.gmailClient,
            to: pmEmail,
            replyTo: replyToAddress,
            repoFullName,
            error: e,
          });
        } catch (notifyErr) {
          throw new IntrospectionActivationError(
            `Failed to notify PM of introspection failure for ${repoFullName}`,
            'notify_failure',
            repoFullName,
            notifyErr
          );
        }
      }

      throw e;
    }

    const generate = options.generateDraftAdapter ?? generateDraftAdapter;

    let draft: DraftAdapter;
    try {
      draft = await generate(signals, repoFullName);
    } catch (err) {
      const e = new IntrospectionActivationError(
        `Failed to generate draft adapter for ${repoFullName}`,
        'generate_draft',
        repoFullName,
        err
      );

      if (options.deps) {
        try {
          await sendFailureEmailBestEffort({
            gmailClient: options.deps.gmailClient,
            to: pmEmail,
            replyTo: replyToAddress,
            repoFullName,
            error: e,
          });
        } catch (notifyErr) {
          throw new IntrospectionActivationError(
            `Failed to notify PM of introspection failure for ${repoFullName}`,
            'notify_failure',
            repoFullName,
            notifyErr
          );
        }
      }

      throw e;
    }

    let approved: DraftAdapter;
    try {
      const approvalLoop =
        options.approvalLoop ??
        (options.deps
          ? async (a) =>
              runIntrospectionApprovalLoop({
                repoFullName: a.repoFullName,
                pmEmail: a.pmEmail,
                forkOrg: a.forkOrg,
                draft: a.draft,
                signals: a.signals,
                deps: a.deps,
                approvalKeywords: a.approvalKeywords,
                replyToAddress: a.replyToAddress,
                maxIterations: options.maxEmailIterations,
              })
          : null);

      if (!approvalLoop) {
        throw new Error('Missing deps for email approval loop; pass options.deps or options.approvalLoop');
      }

      approved = await approvalLoop({
        repoFullName,
        pmEmail,
        forkOrg,
        draft,
        signals,
        deps: options.deps!,
        approvalKeywords,
        replyToAddress,
      });
    } catch (err) {
      throw new IntrospectionActivationError(
        `Introspection email loop failed for ${repoFullName}`,
        'email_loop',
        repoFullName,
        err
      );
    }

    // Ensure bootstrap-owned manifest fields are correct before writing.
    approved = {
      ...approved,
      manifestYaml: ensureManifestBootstrapFields(approved.manifestYaml, {
        repoFullName,
        pmEmail,
        forkOrg,
      }),
    };

    let writeInfo:
      | {
          configDir: string;
          manifestPath: string;
          adapterPath: string;
          written: WrittenFile[];
          dirExistedBefore: boolean;
        }
      | undefined;

    try {
      writeInfo = await writeAdapterFiles({
        repoRoot,
        repoFullName,
        draft: approved,
        force: options.forceWrite,
      });
    } catch (err) {
      throw new IntrospectionActivationError(
        `Failed to write adapter files for ${repoFullName}`,
        'write_files',
        repoFullName,
        err
      );
    }

    let labels: { created: string[]; skipped: string[] };

    try {
      if (!options.deps) {
        throw new Error('Missing deps for label activation');
      }

      labels = await addGitHubLabels(options.deps.labelClient, repoFullName);
    } catch (err) {
      // Roll back newly created files if activation cannot complete.
      await rollbackWrittenAdapterFiles({
        configDir: writeInfo.configDir,
        written: writeInfo.written,
        dirExistedBefore: writeInfo.dirExistedBefore,
      });

      throw new IntrospectionActivationError(
        `Failed to add required GitHub labels for ${repoFullName}`,
        'add_labels',
        repoFullName,
        err
      );
    }

    logger.info('Introspection activated', {
      repoFullName,
      configDir: writeInfo.configDir,
      labels,
    });

    if (options.triggeringEvent !== undefined && options.eventQueue) {
      options.eventQueue.enqueue(options.triggeringEvent);
    }

    return {
      repoFullName,
      activated: true,
      configDir: writeInfo.configDir,
      manifestPath: writeInfo.manifestPath,
      adapterPath: writeInfo.adapterPath,
      labels,
    };
  })();

  inFlightByRepo.set(repoFullName, p);

  try {
    return await p;
  } finally {
    inFlightByRepo.delete(repoFullName);
  }
}

// Re-export concrete waiter for convenience.
export { IntrospectionReplyWaiter };
