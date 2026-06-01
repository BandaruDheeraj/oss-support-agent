/**
 * Repro orchestrator: Analyst → Builder + best-of-N Prober sampling →
 * Deterministic Repro Oracle.
 *
 * One authoritative deterministic gate decides candidate validity. LLMs are
 * only advisory rankers over already-valid candidates.
 */

import { runAnalyst } from '../analyst/analyst';
import { DossierStore, buildReproOracleSpec, type DossierSnapshot, type ReproRecipe } from '../analyst/dossier';
import { runReproProber, type ReproProberResult } from './prober';
import { runReproBuilder, type ReproBuilderResult, type BuilderRejectStage } from './builder';
import { rankValidReproCandidates, type ReproAdvisoryRankResult } from './advisory-ranker';
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
import type { SemanticSuspectSeed } from '../analyst/semantic-search';

const DEFAULT_PROBER_SAMPLE_COUNT = 3;
const DEFAULT_PROBER_TEMPERATURE = 0.7;
const PROBER_SAMPLE_COUNT_ENV = 'OSA_REPRO_PROBER_SAMPLES';
const PROBER_TEMPERATURE_ENV = 'OSA_REPRO_PROBER_TEMPERATURE';
const OPENINFERENCE_REPO_SUFFIX = '/openinference';

type ProberSandboxPreflightStep =
  | {
      kind: 'pip_install';
      label: string;
      spec: string;
    }
  | {
      kind: 'run_python';
      label: string;
      snippet: string;
    };

const OPENINFERENCE_PROBER_PREFLIGHT_STEPS: readonly ProberSandboxPreflightStep[] = [
  {
    kind: 'pip_install',
    label: 'pip install -e python/openinference-semantic-conventions',
    spec: '-e python/openinference-semantic-conventions',
  },
  {
    kind: 'pip_install',
    label: 'pip install -e python/openinference-instrumentation',
    spec: '-e python/openinference-instrumentation',
  },
  {
    kind: 'pip_install',
    label: 'pip install -e python/instrumentation/openinference-instrumentation-smolagents',
    spec: '-e python/instrumentation/openinference-instrumentation-smolagents',
  },
  {
    kind: 'pip_install',
    label: 'pip install smolagents',
    spec: 'smolagents',
  },
  {
    kind: 'run_python',
    label: 'python -c "from openinference.instrumentation.smolagents import SmolagentsInstrumentor"',
    snippet: 'from openinference.instrumentation.smolagents import SmolagentsInstrumentor',
  },
] as const;

type CandidateSource = 'builder' | 'prober';
type CandidateStatus =
  | 'generation_failed'
  | 'setup_failed'
  | 'invalid'
  | 'valid'
  | 'credentials_required';

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
  /**
   * Semantic retrieval seed computed once per pipeline run after clone and
   * before Analyst execution. Analyst uses this as the primary suspect-file
   * and suspect-symbol starting point.
   */
  semanticSuspectSeed?: SemanticSuspectSeed | null;
  /** Number of Prober samples to run in parallel. */
  proberSampleCount?: number;
  /** Sampling temperature for Prober best-of-N generation. */
  proberTemperature?: number;
}

export interface ReproCandidateEvaluation {
  candidateId: string;
  source: CandidateSource;
  sampleIndex: number;
  status: CandidateStatus;
  message: string;
  recipe?: ReproRecipe;
  plan?: {
    candidateTestPath: string;
    sentinelString: string;
    expectedFailureSignature: string;
    approach: string;
  };
  prober?: ReproProberResult;
  builder?: ReproBuilderResult;
  builderRejectStage?: BuilderRejectStage;
  executor?: DeterministicExecutorResult;
  oracle?: DeterministicReproOracleResult;
  credentialsTerminal?: {
    inferredEnvVars: string[];
    matchedPattern: string | null;
    stderrTail?: string;
  };
}

