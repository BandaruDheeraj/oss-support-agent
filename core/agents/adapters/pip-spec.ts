/**
 * Heuristics for pip install specs coming from agent-authored tool calls.
 *
 * We only pre-probe "bare import-like" specs (e.g. `inspect`, `json`, `foo.bar`).
 * For anything with flags, paths, version markers, extras, URLs, or package-name
 * punctuation (`-`) we defer to pip directly.
 */

export interface ModuleCheckResult {
  importable?: boolean;
}

const IMPORTABLE_MODULE_SPEC = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const DISALLOWED_PIP_SPEC_CHARS = /[\s<>=!~\[\]@:/\\-]/;

/**
 * Returns a Python import-probe candidate when `spec` looks like a bare module
 * name (`inspect`, `json`, `foo.bar`). Returns null for editable specs, version
 * pins/ranges, extras, URLs, paths, or package-name forms (`google-genai`).
 */
export function pipSpecToImportProbeName(spec: string): string | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  if (DISALLOWED_PIP_SPEC_CHARS.test(trimmed)) return null;
  if (!IMPORTABLE_MODULE_SPEC.test(trimmed)) return null;
  return trimmed;
}

/**
 * Best-effort guard against redundant installs of already-importable modules
 * (including stdlib modules like `inspect`).
 *
 * Returns the import name to skip when moduleCheck(importName).importable=true;
 * otherwise returns null so callers proceed with `pip install`.
 */
export async function resolveSkippablePipInstall(
  spec: string,
  moduleCheck: (name: string) => Promise<ModuleCheckResult>
): Promise<string | null> {
  const importName = pipSpecToImportProbeName(spec);
  if (!importName) return null;
  const check = await moduleCheck(importName);
  return check.importable === true ? importName : null;
}

