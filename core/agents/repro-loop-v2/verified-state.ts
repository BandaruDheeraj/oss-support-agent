/**
 * Verified sandbox state — mechanically derived classification of what
 * the Repro Executor's prior tool calls have actually established in the
 * stateful sandbox (local adapter's persistent venv + workspace).
 *
 * This module is a PURE FUNCTION over the transcript — no side effects.
 * Commit A wires it as an observability log only; commits B/C use the
 * rendered form as a prompt prelude and as a gate input.
 *
 * Rationale: the Executor today re-derives "what's been verified" from
 * raw transcript text every turn, which is unreliable. A pre-classified
 * ledger makes statefulness visible as ~200 tokens at the top of the
 * prompt instead of buried in 8KB of mixed tool I/O.
 */

import type { TranscriptEntry } from '../tools/types';

export interface VerifiedSandboxState {
  /** pip_install specs that returned exitCode === 0. Most recent first. */
  installsOK: string[];
  /** pip_install specs that returned non-zero or threw. Most recent first. */
  installsFailed: string[];
  /**
   * Module names confirmed importable, derived from BOTH
   * python_module_check(name) → importable:true AND
   * run_python(snippet starting with "from X import …" or "import X")
   * that returned exitCode === 0. De-duplicated, insertion order.
   */
  importable: string[];
  /**
   * Module names confirmed NOT importable, derived from
   * python_module_check(name) → importable:false OR
   * run_python(import statement) that returned exit !== 0 with
   * ModuleNotFoundError/ImportError in stderr.
   * De-duplicated. Most recent failure reason preserved.
   */
  notImportable: Array<{ module: string; reason: string }>;
  /** Count of run_python calls that returned exitCode === 0. */
  runPythonSuccessCount: number;
  /** Count of run_python calls that returned exitCode !== 0. */
  runPythonFailureCount: number;
  /** Path of the committed test file (last successful write_test/revise_test), if any. */
  testCommittedPath: string | null;
  /** Count of successful run_repro calls (back-compat: e.ok regardless of exitCode). */
  runReproCount: number;
  /** Count of successful run_repro calls with exitCode === 0 (test PASSED — bug not triggered). */
  runReproPassingCount: number;
  /** Count of successful run_repro calls with exitCode !== 0 (test FAILED — regardless of cause). */
  runReproFailingCount: number;
  /** Count of run_repro calls that either threw or returned a non-numeric exitCode. */
  runReproErrorCount: number;
  /**
   * Count of POSITIVE run_repro observations AFTER the latest successful
   * write_test/revise_test: exitCode !== 0 AND the derived sentinel appears
   * in stdout+stderr. This is the canonical "you have a working repro"
   * signal. Requires the sentinel to be derivable from a recent test write;
   * if no sentinel can be derived, this stays 0.
   */
  runReproPositiveSinceWrite: number;
  /**
   * The sentinel string the classifier used (extracted from the latest
   * write_test/revise_test content). Null if not derivable.
   */
  derivedSentinel: string | null;
}

const IMPORT_LINE_RE = /^\s*(?:from\s+([a-zA-Z_][\w.]*)\s+import\b|import\s+([a-zA-Z_][\w.]*))/m;
const MODULE_NOT_FOUND_RE = /(?:ModuleNotFoundError|ImportError)[^\n]*?named\s+['"]?([\w.]+)['"]?/;

/**
 * Extract the most likely sentinel string from the most recent successful
 * write_test/revise_test in the transcript. Looks for `assert False, "<text>"`
 * or `assert False, '<text>'` (the canonical pattern in the Prober's SYSTEM
 * prompt and the candidate-repro renderer). Also tolerates the variant
 * `assert False, "<text>: " + …` produced by the unexpected_exception
 * template. Returns just the bare sentinel substring (no trailing ": ").
 *
 * Exported for tests / gates that need the same sentinel the classifier used.
 */
export function extractSentinelFromTranscript(transcript: TranscriptEntry[]): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if ((e.tool !== 'write_test' && e.tool !== 'revise_test') || !e.ok) continue;
    const args = e.args as Record<string, unknown> | undefined | null;
    const content = typeof args?.content === 'string' ? args.content : '';
    if (!content) continue;
    // Match: assert False, "<sentinel>" or assert False, "<sentinel>: " + ...
    // Use a non-greedy capture and accept either quote style.
    const m =
      content.match(/assert\s+False\s*,\s*"([^"\\\n]+?)(?::\s*)?"/) ||
      content.match(/assert\s+False\s*,\s*'([^'\\\n]+?)(?::\s*)?'/);
    if (m && m[1] && m[1].length >= 4) {
      return m[1];
    }
  }
  return null;
}

