import type { ActionsClient, WorkflowRun } from '../../sandbox-types';
import type { SuspectSymbol } from './dossier';

const SEMANTIC_MODEL_NAME = 'BAAI/bge-small-en-v1.5';
const SEMANTIC_TOP_K = 5;
const SEMANTIC_WORKFLOW_FILE = 'semantic-search.yml';
const SEMANTIC_RUN_APPEAR_TIMEOUT_MS = 180_000;
const SEMANTIC_RUN_APPEAR_POLL_MS = 5_000;
const SEMANTIC_REF_CHECK_ATTEMPTS = 3;
const SEMANTIC_REF_CHECK_DELAY_MS = 2_000;
const SEMANTIC_ISSUE_TITLE_MAX_CHARS = 4_000;
const SEMANTIC_ISSUE_BODY_MAX_CHARS = 60_000;

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
  await verifySemanticDispatchRefs({
    actionsClient: ghaConfig.actionsClient,
    workflowRepoFullName: ghaConfig.workflowRepoFullName,
    workflowDispatchRef: ghaConfig.workflowDispatchRef,
    forkFullName: ghaConfig.forkFullName,
    forkBranchName: ghaConfig.branchName,
  });

  const issueTitle = limitWorkflowInput(args.issueTitle, SEMANTIC_ISSUE_TITLE_MAX_CHARS);
  const issueBody = limitWorkflowInput(args.issueBody, SEMANTIC_ISSUE_BODY_MAX_CHARS);
  if (issueTitle.truncated || issueBody.truncated) {
    args.log(
      `[semantic-search] workflow inputs truncated (title=${issueTitle.value.length}, body=${issueBody.value.length})`
    );
  }

  const dispatchCreatedAt = new Date().toISOString();
  await ghaConfig.actionsClient.triggerWorkflowDispatch(
    ghaConfig.workflowRepoFullName,
    SEMANTIC_WORKFLOW_FILE,
    ghaConfig.workflowDispatchRef,
    {
      repo_full_name: ghaConfig.repoFullName,
      fork_clone_url: ghaConfig.forkCloneUrl,
      branch_name: ghaConfig.branchName,
      issue_title: issueTitle.value,
      issue_body: issueBody.value,
      affected_module: args.affectedModule,
      top_k: String(SEMANTIC_TOP_K),
    }
  );

  const workflowRun = await waitForSemanticRunAppearance({
    actionsClient: ghaConfig.actionsClient,
    workflowRepoFullName: ghaConfig.workflowRepoFullName,
    workflowDispatchRef: ghaConfig.workflowDispatchRef,
    createdAfter: dispatchCreatedAt,
  });
  if (!workflowRun) {
    throw new Error(
      `semantic workflow run did not appear within ${SEMANTIC_RUN_APPEAR_TIMEOUT_MS}ms after dispatch`
    );
  }

  const runStatus = await ghaConfig.actionsClient.waitForWorkflowRun(
    ghaConfig.workflowRepoFullName,
    workflowRun.id,
    ghaConfig.timeoutMinutes * 60 * 1_000
  );
  if (runStatus.timedOut) {
    throw new Error(
      `semantic workflow timed out after ${ghaConfig.timeoutMinutes} minute(s): ${workflowRun.html_url}`
    );
  }
  if (runStatus.conclusion !== 'success') {
    throw new Error(
      `semantic workflow failed with conclusion=${runStatus.conclusion ?? 'unknown'}: ${workflowRun.html_url}`
    );
  }

  const rawArtifact = await ghaConfig.actionsClient.downloadWorkflowRunArtifact?.(
    ghaConfig.workflowRepoFullName,
    workflowRun.id,
    'semantic-output'
  );
  if (!rawArtifact) {
    throw new Error(`semantic workflow produced no semantic-output artifact: ${workflowRun.html_url}`);
  }
  return rawArtifact;
}

async function waitForSemanticRunAppearance(args: {
  actionsClient: ActionsClient;
  workflowRepoFullName: string;
  workflowDispatchRef: string;
  createdAfter: string;
}): Promise<WorkflowRun | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SEMANTIC_RUN_APPEAR_TIMEOUT_MS) {
    const run = await args.actionsClient.getWorkflowRun(
      args.workflowRepoFullName,
      SEMANTIC_WORKFLOW_FILE,
      args.workflowDispatchRef,
      args.createdAfter
    );
    if (run) return run;
    await sleep(SEMANTIC_RUN_APPEAR_POLL_MS);
  }
  return null;
}

async function verifySemanticDispatchRefs(args: {
  actionsClient: ActionsClient;
  workflowRepoFullName: string;
  workflowDispatchRef: string;
  forkFullName: string;
  forkBranchName: string;
}): Promise<void> {
  if (!args.actionsClient.branchRefExists) return;

  const checks = [
    {
      repoFullName: args.workflowRepoFullName,
      branch: args.workflowDispatchRef,
      label: 'workflow dispatch ref',
    },
    {
      repoFullName: args.forkFullName,
      branch: args.forkBranchName,
      label: 'fork semantic ref',
    },
  ] as const;

  const uniqueChecks = checks.filter(
    (check, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.repoFullName === check.repoFullName && candidate.branch === check.branch
      ) === index
  );

  for (const check of uniqueChecks) {
    let exists = false;
    for (let attempt = 1; attempt <= SEMANTIC_REF_CHECK_ATTEMPTS; attempt += 1) {
      exists = await args.actionsClient.branchRefExists(check.repoFullName, check.branch);
      if (exists) break;
      if (attempt < SEMANTIC_REF_CHECK_ATTEMPTS) {
        await sleep(SEMANTIC_REF_CHECK_DELAY_MS);
      }
    }
    if (!exists) {
      throw new Error(
        `semantic workflow pre-dispatch missing ${check.label} "${check.branch}" in ${check.repoFullName}`
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    results: p.results.map(parseResultItem).filter((v): v is SemanticScriptResultItem => v !== null),
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
