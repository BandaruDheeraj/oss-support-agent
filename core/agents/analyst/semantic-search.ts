import type { ActionsClient } from '../../sandbox-types';
import type { SandboxPhaseFailure, SandboxSession } from '../../sandbox-session';
import type { SemanticConfidence, SuspectSymbol } from './dossier';

const SEMANTIC_MODEL_NAME = 'BAAI/bge-small-en-v1.5';
const SEMANTIC_TOP_K = 5;
const SEMANTIC_WORKFLOW_FILE = 'semantic-search.yml';
const SEMANTIC_ISSUE_TITLE_MAX_CHARS = 4_000;
const SEMANTIC_ISSUE_BODY_MAX_CHARS = 60_000;
const SEMANTIC_LOW_CONFIDENCE_THRESHOLD = 0.6;

interface SemanticScriptResultItem {
  file: string;
  score?: number;
  primaryClass?: string | null;
  primaryFunction?: string | null;
}

interface SemanticScriptResult {
  model: string;
  cacheHit: boolean;
  cacheKey: string;
  indexedFileCount: number;
  instrumentationDirs: string[];
  topScore: number | null;
  results: SemanticScriptResultItem[];
}

export interface SemanticSuspectSeed {
  model: string;
  query: string;
  cacheHit: boolean;
  cacheKey: string;
  indexedFileCount: number;
  instrumentationDirs: string[];
  suspectFiles: string[];
  suspectSymbols: SuspectSymbol[];
  semanticConfidence: SemanticConfidence;
}

export interface BuildSemanticSuspectSeedArgs {
  workspaceDir: string;
  issueTitle: string;
  issueBody?: string;
  affectedModule?: string;
  ghaConfig?: SemanticSearchGhaConfig;
  log?: (message: string) => void;
}

export interface SemanticSearchGhaConfig {
  actionsClient: ActionsClient;
  sandboxSession: SandboxSession;
  repoFullName: string;
  forkFullName: string;
  forkCloneUrl: string;
  branchName: string;
  workflowRepoFullName: string;
  workflowDispatchRef: string;
  timeoutMinutes: number;
}

export async function buildSemanticSuspectSeed(
  args: BuildSemanticSuspectSeedArgs
): Promise<SemanticSuspectSeed | null> {
  const log = args.log ?? (() => {});
  const query = `${args.issueTitle}\n\n${args.issueBody ?? ''}`.trim();
  if (!query) return null;
  if (!args.ghaConfig) {
    log('[semantic-search] skipping semantic seed: gha workflow config unavailable');
    return null;
  }

  const workflowOutput = await runSemanticWorkflow({
    issueTitle: args.issueTitle,
    issueBody: args.issueBody ?? '',
    affectedModule: args.affectedModule?.trim() || '.',
    ghaConfig: args.ghaConfig,
    log,
  });
  const parsed = parseSemanticScriptResult(workflowOutput);
  const suspectFiles = parsed.results.map((r) => normalizeRepoPath(r.file)).filter((p) => p.length > 0);
  const suspectSymbols = dedupeSuspectSymbols(parsed.results.flatMap(resultToSuspectSymbols));
  const semanticConfidence = buildSemanticConfidence(parsed.topScore);

  if (suspectFiles.length === 0 || suspectSymbols.length === 0) {
    log(
      `[semantic-search] no semantic suspects (indexed=${parsed.indexedFileCount}, instrumentationDirs=${parsed.instrumentationDirs.length})`
    );
    return null;
  }

  return {
    model: parsed.model,
    query,
    cacheHit: parsed.cacheHit,
    cacheKey: parsed.cacheKey,
    indexedFileCount: parsed.indexedFileCount,
    instrumentationDirs: parsed.instrumentationDirs.map(normalizeRepoPath),
    suspectFiles,
    suspectSymbols,
    semanticConfidence,
  };
}

interface RunSemanticWorkflowArgs {
  issueTitle: string;
  issueBody: string;
  affectedModule: string;
  ghaConfig: SemanticSearchGhaConfig;
  log: (message: string) => void;
}

