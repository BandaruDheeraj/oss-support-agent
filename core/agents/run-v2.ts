/**
 * v2 pipeline driver — slim wrappers over runReproV2 and runFixV2 that
 * hydrate adapters from a LocalWorkspace + IssueEvent + manifest, and return
 * normalized outcomes the caller (bin/run-pipeline.ts) can switch on.
 *
 * These are the shapes we expose; callers should NOT depend on legacy
 * ReproSpec / FixAgentResult any more.
 */

import type { LocalWorkspace } from '../../bin/clients/local-workspace';
import type { IssueEvent } from '../webhook/types';
import type { ActionsClient, SandboxConfig } from '../sandbox-types';

import {
  createIssueHandle,
  createRepoHandle,
  createWorkspaceFsAdapter,
  createSandboxAdapter,
  type SandboxDriver,
} from './adapters';
import type { LocalSandboxAdapterOptions } from './adapters/sandbox-local';
import type { GhActionsSandboxAdapterOptions } from './adapters/sandbox-gh-actions';

import { runReproV2, type ReproV2Outcome } from './repro-loop-v2/orchestrator';
import { runFixV2, type FixV2Outcome } from './fix-loop/orchestrator';
import { DossierStore } from './analyst/dossier';
import { buildSemanticSuspectSeed } from './analyst/semantic-search';
import {
  discoverEditableInstallCandidates,
  extractIssueCodeSnippets,
} from './repro-loop-v2/repro-hints';

import { execCommand } from '../../bin/clients/local-workspace';
import { getTracer, runWithSpan, type Span } from '../observability';
import { emitOnlineEvaluation } from '../observability/evaluator';

async function withPipelineSpan<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  const span: Span = tracer.startSpan(name, { kind: 'phase', attributes: attrs });
  try {
    return await runWithSpan(span, fn);
  } catch (err) {
    span.recordError(err);
    throw err;
  } finally {
    span.end();
  }
}

function isGhaSandboxDriver(driver: SandboxDriver | undefined): boolean {
  return driver === 'gha' || driver === 'gh-actions';
}

function resolveWorkflowDispatchRef(args: {
  workflowRepoFullName: string;
  forkFullName: string;
  branchName: string;
}): string {
  if (args.workflowRepoFullName === args.forkFullName) {
    return args.branchName;
  }
  return process.env.HARNESS_WORKFLOW_REF?.trim() || 'main';
}

/* -------------------------------------------------------------------------- */
/* Common driver inputs                                                       */
/* -------------------------------------------------------------------------- */

export interface ReproPipelineInput {
  attemptId: string;
  payload: IssueEvent;
  workspace: LocalWorkspace;
  forkFullName: string;
  branch: string;
  baselineSha: string;
  affectedModule: string;
  language?: 'python' | 'javascript' | 'typescript' | 'go' | 'other';

  /** Sandbox driver selection. Defaults to env OSA_SANDBOX_DRIVER (else local). */
  sandboxDriver?: SandboxDriver;
  localSandboxOptions?: Omit<LocalSandboxAdapterOptions, 'reproTestPath'>;
  ghActionsSandboxOptions?: Omit<GhActionsSandboxAdapterOptions, 'reproTestPath'> & {
    actionsClient: ActionsClient;
    baseConfig: Omit<SandboxConfig, 'testCommand' | 'testCommands'>;
  };

  carryforwardSummary?: string;
  log?: (msg: string) => void;
}

export interface ReproPipelineOutcome {
  ok: boolean;
  status: ReproV2Outcome['status'];
  message: string;
  /** Repo-relative path of the candidate test the v2 loop produced. */
  candidateTestPath?: string;
  /** File content of the candidate test (read post-success from workspace). */
  candidateTestContent?: string;
  /** The full v2 outcome for downstream consumers (email composer, etc.). */
  v2: ReproV2Outcome;
}

/* -------------------------------------------------------------------------- */
/* runReproPipeline                                                            */
/* -------------------------------------------------------------------------- */

