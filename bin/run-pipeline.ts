/**
 * Pipeline orchestrator for live mode.
 *
 * Branches on triage routing:
 *   - clarify   -> comment posted by triage; pipeline stops
 *   - route_fork -> direct fix (skip-PM-gate or low-complexity bug)
 *   - route_pm  -> PM design loop (Gmail) -> fix
 *   - route_docs -> docs agent (no PM design loop)
 *
 * Around fix+sandbox+eval, applies the retry loop up to manifest.max_retries.
 * On max-retries exceeded: labels upstream issue agent-failed and emails PM.
 */

import * as path from 'path';

import type { RepoAdapter } from '../core/adapter.interface';
import type { Manifest } from '../core/manifest/types';
import { runTriage } from '../core/agents/triage';
import type { TriageInput } from '../core/agents/triage-types';
import { createForkAndBranch } from '../core/fork-manager';
import { runFixAgent } from '../core/agents/fix';
import { runDocsAgent } from '../core/agents/docs';
import type {
  ConfirmedIssue,
  FixAgentInput,
  ModuleCommit,
  ModuleFile,
} from '../core/agents/fix-types';
import type { DocsAgentInput } from '../core/agents/docs-types';
import { OpenRouterFixGenerator } from '../core/llm/openrouter-fix-generator';
import { createDefaultTriageClassifier } from '../core/llm/openrouter-triage-classifier';
import type { IssueEvent } from '../core/webhook/types';

import { scoreDesign } from '../core/agents/pm';
import {
  HeuristicBriefGenerator,
  HeuristicFollowUpGenerator,
  formatDesignBriefEmail,
  extractDecisions,
  summarizeAgreedDesign,
  processReply,
  sendDesignBrief,
} from '../core/pm-email-loop';
import type { PMEmailLoopConfig, DesignBriefInput } from '../core/pm-email-types';
import { detectApproval } from '../core/gmail-mcp';

import {
  runRetryLoop,
  injectRetryContextForFixAgent,
} from '../core/retry-loop';
import type { RetryLoopConfig } from '../core/retry-loop-types';

import { GitHubIssueCommenter, GitHubRestClient } from './clients/github-rest';
import { LocalWorkspace } from './clients/local-workspace';
import { LocalForkCommitter, LocalRepoFileReader } from './clients/local-fork-deps';
import { runLocalSandbox } from './clients/local-sandbox';
import type { LiveDeps } from './clients/live-deps';

export interface PipelineDeps {
  token: string;
  forkOrg: string;
  workspaceRoot: string;
  authorName: string;
  authorEmail: string;
  log: (msg: string) => void;
  /** Optional bundle of Gmail/state/PM deps for the full design + retry path. */
  live?: LiveDeps;
}

export type PipelineResult =
  | { status: 'skipped'; reason: string }
  | { status: 'commented'; reason: string }
  | { status: 'fix-failed'; reason: string }
  | { status: 'sandbox-failed'; reason: string; logsPath?: string }
  | { status: 'max-retries-exceeded'; reason: string }
  | { status: 'pr-opened'; prUrl: string; prNumber: number };

function buildTriageInput(payload: IssueEvent, manifest: Manifest, repoTree: string[]): TriageInput {
  const labels = (payload.issue.labels ?? []).map((l) => l.name);
  return {
    number: payload.issue.number,
    title: payload.issue.title ?? '',
    body: payload.issue.body ?? '',
    labels,
    author: payload.issue.user?.login ?? 'unknown',
    repoTree,
    hasSkipPmGate: !!manifest.skip_pm_gate_label && labels.includes(manifest.skip_pm_gate_label),
    url: `https://github.com/${payload.repository.full_name}/issues/${payload.issue.number}`,
  };
}

function gatherModuleFiles(workspace: LocalWorkspace, modulePath: string): ModuleFile[] {
  const files: ModuleFile[] = [];
  const candidates = workspace.listFiles(modulePath);
  for (const f of candidates) {
    if (/\.(test|spec)\.(ts|js|py)$/i.test(f)) continue;
    if (!/\.(ts|tsx|js|jsx|py|go|rs|java|md|yml|yaml)$/i.test(f)) continue;
    try {
      const content = workspace.readFile(f);
      files.push({ path: f, content: content.slice(0, 50_000) });
    } catch {
      /* skip */
    }
  }
  return files.slice(0, 30);
}

