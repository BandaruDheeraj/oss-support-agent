import fs from 'node:fs';
import path from 'node:path';

import { ensurePythonVenv } from '../../../bin/clients/local-sandbox';
import { execCommand } from '../../../bin/clients/local-workspace';
import type { SuspectSymbol } from './dossier';

const SEMANTIC_MODEL_NAME = 'BAAI/bge-small-en-v1.5';
const SEMANTIC_VENV_DIR = '.semantic-venv';
const SEMANTIC_TOP_K = 5;
const SEMANTIC_TIMEOUT_MS = 20 * 60 * 1_000;
const PYTHON_IMPORT_PROBE_TIMEOUT_MS = 2 * 60 * 1_000;
const PIP_INSTALL_TIMEOUT_MS = 20 * 60 * 1_000;

const REQUIRED_SEMANTIC_PACKAGES = [
  'llama-index-core',
  'llama-index-embeddings-huggingface',
  'llama-index-readers-file',
  'sentence-transformers',
] as const;

const SCRIPT_RELATIVE_PATH = path.join('scripts', 'semantic_suspects.py');
const REQUIREMENTS_FILE = 'requirements.txt';

interface SemanticScriptPayload {
  workspaceDir: string;
  query: string;
  topK: number;
  affectedModule: string;
}

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
  log?: (message: string) => void;
}

export async function buildSemanticSuspectSeed(
  args: BuildSemanticSuspectSeedArgs
): Promise<SemanticSuspectSeed | null> {
  const log = args.log ?? (() => {});
  const query = `${args.issueTitle}\n\n${args.issueBody ?? ''}`.trim();
  if (!query) return null;

  const venv = await ensurePythonVenv(args.workspaceDir, log, SEMANTIC_TIMEOUT_MS, SEMANTIC_VENV_DIR);
  if (!venv) {
    log('[semantic-search] unable to initialize Python venv; skipping semantic seed');
    return null;
  }
  const pythonPath = path.join(venv.binDir, process.platform === 'win32' ? 'python.exe' : 'python');
  const pipPath = path.join(venv.binDir, process.platform === 'win32' ? 'pip.exe' : 'pip');

  await ensureSemanticDependencies({
    workspaceDir: args.workspaceDir,
    pythonPath,
    pipPath,
    log,
  });

  const scriptPath = resolveRepoFile(SCRIPT_RELATIVE_PATH);
  if (!scriptPath) {
    throw new Error(`semantic search script not found at ${SCRIPT_RELATIVE_PATH}`);
  }

  const payload: SemanticScriptPayload = {
    workspaceDir: args.workspaceDir,
    query,
    topK: SEMANTIC_TOP_K,
    affectedModule: args.affectedModule?.trim() || '.',
  };
  const cacheRoot = path.join(args.workspaceDir, '.semantic-index-cache');
  const hfCache = path.join(args.workspaceDir, '.semantic-hf-cache');
  const run = await execCommand(`"${pythonPath}" "${scriptPath}"`, [], args.workspaceDir, {
    shell: true,
    timeoutMs: SEMANTIC_TIMEOUT_MS,
    stdin: `${JSON.stringify(payload)}\n`,
    env: {
      ...process.env,
      HF_HOME: hfCache,
      TRANSFORMERS_CACHE: hfCache,
      SENTENCE_TRANSFORMERS_HOME: hfCache,
      TOKENIZERS_PARALLELISM: 'false',
      PYTHONUNBUFFERED: '1',
      SEMANTIC_INDEX_CACHE_DIR: cacheRoot,
      SEMANTIC_INDEX_MODEL: SEMANTIC_MODEL_NAME,
    },
  });
  if (run.exitCode !== 0) {
    throw new Error(
      `semantic search script failed (exit=${run.exitCode}): ${(run.stderr || run.stdout).slice(0, 800)}`
    );
  }
  const parsed = parseSemanticScriptResult(run.stdout);
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

interface EnsureSemanticDependenciesArgs {
  workspaceDir: string;
  pythonPath: string;
  pipPath: string;
  log: (message: string) => void;
}

async function ensureSemanticDependencies(args: EnsureSemanticDependenciesArgs): Promise<void> {
  const probe = await execCommand(
    `"${args.pythonPath}" -c "import llama_index.core; import llama_index.embeddings.huggingface; import sentence_transformers"`,
    [],
    args.workspaceDir,
    { shell: true, timeoutMs: PYTHON_IMPORT_PROBE_TIMEOUT_MS }
  );
  if (probe.exitCode === 0) return;

  args.log('[semantic-search] installing llama-index + sentence-transformers dependencies');
  const requirementsPath = resolveRepoFile(REQUIREMENTS_FILE);
  const installCommand = requirementsPath
    ? `"${args.pipPath}" install --disable-pip-version-check --quiet -r "${requirementsPath}"`
    : `"${args.pipPath}" install --disable-pip-version-check --quiet ${REQUIRED_SEMANTIC_PACKAGES.join(' ')}`;
  const install = await execCommand(installCommand, [], args.workspaceDir, {
    shell: true,
    timeoutMs: PIP_INSTALL_TIMEOUT_MS,
    env: {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    },
  });
  if (install.exitCode !== 0) {
    throw new Error(
      `failed to install semantic dependencies (exit=${install.exitCode}): ${(install.stderr || install.stdout).slice(0, 800)}`
    );
  }
}

function resolveRepoFile(relativePath: string): string | null {
  let cursor = __dirname;
  for (let i = 0; i < 12; i += 1) {
    const candidate = path.join(cursor, relativePath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function parseSemanticScriptResult(stdout: string): SemanticScriptResult {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('semantic search script returned empty output');

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const jsonLine = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith('{') && line.endsWith('}'));
    if (!jsonLine) {
      throw new Error(`semantic search script returned non-JSON output: ${trimmed.slice(0, 300)}`);
    }
    parsed = JSON.parse(jsonLine);
  }

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