export interface ReproV2Outcome {
  status: 'reproduced' | 'credentials_required' | 'not_reproduced' | 'api_unavailable';
  dossier: DossierStore;
  /** The recipe authored by the selected candidate (when reproduced). */
  recipe?: ReproRecipe;
  /**
   * Back-compat alias: callers (PR builders, run-v2 driver) read
   * `outcome.plan?.candidateTestPath` / `.sentinelString` / `.approach`.
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
   * Granular Builder stage when the Builder rejected. null when the Builder
   * built the recipe.
   */
  builderRejectStage?: BuilderRejectStage;
  executor?: DeterministicExecutorResult;
  criticVerdict?: ReproVerdict;
  oracle?: DeterministicReproOracleResult;
  advisoryRanker?: ReproAdvisoryRankResult;
  selectedCandidateId?: string;
  candidates: ReproCandidateEvaluation[];
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
  apiUnavailable?: {
    stage: 'analyst_preflight';
    reason: string;
    routeId: string | null;
    modelId: string | null;
  };
  message: string;
}

interface ValidCandidate extends ReproCandidateEvaluation {
  status: 'valid';
  recipe: ReproRecipe;
  executor: DeterministicExecutorResult;
  oracle: DeterministicReproOracleResult;
}

type AsyncLock = <T>(task: () => Promise<T>) => Promise<T>;