async function runSemanticWorkflow(args: RunSemanticWorkflowArgs): Promise<string> {
  const { ghaConfig } = args;
  const branchResult = await ghaConfig.sandboxSession.verifyAndPushBranch();
  if (!branchResult.ok) {
    throw new Error(`semantic workflow pre-dispatch branch check failed: ${formatSessionFailure(branchResult)}`);
  }
  const workflowResult = await ghaConfig.sandboxSession.verifyWorkflowReachability(SEMANTIC_WORKFLOW_FILE);
  if (!workflowResult.ok) {
    throw new Error(
      `semantic workflow pre-dispatch workflow check failed: ${formatSessionFailure(workflowResult)}`
    );
  }

  const issueTitle = limitWorkflowInput(args.issueTitle, SEMANTIC_ISSUE_TITLE_MAX_CHARS);
  const issueBody = limitWorkflowInput(args.issueBody, SEMANTIC_ISSUE_BODY_MAX_CHARS);
  if (issueTitle.truncated || issueBody.truncated) {
    args.log(
      `[semantic-search] workflow inputs truncated (title=${issueTitle.value.length}, body=${issueBody.value.length})`
    );
  }

  const dispatch = await ghaConfig.sandboxSession.dispatchWorkflow({
    workflowId: SEMANTIC_WORKFLOW_FILE,
    timeoutMins: ghaConfig.timeoutMinutes,
    inputs: {
      repo_full_name: ghaConfig.repoFullName,
      fork_clone_url: ghaConfig.forkCloneUrl,
      branch_name: ghaConfig.branchName,
      issue_title: issueTitle.value,
      issue_body: issueBody.value,
      affected_module: args.affectedModule,
      top_k: String(SEMANTIC_TOP_K),
    },
  });
  if (!dispatch.ok) {
    throw new Error(
      `semantic workflow dispatch failed: reason=${dispatch.reason} diagnostics=${JSON.stringify(dispatch.diagnostics)}`
    );
  }
  if (dispatch.conclusion !== 'success') {
    throw new Error(
      `semantic workflow failed with conclusion=${dispatch.conclusion ?? 'unknown'} run_id=${dispatch.runId}`
    );
  }

  const rawArtifact = await ghaConfig.actionsClient.downloadWorkflowRunArtifact?.(
    ghaConfig.workflowRepoFullName,
    dispatch.runId,
    'semantic-output'
  );
  if (!rawArtifact) {
    throw new Error(`semantic workflow produced no semantic-output artifact: run_id=${dispatch.runId}`);
  }
  return rawArtifact;
}

function formatSessionFailure(failure: SandboxPhaseFailure): string {
  const diagnosticText = failure.diagnostics ? ` diagnostics=${JSON.stringify(failure.diagnostics)}` : '';
  const stepText = failure.failedStep ? ` failedStep=${failure.failedStep}` : '';
  return `phase=${failure.phase} reason=${failure.reason}${stepText}${diagnosticText}`;
}

function limitWorkflowInput(
  value: string,
  maxChars: number
): {
  value: string;
  truncated: boolean;
} {
  const normalized = value.replace(/\r\n/g, '\n');
  if (normalized.length <= maxChars) {
    return { value: normalized, truncated: false };
  }
  return { value: normalized.slice(0, maxChars), truncated: true };
}

function parseSemanticScriptResult(stdout: string): SemanticScriptResult {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('semantic search script returned empty output');

  const parsed = parseJsonLikeOutput(trimmed);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('semantic search script returned invalid JSON payload');
  }
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p.results)) {
    throw new Error('semantic search script payload missing `results`');
  }
  return {
    model: typeof p.model === 'string' && p.model.trim() ? p.model : SEMANTIC_MODEL_NAME,
    cacheHit: p.cacheHit === true,
    cacheKey: typeof p.cacheKey === 'string' ? p.cacheKey : 'unknown',
    indexedFileCount: typeof p.indexedFileCount === 'number' ? p.indexedFileCount : 0,
    instrumentationDirs: Array.isArray(p.instrumentationDirs)
      ? p.instrumentationDirs.filter((v): v is string => typeof v === 'string')
      : [],
    topScore: parseTopScore(p.top_score, p.results),
    results: p.results.map(parseResultItem).filter((v): v is SemanticScriptResultItem => v !== null),
  };
}

