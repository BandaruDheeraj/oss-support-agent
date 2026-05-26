/**
 * Repro orchestrator: Analyst → Planner → Executor → Critic.
 *
 * Returns a ReproOutcome carrying everything downstream agents need.
 */

import { runAnalyst } from '../analyst/analyst';
import { DossierStore } from '../analyst/dossier';
import { runReproPlanner, type ReproPlan } from './planner';
import { runReproExecutor, type ReproExecutorResult, reproAstPreflight } from './executor';
import { runReproCritic, type ReproVerdict } from './critic';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';
import { detectCredentialError } from '../../credentials-check';
import type { IssueCodeSnippet } from './repro-hints';

export interface RunReproV2Args {
  attemptId: string;
  issue: IssueHandle;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
  /** When set, skip Analyst and reuse this store. */
  dossier?: DossierStore;
  carryforwardSummary?: string;
  /** Process env used to check whether detected credential vars are actually missing. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Repo-relative dirs containing a Python package manifest, surfaced to
   * Planner + Executor so the executor can `pip install -e <dir>` for in-repo
   * imports instead of getting stuck on ModuleNotFoundError.
   */
  editableInstallCandidates?: string[];
  /**
   * Verbatim fenced code blocks lifted from the issue body, surfaced to the
   * Planner + Executor so the first repro draft can mirror the snippet
   * exactly rather than paraphrasing it.
   */
  issueSnippets?: IssueCodeSnippet[];
}

export interface ReproV2Outcome {
  status:
    | 'reproduced'
    | 'critic_rejected'
    | 'executor_failed'
    | 'planner_failed'
    | 'analyst_failed'
    | 'preflight_failed'
    | 'credentials_required';
  dossier: DossierStore;
  plan?: ReproPlan;
  executor?: ReproExecutorResult;
  criticVerdict?: ReproVerdict;
  preflightReason?: string;
  /**
   * Populated when status === 'credentials_required'. Lifted from any run_repro
   * transcript entry whose stderr/stdout matched a known credential-error pattern.
   */
  credentialsTerminal?: {
    inferredEnvVars: string[];
    matchedPattern: string | null;
    stderrTail?: string;
  };
  message: string;
}

