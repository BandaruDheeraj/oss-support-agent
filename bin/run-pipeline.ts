/**
 * Pipeline orchestrator for live mode.
 *
 * Skip-PM-gate path only (US-skip-pm-gate). Chains:
 *   triage → fork → fix → local sandbox → eval → draft PR.
 *
 * The PM design loop (Gmail-driven) is intentionally out of scope here. Issues that
 * don't carry the manifest's skip_pm_gate_label are rejected with a clear log line.
 */

import * as path from 'path';
import * as os from 'os';

import type { RepoAdapter } from '../core/adapter.interface';
import type { Manifest } from '../core/manifest/types';
import { runTriage } from '../core/agents/triage';
import type { TriageInput } from '../core/agents/triage-types';
import { createForkAndBranch } from '../core/fork-manager';
import { runFixAgent } from '../core/agents/fix';
import type {
  ConfirmedIssue,
  FixAgentInput,
  ModuleCommit,
  ModuleFile,
} from '../core/agents/fix-types';
import { OpenRouterFixGenerator } from '../core/llm/openrouter-fix-generator';
import { createDefaultTriageClassifier } from '../core/llm/openrouter-triage-classifier';
import type { IssueEvent } from '../core/webhook/types';

import { GitHubIssueCommenter, GitHubRestClient } from './clients/github-rest';
import { LocalWorkspace } from './clients/local-workspace';
import { LocalForkCommitter, LocalRepoFileReader } from './clients/local-fork-deps';
import { runLocalSandbox } from './clients/local-sandbox';

export interface PipelineDeps {
  token: string;
  forkOrg: string;
  workspaceRoot: string;
  authorName: string;
  authorEmail: string;
  log: (msg: string) => void;
}

export type PipelineResult =
  | { status: 'skipped'; reason: string }
  | { status: 'commented'; reason: string }
  | { status: 'fix-failed'; reason: string }
  | { status: 'sandbox-failed'; reason: string; logsPath?: string }
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
      // Cap each file at 50KB to keep prompt size reasonable.
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

  // ---------- Triage ----------
  const commenter = new GitHubIssueCommenter(deps.token);
  const triageInput = buildTriageInput(payload, manifest, []);
  if (!triageInput.hasSkipPmGate) {
    log(
      `[skip] issue #${issueNumber} missing skip_pm_gate_label "${manifest.skip_pm_gate_label}". ` +
        `Live mode does not run the PM design loop yet.`
    );
    return { status: 'skipped', reason: 'no-skip-pm-gate-label' };
  }

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
  if (routing.action !== 'route_fork') {
    log(`[skip] triage routed to ${routing.action}; only route_fork is wired in live mode`);
    return { status: 'skipped', reason: `triage-routed-${routing.action}` };
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

  // ---------- Fix agent ----------
  const moduleSource = gatherModuleFiles(workspace, routing.result.affectedModule);
  const moduleTests = gatherTestFiles(workspace, routing.result.affectedModule);
  const recentCommits: ModuleCommit[] = []; // best-effort omission for live mode

  const confirmedIssues: ConfirmedIssue[] = [
    {
      number: issueNumber,
      title: payload.issue.title ?? '',
      body: payload.issue.body ?? '',
      labels: triageInput.labels,
    },
  ];

  const fixInput: FixAgentInput = {
    designSummary: `Skip-PM-gate fix for issue #${issueNumber}: ${routing.result.summary}`,
    confirmedIssues,
    affectedModule: routing.result.affectedModule,
    moduleSource,
    moduleTests,
    recentCommits,
    forkFullName: fork.forkFullName,
    branchName: fork.branchName,
  };

  const reader = new LocalRepoFileReader(workspace);
  const tokenScopes = await ghClient.getTokenScopes();
  const committer = new LocalForkCommitter(workspace, tokenScopes);
  const generator = new OpenRouterFixGenerator();

  log('[fix] invoking OpenRouter fix generator');
  let fixResult;
  try {
    fixResult = await runFixAgent(fixInput, generator, committer, reader);
  } catch (err: any) {
    log(`[fix] FAILED: ${err?.message ?? err}`);
    return { status: 'fix-failed', reason: err?.message ?? 'fix-error' };
  }

  if (!fixResult.success) {
    log('[fix] no changes generated');
    return { status: 'fix-failed', reason: 'no-changes-generated' };
  }
  log(`[fix] committed ${fixResult.changes.length} files: ${fixResult.summary}`);

  // ---------- Local sandbox ----------
  const testCommands = await adapter.getTestCommands();
  const sandboxServices = await adapter.getSandboxServices();
  log(`[sandbox] ${testCommands.length} command(s); services=${sandboxServices.map((s) => typeof s === 'string' ? s : s.name).join(',')}`);

  const sandboxArtifact = await runLocalSandbox({
    workspace,
    config: {
      repoFullName,
      forkFullName: fork.forkFullName,
      branchName: fork.branchName,
      workflowRepoFullName: '',
      testCommands,
      sandboxServices,
      timeoutMinutes: manifest.sandbox_timeout_mins ?? 15,
    },
    services: sandboxServices.filter((s): s is Exclude<typeof s, string> => typeof s !== 'string'),
    options: { log },
  });

  // ---------- Eval ----------
  const evalResult = await adapter.runCustomEval(sandboxArtifact.commands);
  log(`[eval] passed=${evalResult.passed} summary=${evalResult.summary}`);

  if (!evalResult.passed) {
    log('[eval] failures detected; not opening PR. retryContext:');
    for (const c of evalResult.retryContext) log(`  - ${c}`);
    return { status: 'sandbox-failed', reason: evalResult.summary };
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
  const prTitle = `${fixResult.summary} (closes #${issueNumber})`;
  const prBody = [
    `Automated fix generated by oss-support-agent.`,
    ``,
    `Closes #${issueNumber}.`,
    ``,
    `## Summary`,
    fixResult.summary,
    ``,
    `## Eval`,
    `- ${evalResult.summary}`,
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

export { LocalWorkspace, os };
