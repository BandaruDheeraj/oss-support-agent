/**
 * Sandbox Registry — reads persisted per-SDK sandbox tests from the support-agent repo
 * and returns them as context for the repro builder / repair agent.
 *
 * Sandboxes live at:
 *   sandboxes/{repoOwner}/{sdkName}/
 *     conftest.py
 *     test_issue_NNN_*.py   ← grows with each fixed issue
 *     shared/
 *       arize_trace_helper.py
 *
 * The registry:
 *   1. Resolves the SDK name from the dossier suspect symbols / package paths
 *   2. Reads the conftest + existing tests
 *   3. Returns a formatted context string for injection into the repair prompt
 *
 * After a successful repro, call registerNewTest() to commit the new test file
 * back into the sandbox so future issues build on it.
 */

import fs from 'fs';
import path from 'path';

export interface SandboxFile {
  path: string;    // relative to repo root
  content: string;
}

export interface SandboxContext {
  sdkName: string;
  sandboxDir: string;
  files: SandboxFile[];
  /** Formatted block for injection into the LLM repair prompt. */
  promptBlock: string;
}

/** Map from canonical SDK name fragments to sandbox dir names.
 *  The `openinference-instrumentation-` prefix is stripped before matching,
 *  so each SDK needs only one entry. Entries are sorted longest-first so the
 *  most-specific match wins (e.g. "llama-index" beats "llama").
 */
const SDK_DIR_MAP: Record<string, string> = {
  openllmetry: 'openllmetry',
  langchain: 'langchain',
  'llama-index': 'llamaindex',
  llamaindex: 'llamaindex',
  dspy: 'dspy',
  bedrock: 'bedrock',
  anthropic: 'anthropic',
  groq: 'groq',
  mistralai: 'mistralai',
  vertexai: 'vertexai',
};

// Pre-sorted (longest fragment first) so most-specific match wins; hoisted to avoid
// re-allocating on every resolveSdkDir call.
const SDK_DIR_ENTRIES = Object.entries(SDK_DIR_MAP).sort((a, b) => b[0].length - a[0].length);

// Cache loadSandboxContext results to avoid repeated disk reads within a single repair session.
const _sandboxCache = new Map<string, SandboxContext | null>();

function resolveSdkDir(repoOwner: string, hint: string): string | null {
  // Strip the common prefix so the SDK_DIR_MAP stays half the size.
  const lower = hint.toLowerCase().replace('openinference-instrumentation-', '');
  for (const [fragment, dir] of SDK_DIR_ENTRIES) {
    if (lower.includes(fragment)) {
      return path.join('sandboxes', repoOwner, dir);
    }
  }
  return null;
}

/**
 * Load sandbox context for a given SDK hint (package path, module name, etc.).
 * Returns null if no sandbox exists yet — the builder will create the first one.
 */
export function loadSandboxContext(
  repoOwner: string,
  sdkHint: string,
  repoRoot: string = process.cwd()
): SandboxContext | null {
  const cacheKey = `${repoOwner}:${sdkHint}:${repoRoot}`;
  if (_sandboxCache.has(cacheKey)) return _sandboxCache.get(cacheKey)!;

  const sandboxDir = resolveSdkDir(repoOwner, sdkHint);
  if (!sandboxDir) {
    _sandboxCache.set(cacheKey, null);
    return null;
  }

  const absDir = path.join(repoRoot, sandboxDir);
  if (!fs.existsSync(absDir)) return null;

  const files: SandboxFile[] = [];

  // Read conftest first, then tests in issue-number order
  const entries = fs.readdirSync(absDir).sort();
  for (const entry of entries) {
    if (!entry.endsWith('.py')) continue;
    const filePath = path.join(sandboxDir, entry);
    try {
      const content = fs.readFileSync(path.join(repoRoot, filePath), 'utf-8');
      files.push({ path: filePath, content });
    } catch {
      // skip unreadable files
    }
  }

  // Also include shared helper
  const sharedHelper = path.join('sandboxes', repoOwner, 'shared', 'arize_trace_helper.py');
  const absHelper = path.join(repoRoot, sharedHelper);
  if (fs.existsSync(absHelper)) {
    files.unshift({
      path: sharedHelper,
      content: fs.readFileSync(absHelper, 'utf-8'),
    });
  }

  if (files.length === 0) {
    _sandboxCache.set(cacheKey, null);
    return null;
  }

  const sdkName = sandboxDir.split('/').pop() ?? sdkHint;

  const promptBlock = [
    `━━━ EXISTING SANDBOX (${sdkName}) ━━━`,
    `These files already exist in the support-agent repo at ${sandboxDir}/.`,
    `Use the conftest fixtures (make_tracer_provider, oi_tracer, memory_exporter) and`,
    `the arize_trace_helper to emit broken traces to Arize AX for reviewer visibility.`,
    `Add a new test file test_issue_NNN_<short_description>.py following the same pattern.`,
    '',
    ...files.map((f) => `=== ${f.path} ===\n${f.content}`),
  ].join('\n');

  const ctx: SandboxContext = { sdkName, sandboxDir, files, promptBlock };
  _sandboxCache.set(cacheKey, ctx);
  return ctx;
}

/**
 * Persist a new test file into the sandbox directory after a successful repro.
 * Call this from the builder after runReproBuilder() succeeds.
 */
export function registerNewTest(
  repoOwner: string,
  sdkHint: string,
  issueNumber: number,
  testFileName: string,
  testContent: string,
  repoRoot: string = process.cwd()
): string | null {
  const sandboxDir = resolveSdkDir(repoOwner, sdkHint);
  if (!sandboxDir) return null;

  const absDir = path.join(repoRoot, sandboxDir);
  if (!fs.existsSync(absDir)) {
    fs.mkdirSync(absDir, { recursive: true });
  }

  const safeName = testFileName.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const destPath = path.join(absDir, `test_issue_${issueNumber}_${safeName}`);
  fs.writeFileSync(destPath, testContent, 'utf-8');
  return destPath;
}