function parseTopScore(rawTopScore: unknown, rawResults: unknown): number | null {
  if (typeof rawTopScore === 'number' && Number.isFinite(rawTopScore)) {
    return rawTopScore;
  }
  if (!Array.isArray(rawResults)) {
    return null;
  }
  const scores = rawResults
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const score = (entry as Record<string, unknown>).score;
      return typeof score === 'number' && Number.isFinite(score) ? score : null;
    })
    .filter((score): score is number => score !== null);
  return scores.length > 0 ? Math.max(...scores) : null;
}

function buildSemanticConfidence(topScore: number | null): SemanticConfidence {
  const roundedTopScore = topScore === null ? null : Number(topScore.toFixed(6));
  const lowConfidence = roundedTopScore !== null && roundedTopScore < SEMANTIC_LOW_CONFIDENCE_THRESHOLD;
  const thresholdText = SEMANTIC_LOW_CONFIDENCE_THRESHOLD.toFixed(3);
  const diagnostics =
    roundedTopScore === null
      ? 'semantic top_score unavailable; confidence remains unverified'
      : lowConfidence
        ? `semantic top_score=${roundedTopScore.toFixed(3)} below threshold ${thresholdText}; suspects are low-confidence`
        : `semantic top_score=${roundedTopScore.toFixed(3)} meets threshold ${thresholdText}; suspects are confidence-qualified`;
  return {
    top_score: roundedTopScore,
    low_confidence: lowConfidence,
    diagnostics,
  };
}

function parseJsonLikeOutput(trimmed: string): unknown {
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to tolerant extraction fallback.
  }

  const jsonLine = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith('{') && line.endsWith('}'));
  if (jsonLine) {
    try {
      return JSON.parse(jsonLine);
    } catch {
      // Continue to broader brace extraction fallback.
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // Fall through to explicit non-JSON error below.
    }
  }

  throw new Error(`semantic search script returned non-JSON output: ${trimmed.slice(0, 300)}`);
}

function parseResultItem(raw: unknown): SemanticScriptResultItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.file !== 'string' || !r.file.trim()) return null;
  return {
    file: r.file,
    score: typeof r.score === 'number' ? r.score : undefined,
    primaryClass: typeof r.primaryClass === 'string' && r.primaryClass.trim() ? r.primaryClass : null,
    primaryFunction:
      typeof r.primaryFunction === 'string' && r.primaryFunction.trim() ? r.primaryFunction : null,
  };
}

function resultToSuspectSymbols(item: SemanticScriptResultItem): SuspectSymbol[] {
  const file = normalizeRepoPath(item.file);
  if (!file) return [];
  const scoreHint =
    typeof item.score === 'number' && Number.isFinite(item.score) ? ` (similarity=${item.score.toFixed(3)})` : '';
  const out: SuspectSymbol[] = [];
  if (item.primaryClass) {
    out.push({
      file,
      symbol: item.primaryClass,
      reasoning: `Semantic retrieval hit${scoreHint}; primary class parsed from AST`,
    });
  }
  if (item.primaryFunction) {
    out.push({
      file,
      symbol: item.primaryFunction,
      reasoning: `Semantic retrieval hit${scoreHint}; primary function parsed from AST`,
    });
  }
  return out;
}

function dedupeSuspectSymbols(symbols: SuspectSymbol[]): SuspectSymbol[] {
  const seen = new Set<string>();
  const out: SuspectSymbol[] = [];
  for (const symbol of symbols) {
    const file = normalizeRepoPath(symbol.file);
    const key = `${file}::${symbol.symbol}`;
    if (!file || !symbol.symbol || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...symbol, file });
  }
  return out;
}

function normalizeRepoPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}