function gatherTestFiles(workspace: LocalWorkspace, modulePath: string): ModuleFile[] {
  const candidates = workspace.listFiles(modulePath);
  const tests: ModuleFile[] = [];
  for (const f of candidates) {
    if (!/\.(test|spec)\.(ts|js|py)$/i.test(f)) continue;
    try {
      tests.push({ path: f, content: workspace.readFile(f).slice(0, 50_000) });
    } catch {
      /* skip */
    }
  }
  return tests;
}

function gatherDocFiles(workspace: LocalWorkspace, modulePath: string): ModuleFile[] {
  const candidates = workspace.listFiles(modulePath);
  const docs: ModuleFile[] = [];
  const docExt = /\.(md|mdx|rst|txt|adoc)$/i;
  const docNames = /(^|\/)(README|CHANGELOG|CONTRIBUTING|MIGRATION|UPGRADING|SECURITY)/i;
  for (const f of candidates) {
    if (!docExt.test(f) && !docNames.test(f)) continue;
    try {
      docs.push({ path: f, content: workspace.readFile(f).slice(0, 50_000) });
    } catch {
      /* skip */
    }
  }
  return docs.slice(0, 20);
}

/**
 * Run the PM design loop over Gmail, blocking until approval is received.
 * Returns the agreed design summary.
 */
async function runPMDesignLoop(args: {
  payload: IssueEvent;
  manifest: Manifest;
  triageSummary: string;
  affectedModule: string;
  live: LiveDeps;
  log: (msg: string) => void;
  runId: string;
}): Promise<{ approved: true; agreedDesign: string }> {
  const { payload, manifest, triageSummary, affectedModule, live, log, runId } = args;
  const repoFullName = payload.repository.full_name;
  const issueNumber = payload.issue.number;

  log('[pm] gathering design context (related issues, recent PRs, design docs)');
  const [relatedIssues, recentPRs, designDocs] = await Promise.all([
    live.issueSearcher.searchRelatedIssues(repoFullName, affectedModule, null, null),
    live.prFetcher.getRecentMergedPRs(repoFullName, affectedModule, 30),
    live.designDocFinder.findDesignDocs(repoFullName, affectedModule),
  ]);

  const labels = (payload.issue.labels ?? []).map((l) => l.name);

  const scoringInput = {
    issueType: 'bug_fix' as const,
    affectedModule,
    summary: triageSummary,
    title: payload.issue.title ?? '',
    body: payload.issue.body ?? '',
    labels,
    relatedIssues,
    recentPRs,
    designDocs,
  };

  const scoring = scoreDesign(scoringInput);
  log(`[pm] scoring: design_needed=${scoring.designNeeded}`);

  if (!scoring.designNeeded) {
    return { approved: true, agreedDesign: scoring.reasoning };
  }

  const briefInput: DesignBriefInput = {
    issueSummary: triageSummary,
    affectedModule,
    relatedIssues,
    recentPRs,
    designDocs,
    issueTitle: payload.issue.title ?? '',
    issueBody: payload.issue.body ?? null,
    issueLabels: labels,
    scoringResult: scoring,
  };

  const config: PMEmailLoopConfig = {
    pmEmail: manifest.pm_email,
    replyToAddress: live.replyToFor(runId),
    repo: repoFullName,
    issueNumber,
    issueTitle: payload.issue.title ?? '',
    approvalKeywords: manifest.approval_keywords,
    runId,
  };

  const briefGen = new HeuristicBriefGenerator();
  const followUpGen = new HeuristicFollowUpGenerator();

  log(`[pm] sending design brief to ${manifest.pm_email}`);
  const sendResult = await sendDesignBrief(
    live.gmail,
    live.watcher,
    config,
    briefInput,
    briefGen,
    live.pmEmailStateStore
  );
  if (sendResult.action !== 'email_sent') {
    throw new Error(`Unexpected pm-email action ${sendResult.action} from sendDesignBrief`);
  }
  let thread = sendResult.thread;
  let resolvedDecisions: string[] = [];
  let unresolvedQuestions = scoring.signals.length
    ? briefGen.generateBrief(briefInput).openQuestions
    : [];

  // Loop: block on watcher reply, process, send follow-up, until approved.
  while (true) {
    log(`[pm] waiting for PM reply on thread ${thread.threadId} (runId=${runId})`);
    const { reply } = await live.replyWaiter.waitForEmailReply(runId);
    log(`[pm] received reply (${reply.body.length} chars) from ${reply.from}`);

    const result = await processReply(
      live.gmail,
      live.watcher,
      config,
      thread,
      reply.body,
      resolvedDecisions,
      unresolvedQuestions,
      briefInput,
      followUpGen,
      live.pmEmailStateStore
    );

    if (result.action === 'approved') {
      log(`[pm] approved (matched keyword: ${result.approvalResult.matchedKeyword})`);
      return { approved: true, agreedDesign: result.agreedDesign };
    }

    // result.action === 'reply_processed' -- update local state and keep waiting
    thread = result.thread;
    const newDecisions = extractDecisions(reply.body);
    resolvedDecisions = [...resolvedDecisions, ...newDecisions];
    // best-effort: trim resolved questions from unresolvedQuestions
    const replyLower = reply.body.toLowerCase();
    unresolvedQuestions = unresolvedQuestions.filter(
      (q) => !replyLower.includes(q.toLowerCase().split(' ').slice(0, 3).join(' '))
    );
  }
}

