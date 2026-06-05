/**
 * Repro orchestrator: Analyst → Builder → Deterministic Repro Oracle.
 *
 * One authoritative deterministic gate decides candidate validity. LLMs are
 * only advisory rankers over already-valid candidates.
 */

import { runAnalyst } from '../analyst/analyst';
import { DossierStore, buildReproOracleSpec, type DossierSnapshot, type ReproRecipe } from '../analyst/dossier';
import { runReproBuilder, type ReproBuilderResult, type BuilderRejectStage } from './builder';
import { rankValidReproCandidates, type ReproAdvisoryRankResult } from './advisory-ranker';
import type { DeterministicExecutorResult } from './executor';
import type { ReproVerdict } from './critic';
import {
  runDeterministicReproOracle,
  type DeterministicReproOracleResult,
} from './deterministic-oracle';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';
import { deriveEditableInstallsFromSuspectPaths, mergeEditableInstallCandidates } from './repro-hints';
import type { IssueCodeSnippet } from './repro-hints';
import type { SemanticSuspectSeed } from '../analyst/semantic-search';
import type { TestInfraProfile } from './test-infra-fingerprint';
import { assembleReproTest } from './test-assembler';

type CandidateSource = 'builder';
type CandidateStatus =
  | 'generation_failed'
  | 'sandbox_failed'
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
   * Verbatim fenced code blocks lifted from the issue body.
   */
  issueSnippets?: IssueCodeSnippet[];
  /**
   * Raw issue body.
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
  /** Optional test infrastructure fingerprint for the affected package. */
  testInfraProfile?: TestInfraProfile | null;
  /**
   * Optional git client for reading repo file contents. When provided together
   * with testInfraProfile, enables the deterministic Test Assembler (Stage A)
   * which builds a working test from known-good patterns without an LLM loop.
   */
  gitClient?: { getFileContents(repo: string, path: string, ref: string): Promise<{ok: boolean, content?: string}> };
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
  status:
    | 'reproduced'
    | 'credentials_required'
    | 'not_reproduced'
    | 'not_runnable'
    | 'sandbox_failed'
    | 'api_unavailable';
  dossier: DossierStore;
  /**
   * When status==='sandbox_failed', the raw error message from the sandbox.
   * Surfaces to the pipeline driver so it can be fed back to the analyst as
   * a corrective hint on the next attempt.
   */
  sandboxError?: string;
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
   * Populated when status === 'credentials_required'. Lifted from
   * the recipe's `requiresCredentials` (static check before Executor) or
   * from run_repro stderr that matched a known credential-error pattern.
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

// eslint-disable-next-line no-console
const log = (msg: string) => console.log(msg);

