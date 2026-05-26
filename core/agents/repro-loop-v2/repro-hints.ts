/**
 * Hints surfaced to the v2 Repro Planner / Executor that the model cannot
 * reasonably derive from tool calls within its budget:
 *
 *   1. `discoverEditableInstallCandidates(workspaceDir, affectedModule?)`
 *      — repo-relative dirs containing a Python package manifest
 *      (pyproject.toml / setup.py / setup.cfg). The executor uses these to
 *      run `pip install -e <dir>` for in-repo packages whose imports would
 *      otherwise raise ModuleNotFoundError. Mirrors the v1 behaviour
 *      (commits cee51fc / 218e9c2 / de3f15f) on the new fs adapter surface.
 *
 *   2. `extractIssueCodeSnippets(body)` — fenced code blocks lifted
 *      verbatim from the GitHub issue body. The Repro Executor must try the
 *      verbatim snippet first before paraphrasing; this avoids subtle
 *      transcription drift on bug reports that hinge on a specific call
 *      sequence.
 *
 * Both helpers are deliberately side-effect free and synchronous so they can
 * be invoked from the slim driver (`run-v2.ts`) before the agent loop even
 * starts.
 */
import * as fs from 'fs';
import * as path from 'path';

import { validateReproSetup } from '../repro-setup-validation';

const PYTHON_PACKAGE_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg'];

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

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_CAP = 50;
const FINAL_RETURN_CAP = 5; // matches MAX_EDITABLE_INSTALLS in repro-setup-validation

export interface EditableInstallDiscoveryOptions {
  /** Repo-relative module path triage identified (used for walk-up priority). */
  affectedModule?: string;
  maxDepth?: number;
  cap?: number;
}

/**
 * Walk `workspaceDir` looking for Python package manifests.
 *
 * Strategy mirrors the v1 ReproWorkspace:
 *   1. Walk UP from `affectedModule` to the repo root, collecting every
 *      ancestor dir that has a manifest (innermost first).
 *   2. If that yields nothing, BFS the whole repo (depth-capped, count-capped)
 *      and list every manifest dir found.
 *
 * Returned paths are repo-relative POSIX strings. They are passed through
 * `validateReproSetup` so they're guaranteed safe for `pip install -e <dir>`.
 * The final list is capped at `FINAL_RETURN_CAP` (the validator's max).
 */
export function discoverEditableInstallCandidates(
  workspaceDir: string,
  opts: EditableInstallDiscoveryOptions = {}
): string[] {
  if (!workspaceDir || !fs.existsSync(workspaceDir)) return [];

  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const cap = opts.cap ?? DEFAULT_CAP;

  let candidates: string[] = [];
  const affected = (opts.affectedModule ?? '').replace(/^[/]+|[/]+$/g, '').replace(/\\+/g, '/');
  if (affected && affected !== '.') {
    candidates = walkUpForManifests(workspaceDir, affected);
  }
  if (candidates.length === 0) {
    candidates = bfsForManifests(workspaceDir, maxDepth, cap);
  }

  // De-dupe defensively while preserving order.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    ordered.push(c);
  }

  // Skip the repo-root candidate ("."). Editable-installing the entire
  // workspace root is almost never what you want, and validateReproSetup
  // would reject "." anyway (regex requires at least one alnum char).
  const filtered = ordered.filter((c) => c !== '.' && c !== '');
  const trimmed = filtered.slice(0, FINAL_RETURN_CAP);

  try {
    const validated = validateReproSetup({ editableInstalls: trimmed });
    return validated.editableInstalls;
  } catch {
    // If the batch fails validation (e.g. a pathological filename slipped
    // through), filter entry-by-entry and return whatever survives.
    const out: string[] = [];
    for (const c of trimmed) {
      try {
        validateReproSetup({ editableInstalls: [c] });
        out.push(c);
      } catch {
        /* skip */
      }
    }
    return out;
  }
}

function walkUpForManifests(workspaceDir: string, rel: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = rel;
  for (let i = 0; i < 32; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    if (dirHasManifest(path.join(workspaceDir, cur))) {
      out.push(cur === '' ? '.' : cur);
    }
    if (cur === '' || cur === '.') break;
    const idx = cur.lastIndexOf('/');
    cur = idx === -1 ? '' : cur.slice(0, idx);
  }
  return out;
}

/**
 * Derive editable-install candidate dirs from a list of suspect file paths
 * (typically dossier suspectSymbols[].file or precondition.appliesTo.file).
 *
 * For each file path, walks up looking for the nearest ancestor dir that
 * contains a Python package manifest. Returns repo-relative POSIX paths,
 * de-duped, with the inner-most (closest to the suspect file) listed first.
 *
 * This rescues snippet-less issues where `discoverEditableInstallCandidates`
 * fell back to BFS and the alphabetic first-N capped out before reaching the
 * package the bug actually lives in. The dossier knows which file is suspect;
 * the resulting candidate list is the exact package to `pip install -e`.
 */
export function deriveEditableInstallsFromSuspectPaths(
  workspaceDir: string,
  filePaths: string[]
): string[] {
  if (!workspaceDir || !fs.existsSync(workspaceDir)) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of filePaths) {
    if (!raw || typeof raw !== 'string') continue;
    const normalized = raw.replace(/\\+/g, '/').replace(/^[/]+/, '').replace(/\/+$/, '');
    if (!normalized) continue;
    const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
    if (!dir) continue;
    for (const cand of walkUpForManifests(workspaceDir, dir)) {
      if (cand === '.' || cand === '') continue;
      if (seen.has(cand)) continue;
      seen.add(cand);
      ordered.push(cand);
    }
  }
  return ordered;
}