export async function runReproV2(args: RunReproV2Args): Promise<ReproV2Outcome> {
  const dossier = args.dossier ?? new DossierStore();
  const runtimeEnv = args.env ?? process.env;
  const candidates: ReproCandidateEvaluation[] = [];

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
      semanticSuspectSeed: args.semanticSuspectSeed ?? null,
    });
    if (!analyst.snapshot) {
      if (analyst.terminated === 'api_unavailable') {
        return {
          status: 'api_unavailable',
          dossier,
          candidates,
          apiUnavailable:
            analyst.apiUnavailable ?? {
              stage: 'analyst_preflight',
              reason: analyst.reason ?? 'analyst api preflight failed',
              routeId: null,
              modelId: null,
            },
          message:
            `Analyst API preflight failed` +
            `${analyst.reason ? ` (${analyst.reason})` : ''}`,
        };
      }
      return {
        status: 'not_reproduced',
        dossier,
        candidates,
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

  const proberSampleCount = resolveProberSampleCount(args.proberSampleCount, runtimeEnv);
  const proberTemperature = resolveProberTemperature(args.proberTemperature, runtimeEnv);
  // eslint-disable-next-line no-console
  console.log(
    `[v2-orchestrator] attempt=${args.attemptId} prober_samples=${proberSampleCount} prober_temperature=${proberTemperature}`
  );

  // Stage B0: Deterministic Builder as candidate 0.
  let builder: ReproBuilderResult | undefined;
  let builderRejectStage: BuilderRejectStage | undefined;
  try {
    builder = await runReproBuilder({
      attemptId: args.attemptId,
      dossierSnapshot: snapshot,
      repo: args.repo,
      workspace: args.workspace,
      sandbox: args.sandbox,
      env: runtimeEnv,
    });
  } catch (err) {
    // Builder is defensive; an unexpected throw should not tank the orchestrator.
    // eslint-disable-next-line no-console
    console.log(
      `[v2-orchestrator] attempt=${args.attemptId} builder_threw=${err instanceof Error ? err.message : String(err)}`
    );
  }
  const builderCandidate = buildBuilderCandidate({
    builder,
    attemptId: args.attemptId,
    runtimeEnv,
  });
  builderRejectStage = builderCandidate.builderRejectStage;
  candidates.push(builderCandidate);

  const requiresOpenInferencePreflight =
    proberSampleCount > 0 && shouldRunOpenInferencePreflight(args.repo.fullName);
  if (requiresOpenInferencePreflight) {
    const preflight = await runOpenInferenceProberPreflight({
      sandbox: args.sandbox,
      attemptId: args.attemptId,
    });
    if (!preflight.ok) {
      candidates.push(...buildBlockedProberCandidates(proberSampleCount, preflight.message));
      return {
        status: 'not_reproduced',
        dossier,
        ...(builder ? { builder } : {}),
        ...(builderRejectStage ? { builderRejectStage } : {}),
        candidates,
        message: preflight.message,
      };
    }
  }

  // Stage B1: K Prober samples at temperature in parallel.
  const lock = createAsyncLock();
  const proberRuns = Array.from({ length: proberSampleCount }, (_, idx) => {
    const sampleIndex = idx + 1;
    return runProberSample({
      args,
      snapshot,
      sampleIndex,
      temperature: proberTemperature,
      editableInstallCandidates: effectiveEditableInstalls,
      runtimeEnv,
      sandbox: createSerializedSandboxView(args.sandbox, lock),
    });
  });
  const proberCandidates = await Promise.all(proberRuns);
  candidates.push(...proberCandidates);

  // Stage C: deterministic oracle over every candidate with a recipe.
  for (const candidate of candidates) {
    if (!candidate.recipe) continue;
    const oracle = await runDeterministicReproOracle({
      attemptId: `${args.attemptId}:${candidate.candidateId}`,
      recipe: candidate.recipe,
      oracleSpec,
      suspectSymbols: snapshot.body.suspectSymbols,
      repoLanguage: args.repo.language,
      workspace: args.workspace,
      sandbox: args.sandbox,
      editableInstallFallbacks: effectiveEditableInstalls,
      env: runtimeEnv,
      semanticConfidence: snapshot.body.semanticConfidence,
    });
    candidate.executor = oracle.executor;
    candidate.oracle = oracle;
    candidate.message = oracle.message;

    if (oracle.verdict === 'valid') {
      candidate.status = 'valid';
      continue;
    }

    if (oracle.verdict === 'credentials_required' && oracle.credentialsTerminal) {
      candidate.status = 'credentials_required';
      candidate.credentialsTerminal = oracle.credentialsTerminal;
      candidate.message = `Oracle detected missing credentials: ${oracle.credentialsTerminal.inferredEnvVars.join(', ')}`;
      continue;
    }

    candidate.status = 'invalid';
    if (candidate.prober) {
      // Keep transcript-based credential detection unchanged.
      const credResult = detectCredentialsFromTranscript(candidate.prober.transcript, runtimeEnv);
      if (credResult) {
        candidate.status = 'credentials_required';
        candidate.credentialsTerminal = credResult;
        candidate.message = `Prober transcript indicates missing credentials: ${credResult.inferredEnvVars.join(', ')}`;
      }
    }
  }

  const validCandidates = candidates.filter(isValidCandidate);
  if (validCandidates.length > 0) {
    let selected = validCandidates[0];
    let advisoryRanker: ReproAdvisoryRankResult | undefined;
    if (validCandidates.length > 1) {
      const rankResult = await rankValidReproCandidates({
        attemptId: args.attemptId,
        issue: args.issue,
        candidates: validCandidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          source: candidate.source,
          sampleIndex: candidate.sampleIndex,
          recipe: candidate.recipe,
          oracle: candidate.oracle,
        })),
      });
      advisoryRanker = rankResult;
      const ranked = validCandidates.find((candidate) => candidate.candidateId === rankResult.selectedCandidateId);
      if (ranked) {
        selected = ranked;
      }
    }

    if (selected.source === 'prober') {
      appendRecipeSnapshot({
        dossier,
        baseSnapshot: snapshot,
        issueNumber: args.issue.number,
        attemptId: args.attemptId,
        recipe: selected.recipe,
      });
    }

    return {
      status: 'reproduced',
      dossier,
      recipe: selected.recipe,
      plan: selected.plan,
      ...(selected.prober ? { prober: selected.prober } : {}),
      ...(builder ? { builder } : {}),
      ...(builderRejectStage ? { builderRejectStage } : {}),
      executor: selected.executor,
      oracle: selected.oracle,
      ...(advisoryRanker ? { advisoryRanker } : {}),
      selectedCandidateId: selected.candidateId,
      candidates,
      message:
        validCandidates.length > 1 && advisoryRanker
          ? `Repro reproduced reliably. Selected ${selected.candidateId} via advisory ranker: ${advisoryRanker.reason}`
          : `Repro reproduced reliably with ${selected.candidateId}.`,
    };
  }

  const credentialCandidate = candidates.find((candidate) => candidate.status === 'credentials_required');
  if (credentialCandidate?.credentialsTerminal) {
    return {
      status: 'credentials_required',
      dossier,
      ...(credentialCandidate.recipe ? { recipe: credentialCandidate.recipe } : {}),
      ...(credentialCandidate.plan ? { plan: credentialCandidate.plan } : {}),
      ...(credentialCandidate.prober ? { prober: credentialCandidate.prober } : {}),
      ...(builder ? { builder } : {}),
      ...(builderRejectStage ? { builderRejectStage } : {}),
      ...(credentialCandidate.executor ? { executor: credentialCandidate.executor } : {}),
      ...(credentialCandidate.oracle ? { oracle: credentialCandidate.oracle } : {}),
      credentialsTerminal: credentialCandidate.credentialsTerminal,
      selectedCandidateId: credentialCandidate.candidateId,
      candidates,
      message: `Repro halted on missing credentials (${credentialCandidate.credentialsTerminal.matchedPattern ?? 'unknown pattern'}): ${credentialCandidate.credentialsTerminal.inferredEnvVars.join(', ')}`,
    };
  }

  return {
    status: 'not_reproduced',
    dossier,
    ...(builder ? { builder } : {}),
    ...(builderRejectStage ? { builderRejectStage } : {}),
    candidates,
    message: buildNoReproMessage(candidates),
  };
}