export async function runReproV2(args: RunReproV2Args): Promise<ReproV2Outcome> {
  const dossier = args.dossier ?? new DossierStore();
  const runtimeEnv = args.env ?? process.env;
  const candidates: ReproCandidateEvaluation[] = [];

  // Stage A: Analyst (skipped if dossier was passed in)
  const analystRanThisAttempt = !args.dossier || !dossier.latest();
  if (analystRanThisAttempt) {
    const analystWorkspace = createAnalystSemanticScopedWorkspace(
      args.workspace,
      args.semanticSuspectSeed ?? null
    );
    const analyst = await runAnalyst({
      issue: args.issue,
      repo: args.repo,
      workspace: analystWorkspace,
      sandbox: args.sandbox,
      attemptId: args.attemptId,
      dossier,
      carryforwardSummary: args.carryforwardSummary,
      semanticSuspectSeed: args.semanticSuspectSeed ?? null,
      testInfraProfile: args.testInfraProfile,
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
  const hasSemanticSeedScope =
    !!args.semanticSuspectSeed &&
    ((args.semanticSuspectSeed.suspectFiles?.length ?? 0) > 0 ||
      (args.semanticSuspectSeed.suspectSymbols?.length ?? 0) > 0);
  const suspectSymbols = snapshot.body.suspectSymbols ?? [];
  const hasReproSpec = !!(snapshot.body.candidateRepro || (snapshot.body as any).reproFiles);
  if (analystRanThisAttempt && hasSemanticSeedScope && suspectSymbols.length > 0 && !hasReproSpec) {
    return {
      status: 'not_runnable',
      dossier,
      candidates,
      message:
        `Analyst dossier is missing required candidateRepro for semantic-seeded repro ` +
        `(suspectSymbols=${suspectSymbols.length}). Halting before Builder/Prober.`,
    };
  }

  const oracleSpec =
    snapshot.body.oracleSpec ??
    buildReproOracleSpec(snapshot.body.suspectSymbols, snapshot.body.preconditions) ??
    {
      suspect_path_assertions: [],
      precondition_assertions: [],
    };

  // Stage A: Deterministic Test Assembly
  // Replaces the LLM-based Prober entirely. The assembler reads the suspect
  // function source, finds the tracker base class, and builds a working test
  // from known-good patterns — no LLM creativity needed.
  let assembledTest: import('./test-assembler').AssembledTest | null = null;
  if (args.testInfraProfile && args.gitClient) {
    try {
      assembledTest = await assembleReproTest({
        dossierSnapshot: snapshot,
        testInfraProfile: args.testInfraProfile,
        gitClient: args.gitClient,
        repoFullName: args.repo.fullName,
        ref: 'main',
      });
      if (assembledTest) {
        log('[v2-orchestrator] assembled test: type=' + assembledTest.bugType + ' path=' + assembledTest.testEntryPoint);
      }
    } catch (err: any) {
      log('[v2-orchestrator] test assembly failed (continuing): ' + (err?.message ?? err));
    }
  }

  // Stage B0: Inject assembled test into the snapshot so the Builder uses it
  if (assembledTest) {
    // Build a reproFilesCandidate block so the Builder's committed path is taken.
    const reproFilesCandidate = {
      reproFiles: assembledTest.reproFiles,
      testEntryPoint: assembledTest.testEntryPoint,
      installSpec: assembledTest.installSpec,
      expectedFailureOutput: '',
      fixHypothesis: { file: '', description: assembledTest.rationale },
      rationale: assembledTest.rationale,
    };

    // Synthetic candidateRepro with reproFilesCandidate wired in — Builder will
    // route directly to runReproFilesPath (write to branch, push, GHA pytest).
    const syntheticCandidate = {
      version: 1 as const,
      source: 'derived' as const,
      failureMode: 'wrong_return' as const,
      testSource: assembledTest.reproFiles[0]?.content ?? '',
      candidateTestPath: assembledTest.testEntryPoint.split('::')[0],
      imports: [],
      setup: '',
      pipInstalls: [],
      requiresCredentials: [],
      preconditionsSatisfied: [],
      rationale: assembledTest.rationale,
      reproFilesCandidate,
    } as any;

    // Update snapshot body with the assembled test
    (snapshot.body as any).reproFiles = {
      reproFiles: assembledTest.reproFiles,
      testEntryPoint: assembledTest.testEntryPoint,
      installSpec: assembledTest.installSpec,
    };
    (snapshot.body as any).candidateRepro = syntheticCandidate;
  }

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

    if (oracle.verdict === 'sandbox_failed') {
      candidate.status = 'sandbox_failed';
      candidate.message = oracle.message;
      continue;
    }

    candidate.status = 'invalid';
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

    return {
      status: 'reproduced',
      dossier,
      recipe: selected.recipe,
      plan: selected.plan,
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

  const allSandboxFailed =
    candidates.length > 0 &&
    candidates.every((candidate) => candidate.status === 'sandbox_failed');
  if (allSandboxFailed) {
    return {
      status: 'sandbox_failed',
      dossier,
      ...(builder ? { builder } : {}),
      ...(builderRejectStage ? { builderRejectStage } : {}),
      candidates,
      message: buildSandboxFailedMessage(candidates),
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

function createAnalystSemanticScopedWorkspace(
  workspace: WorkspaceReader & WorkspaceWriter,
  semanticSuspectSeed: SemanticSuspectSeed | null
): WorkspaceReader & WorkspaceWriter {
  const allowedFiles = dedupeNormalizedPaths(semanticSuspectSeed?.suspectFiles ?? []);
  if (allowedFiles.length === 0) return workspace;

  const allowedFileSet = new Set(allowedFiles);
  return {
    ...workspace,
    async readFile(path: string): Promise<string | null> {
      const normalized = normalizeRepoPath(path);
      if (!allowedFileSet.has(normalized)) return null;
      return workspace.readFile(path);
    },
    async listDir(path: string): Promise<{ name: string; isDir: boolean }[]> {
      const normalizedDir = normalizeRepoPath(path);
      if (
        normalizedDir !== '.' &&
        !allowedFiles.some((filePath) => isPathWithinDirectory(filePath, normalizedDir))
      ) {
        return [];
      }
      const entries = await workspace.listDir(path);
      return entries.filter((entry) => {
        const entryPath = normalizeRepoPath(
          normalizedDir === '.' ? entry.name : `${normalizedDir}/${entry.name}`
        );
        if (entry.isDir) {
          return allowedFiles.some((filePath) => isPathWithinDirectory(filePath, entryPath));
        }
        return allowedFileSet.has(entryPath);
      });
    },
    async grep(
      pattern: string,
      paths: string[] | undefined,
      flags: { caseInsensitive?: boolean }
    ): Promise<ReturnType<WorkspaceReader['grep']> extends Promise<infer T> ? T : never> {
      const scopedPaths = clampPathsToAllowedFiles(paths, allowedFiles);
      return workspace.grep(pattern, scopedPaths, flags);
    },
    async gitLog(
      path: string | undefined,
      n: number
    ): Promise<ReturnType<WorkspaceReader['gitLog']> extends Promise<infer T> ? T : never> {
      if (!path) {
        return workspace.gitLog(allowedFiles[0], n);
      }
      const normalized = normalizeRepoPath(path);
      if (!allowedFileSet.has(normalized)) return [];
      return workspace.gitLog(path, n);
    },
    async gitBlame(
      path: string,
      lineStart?: number,
      lineEnd?: number
    ): Promise<ReturnType<WorkspaceReader['gitBlame']> extends Promise<infer T> ? T : never> {
      const normalized = normalizeRepoPath(path);
      if (!allowedFileSet.has(normalized)) return [];
      return workspace.gitBlame(path, lineStart, lineEnd);
    },
  };
}

function normalizeRepoPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
  return normalized.length > 0 ? normalized : '.';
}

function dedupeNormalizedPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const normalized = normalizeRepoPath(raw);
    if (normalized === '.' || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function isPathWithinDirectory(filePath: string, directoryPath: string): boolean {
  const normalizedDir = normalizeRepoPath(directoryPath);
  if (normalizedDir === '.') return true;
  const normalizedFile = normalizeRepoPath(filePath);
  return normalizedFile === normalizedDir || normalizedFile.startsWith(`${normalizedDir}/`);
}

function clampPathsToAllowedFiles(paths: string[] | undefined, allowedFiles: string[]): string[] {
  if (!paths || paths.length === 0) return allowedFiles;
  const requested = dedupeNormalizedPaths(paths);
  if (requested.length === 0) return allowedFiles;
  const scoped = requested.filter((candidatePath) =>
    allowedFiles.some((filePath) => isPathWithinDirectory(filePath, candidatePath))
  );
  return scoped.length > 0 ? scoped : allowedFiles;
}

function buildNoReproMessage(candidates: ReproCandidateEvaluation[]): string {
  const builderUnavailable =
    candidates.length === 0 ||
    candidates.every(
      (candidate) => candidate.status === 'generation_failed' && candidate.builderRejectStage === 'no_candidate'
    );
  if (builderUnavailable) {
    return `Builder had no candidate repro to evaluate.`;
  }
  return `Deterministic repro oracle rejected all ${candidates.length} candidates.`;
}

function buildSandboxFailedMessage(candidates: ReproCandidateEvaluation[]): string {
  const details = candidates
    .map((candidate) => `${candidate.candidateId}=${candidate.message}`)
    .join(' | ');
  return (
    `sandbox_failed: all ${candidates.length} candidate(s) failed sandbox lifecycle before runnable repro evidence.` +
    (details ? ` Details: ${details}` : '')
  );
}