/**
 * Merge two editable-install candidate lists, prioritising `prioritized`
 * entries first, de-duplicating, validating each entry through
 * `validateReproSetup`, and capping the result at `FINAL_RETURN_CAP`.
 */
export function mergeEditableInstallCandidates(
  prioritized: string[],
  fallback: string[]
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const c of [...prioritized, ...fallback]) {
    if (!c || c === '.' || c === '') continue;
    if (seen.has(c)) continue;
    seen.add(c);
    merged.push(c);
    if (merged.length >= FINAL_RETURN_CAP) break;
  }
  try {
    return validateReproSetup({ editableInstalls: merged }).editableInstalls;
  } catch {
    const out: string[] = [];
    for (const c of merged) {
      try {
        validateReproSetup({ editableInstalls: [c] });
        out.push(c);
      } catch {
        /* skip */
      }
    }
    return out;
  }
}


function bfsForManifests(workspaceDir: string, maxDepth: number, cap: number): string[] {
  const out: string[] = [];
  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  while (queue.length > 0) {
    if (out.length >= cap) break;
    const { rel, depth } = queue.shift()!;
    const abs = rel === '' ? workspaceDir : path.join(workspaceDir, rel);
    if (dirHasManifest(abs)) {
      out.push(rel === '' ? '.' : rel);
    }
    if (depth >= maxDepth) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (IGNORED_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.') && !ALLOWED_DOT_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      queue.push({ rel: childRel, depth: depth + 1 });
    }
  }
  return out;
}

const ALLOWED_DOT_DIRS = new Set<string>(); // currently none — pyproject lives in normal dirs

function dirHasManifest(absDir: string): boolean {
  for (const name of PYTHON_PACKAGE_MANIFESTS) {
    try {
      const st = fs.statSync(path.join(absDir, name));
      if (st.isFile()) return true;
    } catch {
      /* missing — keep scanning */
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Issue snippet extraction                                                    */
/* -------------------------------------------------------------------------- */

export interface IssueCodeSnippet {
  /** Language tag from the fence (lowercased), or empty string if absent. */
  language: string;
  /** Snippet body (the text between the fences). */
  code: string;
}

const SNIPPET_FENCE_RE = /```([A-Za-z0-9_+\-.#]*)\r?\n([\s\S]*?)```/g;

const MAX_SNIPPETS = 3;
const MAX_SNIPPET_BYTES = 2_000;
const PREFERRED_LANGUAGE_TAGS = new Set([
  'python',
  'py',
  'python3',
  'bash',
  'sh',
  'shell',
  'console',
  'pycon',
  'js',
  'javascript',
  'ts',
  'typescript',
  'go',
  'ruby',
  'rb',
  'rust',
  'rs',
]);

/**
 * Extract fenced code blocks from a GitHub issue body. Returns up to
 * `MAX_SNIPPETS` entries, each capped at `MAX_SNIPPET_BYTES`. Snippets with
 * a language tag in `PREFERRED_LANGUAGE_TAGS` are surfaced first; un-tagged
 * blocks come last (and are kept only if there's room).
 *
 * Unbalanced fences and zero-length bodies are skipped.
 */
export function extractIssueCodeSnippets(body: string | undefined | null): IssueCodeSnippet[] {
  if (!body || typeof body !== 'string') return [];
  const all: IssueCodeSnippet[] = [];
  SNIPPET_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SNIPPET_FENCE_RE.exec(body)) !== null) {
    const language = (match[1] ?? '').trim().toLowerCase();
    let code = match[2] ?? '';
    if (!code.trim()) continue;
    if (code.length > MAX_SNIPPET_BYTES) {
      code = code.slice(0, MAX_SNIPPET_BYTES) + '\n# [...truncated by repro-hints]';
    }
    all.push({ language, code });
  }

  if (all.length === 0) return [];

  const preferred = all.filter((s) => s.language && PREFERRED_LANGUAGE_TAGS.has(s.language));
  const others = all.filter((s) => !preferred.includes(s));
  const ordered = [...preferred, ...others];

  // De-dupe identical bodies (some issue bodies repeat the same snippet in
  // multiple places — collapse to keep the prompt slim).
  const seen = new Set<string>();
  const deduped: IssueCodeSnippet[] = [];
  for (const s of ordered) {
    const k = s.code.trim();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(s);
    if (deduped.length >= MAX_SNIPPETS) break;
  }
  return deduped;
}

/**
 * Render the snippets as a prompt block. Returns null when there's nothing
 * to surface, so callers can omit the section entirely.
 */
export function renderIssueSnippetsBlock(snippets: IssueCodeSnippet[]): string | null {
  if (!snippets || snippets.length === 0) return null;
  const lines: string[] = [];
  lines.push(
    `Verbatim code snippets from the issue body (try these EXACTLY first — paraphrasing tends to lose the bug):`
  );
  snippets.forEach((s, i) => {
    const tag = s.language || 'text';
    lines.push('');
    lines.push(`Snippet ${i + 1} (\`${tag}\`):`);
    lines.push('```' + tag);
    lines.push(s.code.replace(/\r\n/g, '\n').replace(/\s+$/, ''));
    lines.push('```');
  });
  return lines.join('\n');
}

/**
 * Render the editable-install candidates as a prompt block.
 */
export function renderEditableInstallsBlock(candidates: string[]): string | null {
  if (!candidates || candidates.length === 0) return null;
  const lines: string[] = [];
  lines.push(
    `Candidate editable-install dirs (each contains a Python package manifest). If the repro raises ModuleNotFoundError on an in-repo import, run \`pip install -e <dir>\` from the matching candidate BEFORE revising the test:`
  );
  for (const c of candidates) lines.push(`- ${c}`);
  return lines.join('\n');
}
