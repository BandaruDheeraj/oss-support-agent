/**
 * Extract repo-relative file paths mentioned in issue text.
 *
 * Motivation: the fix-agent otherwise only sees a blind sample from gatherModuleFiles.
 * If the issue body or its traceback names specific files, we should pre-load them
 * so the first fix attempt isn't blind.
 *
 * Safety: every returned path is repo-relative (no leading slash, no `..`). Callers
 * should still verify the path exists in the workspace before reading.
 */

const KNOWN_EXTS = new Set([
  'py',
  'pyi',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'go',
  'rs',
  'java',
  'kt',
  'rb',
  'cs',
  'cpp',
  'c',
  'h',
  'hpp',
  'md',
  'yml',
  'yaml',
  'json',
  'toml',
]);

const TRACEBACK_PYTHON = /File\s+"([^"]+)",\s*line\s*\d+/g;
const TRACEBACK_JS = /\b(?:at\s+[^\n(]*\(?|\bfrom\s+)([\w./@-]+\.[a-zA-Z]{1,5})(?::\d+(?::\d+)?)?\)?/g;
const BACKTICKED_PATH = /`([^`\s]+)`/g;
const FILE_HEADER = /(?:^|\n)\s*\*{0,2}File\*{0,2}\s*:\*{0,2}\s*`?([^\s`*]+\.[a-zA-Z]{1,5}(?::\d+(?::\d+)?)?)`?/gi;
const PATH_HEADER = /(?:^|\n)\s*\*{0,2}Path\*{0,2}\s*:\*{0,2}\s*`?([^\s`*]+\.[a-zA-Z]{1,5}(?::\d+(?::\d+)?)?)`?/gi;
// "in src/foo/bar.py" — narrative mentions
const NARRATIVE_PATH = /\b(?:in|at|inside|within|of|from|see|file)\s+([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,5})\b/g;

function hasKnownExt(p: string): boolean {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = p.slice(dot + 1).toLowerCase();
  return KNOWN_EXTS.has(ext);
}

/**
 * Normalize a candidate path:
 *  - strip surrounding punctuation
 *  - strip absolute path prefix back to a repo-relative best guess
 *  - drop site-packages/ and dist-packages/ prefixes so the result is the
 *    import-path suffix (`<pkg>/<rest>`) the workspace can resolve via
 *    suffix matching
 *  - reject empty / parent-traversal
 *
 * Returns null if path is unsafe or doesn't look like a code file.
 */
function normalize(raw: string): string | null {
  let p = raw.trim().replace(/^[(\[<"']+|[)\]>"',.;:]+$/g, '');
  if (!p) return null;
  // strip windows drive letters and absolute prefixes
  p = p.replace(/\\/g, '/');
  // strip line:col suffixes "foo.py:42:7" BEFORE extension check
  p = p.replace(/(\.[a-zA-Z]{1,5}):\d+(:\d+)?$/, '$1');
  // If it's an absolute path or contains a virtualenv install root, try to
  // recover a repo-relative suffix. site-packages/dist-packages prefixes
  // never map to actual repo paths, so we drop them entirely — leaving the
  // import-path suffix (e.g. "openinference/instrumentation/smolagents/_wrappers.py")
  // which the workspace resolves via suffix matching.
  if (
    /^([a-zA-Z]:\/|\/)/.test(p) ||
    p.includes('site-packages/') ||
    p.includes('dist-packages/') ||
    p.includes('.venv/')
  ) {
    // Try to peel back to a known repo marker first. We match at a path-
    // component boundary (preceded by `/`) so that `packages/` doesn't
    // erroneously match inside `site-packages/` or `dist-packages/`. We
    // pick the LEFTMOST matching marker so the recovered path is as long
    // (i.e. as repo-rooted) as possible — e.g. `python/.../src/foo.py`
    // beats `src/foo.py`.
    const repoMarkers = ['python/', 'packages/', 'src/'];
    let bestIdx = -1;
    for (const m of repoMarkers) {
      const re = new RegExp('(?:^|/)' + m.replace(/\//g, '\\/'));
      const match = re.exec(p);
      if (!match) continue;
      // index after the optional leading "/"
      const idx = match.index + (p[match.index] === '/' ? 1 : 0);
      if (bestIdx < 0 || idx < bestIdx) bestIdx = idx;
    }
    let recovered = false;
    if (bestIdx >= 0) {
      p = p.slice(bestIdx);
      recovered = true;
    }
    // Otherwise, drop the install-root prefix entirely. The suffix that
    // remains is the import path under the package — callers must resolve
    // it against the repo (e.g. by suffix-globbing).
    if (!recovered) {
      for (const m of ['site-packages/', 'dist-packages/', '.venv/']) {
        const idx = p.lastIndexOf(m);
        if (idx >= 0) {
          p = p.slice(idx + m.length);
          break;
        }
      }
    }
    if (/^([a-zA-Z]:\/|\/)/.test(p)) return null;
  }
  if (p.includes('..')) return null;
  if (!hasKnownExt(p)) return null;
  if (p.length > 400) return null;
  return p;
}

/**
 * Extract candidate file paths from arbitrary issue text.
 *
 * The result is a deduplicated, normalized list of repo-relative paths. The
 * caller MUST verify each path exists in the workspace before reading it
 * (paths like `tools.py` referenced narratively in an issue may not exist
 * at the repo root).
 */
export function extractFilePaths(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();

  const push = (raw: string | undefined) => {
    if (!raw) return;
    const n = normalize(raw);
    if (n) out.add(n);
  };

  for (const re of [TRACEBACK_PYTHON, TRACEBACK_JS, BACKTICKED_PATH, FILE_HEADER, PATH_HEADER, NARRATIVE_PATH]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      push(m[1]);
    }
  }

  return Array.from(out);
}

/**
 * Combine extractFilePaths over multiple text fragments (e.g. each issue body).
 */
export function extractFilePathsFromAll(fragments: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const frag of fragments) {
    for (const p of extractFilePaths(frag)) seen.add(p);
  }
  return Array.from(seen);
}