/**
 * Pure: classify transcript into a VerifiedSandboxState.
 *
 * Defensive about result shapes — tool results are `unknown` at this layer
 * since the registry stores redacted versions. We narrow with typeof checks
 * and ignore entries we can't interpret rather than throwing.
 *
 * If `opts.sentinel` is provided it is used to count "positive" run_repro
 * observations; otherwise the function auto-extracts the sentinel from the
 * latest test write via `extractSentinelFromTranscript`.
 */
export function deriveVerifiedState(
  transcript: TranscriptEntry[],
  opts?: { sentinel?: string }
): VerifiedSandboxState {
  const installsOK: string[] = [];
  const installsFailed: string[] = [];
  const importable: string[] = [];
  const notImportableMap = new Map<string, string>();
  let runPythonSuccessCount = 0;
  let runPythonFailureCount = 0;
  let testCommittedPath: string | null = null;
  let runReproCount = 0;
  let runReproPassingCount = 0;
  let runReproFailingCount = 0;
  let runReproErrorCount = 0;
  let lastWriteIdx = -1;

  const seenImportable = new Set<string>();

  const derivedSentinel = opts?.sentinel ?? extractSentinelFromTranscript(transcript);

  for (let idx = 0; idx < transcript.length; idx++) {
    const e = transcript[idx];
    const r = e.result as Record<string, unknown> | undefined | null;
    const args = e.args as Record<string, unknown> | undefined | null;

    if (e.tool === 'pip_install') {
      const spec = typeof args?.spec === 'string' ? args.spec : '<unknown>';
      const exit = typeof r?.exitCode === 'number' ? r.exitCode : (e.ok ? 0 : 1);
      if (e.ok && exit === 0) {
        installsOK.unshift(spec);
      } else {
        installsFailed.unshift(spec);
      }
      continue;
    }

    if (e.tool === 'python_module_check') {
      const name = typeof args?.name === 'string' ? args.name : '<unknown>';
      if (e.ok && r?.importable === true) {
        if (!seenImportable.has(name)) {
          importable.push(name);
          seenImportable.add(name);
        }
        notImportableMap.delete(name);
      } else if (e.ok && r?.importable === false) {
        const reason = typeof r?.error === 'string' ? r.error : 'python_module_check returned importable=false';
        notImportableMap.set(name, reason);
      }
      continue;
    }

    if (e.tool === 'run_python') {
      const exit = typeof r?.exitCode === 'number' ? r.exitCode : (e.ok ? 0 : 1);
      const stderr = typeof r?.stderr === 'string' ? r.stderr : '';
      const snippet = typeof args?.snippet === 'string' ? args.snippet : '';
      const importMatch = snippet.match(IMPORT_LINE_RE);
      const importedModule = importMatch?.[1] ?? importMatch?.[2];
      if (e.ok && exit === 0) {
        runPythonSuccessCount += 1;
        // If the snippet was effectively an import probe, record the module.
        if (importedModule && !seenImportable.has(importedModule)) {
          importable.push(importedModule);
          seenImportable.add(importedModule);
          notImportableMap.delete(importedModule);
        }
      } else {
        runPythonFailureCount += 1;
        // Try to extract a failed import target from stderr.
        const modErr = stderr.match(MODULE_NOT_FOUND_RE);
        if (modErr?.[1]) {
          notImportableMap.set(modErr[1], modErr[0].trim().slice(0, 200));
        } else if (importedModule && !seenImportable.has(importedModule)) {
          // Non-import failure (e.g. the bug raised, AttributeError, etc.).
          // The import line itself succeeded — Python parses+executes top-down
          // and the failure surfaced after import. Credit the module as
          // importable so a strong "probe + exercise" snippet that reaches
          // the bug doesn't get classified as no-progress by the probe gate.
          importable.push(importedModule);
          seenImportable.add(importedModule);
          notImportableMap.delete(importedModule);
        }
      }
      continue;
    }

    if (e.tool === 'write_test' || e.tool === 'revise_test') {
      if (e.ok) {
        const path =
          (e.tool === 'write_test' ? (r?.written as string | undefined) : (r?.revised as string | undefined)) ??
          (typeof args?.path === 'string' ? args.path : null);
        if (path) testCommittedPath = path;
        lastWriteIdx = idx;
      }
      continue;
    }

    if (e.tool === 'run_repro') {
      if (!e.ok || typeof r?.exitCode !== 'number') {
        runReproErrorCount += 1;
        continue;
      }
      runReproCount += 1;
      if (r.exitCode === 0) {
        runReproPassingCount += 1;
      } else {
        runReproFailingCount += 1;
      }
      continue;
    }
  }

  // Count POSITIVE observations only after the latest test write.
  let runReproPositiveSinceWrite = 0;
  if (lastWriteIdx >= 0 && derivedSentinel) {
    for (let i = lastWriteIdx + 1; i < transcript.length; i++) {
      const e = transcript[i];
      if (e.tool !== 'run_repro' || !e.ok) continue;
      const r = e.result as { exitCode?: number; stdout?: string; stderr?: string } | null;
      if (!r || typeof r.exitCode !== 'number' || r.exitCode === 0) continue;
      const combined = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
      if (combined.includes(derivedSentinel)) runReproPositiveSinceWrite += 1;
    }
  }

  return {
    installsOK,
    installsFailed,
    importable,
    notImportable: Array.from(notImportableMap.entries()).map(([module, reason]) => ({ module, reason })),
    runPythonSuccessCount,
    runPythonFailureCount,
    testCommittedPath,
    runReproCount,
    runReproPassingCount,
    runReproFailingCount,
    runReproErrorCount,
    runReproPositiveSinceWrite,
    derivedSentinel,
  };
}