interface FixAttemptOutcome {
  ok: boolean;
  /** When ok=true, the eval summary; when ok=false, the retry context to feed back. */
  retryContext: string;
  evalSummary: string;
  fixSummary: string;
}

/**
 * Run a single fix → sandbox → eval attempt.
 */
async function runFixAttempt(args: {
  fixInput: FixAgentInput;
  workspace: LocalWorkspace;
  adapter: RepoAdapter;
  manifest: Manifest;
  payload: IssueEvent;
  forkFullName: string;
  branchName: string;
  ghClient: GitHubRestClient;
  log: (msg: string) => void;
}): Promise<FixAttemptOutcome> {
  const { fixInput, workspace, adapter, manifest, payload, log, ghClient } = args;
  const reader = new LocalRepoFileReader(workspace);
  const tokenScopes = await ghClient.getTokenScopes();
  const committer = new LocalForkCommitter(workspace, tokenScopes);
  const generator = new OpenRouterFixGenerator();

  log('[fix] invoking OpenRouter fix generator');
  const fixResult = await runFixAgent(fixInput, generator, committer, reader);
  if (!fixResult.success) {
    return {
      ok: false,
      retryContext: 'Fix generator returned no changes.',
      evalSummary: 'no-changes',
      fixSummary: '',
    };
  }
  log(`[fix] committed ${fixResult.changes.length} files: ${fixResult.summary}`);

  const testCommands = await adapter.getTestCommands();
  const sandboxServices = await adapter.getSandboxServices();
  log(
    `[sandbox] ${testCommands.length} command(s); services=${sandboxServices
      .map((s) => (typeof s === 'string' ? s : s.name))
      .join(',') || '(none)'}`
  );

  const sandboxArtifact = await runLocalSandbox({
    workspace,
    config: {
      repoFullName: payload.repository.full_name,
      forkFullName: args.forkFullName,
      branchName: args.branchName,
      workflowRepoFullName: '',
      testCommands,
      sandboxServices,
      timeoutMinutes: manifest.sandbox_timeout_mins ?? 15,
    },
    services: sandboxServices.filter(
      (s): s is Exclude<typeof s, string> => typeof s !== 'string'
    ),
    options: { log },
  });

  const evalResult = await adapter.runCustomEval(sandboxArtifact.commands);
  log(`[eval] passed=${evalResult.passed} summary=${evalResult.summary}`);

  if (evalResult.passed) {
    return {
      ok: true,
      retryContext: '',
      evalSummary: evalResult.summary,
      fixSummary: fixResult.summary,
    };
  }

  return {
    ok: false,
    retryContext:
      `Eval failed: ${evalResult.summary}\n` +
      (evalResult.retryContext.length
        ? `Retry hints:\n${evalResult.retryContext.map((c) => `- ${c}`).join('\n')}`
        : ''),
    evalSummary: evalResult.summary,
    fixSummary: fixResult.summary,
  };
}

/**
 * Run the docs agent path (no PM design loop, no retry loop).
 */
async function runDocsPath(args: {
  payload: IssueEvent;
  manifest: Manifest;
  affectedModule: string;
  workspace: LocalWorkspace;
  forkFullName: string;
  branchName: string;
  ghClient: GitHubRestClient;
  live: LiveDeps;
  log: (msg: string) => void;
  triageSummary: string;
}): Promise<{ summary: string }> {
  const { payload, workspace, forkFullName, branchName, ghClient, live, log, triageSummary, affectedModule } = args;
  const reader = new LocalRepoFileReader(workspace);
  const tokenScopes = await ghClient.getTokenScopes();
  const committer = new LocalForkCommitter(workspace, tokenScopes);

  const docFiles = gatherDocFiles(workspace, affectedModule);
  log(`[docs] gathered ${docFiles.length} doc files`);

  const docInput: DocsAgentInput = {
    confirmedIssues: [
      {
        number: payload.issue.number,
        title: payload.issue.title ?? '',
        body: payload.issue.body ?? '',
        labels: (payload.issue.labels ?? []).map((l) => l.name),
      },
    ],
    affectedModule,
    docFiles,
    recentCommits: [],
    forkFullName,
    branchName,
    triageSummary,
  };

  const result = await runDocsAgent(docInput, live.docsGenerator, committer, reader);
  if (!result.success) {
    throw new Error('Docs agent produced no changes');
  }
  log(`[docs] committed ${result.changes.length} files: ${result.summary}`);
  return { summary: result.summary };
}

