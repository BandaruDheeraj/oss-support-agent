/**
 * ReproWorkspace implementation backed by a local clone, plus the
 * safety/redaction utilities the iterative repro loop relies on.
 *
 * The LLM is allowed to ask the loop to read files, list dirs, find files by
 * suffix, or grep — but every request goes through this adapter, which
 * enforces:
 *   - repo-relative paths only (no `..`, no absolute paths, no backslashes,
 *     no drive letters)
 *   - sensitive filenames denied (`.env*`, `*.pem`, `*.key`, `id_rsa*`,
 *     `credentials*`, `secrets*`)
 *   - generated/cache directories ignored (`.git`, `node_modules`, `.venv`,
 *     `venv`, `dist`, `build`, `__pycache__`, `.tox`, `.pytest_cache`,
 *     `.mypy_cache`, `.next`, `.cache`, `.agent-venv`)
 *   - per-file byte cap, per-turn byte cap, total accumulated byte cap
 *   - grep: fixed-string by default, capped pattern length, capped matches
 *   - basic redaction of well-known secret patterns in returned snippets
 *
 * Failures are returned as structured `ContextResult.status` values rather
 * than raised, so the LLM can react in its next turn (e.g. "denied", "too
 * large", "not found").
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
  ContextRequest,
  ContextResult,
  ReproWorkspace,
} from './repro-types';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '.tox',
  '.pytest_cache',
  '.mypy_cache',
  '.next',
  '.cache',
  '.agent-venv',
  '.idea',
  '.vscode',
]);

const SENSITIVE_BASENAME_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /^id_rsa.*$/i,
  /^id_ed25519.*$/i,
  /^id_ecdsa.*$/i,
  /^.*\.pem$/i,
  /^.*\.key$/i,
  /^credentials(\..+)?$/i,
  /^secrets(\..+)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
];

const ALLOWED_TEXT_EXTENSIONS = new Set([
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.toml',
  '.cfg',
  '.ini',
  '.yaml',
  '.yml',
  '.md',
  '.rst',
  '.txt',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.lock',
  '.sh',
  '.dockerfile',
  '.proto',
  '.gradle',
  '.xml',
  '.html',
  '.css',
  '.scss',
  '.sql',
  '.in',
]);

/** Look like API keys / tokens. Replaced with `[REDACTED]` in returned text. */
const SECRET_REDACTION_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,}\b/g, // OpenAI-ish
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PAT
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  /\bghs_[A-Za-z0-9]{20,}\b/g,
  /\bghu_[A-Za-z0-9]{20,}\b/g,
  /\baws_secret_access_key\s*=\s*['"]?[A-Za-z0-9/+=]{20,}['"]?/gi,
  /\bAIza[0-9A-Za-z\-_]{20,}\b/g, // Google API
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\b[A-Fa-f0-9]{40,}\b/g, // generic long hex (could be hashes, but safer)
];

const DEFAULT_LIMITS = {
  perFileBytes: 60_000,
  perTurnBytes: 200_000,
  totalBytes: 600_000,
  listMaxEntries: 200,
  findMaxResults: 25,
  grepMaxResults: 30,
  grepPatternMaxLen: 200,
  grepMaxFilesVisited: 5_000,
  grepLineMaxLen: 240,
};

export type ReproWorkspaceLimits = Partial<typeof DEFAULT_LIMITS>;

interface FileReader {
  readFile(relPath: string): string;
  fileExists(relPath: string): boolean;
  listFiles(relDir: string): string[];
  listSubdirs(relDir: string): string[];
  findFilesBySuffix(suffix: string, maxResults?: number): string[];
  /** Absolute root used to walk the tree for grep + tree summary. */
  readonly dir: string;
}

export class LocalReproWorkspace implements ReproWorkspace {
  private readonly limits: typeof DEFAULT_LIMITS;
  /** Bytes returned this turn (reset by `beginTurn`). */
  private turnBytes = 0;
  /** Total bytes returned across all turns. */
  private totalBytes = 0;