/**
 * Render the verified state as a compact block suitable for either a
 * console log (Commit A) or a prompt prelude (Commit B). One-line-per-key
 * where possible; truncated lists for high-cardinality fields.
 */
export function renderVerifiedState(state: VerifiedSandboxState): string {
  const lines: string[] = [];
  lines.push('VERIFIED SANDBOX STATE (mechanically derived from your prior tool calls — trust this, do not re-probe):');
  lines.push(`  Editable installs OK: ${formatList(state.installsOK)}`);
  lines.push(`  pip_install failed: ${formatList(state.installsFailed)}`);
  lines.push(`  Modules importable: ${formatList(state.importable)}`);
  if (state.notImportable.length > 0) {
    lines.push('  Modules NOT importable:');
    for (const ni of state.notImportable.slice(0, 6)) {
      lines.push(`    - ${ni.module}  (${truncate(ni.reason, 120)})`);
    }
  } else {
    lines.push('  Modules NOT importable: (none observed)');
  }
  lines.push(`  run_python calls succeeded: ${state.runPythonSuccessCount}`);
  lines.push(`  run_python calls failed: ${state.runPythonFailureCount}`);
  lines.push(`  Test file committed: ${state.testCommittedPath ?? 'no'}`);
  lines.push(
    `  run_repro: ${state.runReproFailingCount} failing (exit!=0), ${state.runReproPassingCount} passing (exit=0 — bug NOT triggered), ${state.runReproErrorCount} errored`
  );
  if (state.derivedSentinel) {
    lines.push(
      `  POSITIVE run_repro since last test write (exit!=0 AND sentinel "${state.derivedSentinel}" in output): ${state.runReproPositiveSinceWrite}`
    );
  } else {
    lines.push(`  POSITIVE run_repro since last test write: 0 (no sentinel derivable from current test)`);
  }
  return lines.join('\n');
}

/**
 * One-line summary suitable for embedding in the existing `[v2-executor]`
 * diagnostic log line in `executor.ts`. Stable shape for grep-ability.
 */
export function summariseVerifiedState(state: VerifiedSandboxState): string {
  return (
    `installs_ok=${state.installsOK.length} installs_failed=${state.installsFailed.length}` +
    ` importable=${state.importable.length} not_importable=${state.notImportable.length}` +
    ` run_python_ok=${state.runPythonSuccessCount} run_python_err=${state.runPythonFailureCount}` +
    ` test_committed=${state.testCommittedPath ? 'yes' : 'no'}` +
    ` run_repro_ok=${state.runReproCount} run_repro_failing=${state.runReproFailingCount}` +
    ` run_repro_passing=${state.runReproPassingCount} run_repro_errored=${state.runReproErrorCount}` +
    ` run_repro_positive_since_write=${state.runReproPositiveSinceWrite}`
  );
}

function formatList(items: string[]): string {
  if (items.length === 0) return '(none)';
  const shown = items.slice(0, 8);
  const tail = items.length > shown.length ? ` (+${items.length - shown.length} more)` : '';
  return `[${shown.join(', ')}]${tail}`;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}
