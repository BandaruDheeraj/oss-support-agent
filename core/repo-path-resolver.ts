/**
 * Helpers for resolving issue-mentioned paths against a real workspace.
 *
 * - `resolveSuffixToRepoPath`: given a (possibly site-packages-derived)
 *   path suffix like `openinference/instrumentation/smolagents/_wrappers.py`,
 *   find the best repo file by suffix matching. Ranks candidates so a
 *   vendored / dist / build copy doesn't outrank the real source.
 *
 * - `validateEditableInstallPath`: given a repo-relative directory the LLM
 *   wants to `pip install -e`, confirm it actually exists in the workspace
 *   AND contains a recognizable Python package manifest. We do this BEFORE
 *   running pip so the email tells the user the LLM picked a bad path
 *   instead of dumping a pip error.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SuffixResolveResult {
  /** Direct read succeeded (no suffix search needed). */
  direct: boolean;
  /** All matches found (ranked best-first). Empty if nothing matched. */
  matches: string[];
}

/**
 * Rank candidate matches so high-confidence repo paths beat fixtures/vendored copies.
 *
 * Priority (lower number = better):
 *   0  exact direct path (caller already tried readFile, so this is rare)
 *   1  matches `python/instrumentation/*\/src/<suffix>`  (openinference layout)
 *   2  matches `**\/src/<suffix>` (any package layout)
 *   3  matches `**\/lib/<suffix>`
 *   4  other path under `python/`, `packages/`, `src/`
 *   5  anything else
 *
 * Within the same rank, prefer the shortest path.
 */
function rankMatch(p: string, exactDirect?: boolean): number {
  if (exactDirect) return 0;
  // openinference monorepo specifically: python/instrumentation/<dist>/src/...
  if (/^python\/instrumentation\/[^/]+\/src\//.test(p)) return 1;
  if (p.includes('/src/')) return 2;
  if (p.includes('/lib/')) return 3;
  if (
    p.startsWith('python/') ||
    p.startsWith('packages/') ||
    p.startsWith('src/')
  ) {
    return 4;
  }
  return 5;
}

export function rankMatches(matches: string[]): string[] {
  return [...matches].sort((a, b) => {
    const ra = rankMatch(a);
    const rb = rankMatch(b);
    if (ra !== rb) return ra - rb;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });
}

/**
 * Verify an editable-install path looks like a real Python package.
 *
 * Returns null on success, or a human-readable reason if invalid.
 */
export function validateEditableInstallPath(
  workspaceDir: string,
  relPath: string
): string | null {
  const abs = path.join(workspaceDir, relPath);
  if (!fs.existsSync(abs)) {
    return `directory does not exist in workspace: ${relPath}`;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (err: any) {
    return `cannot stat ${relPath}: ${err?.message ?? err}`;
  }
  if (!stat.isDirectory()) {
    return `not a directory: ${relPath}`;
  }
  const MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg'];
  const hasManifest = MARKERS.some((m) => fs.existsSync(path.join(abs, m)));
  if (!hasManifest) {
    return `no Python package manifest (pyproject.toml / setup.py / setup.cfg) found in ${relPath}`;
  }
  return null;
}