  constructor(
    private readonly inner: FileReader,
    private readonly affectedModule: string,
    limits: ReproWorkspaceLimits = {}
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Called by the loop at the start of each turn before servicing requests. */
  beginTurn(): void {
    this.turnBytes = 0;
  }

  repoTreeSummary(): string {
    const lines: string[] = [];
    lines.push('Top-level directories:');
    for (const d of safeListSubdirs(this.inner, '').sort()) {
      lines.push(`  ${d}/`);
    }

    // Collect candidate editableInstall paths. We try in order:
    // 1. Walk UP from affectedModule looking for ancestor dirs with a Python
    //    package manifest. This is the precise hit when triage gave us a
    //    real disk path.
    // 2. If that yields nothing (e.g. triage produced an import-style path
    //    like "openinference/instrumentation/smolagents/_wrappers.py" that
    //    doesn't exist on disk), scan the whole repo for pyproject.toml /
    //    setup.py / setup.cfg files and list those, capped.
    // The LLM otherwise has no way to know which dir to `pip install -e`,
    // and getting it wrong burns the entire baseline budget on
    // ModuleNotFoundError.
    let candidates: string[] = [];
    let candidatesAreFallback = false;
    if (this.affectedModule && this.affectedModule !== '.' && this.affectedModule !== '') {
      lines.push('');
      lines.push(`Affected module subtree (${this.affectedModule}, depth=2):`);
      const affectedRoot = this.affectedModule.replace(/^\/+|\/+$/g, '');
      const sub = collectSubtree(this.inner, affectedRoot, 2, 200);
      for (const entry of sub) lines.push(`  ${entry}`);

      candidates = findEditableInstallCandidates(this.inner, affectedRoot);
    }
    if (candidates.length === 0) {
      candidates = findAllEditableInstallCandidates(this.inner, 6, 50);
      candidatesAreFallback = true;
    }
    if (candidates.length > 0) {
      lines.push('');
      const header = candidatesAreFallback
        ? 'Candidate editableInstalls (all dirs in the repo containing pyproject.toml/setup.py/setup.cfg — pick the one whose package name matches the import you need; in monorepos this is usually a subdir like python/instrumentation/<pkg>/):'
        : 'Candidate editableInstalls (dirs containing pyproject.toml/setup.py/setup.cfg on the path to the affected module — pick the INNERMOST one whose package matches the import you need):';
      lines.push(header);
      for (const c of candidates) lines.push(`  ${c}`);
    }
    return lines.join('\n');
  }

  readFile(req: Extract<ContextRequest, { op: 'read_file' }>): ContextResult {
    const safety = this.validateRelPath(req.path);
    if (!safety.ok) {
      return { op: 'read_file', path: req.path, status: 'denied', reason: safety.reason };
    }
    const ext = path.extname(safety.normalized).toLowerCase();
    if (ext && !ALLOWED_TEXT_EXTENSIONS.has(ext)) {
      return {
        op: 'read_file',
        path: safety.normalized,
        status: 'denied',
        reason: `extension ${ext} is not in the text-content allowlist`,
      };
    }
    if (!this.inner.fileExists(safety.normalized)) {
      return { op: 'read_file', path: safety.normalized, status: 'not_found' };
    }
    let raw: string;
    try {
      raw = this.inner.readFile(safety.normalized);
    } catch (err: any) {
      return {
        op: 'read_file',
        path: safety.normalized,
        status: 'not_found',
        reason: err?.message ?? String(err),
      };
    }
    if (looksBinary(raw)) {
      return { op: 'read_file', path: safety.normalized, status: 'binary' };
    }
    const budgetCheck = this.consumeBudget(raw.length);
    if (!budgetCheck.ok) {
      return {
        op: 'read_file',
        path: safety.normalized,
        status: 'too_large',
        bytes: raw.length,
        reason: budgetCheck.reason,
      };
    }
    let truncated = false;
    let content = raw;
    if (content.length > this.limits.perFileBytes) {
      content = content.slice(0, this.limits.perFileBytes);
      truncated = true;
    }
    content = redactSecrets(content);
    return {
      op: 'read_file',
      path: safety.normalized,
      status: truncated ? 'truncated' : 'ok',
      content,
      bytes: raw.length,
    };
  }

  listDir(req: Extract<ContextRequest, { op: 'list_dir' }>): ContextResult {
    const safety = this.validateRelDirPath(req.path);
    if (!safety.ok) {
      return { op: 'list_dir', path: req.path, status: 'denied', reason: safety.reason };
    }
    if (!this.inner.fileExists(safety.normalized) && safety.normalized !== '') {
      // listFiles/listSubdirs also handle missing dirs (return []), but we
      // want to distinguish "empty" from "doesn't exist" for the LLM.
      const absExists = fs.existsSync(path.join(this.inner.dir, safety.normalized));
      if (!absExists) {
        return { op: 'list_dir', path: safety.normalized, status: 'not_found' };
      }
    }
    const max = Math.min(req.maxEntries ?? this.limits.listMaxEntries, this.limits.listMaxEntries);
    const subdirs = safeListSubdirs(this.inner, safety.normalized);
    const files = safeListFiles(this.inner, safety.normalized);
    const merged: Array<{ name: string; kind: 'file' | 'dir' }> = [
      ...subdirs.map((n) => ({ name: n, kind: 'dir' as const })),
      ...files.map((p) => ({ name: path.posix.basename(p), kind: 'file' as const })),
    ];
    const truncated = merged.length > max;
    return {
      op: 'list_dir',
      path: safety.normalized,
      status: 'ok',
      entries: merged.slice(0, max),
      truncated,
    };
  }

  findFile(req: Extract<ContextRequest, { op: 'find_file' }>): ContextResult {
    const suffix = (req.suffix ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!suffix || suffix.includes('..') || suffix.includes('\0')) {
      return { op: 'find_file', suffix: req.suffix, status: 'denied', reason: 'invalid suffix' };
    }
    if (suffix.length > 200) {
      return { op: 'find_file', suffix: req.suffix, status: 'denied', reason: 'suffix too long' };
    }
    const max = Math.min(req.maxResults ?? this.limits.findMaxResults, this.limits.findMaxResults);
    const matches = this.inner.findFilesBySuffix(suffix, max + 1).filter((m) => {
      const base = path.posix.basename(m);
      return !isSensitiveBasename(base);
    });
    const truncated = matches.length > max;
    return {
      op: 'find_file',
      suffix,
      status: 'ok',
      matches: matches.slice(0, max),
      truncated,
    };
  }

  grep(req: Extract<ContextRequest, { op: 'grep' }>): ContextResult {
    const query = req.query ?? '';
    if (!query || query.length > this.limits.grepPatternMaxLen) {
      return { op: 'grep', query, status: 'denied', reason: 'empty or oversized query' };
    }
    let prefix = '';
    if (req.pathPrefix) {
      const safety = this.validateRelDirPath(req.pathPrefix);
      if (!safety.ok) {
        return { op: 'grep', query, status: 'denied', reason: `pathPrefix: ${safety.reason}` };
      }
      prefix = safety.normalized;
    }
    const exts = (req.extensions ?? [])
      .map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase())
      .filter((e) => ALLOWED_TEXT_EXTENSIONS.has(e));
    const fixed = req.fixedString !== false; // default true
    let needle: RegExp;
    if (fixed) {
      needle = new RegExp(escapeRegex(query));
    } else {
      try {
        // Anchor a length cap, no flags besides 'i' to avoid catastrophic backtracking surprises.
        needle = new RegExp(query.slice(0, this.limits.grepPatternMaxLen));
      } catch (err: any) {
        return { op: 'grep', query, status: 'denied', reason: `invalid regex: ${err?.message}` };
      }
    }
    const max = Math.min(req.maxResults ?? this.limits.grepMaxResults, this.limits.grepMaxResults);
    const hits: Array<{ path: string; line: number; preview: string }> = [];
    let visited = 0;
    let truncated = false;
    const root = this.inner.dir;
    const startRel = prefix;
    const startAbs = path.join(root, startRel);
    const stack: string[] = [startRel];
    walk: while (stack.length > 0) {
      const cur = stack.pop()!;
      const absCur = path.join(root, cur);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absCur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (IGNORED_DIRS.has(e.name)) continue;
        const child = cur ? `${cur}/${e.name}` : e.name;
        if (e.isDirectory()) {
          stack.push(child);
          continue;
        }
        if (!e.isFile()) continue;
        if (isSensitiveBasename(e.name)) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!ALLOWED_TEXT_EXTENSIONS.has(ext)) continue;
        if (exts.length > 0 && !exts.includes(ext)) continue;
        visited++;
        if (visited > this.limits.grepMaxFilesVisited) {
          truncated = true;
          break walk;
        }
        let text: string;
        try {
          text = fs.readFileSync(path.join(root, child), 'utf-8');
        } catch {
          continue;
        }
        if (looksBinary(text)) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          if (!needle.test(line)) continue;
          const preview = redactSecrets(line.slice(0, this.limits.grepLineMaxLen));
          hits.push({ path: child, line: i + 1, preview });
          if (hits.length >= max) {
            truncated = true;
            break walk;
          }
        }
      }
    }
    void startAbs;
    return { op: 'grep', query, status: 'ok', hits, truncated };
  }

  // -------------------------------------------------------------------------

  private validateRelPath(p: string): { ok: true; normalized: string } | { ok: false; reason: string } {
    if (!p || typeof p !== 'string') return { ok: false, reason: 'path is empty' };
    if (p.includes('\0')) return { ok: false, reason: 'path contains NUL' };
    if (p.includes('\\')) return { ok: false, reason: 'path contains backslash' };
    if (/^[A-Za-z]:\//.test(p)) return { ok: false, reason: 'path is absolute (drive letter)' };
    if (p.startsWith('/')) return { ok: false, reason: 'path is absolute' };
    if (p.split('/').some((seg) => seg === '..' || seg === '')) {
      return { ok: false, reason: 'path contains parent traversal or empty segment' };
    }
    if (p.length > 400) return { ok: false, reason: 'path too long' };
    const normalized = p.replace(/\/+$/, '');
    const segments = normalized.split('/');
    for (const seg of segments) {
      if (IGNORED_DIRS.has(seg)) {
        return { ok: false, reason: `path traverses ignored directory ${seg}` };
      }
    }
    if (isSensitiveBasename(path.posix.basename(normalized))) {
      return { ok: false, reason: 'sensitive filename' };
    }
    // Final realpath check: ensure it stays under the workspace root.
    const abs = path.resolve(this.inner.dir, normalized);
    const rootAbs = path.resolve(this.inner.dir);
    if (!abs.startsWith(rootAbs + path.sep) && abs !== rootAbs) {
      return { ok: false, reason: 'resolved path escapes workspace root' };
    }
    return { ok: true, normalized };
  }

  private validateRelDirPath(p: string): { ok: true; normalized: string } | { ok: false; reason: string } {
    // Allow empty / "." / "./" to mean repo root.
    if (!p || p === '.' || p === './') return { ok: true, normalized: '' };
    return this.validateRelPath(p);
  }

  private consumeBudget(bytes: number): { ok: true } | { ok: false; reason: string } {
    if (bytes > this.limits.perFileBytes && this.turnBytes > 0) {
      // Will be truncated to perFileBytes later; only count the truncated size.
    }
    const charged = Math.min(bytes, this.limits.perFileBytes);
    if (this.turnBytes + charged > this.limits.perTurnBytes) {
      return { ok: false, reason: `per-turn byte budget (${this.limits.perTurnBytes}) exhausted` };
    }
    if (this.totalBytes + charged > this.limits.totalBytes) {
      return { ok: false, reason: `total byte budget (${this.limits.totalBytes}) exhausted` };
    }
    this.turnBytes += charged;
    this.totalBytes += charged;
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// helpers

function looksBinary(s: string): boolean {
  // Cheap heuristic: any NUL byte in the first 8KB → binary.
  const sample = s.length > 8192 ? s.slice(0, 8192) : s;
  return sample.indexOf('\0') !== -1;
}

function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_REDACTION_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

function isSensitiveBasename(name: string): boolean {
  return SENSITIVE_BASENAME_PATTERNS.some((re) => re.test(name));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeListSubdirs(reader: FileReader, relDir: string): string[] {
  try {
    return reader.listSubdirs(relDir).filter((n) => !IGNORED_DIRS.has(n));
  } catch {
    return [];
  }
}

function safeListFiles(reader: FileReader, relDir: string): string[] {
  try {
    return reader.listFiles(relDir);
  } catch {
    return [];
  }
}

function collectSubtree(
  reader: FileReader,
  rel: string,
  depth: number,
  cap: number
): string[] {
  const out: string[] = [];
  const walk = (cur: string, d: number): void => {
    if (out.length >= cap) return;
    const subs = safeListSubdirs(reader, cur);
    const files = safeListFiles(reader, cur);
    for (const f of files) {
      if (out.length >= cap) return;
      out.push(f);
    }
    if (d <= 0) return;
    for (const s of subs) {
      if (out.length >= cap) return;
      walk(cur ? `${cur}/${s}` : s, d - 1);
    }
  };
  walk(rel, depth);
  return out;
}

const PYTHON_PACKAGE_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg'];

/**
 * Walk up from `rel` to the repo root, returning each ancestor dir that
 * contains a Python package manifest. Innermost first.
 */
function findEditableInstallCandidates(
  reader: FileReader,
  rel: string
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = rel.replace(/^\/+|\/+$/g, '');
  // Cap iterations defensively in case of pathological inputs.
  for (let i = 0; i < 32; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const basenames = new Set(safeListFiles(reader, cur).map((f) => f.split('/').pop() ?? f));
    if (PYTHON_PACKAGE_MANIFESTS.some((m) => basenames.has(m))) {
      out.push(cur === '' ? '.' : cur);
    }
    if (cur === '' || cur === '.') break;
    const idx = cur.lastIndexOf('/');
    cur = idx === -1 ? '' : cur.slice(0, idx);
  }
  return out;
}

/**
 * BFS the whole repo (depth-capped, count-capped) returning every dir that
 * contains a Python package manifest. Used as a fallback when the
 * walk-up-from-affected-module strategy yields nothing — e.g. when triage
 * gave us an import-style "module path" that doesn't exist on disk.
 */
function findAllEditableInstallCandidates(
  reader: FileReader,
  maxDepth: number,
  cap: number
): string[] {
  const out: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: '', depth: 0 }];
  while (queue.length > 0) {
    if (out.length >= cap) break;
    const { dir, depth } = queue.shift()!;
    const basenames = new Set(safeListFiles(reader, dir).map((f) => f.split('/').pop() ?? f));
    if (PYTHON_PACKAGE_MANIFESTS.some((m) => basenames.has(m))) {
      out.push(dir === '' ? '.' : dir);
    }
    if (depth >= maxDepth) continue;
    for (const sub of safeListSubdirs(reader, dir)) {
      queue.push({ dir: dir ? `${dir}/${sub}` : sub, depth: depth + 1 });
    }
  }
  return out;
}
