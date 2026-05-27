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
  /** Count of successful run_repro calls. */
  runReproCount: number;
}

const IMPORT_LINE_RE = /^\s*(?:from\s+([a-zA-Z_][\w.]*)\s+import\b|import\s+([a-zA-Z_][\w.]*))/m;
const MODULE_NOT_FOUND_RE = /(?:ModuleNotFoundError|ImportError)[^\n]*?named\s+['"]?([\w.]+)['"]?/;

/**
 * Pure: classify transcript into a VerifiedSandboxState.
 *
 * Defensive about result shapes — tool results are `unknown` at this layer
 * since the registry stores redacted versions. We narrow with typeof checks
 * and ignore entries we can't interpret rather than throwing.
 */
export function deriveVerifiedState(transcript: TranscriptEntry[]): VerifiedSandboxState {
  const installsOK: string[] = [];
  const installsFailed: string[] = [];
  const importable: string[] = [];
  const notImportableMap = new Map<string, string>();
  let runPythonSuccessCount = 0;
  let runPythonFailureCount = 0;
  let testCommittedPath: string | null = null;
  let runReproCount = 0;

  const seenImportable = new Set<string>();

  for (const e of transcript) {
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
      }
      continue;
    }

    if (e.tool === 'run_repro' && e.ok) {
      runReproCount += 1;
      continue;
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
  lines.push(`  run_repro successes: ${state.runReproCount}`);
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
    ` run_repro_ok=${state.runReproCount}`
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
