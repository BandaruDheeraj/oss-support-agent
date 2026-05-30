/**
 * Repro orchestrator: Analyst → Builder/Prober → Deterministic Repro Oracle.
 *
 * No LLM gate can halt this stage after candidate generation. Candidate
 * validity is decided only by deterministic oracle criteria.
 */

import { runAnalyst } from '../analyst/analyst';
import { DossierStore, buildReproOracleSpec, type ReproRecipe } from '../analyst/dossier';
import { runReproProber, type ReproProberResult } from './prober';
import { runReproBuilder, type ReproBuilderResult, type BuilderRejectStage } from './builder';
import type { DeterministicExecutorResult } from './executor';
import type { ReproVerdict } from './critic';
import {
  runDeterministicReproOracle,
  type DeterministicReproOracleResult,
} from './deterministic-oracle';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';
import { detectCredentialError } from '../../credentials-check';
import type { IssueCodeSnippet } from './repro-hints';
import { deriveEditableInstallsFromSuspectPaths, mergeEditableInstallCandidates } from './repro-hints';

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
   * Repo-relative dirs containing a Python package manifest, surfaced to the
   * Prober so its draft test can `pip install -e <dir>` for in-repo imports.
   */
  editableInstallCandidates?: string[];
  /**
   * Verbatim fenced code blocks lifted from the issue body, surfaced to the
   * Prober so the first repro draft can mirror the snippet exactly rather
   * than paraphrasing it.
   */
  issueSnippets?: IssueCodeSnippet[];
  /**
   * Raw issue body. Used by the deterministic heavy-framework detector to
   * surface a hint about prose-only issues that name a heavy 3rd-party
   * framework in their reproduction steps.
   */
  issueBody?: string;
  /**
   * Absolute path to the cloned workspace directory. When provided AND the
   * Analyst dossier surfaces suspect symbols, the orchestrator re-derives
   * editable-install candidates by walking up each suspect file path to its
   * nearest package manifest, prioritising those over the initial BFS list.
   */
  workspaceDir?: string;
}