export async function runPipeline(args: {
  payload: IssueEvent;
  manifest: Manifest;
  adapter: RepoAdapter;
  deps: PipelineDeps;
}): Promise<PipelineResult> {
  const { payload, manifest, adapter, deps } = args;
  const log = deps.log;
  const repoFullName = payload.repository.full_name;
  const issueNumber = payload.issue.number;
  const runId = `${repoFullName}#${issueNumber}-${Date.now()}`;

  // ---------- Triage ----------
  const commenter = new GitHubIssueCommenter(deps.token);
  const triageInput = buildTriageInput(payload, manifest, []);

  const routing = await runTriage(
    repoFullName,
    issueNumber,
    triageInput,
    adapter,
    commenter,
    { typeClassifier: createDefaultTriageClassifier() }
  );
  log(
    `[triage] action=${routing.action} type=${routing.result.issueType} ` +
      `module=${routing.result.affectedModule} confidence=${routing.result.confidence.toFixed(2)}`
  );

  if (routing.action === 'clarify') {
    return { status: 'commented', reason: 'low-confidence-clarification-posted' };
  }

  // route_pm requires live deps for the Gmail design loop.
  if (routing.action === 'route_pm' && !deps.live) {
    log(
      `[skip] issue routed to PM design loop but Gmail/PM deps not configured. ` +
        `Add the manifest skip_pm_gate label to bypass, or set Gmail env vars.`
    );
    return { status: 'skipped', reason: 'pm-design-loop-deps-missing' };
  }

  // ---------- Optional PM design loop ----------
  let designSummary = `Skip-PM-gate fix for issue #${issueNumber}: ${routing.result.summary}`;
  if (routing.action === 'route_pm') {
    const result = await runPMDesignLoop({
      payload,
      manifest,
      triageSummary: routing.result.summary,
      affectedModule: routing.result.affectedModule,
      live: deps.live!,
      log,
      runId,
    });
    designSummary = `Approved design for issue #${issueNumber}:\n${result.agreedDesign}`;
  }

  // ---------- Fork + branch ----------
  const ghClient = new GitHubRestClient(deps.token);
  const fork = await createForkAndBranch(ghClient, {
    upstream: repoFullName,
    forkOrg: deps.forkOrg,
    branchPrefix: manifest.branch_prefix,
    issueIds: [issueNumber],
  });
  log(
    `[fork] ${fork.forkFullName} branch=${fork.branchName} ` +
      `created=${fork.forkCreated} synced=${fork.forkSynced} reset=${fork.branchReset}`
  );

  // ---------- Local workspace ----------
  const baseBranch = await ghClient.getDefaultBranch(fork.forkFullName);
  const workspace = new LocalWorkspace(
    {
      rootDir: deps.workspaceRoot,
      token: deps.token,
      authorName: deps.authorName,
      authorEmail: deps.authorEmail,
    },
    fork.forkFullName,
    fork.branchName
  );
  log(`[workspace] cloning ${fork.forkFullName} → ${workspace.dir}`);
  await workspace.ensureCheckedOut(baseBranch);

  const confirmedIssues: ConfirmedIssue[] = [
    {
      number: issueNumber,
      title: payload.issue.title ?? '',
      body: payload.issue.body ?? '',
      labels: triageInput.labels,
    },
  ];

  let prSummary = '';
  let evalSummary = '';

  if (routing.action === 'route_docs') {
    // ---------- Docs path ----------
    const result = await runDocsPath({
      payload,
      manifest,
      affectedModule: routing.result.affectedModule,
      workspace,
      forkFullName: fork.forkFullName,
      branchName: fork.branchName,
      ghClient,
      live: deps.live!,
      log,
      triageSummary: routing.result.summary,
    });
    prSummary = result.summary;
    evalSummary = 'docs-only (no eval)';
  } else {
    // ---------- Fix path with retry loop ----------
    const moduleSource = gatherModuleFiles(workspace, routing.result.affectedModule);
    const moduleTests = gatherTestFiles(workspace, routing.result.affectedModule);
    const recentCommits: ModuleCommit[] = [];

    const fixInputBase: FixAgentInput = {
      designSummary,
      confirmedIssues,
      affectedModule: routing.result.affectedModule,
      moduleSource,
      moduleTests,
      recentCommits,
      forkFullName: fork.forkFullName,
      branchName: fork.branchName,
    };

    const maxRetries = manifest.max_retries ?? 3;
    let attempt: FixAttemptOutcome | null = null;
    let currentInput = fixInputBase;
    let lastRetryContext: string | null = null;

    while (true) {
      try {
        attempt = await runFixAttempt({
          fixInput: currentInput,
          workspace,
          adapter,
          manifest,
          payload,
          forkFullName: fork.forkFullName,
          branchName: fork.branchName,
          ghClient,
          log,
        });
      } catch (err: any) {
        log(`[fix] attempt threw: ${err?.message ?? err}`);
        attempt = {
          ok: false,
          retryContext: `Fix attempt threw: ${err?.message ?? err}`,
          evalSummary: 'exception',
          fixSummary: '',
        };
      }

      if (attempt.ok) break;

      lastRetryContext = attempt.retryContext;

      if (deps.live) {
        const retryConfig: RetryLoopConfig = {
          runId,
          maxRetries,
          agentType: 'fix',
          upstreamRepo: repoFullName,
          primaryIssueNumber: issueNumber,
          pmEmail: manifest.pm_email,
          replyToAddress: deps.live.replyToFor(runId),
          confirmedIssues,
          forkFullName: fork.forkFullName,
          branchName: fork.branchName,
        };
        const decision = await runRetryLoop(
          attempt.retryContext,
          retryConfig,
          deps.live.retryStateStore,
          deps.live.failureNotifier,
          deps.live.issueLabeler
        );
        if (decision.action === 'max_retries_exceeded') {
          log(`[retry] max_retries exceeded; labeled agent-failed and emailed PM`);
          return { status: 'max-retries-exceeded', reason: attempt.evalSummary };
        }
        log(`[retry] retrying (attempt ${decision.dispatch.retryCount}/${maxRetries})`);
        currentInput = {
          ...fixInputBase,
          designSummary: injectRetryContextForFixAgent(designSummary, decision.dispatch),
        };
      } else {
        // No live deps -> simple in-memory retry without persistence/notifications.
        const attemptsSoFar = (currentInput.designSummary.match(/## Latest Failure/g) ?? []).length;
        if (attemptsSoFar >= maxRetries) {
          log(`[retry] max_retries exceeded (no live deps to label/email)`);
          return { status: 'max-retries-exceeded', reason: attempt.evalSummary };
        }
        log(`[retry] retrying without persistence (attempt ${attemptsSoFar + 1}/${maxRetries})`);
        currentInput = {
          ...fixInputBase,
          designSummary:
            `${designSummary}\n\n## Latest Failure (address this in your fix)\n\n${attempt.retryContext}`,
        };
      }
    }

    prSummary = attempt!.fixSummary;
    evalSummary = attempt!.evalSummary;
  }

  // ---------- Draft PR ----------
  const prMeta = await adapter.getPRMetadata(
    confirmedIssues.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      labels: i.labels,
    }))
  );
  const prTitle = `${prSummary} (closes #${issueNumber})`;
  const prBody = [
    `Automated change generated by oss-support-agent.`,
    ``,
    `Closes #${issueNumber}.`,
    ``,
    `## Summary`,
    prSummary,
    ``,
    `## Eval`,
    `- ${evalSummary}`,
    ``,
    ...(prMeta.extraBodySections ?? []),
  ].join('\n');

  const pr = await ghClient.createPullRequest({
    upstream: repoFullName,
    forkFullName: fork.forkFullName,
    headBranch: fork.branchName,
    baseBranch,
    title: prTitle,
    body: prBody,
    draft: true,
  });
  log(`[pr] opened ${pr.url}`);

  if (prMeta.extraLabels?.length) {
    try {
      await ghClient.addLabelsToPR(repoFullName, pr.number, prMeta.extraLabels);
    } catch (err: any) {
      log(`[pr] label apply failed (non-fatal): ${err?.message ?? err}`);
    }
  }

  return { status: 'pr-opened', prUrl: pr.url, prNumber: pr.number };
}

export function defaultWorkspaceRoot(): string {
  return path.join(process.cwd(), 'data', 'workspaces');
}

// formatDesignBriefEmail is re-exported for tests / external callers.
export { formatDesignBriefEmail, summarizeAgreedDesign, detectApproval };