export async function runReproV2(args: RunReproV2Args): Promise<ReproV2Outcome> {
  const dossier = args.dossier ?? new DossierStore();

  // Stage A: Analyst (skipped if dossier was passed in)
  if (!args.dossier || !dossier.latest()) {
    const analyst = await runAnalyst({
      issue: args.issue,
      repo: args.repo,
      workspace: args.workspace,
      sandbox: args.sandbox,
      attemptId: args.attemptId,
      dossier,
      carryforwardSummary: args.carryforwardSummary,
    });
    if (!analyst.snapshot) {
      return {
        status: 'analyst_failed',
        dossier,
        message: `Analyst terminated without producing a dossier (${analyst.terminated}${analyst.reason ? `: ${analyst.reason}` : ''})`,
      };
    }
  }

  const snapshot = dossier.latest()!;

  // Stage B: Planner
  let plan: ReproPlan;
  try {
    plan = await runReproPlanner({
      attemptId: args.attemptId,
      dossier: snapshot,
      carryforwardSummary: args.carryforwardSummary,
      editableInstallCandidates: args.editableInstallCandidates,
      issueSnippets: args.issueSnippets,
    });
  } catch (err) {
    return { status: 'planner_failed', dossier, message: err instanceof Error ? err.message : String(err) };
  }

  // Sandbox needs to know the candidate test path before the executor can
  // call run_repro. Previously the sandbox was constructed (in run-v2.ts)
  // before the Planner picked the path, so run_repro returned
  // "reproTestPath not configured" and the executor abandoned. Setting it
  // here closes that gap.
  args.sandbox.setReproTestPath(plan.candidateTestPath);

  // Stage C: Executor
  const executor = await runReproExecutor({
    attemptId: args.attemptId,
    plan,
    dossier,
    dossierSnapshot: snapshot,
    issue: args.issue,
    repo: args.repo,
    workspace: args.workspace,
    sandbox: args.sandbox,
    editableInstallCandidates: args.editableInstallCandidates,
    issueSnippets: args.issueSnippets,
  });

  if (executor.terminated !== 'done') {
    // Before declaring a generic executor failure, inspect run_repro transcript
    // entries for credential errors. If any matched and the inferred env vars
    // are not currently set, surface this as a structured credentials_required
    // outcome so the caller can halt with an awaiting-credentials email.
    const credResult = detectCredentialsFromExecutor(executor, args.env ?? process.env);
    if (credResult) {
      return {
        status: 'credentials_required',
        dossier,
        plan,
        executor,
        credentialsTerminal: credResult,
        message: `Repro halted on missing credentials (${credResult.matchedPattern ?? 'unknown pattern'}): ${credResult.inferredEnvVars.join(', ')}`,
      };
    }
    return {
      status: 'executor_failed',
      dossier,
      plan,
      executor,
      message: `Repro Executor did not reach done (${executor.terminated}${executor.reason ? `: ${executor.reason}` : ''})`,
    };
  }

  // Stage D: AST preflight on the candidate test (language-aware best-effort)
  const src = await args.workspace.readFile(plan.candidateTestPath);
  if (src) {
    const suspectFiles = snapshot.body.suspectSymbols.map((s) => s.file);
    const suspectSymbols = snapshot.body.suspectSymbols.map((s) => s.symbol);
    const pre = reproAstPreflight(args.repo.language, src, suspectFiles, suspectSymbols);
    if (!pre.ok) {
      return {
        status: 'preflight_failed',
        dossier,
        plan,
        executor,
        preflightReason: pre.reason,
        message: `AST preflight rejected the candidate test: ${pre.reason}`,
      };
    }
  }

  // Stage E: Critic
  const critic = await runReproCritic({
    attemptId: args.attemptId,
    plan,
    dossier,
    dossierSnapshot: snapshot,
    issue: args.issue,
    repo: args.repo,
    workspace: args.workspace,
    sandbox: args.sandbox,
  });

  if (critic.verdict.verdict !== 'approve') {
    return {
      status: 'critic_rejected',
      dossier,
      plan,
      executor,
      criticVerdict: critic.verdict,
      message: `Repro Critic ${critic.verdict.verdict}: ${critic.verdict.reason}`,
    };
  }

  return {
    status: 'reproduced',
    dossier,
    plan,
    executor,
    criticVerdict: critic.verdict,
    message: 'Repro reproduced reliably and approved by Critic.',
  };
}

/**
 * Walk the executor's run_repro transcript entries. If any of their
 * stderr/stdout matches a known credential-error pattern AND the inferred env
 * vars are missing from the process environment, return a structured signal.
 */
function detectCredentialsFromExecutor(
  executor: ReproExecutorResult,
  env: NodeJS.ProcessEnv,
): ReproV2Outcome['credentialsTerminal'] | null {
  // The executor's transcript isn't directly attached to the result, but the
  // ReproExecutorResult inherits AgentLoopResult and includes a transcriptSummary.
  // For credential detection we need raw stderr — which is on the embedded
  // transcript. We piggyback on `(executor as any).transcript` if present;
  // otherwise we fall back to the transcriptSummary string heuristic.
  const transcript: Array<{ tool?: string; result?: any }> | undefined = (executor as any).transcript;
  const candidates: Array<{ stdout: string; stderr: string }> = [];
  if (Array.isArray(transcript)) {
    for (const e of transcript) {
      if (e.tool !== 'run_repro') continue;
      const r = e.result as any;
      if (!r || typeof r !== 'object') continue;
      candidates.push({ stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') });
    }
  }
  if (candidates.length === 0 && executor.transcriptSummary) {
    candidates.push({ stdout: '', stderr: executor.transcriptSummary });
  }
  for (const c of candidates) {
    const detected = detectCredentialError(c.stdout, c.stderr);
    if (!detected.isCredentialError) continue;
    const missing = detected.inferredEnvVars.filter((v) => !env[v] || env[v]?.length === 0);
    if (missing.length === 0) continue; // env is set — not actually a credentials block
    return {
      inferredEnvVars: missing,
      matchedPattern: detected.matchedPattern ?? null,
      stderrTail: c.stderr.slice(-2000),
    };
  }
  return null;
}