export interface ReproV2Outcome {
  status:
    | 'reproduced'
    | 'critic_rejected'
    | 'executor_failed'
    | 'prober_failed'
    | 'analyst_failed'
    | 'preflight_failed'
    | 'credentials_required';
  dossier: DossierStore;
  /** The recipe authored by the Prober (when produced). */
  recipe?: ReproRecipe;
  /**
   * Back-compat alias: callers (PR builders, run-v2 driver) read
   * `outcome.plan?.candidateTestPath` / `.sentinelString` / `.approach`.
   * The recipe carries all three, so we project a thin plan-shaped view
   * to keep those readers working without a sprawling rewrite.
   *
   * NOTE: This is a read-only projection. New code should read `recipe`.
   */
  plan?: {
    candidateTestPath: string;
    sentinelString: string;
    expectedFailureSignature: string;
    approach: string;
  };
  prober?: ReproProberResult;
  /** Populated when the Builder ran (success or reject). */
  builder?: ReproBuilderResult;
  /**
   * Granular Builder stage when the Builder rejected and we fell through to
   * the Prober (or terminated for credentials). null when the Builder built
   * the recipe.
   */
  builderRejectStage?: BuilderRejectStage;
  executor?: DeterministicExecutorResult;
  criticVerdict?: ReproVerdict;
  oracle?: DeterministicReproOracleResult;
  /**
   * Populated when status === 'credentials_required'. Either lifted from
   * the recipe's `requiresCredentials` (static check before Executor) or
   * from any Prober run_repro transcript entry whose stderr matched a
   * known credential-error pattern (dynamic post-failure detection).
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
  const oracleSpec =
    snapshot.body.oracleSpec ??
    buildReproOracleSpec(snapshot.body.suspectSymbols, snapshot.body.preconditions) ??
    {
      suspect_path_assertions: [],
      precondition_assertions: [],
    };

  // Editable-install candidates: prefer the Analyst's structured
  // reproTargets.editableInstall when present (and non-empty). Falls back
  // to the BFS+walk-up heuristic in repro-hints.ts when the Analyst did
  // not populate the field (legacy dossiers, low-confidence runs).
  let effectiveEditableInstalls = args.editableInstallCandidates ?? [];
  let suspectDerivedForLog: string[] = [];
  let installSource: 'analyst' | 'suspect-derived' | 'fallback' = 'fallback';
  const analystInstalls = snapshot.body.reproTargets?.editableInstall ?? [];
  if (analystInstalls.length > 0) {
    effectiveEditableInstalls = mergeEditableInstallCandidates(analystInstalls, []);
    installSource = 'analyst';
  } else if (args.workspaceDir && (snapshot.body.suspectSymbols ?? []).length > 0) {
    const suspectDerived = deriveEditableInstallsFromSuspectPaths(
      args.workspaceDir,
      snapshot.body.suspectSymbols.map((s) => s.file)
    );
    suspectDerivedForLog = suspectDerived;
    if (suspectDerived.length > 0) {
      effectiveEditableInstalls = mergeEditableInstallCandidates(
        suspectDerived,
        args.editableInstallCandidates ?? []
      );
      installSource = 'suspect-derived';
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `[v2-orchestrator] attempt=${args.attemptId} suspectSymbols=${(snapshot.body.suspectSymbols ?? []).length}` +
      ` installSource=${installSource}` +
      ` analystInstalls=${analystInstalls.length > 0 ? analystInstalls.join('|') : '(none)'}` +
      ` suspectDerivedInstalls=${suspectDerivedForLog.length > 0 ? suspectDerivedForLog.join('|') : '(none)'}` +
      ` effectiveEditableInstalls=${effectiveEditableInstalls.length > 0 ? effectiveEditableInstalls.join('|') : '(none)'}` +
      ` runtimeForbidden=${
        (snapshot.body.reproTargets?.runtimeForbidden ?? []).length > 0
          ? snapshot.body.reproTargets!.runtimeForbidden.join('|')
          : '(none)'
      }`
  );

  // Stage B0: Deterministic Builder.
  //
  // If the Analyst supplied a `candidateRepro`, try to author the recipe
  // without an LLM. Outcomes:
  //   - success → skip Prober, drop the recipe in the dossier, continue
  //     straight to Stage C (Executor).
  //   - credentials missing → short-circuit with credentials_required
  //     (consistent with the post-Executor credentials_required path).
  //   - any other reject (or no candidate at all) → fall through to Prober
  //     with a brief primer so the LLM doesn't re-make the same mistake.
  let builder: ReproBuilderResult | undefined;
  let builderRejectStage: BuilderRejectStage | undefined;
  let builderRecipe: ReproRecipe | undefined;
  try {
    builder = await runReproBuilder({
      attemptId: args.attemptId,
      dossierSnapshot: snapshot,
      repo: args.repo,
      workspace: args.workspace,
      sandbox: args.sandbox,
      env: args.env,
    });
  } catch (err) {
    // Builder is meant to be defensive; an unexpected throw should not
    // tank the orchestrator. Log + fall through to Prober.
    // eslint-disable-next-line no-console
    console.log(
      `[v2-orchestrator] attempt=${args.attemptId} builder_threw=${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (builder?.ok && builder.recipe) {
    builderRecipe = builder.recipe;
    // Persist the Builder-authored recipe onto the dossier so the rest of
    // the pipeline (Executor, Critic) treats it identically to a
    // Prober-authored recipe.
    dossier.append({
      issueNumber: args.issue.number,
      attemptId: args.attemptId,
      evidence: snapshot.body.evidence,
      suspectSymbols: snapshot.body.suspectSymbols,
      preconditions: snapshot.body.preconditions,
      ...(snapshot.body.oracleSpec ? { oracleSpec: snapshot.body.oracleSpec } : {}),
      openQuestions: snapshot.body.openQuestions,
      summary: snapshot.body.summary,
      confidence: snapshot.body.confidence,
      reproRecipe: builderRecipe,
      ...(snapshot.body.candidateRepro ? { candidateRepro: snapshot.body.candidateRepro } : {}),
    });
    // eslint-disable-next-line no-console
    console.log(`[v2-orchestrator] attempt=${args.attemptId} builder_built_recipe=true skipped_prober=true`);
  } else if (builder && !builder.ok) {
    builderRejectStage = builder.rejectStage;
    if (builder.missingCredentials && builder.missingCredentials.length > 0) {
      return {
        status: 'credentials_required',
        dossier,
        builder,
        builderRejectStage,
        credentialsTerminal: {
          inferredEnvVars: builder.missingCredentials,
          matchedPattern: 'builder:requiresCredentials',
        },
        message: `Builder halted on missing credentials: ${builder.missingCredentials.join(', ')}`,
      };
    }
    // eslint-disable-next-line no-console
    console.log(
      `[v2-orchestrator] attempt=${args.attemptId} builder_rejected stage=${builderRejectStage} falling_through_to_prober=true`
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(`[v2-orchestrator] attempt=${args.attemptId} builder_no_candidate=true falling_through_to_prober=true`);
  }

  // Stage B: Prober — draft and probe-verify a recipe.
  //
  // Skipped when the Builder produced a recipe. The Prober's output is
  // null in that case and downstream stages read `builderRecipe`.
  let prober: ReproProberResult | undefined;
  if (!builderRecipe) {
  try {
    prober = await runReproProber({
      attemptId: args.attemptId,
      dossier,
      dossierSnapshot: snapshot,
      issue: args.issue,
      repo: args.repo,
      workspace: args.workspace,
      sandbox: args.sandbox,
      editableInstallCandidates: effectiveEditableInstalls,
      issueSnippets: args.issueSnippets,
      issueBody: args.issueBody,
    });
  } catch (err) {
    return {
      status: 'prober_failed',
      dossier,
      ...(builder ? { builder } : {}),
      ...(builderRejectStage ? { builderRejectStage } : {}),
      message: err instanceof Error ? err.message : String(err),
    };
  }
  }

  // Decide which recipe to run: Builder-authored or Prober-authored.
  let recipe: ReproRecipe;
  if (builderRecipe) {
    recipe = builderRecipe;
  } else {
    // Two failure paths for the Prober-authored branch:
    //   (a) no recipe at all (never called record_evidence), OR
    //   (b) recipe exists but Prober didn't terminate via `done` — meaning
    //       the registry's done-gate never approved it. `terminated === 'done'`
    //       is the *only* signal that proves the recipe self-verified (≥2 failing
    //       run_repro since last write + sentinel match). Any other termination
    //       (abandon / max_turns / error / finished) means the recipe is
    //       unverified and almost guaranteed to fail in the deterministic
    //       Executor — surface a structured failure with the verified-state
    //       ledger so the operator sees what was actually established.
    const proberAuthoritative = prober?.terminated === 'done' && !!prober.recipe;
    if (!prober || !proberAuthoritative) {
      // Credential detection takes precedence — a missing-creds failure is
      // actionable and shouldn't be masked by a generic "prober didn't finish"
      // message. Check transcript patterns first.
      const credResult = prober
        ? detectCredentialsFromTranscript(prober.transcript, args.env ?? process.env)
        : null;
      if (credResult) {
        return {
          status: 'credentials_required',
          dossier,
          prober,
          ...(builder ? { builder } : {}),
          ...(builderRejectStage ? { builderRejectStage } : {}),
          credentialsTerminal: credResult,
          message: `Repro halted on missing credentials (${credResult.matchedPattern ?? 'unknown pattern'}): ${credResult.inferredEnvVars.join(', ')}`,
        };
      }
      // Build a precise failure message that distinguishes "no recipe" from
      // "recipe exists but Prober didn't approve it via done". The latter
      // includes the verified-state ledger so the operator sees why.
      let message: string;
      if (!prober) {
        message = `Builder rejected (${builderRejectStage}) and Prober was skipped`;
      } else if (!prober.recipe) {
        message = `Repro Prober terminated without producing a recipe (${prober.terminated}${prober.reason ? `: ${prober.reason}` : ''})`;
      } else {
        // recipe exists but terminated !== 'done' — most common: abandon.
        message =
          `Repro Prober produced a recipe but did not self-verify it ` +
          `(terminated=${prober.terminated}${prober.reason ? `, reason="${prober.reason}"` : ''}). ` +
          `verifiedState=[${prober.verifiedSummary}]. ` +
          `The done-gate requires ≥2 failing run_repro since last write with the recipe's sentinel observed — ` +
          `running an unverified recipe through the deterministic Executor would predictably fail.`;
      }
      return {
        status: 'prober_failed',
        dossier,
        ...(prober ? { prober } : {}),
        ...(builder ? { builder } : {}),
        ...(builderRejectStage ? { builderRejectStage } : {}),
        message,
      };
    }
    // Past the gate: prober exists, terminated='done', recipe is non-null.
    recipe = prober.recipe as ReproRecipe;
  }

  const planProjection = {
    candidateTestPath: recipe.candidateTestPath,
    sentinelString: recipe.sentinelString,
    expectedFailureSignature: recipe.expectedFailureSignature ?? '',
    approach: recipe.approach ?? '',
  };

  // Stage C: deterministic repro oracle (single authoritative gate).
  const oracle = await runDeterministicReproOracle({
    attemptId: args.attemptId,
    recipe,
    oracleSpec,
    suspectSymbols: snapshot.body.suspectSymbols,
    repoLanguage: args.repo.language,
    workspace: args.workspace,
    sandbox: args.sandbox,
    editableInstallFallbacks: effectiveEditableInstalls,
    env: args.env,
  });
  const executor = oracle.executor;

  if (oracle.verdict === 'credentials_required' && oracle.credentialsTerminal) {
    return {
      status: 'credentials_required',
      dossier,
      recipe,
      plan: planProjection,
      ...(prober ? { prober } : {}),
      ...(builder ? { builder } : {}),
      ...(builderRejectStage ? { builderRejectStage } : {}),
      executor,
      oracle,
      credentialsTerminal: oracle.credentialsTerminal,
      message: `Repro halted on missing credentials (${oracle.credentialsTerminal.matchedPattern ?? 'unknown pattern'}): ${oracle.credentialsTerminal.inferredEnvVars.join(', ')}`,
    };
  }

  if (oracle.verdict !== 'valid') {
    // Keep transcript-based credential detection unchanged.
    const credResult = prober
      ? detectCredentialsFromTranscript(prober.transcript, args.env ?? process.env)
      : null;
    if (credResult) {
      return {
        status: 'credentials_required',
        dossier,
        recipe,
        plan: planProjection,
        ...(prober ? { prober } : {}),
        ...(builder ? { builder } : {}),
        ...(builderRejectStage ? { builderRejectStage } : {}),
        executor,
        oracle,
        credentialsTerminal: credResult,
        message: `Repro halted on missing credentials (${credResult.matchedPattern ?? 'unknown pattern'}): ${credResult.inferredEnvVars.join(', ')}`,
      };
    }
    return {
      status: 'executor_failed',
      dossier,
      recipe,
      plan: planProjection,
      ...(prober ? { prober } : {}),
      ...(builder ? { builder } : {}),
      ...(builderRejectStage ? { builderRejectStage } : {}),
      executor,
      oracle,
      message: oracle.message,
    };
  }

  return {
    status: 'reproduced',
    dossier,
    recipe,
    plan: planProjection,
    ...(prober ? { prober } : {}),
    ...(builder ? { builder } : {}),
    ...(builderRejectStage ? { builderRejectStage } : {}),
    executor,
    oracle,
    message: builderRecipe
      ? 'Repro reproduced reliably (Builder-authored) and passed deterministic oracle.'
      : 'Repro reproduced reliably and passed deterministic oracle.',
  };
}

/**
 * Walk a tool transcript. If any run_repro entry's stderr/stdout matches a
 * known credential-error pattern AND the inferred env vars are missing from
 * the process environment, return a structured signal.
 */
function detectCredentialsFromTranscript(
  transcript: Array<{ tool: string; result: unknown; ok: boolean }>,
  env: NodeJS.ProcessEnv
): ReproV2Outcome['credentialsTerminal'] | null {
  for (const e of transcript) {
    if (e.tool !== 'run_repro') continue;
    const r = e.result as any;
    if (!r || typeof r !== 'object') continue;
    const stdout = String(r.stdout ?? '');
    const stderr = String(r.stderr ?? '');
    const detected = detectCredentialError(stdout, stderr);
    if (!detected.isCredentialError) continue;
    const missing = detected.inferredEnvVars.filter((v) => !env[v] || env[v]?.length === 0);
    if (missing.length === 0) continue;
    return {
      inferredEnvVars: missing,
      matchedPattern: detected.matchedPattern ?? null,
      stderrTail: stderr.slice(-2000),
    };
  }
  return null;
}