function shouldRunOpenInferencePreflight(repoFullName: string): boolean {
  return repoFullName.toLowerCase().endsWith(OPENINFERENCE_REPO_SUFFIX);
}

function buildBlockedProberCandidates(sampleCount: number, message: string): ReproCandidateEvaluation[] {
  return Array.from({ length: sampleCount }, (_, idx) => {
    const sampleIndex = idx + 1;
    return {
      candidateId: `candidate-${sampleIndex}`,
      source: 'prober',
      sampleIndex,
      status: 'setup_failed',
      message,
    };
  });
}

async function runOpenInferenceProberPreflight(args: {
  sandbox: SandboxHandle;
  attemptId: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  for (const step of OPENINFERENCE_PROBER_PREFLIGHT_STEPS) {
    try {
      const run =
        step.kind === 'pip_install'
          ? await args.sandbox.pipInstall(step.spec)
          : await args.sandbox.runPython(step.snippet);
      if (run.exitCode !== 0) {
        const tail = collapseWhitespace(run.stderr || run.stdout).slice(-600);
        const message =
          `sandbox_setup_failed: ${step.label} failed (exitCode=${run.exitCode}).` +
          (tail ? ` Output tail: ${tail}` : '');
        // eslint-disable-next-line no-console
        console.log(`[v2-orchestrator] attempt=${args.attemptId} ${message}`);
        return { ok: false, message };
      }
    } catch (err) {
      const detail = collapseWhitespace(err instanceof Error ? err.message : String(err));
      const message = `sandbox_setup_failed: ${step.label} threw: ${detail}`;
      // eslint-disable-next-line no-console
      console.log(`[v2-orchestrator] attempt=${args.attemptId} ${message}`);
      return { ok: false, message };
    }
  }
  return { ok: true };
}

function buildBuilderCandidate(args: {
  builder: ReproBuilderResult | undefined;
  attemptId: string;
  runtimeEnv: NodeJS.ProcessEnv;
}): ReproCandidateEvaluation {
  const builder = args.builder;
  const candidateId = 'candidate-0';
  if (!builder) {
    return {
      candidateId,
      source: 'builder',
      sampleIndex: 0,
      status: 'generation_failed',
      message: 'Builder did not produce a candidate recipe.',
    };
  }

  if (builder.ok && builder.recipe) {
    return {
      candidateId,
      source: 'builder',
      sampleIndex: 0,
      status: 'generation_failed',
      message: 'Builder produced candidate recipe.',
      recipe: builder.recipe,
      plan: toPlanProjection(builder.recipe),
      builder,
    };
  }

  const builderRejectStage = builder.rejectStage;
  if (builder.missingCredentials && builder.missingCredentials.length > 0) {
    return {
      candidateId,
      source: 'builder',
      sampleIndex: 0,
      status: 'credentials_required',
      message: `Builder candidate requires credentials: ${builder.missingCredentials.join(', ')}`,
      builder,
      builderRejectStage,
      credentialsTerminal: {
        inferredEnvVars: builder.missingCredentials.filter((name) => !args.runtimeEnv[name] || args.runtimeEnv[name]?.length === 0),
        matchedPattern: 'builder:requiresCredentials',
      },
    };
  }

  return {
    candidateId,
    source: 'builder',
    sampleIndex: 0,
    status: 'generation_failed',
    message: `Builder rejected candidate at stage ${builderRejectStage}.`,
    builder,
    builderRejectStage,
  };
}

async function runProberSample(args: {
  args: RunReproV2Args;
  snapshot: DossierSnapshot;
  sampleIndex: number;
  temperature: number;
  editableInstallCandidates: string[];
  runtimeEnv: NodeJS.ProcessEnv;
  sandbox: SandboxHandle;
}): Promise<ReproCandidateEvaluation> {
  const candidateId = `candidate-${args.sampleIndex}`;
  const forcedPath = buildProberCandidatePath(args.args.issue.number, args.sampleIndex);
  const sampleAttemptId = `${args.args.attemptId}:prober:${args.sampleIndex}`;
  const sampleDossier = cloneDossier(args.snapshot);
  const sampleSnapshot = sampleDossier.latest()!;

  let prober: ReproProberResult;
  try {
    prober = await runReproProber({
      attemptId: sampleAttemptId,
      dossier: sampleDossier,
      dossierSnapshot: sampleSnapshot,
      issue: args.args.issue,
      repo: args.args.repo,
      workspace: args.args.workspace,
      sandbox: args.sandbox,
      editableInstallCandidates: args.editableInstallCandidates,
      issueSnippets: args.args.issueSnippets,
      issueBody: args.args.issueBody,
      temperature: args.temperature,
      forcedCandidateTestPath: forcedPath,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      candidateId,
      source: 'prober',
      sampleIndex: args.sampleIndex,
      status: isSandboxSetupFailure(detail) ? 'setup_failed' : 'generation_failed',
      message: `Prober sample failed to run: ${detail}`,
    };
  }

  const proberAuthoritative = prober.terminated === 'done' && !!prober.recipe;
  if (!proberAuthoritative) {
    const credResult = detectCredentialsFromTranscript(prober.transcript, args.runtimeEnv);
    if (credResult) {
      return {
        candidateId,
        source: 'prober',
        sampleIndex: args.sampleIndex,
        status: 'credentials_required',
        message: `Prober sample requires credentials: ${credResult.inferredEnvVars.join(', ')}`,
        prober,
        credentialsTerminal: credResult,
      };
    }
    if (!prober.recipe) {
      const setupFailureDetail = inferProberSetupFailureDetail(prober);
      if (setupFailureDetail) {
        return {
          candidateId,
          source: 'prober',
          sampleIndex: args.sampleIndex,
          status: 'setup_failed',
          message: `Prober sample failed sandbox setup before recipe generation: ${setupFailureDetail}`,
          prober,
        };
      }
      return {
        candidateId,
        source: 'prober',
        sampleIndex: args.sampleIndex,
        status: 'generation_failed',
        message: `Prober sample terminated without recipe (${prober.terminated}${prober.reason ? `: ${prober.reason}` : ''})`,
        prober,
      };
    }
    return {
      candidateId,
      source: 'prober',
      sampleIndex: args.sampleIndex,
      status: 'generation_failed',
      message:
        `Prober sample produced a recipe but did not self-verify it ` +
        `(terminated=${prober.terminated}${prober.reason ? `, reason="${prober.reason}"` : ''}). ` +
        `verifiedState=[${prober.verifiedSummary}].`,
      recipe: prober.recipe,
      plan: toPlanProjection(prober.recipe),
      prober,
    };
  }

  const recipe = prober.recipe as ReproRecipe;
  return {
    candidateId,
    source: 'prober',
    sampleIndex: args.sampleIndex,
    status: 'generation_failed',
    message: 'Prober sample produced candidate recipe.',
    recipe,
    plan: toPlanProjection(recipe),
    prober,
  };
}

function toPlanProjection(recipe: ReproRecipe): ReproV2Outcome['plan'] {
  return {
    candidateTestPath: recipe.candidateTestPath,
    sentinelString: recipe.sentinelString,
    expectedFailureSignature: recipe.expectedFailureSignature ?? '',
    approach: recipe.approach ?? '',
  };
}

function isValidCandidate(candidate: ReproCandidateEvaluation): candidate is ValidCandidate {
  return (
    candidate.status === 'valid' &&
    !!candidate.recipe &&
    !!candidate.oracle &&
    !!candidate.executor
  );
}

function buildProberCandidatePath(issueNumber: number, sampleIndex: number): string {
  return `tests/repro/test_issue_${issueNumber}_candidate_${sampleIndex}.py`;
}

function cloneDossier(snapshot: DossierSnapshot): DossierStore {
  const cloned = new DossierStore();
  cloned.append({ ...snapshot.body });
  return cloned;
}

function appendRecipeSnapshot(args: {
  dossier: DossierStore;
  baseSnapshot: DossierSnapshot;
  issueNumber: number;
  attemptId: string;
  recipe: ReproRecipe;
}): void {
  args.dossier.append({
    ...args.baseSnapshot.body,
    issueNumber: args.issueNumber,
    attemptId: args.attemptId,
    reproRecipe: args.recipe,
  });
}

function createAsyncLock(): AsyncLock {
  let queue = Promise.resolve();
  return async function withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

function createSerializedSandboxView(base: SandboxHandle, lock: AsyncLock): SandboxHandle {
  let reproTestPath: string | undefined;
  return {
    runPython: (snippet, env) => lock(() => base.runPython(snippet, env)),
    pipInstall: (spec) => lock(() => base.pipInstall(spec)),
    runRepro: () =>
      lock(async () => {
        if (reproTestPath) {
          base.setReproTestPath(reproTestPath);
        }
        return base.runRepro();
      }),
    runTests: (command) => lock(() => base.runTests(command)),
    pythonModuleCheck: (name) => lock(() => base.pythonModuleCheck(name)),
    listPackages: () => lock(() => base.listPackages()),
    setReproTestPath: (path) => {
      reproTestPath = path;
    },
  };
}

function resolveProberSampleCount(explicit: number | undefined, env: NodeJS.ProcessEnv): number {
  const raw = explicit ?? parseNumberEnv(env[PROBER_SAMPLE_COUNT_ENV]);
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_PROBER_SAMPLE_COUNT;
  return Math.max(0, Math.floor(raw));
}

function resolveProberTemperature(explicit: number | undefined, env: NodeJS.ProcessEnv): number {
  const raw = explicit ?? parseNumberEnv(env[PROBER_TEMPERATURE_ENV]);
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_PROBER_TEMPERATURE;
  return Math.min(2, Math.max(0, raw));
}

function parseNumberEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function inferProberSetupFailureDetail(prober: ReproProberResult): string | null {
  const candidates: string[] = [];
  if (prober.reason) candidates.push(prober.reason);
  for (const entry of prober.transcript) {
    if (entry.result && typeof entry.result === 'object') {
      const result = entry.result as Record<string, unknown>;
      const message = result.message;
      if (typeof message === 'string') candidates.push(message);
      const stderr = result.stderr;
      if (typeof stderr === 'string') candidates.push(stderr);
      const error = result.error;
      if (typeof error === 'string') candidates.push(error);
    } else if (typeof entry.result === 'string') {
      candidates.push(entry.result);
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isSandboxSetupFailure(candidate)) return collapseWhitespace(candidate).slice(0, 320);
  }
  return null;
}

function isSandboxSetupFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('sandbox_setup_failed') ||
    normalized.includes('wait_for_run') ||
    normalized.includes('workflow run did not appear within') ||
    normalized.includes('no ref found for') ||
    normalized.includes('missing fork repro ref') ||
    normalized.includes('missing workflow dispatch ref') ||
    normalized.includes('pre_dispatch_ref')
  );
}

function buildNoReproMessage(candidates: ReproCandidateEvaluation[]): string {
  const setupFailures = candidates.filter((candidate) => candidate.status === 'setup_failed').length;
  const proberCandidates = candidates.filter((candidate) => candidate.source === 'prober');
  const builderCandidates = candidates.filter((candidate) => candidate.source === 'builder');
  const allProberSetupFailed =
    proberCandidates.length > 0 && proberCandidates.every((candidate) => candidate.status === 'setup_failed');
  const builderUnavailable =
    builderCandidates.length === 0 ||
    builderCandidates.every(
      (candidate) => candidate.status === 'generation_failed' && candidate.builderRejectStage === 'no_candidate'
    );
  if (allProberSetupFailed && builderUnavailable) {
    return (
      `sandbox_setup_failed: no candidate passed deterministic repro oracle after evaluating ${candidates.length} candidates; ` +
      `${setupFailures} candidate(s) failed sandbox setup before oracle validation.`
    );
  }
  if (setupFailures > 0) {
    return (
      `No candidate passed deterministic repro oracle after evaluating ${candidates.length} candidates; ` +
      `${setupFailures} candidate(s) failed sandbox setup before oracle validation.`
    );
  }
  return `Deterministic repro oracle rejected all ${candidates.length} candidates.`;
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