export async function runReproPipeline(input: ReproPipelineInput): Promise<ReproPipelineOutcome> {
  return withPipelineSpan(
    'pipeline.repro',
    {
      attempt_id: input.attemptId,
      issue_number: input.payload.issue?.number,
      repo: input.payload.repository?.full_name,
      affected_module: input.affectedModule,
      language: input.language ?? 'python',
    },
    () => runReproPipelineImpl(input)
  );
}

async function runReproPipelineImpl(input: ReproPipelineInput): Promise<ReproPipelineOutcome> {
  const log = input.log ?? (() => {});
  const language = input.language ?? 'python';

  const workspaceAdapter = createWorkspaceFsAdapter(input.workspace, {
    affectedModule: input.affectedModule,
  });
  const issueHandle = createIssueHandle(input.payload);
  const repoHandle = createRepoHandle({
    payload: input.payload,
    forkFullName: input.forkFullName,
    branch: input.branch,
    baselineSha: input.baselineSha,
    affectedModule: input.affectedModule,
    language,
  });
  const sandbox = createSandboxAdapter({
    driver: input.sandboxDriver,
    workspace: input.workspace,
    localOptions: {
      ...(input.localSandboxOptions ?? {}),
      // Surface venv-creation + per-command sandbox logs to the pipeline log
      // unless the caller explicitly set their own. Without this we lose all
      // visibility into `python3 -m venv` failures, pip stderr, etc.
      log: input.localSandboxOptions?.log ?? log,
    },
    ghActionsOptions: input.ghActionsSandboxOptions
      ? input.ghActionsSandboxOptions
      : undefined,
  });

  log(`[v2-driver] runReproPipeline attemptId=${input.attemptId} module=${input.affectedModule}`);

  // Derive editable-install candidates and verbatim issue snippets up front so
  // the v2 Planner/Executor get them in their initial prompt. The model can't
  // construct a working repro for in-repo Python packages without knowing
  // which dir to `pip install -e`, and paraphrasing the issue's snippet is a
  // common cause of "passes when it should fail".
  const editableInstallCandidates = discoverEditableInstallCandidates(input.workspace.dir, {
    affectedModule: input.affectedModule,
  });
  const issueSnippets = extractIssueCodeSnippets(input.payload.issue.body);
  if (editableInstallCandidates.length > 0) {
    log(
      `[v2-driver] surfaced ${editableInstallCandidates.length} editableInstall candidate(s): ${editableInstallCandidates.join(', ')}`
    );
  }
  if (issueSnippets.length > 0) {
    log(`[v2-driver] surfaced ${issueSnippets.length} issue code snippet(s) to Planner/Executor`);
  }

  let semanticSuspectSeed = null;
  const useGhaSemanticSearch =
    language === 'python' &&
    isGhaSandboxDriver(input.sandboxDriver) &&
    !!input.ghActionsSandboxOptions?.sandboxSession;
  if (useGhaSemanticSearch) {
    const ghaOptions = input.ghActionsSandboxOptions;
    if (!ghaOptions) {
      throw new Error('runReproPipeline: gha semantic search requested without ghActionsSandboxOptions');
    }
    if (!ghaOptions.sandboxSession) {
      throw new Error('runReproPipeline: gha semantic search requested without SandboxSession');
    }
    try {
      const baseConfig = ghaOptions.baseConfig;
      semanticSuspectSeed = await buildSemanticSuspectSeed({
        workspaceDir: input.workspace.dir,
        issueTitle: input.payload.issue.title,
        issueBody: input.payload.issue.body ?? '',
        affectedModule: input.affectedModule,
        ghaConfig: {
          actionsClient: ghaOptions.actionsClient,
          sandboxSession: ghaOptions.sandboxSession,
          repoFullName: baseConfig.repoFullName,
          forkFullName: baseConfig.forkFullName,
          forkCloneUrl:
            baseConfig.forkCloneUrl && baseConfig.forkCloneUrl.trim()
              ? baseConfig.forkCloneUrl
              : `https://github.com/${baseConfig.forkFullName}.git`,
          branchName: baseConfig.branchName,
          workflowRepoFullName: baseConfig.workflowRepoFullName,
          workflowDispatchRef: resolveWorkflowDispatchRef({
            workflowRepoFullName: baseConfig.workflowRepoFullName,
            forkFullName: baseConfig.forkFullName,
            branchName: baseConfig.branchName,
          }),
          timeoutMinutes: baseConfig.timeoutMinutes,
        },
        log,
      });
      if (semanticSuspectSeed) {
        log(
          `[v2-driver] semantic suspects ready: files=${semanticSuspectSeed.suspectFiles.length} symbols=${semanticSuspectSeed.suspectSymbols.length} indexed=${semanticSuspectSeed.indexedFileCount} cacheHit=${semanticSuspectSeed.cacheHit}`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[v2-driver] semantic suspect indexing failed (continuing without seed): ${message}`);
    }
  } else if (language === 'python') {
    log('[v2-driver] semantic suspect indexing skipped (requires gha sandbox mode with SandboxSession)');
  }

  const v2 = await runReproV2({
    attemptId: input.attemptId,
    issue: issueHandle,
    repo: repoHandle,
    workspace: workspaceAdapter,
    sandbox,
    carryforwardSummary: input.carryforwardSummary,
    editableInstallCandidates,
    issueSnippets,
    issueBody: input.payload.issue.body ?? undefined,
    workspaceDir: input.workspace.dir,
    ...(semanticSuspectSeed ? { semanticSuspectSeed } : {}),
  });

  log(
    `[v2-driver] runReproPipeline DONE attemptId=${input.attemptId} status=${v2.status} ok=${v2.status === 'reproduced'} message=${JSON.stringify(v2.message).slice(0, 320)}`
  );

  const candidateTestPath = v2.plan?.candidateTestPath;
  let candidateTestContent: string | undefined;
  if (candidateTestPath) {
    const c = await workspaceAdapter.readFile(candidateTestPath);
    if (c) candidateTestContent = c;
  }

  await emitOnlineEvaluation({
    metric: 'repro_passed',
    stage: 'repro',
    score: v2.status === 'reproduced' ? 1 : 0,
    issueNumber: input.payload.issue?.number,
    attemptId: input.attemptId,
    repo: input.payload.repository?.full_name,
    status: v2.status,
    input: {
      issue_number: input.payload.issue?.number,
      attempt_id: input.attemptId,
      repo: input.payload.repository?.full_name,
      affected_module: input.affectedModule,
    },
    output: {
      status: v2.status,
      message: v2.message,
      candidate_test_path: candidateTestPath ?? null,
      builder_reject_stage: v2.builderRejectStage ?? null,
      executor_outcome: v2.executor?.outcome ?? null,
    },
  });

  return {
    ok: v2.status === 'reproduced',
    status: v2.status,
    message: v2.message,
    candidateTestPath,
    candidateTestContent,
    v2,
  };
}

/* -------------------------------------------------------------------------- */
/* runFixPipeline                                                              */
/* -------------------------------------------------------------------------- */

export interface FixPipelineInput {
  attemptId: string;
  payload: IssueEvent;
  workspace: LocalWorkspace;
  forkFullName: string;
  branch: string;
  baselineSha: string;
  affectedModule: string;
  language?: 'python' | 'javascript' | 'typescript' | 'go' | 'other';

  /** The dossier produced by runReproPipeline (or a freshly-built one). */
  dossier: DossierStore;
  reproTestPath: string;

  sandboxDriver?: SandboxDriver;
  localSandboxOptions?: LocalSandboxAdapterOptions;
  ghActionsSandboxOptions?: GhActionsSandboxAdapterOptions;

  log?: (msg: string) => void;
}

export interface FixPipelineOutcome {
  ok: boolean;
  status: FixV2Outcome['status'];
  message: string;
  changedFiles: string[];
  /** Full v2 outcome for the email composer + PR body generator. */
  v2: FixV2Outcome;
}

export async function runFixPipeline(input: FixPipelineInput): Promise<FixPipelineOutcome> {
  return withPipelineSpan(
    'pipeline.fix',
    {
      attempt_id: input.attemptId,
      issue_number: input.payload.issue?.number,
      repo: input.payload.repository?.full_name,
      affected_module: input.affectedModule,
      language: input.language ?? 'python',
      repro_test_path: input.reproTestPath,
    },
    () => runFixPipelineImpl(input)
  );
}

async function runFixPipelineImpl(input: FixPipelineInput): Promise<FixPipelineOutcome> {
  const log = input.log ?? (() => {});
  const language = input.language ?? 'python';

  const snapshot = input.dossier.latest();
  if (!snapshot) {
    throw new Error('runFixPipeline: dossier has no snapshot — Analyst must run first');
  }

  const workspaceAdapter = createWorkspaceFsAdapter(input.workspace, {
    affectedModule: input.affectedModule,
    reproTestPath: input.reproTestPath,
  });
  const issueHandle = createIssueHandle(input.payload);
  const repoHandle = createRepoHandle({
    payload: input.payload,
    forkFullName: input.forkFullName,
    branch: input.branch,
    baselineSha: input.baselineSha,
    affectedModule: input.affectedModule,
    language,
  });

  // For the fix-loop sandbox we pass through the repro test path so runRepro works.
  const sandbox = createSandboxAdapter({
    driver: input.sandboxDriver,
    workspace: input.workspace,
    localOptions: {
      ...(input.localSandboxOptions ?? {}),
      reproTestPath: input.reproTestPath,
      // Same logger pass-through as the repro pipeline — keep sandbox-level
      // diagnostics visible in Render logs unless the caller opts out.
      log: input.localSandboxOptions?.log ?? log,
    },
    ghActionsOptions: input.ghActionsSandboxOptions
      ? { ...input.ghActionsSandboxOptions, reproTestPath: input.reproTestPath }
      : undefined,
  });

  log(`[v2-driver] runFixPipeline attemptId=${input.attemptId} reproTest=${input.reproTestPath}`);

  const v2 = await runFixV2({
    attemptId: input.attemptId,
    dossier: input.dossier,
    snapshot,
    reproTestPath: input.reproTestPath,
    issue: issueHandle,
    repo: repoHandle,
    workspace: workspaceAdapter,
    sandbox,
    async getCurrentHeadSha() {
      const r = await execCommand('git', ['rev-parse', 'HEAD'], input.workspace.dir, {
        timeoutMs: 10_000,
      });
      return r.stdout.trim();
    },
  });

  log(
    `[v2-driver] runFixPipeline DONE attemptId=${input.attemptId} status=${v2.status} ok=${v2.status === 'fix_approved'} changedFiles=${v2.changedFiles.length} message=${JSON.stringify(v2.message).slice(0, 320)}`
  );

  await emitOnlineEvaluation({
    metric: 'fix_passed',
    stage: 'fix',
    score: v2.status === 'fix_approved' ? 1 : 0,
    issueNumber: input.payload.issue?.number,
    attemptId: input.attemptId,
    repo: input.payload.repository?.full_name,
    status: v2.status,
    input: {
      issue_number: input.payload.issue?.number,
      attempt_id: input.attemptId,
      repo: input.payload.repository?.full_name,
      affected_module: input.affectedModule,
      repro_test_path: input.reproTestPath,
    },
    output: {
      status: v2.status,
      message: v2.message,
      changed_files: v2.changedFiles,
      critic_verdict: v2.criticVerdict?.verdict ?? null,
      critic_reason: v2.criticVerdict?.reason ?? null,
    },
  });

  return {
    ok: v2.status === 'fix_approved',
    status: v2.status,
    message: v2.message,
    changedFiles: v2.changedFiles,
    v2,
  };
}
