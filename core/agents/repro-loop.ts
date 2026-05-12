/**
 * Iterative repro loop.
 *
 * Drives an `IterativeReproGenerator` (LLM) against a `ReproWorkspace`
 * (file/dir/find/grep adapter) and a `BaselineRunner` (sandbox callback)
 * until either:
 *   - a candidate repro is validated and reproduces the bug on baseline → return
 *     ReproLoopSuccess, OR
 *   - the budget is exhausted / a terminal stop reason is reached → throw
 *     ReproUnreproducibleError (or ReproCredentialsRequiredError if the
 *     baseline detected missing inferred credentials).
 *
 * Design notes:
 *   - The loop NEVER runs shell. Setup + the python invocation happens in
 *     the baseline-runner callback, which the pipeline owns.
 *   - The runner is responsible for resetting the workspace tree before
 *     returning, so attempt N+1 starts clean.
 *   - Per-attempt feedback (validation stage, reason, redacted stdout/stderr
 *     tail) is shown to the LLM next turn so it can refine.
 *   - Identical candidate (path+content+sentinel) emitted twice → short
 *     circuit with explicit "duplicate" feedback. Prevents the LLM from
 *     wasting baseline runs on the same failed attempt.
 *   - Setup-validation / path-validation failures are NOT terminal: they
 *     become retry feedback. Repeated identical failures eat the budget,
 *     so the LLM has to actually fix them.
 */

import {
  type IterativeReproGenerator,
  type IterativeReproGeneratorInput,
  type ReproAgentInput,
  type ReproAttemptHistoryEntry,
  type ReproAttemptStage,
  type ReproGeneratorAction,
  type ReproGeneratorOutput,
  type ReproLoopSuccess,
  type ReproSpec,
  type ReproWorkspace,
  type BaselineRunner,
  type BaselineRunResult,
  type ContextRequest,
  type ContextResult,
  ReproAgentError,
  ReproCredentialsRequiredError,
  ReproUnreproducibleError,
} from './repro-types';
import { validateAndBuildReproSpec } from './repro';

export interface ReproLoopOptions {
  /** Hard cap on total LLM calls (default 8). */
  maxIterations?: number;
  /** Cap on baseline executions (default 4). Each baseline run is expensive. */
  maxBaselineAttempts?: number;
  /** Cap on context-request rounds (default 5). */
  maxContextRequestRounds?: number;
  /** Per-attempt stdout/stderr tail bytes to feed back (default 2048). */
  feedbackTailBytes?: number;
  /** Per-attempt content preview bytes (default 2048). */
  contentPreviewBytes?: number;
  /** Optional logger (called with single-line messages). */
  log?: (msg: string) => void;
}

const DEFAULTS: Required<Omit<ReproLoopOptions, 'log'>> = {
  maxIterations: 8,
  maxBaselineAttempts: 4,
  maxContextRequestRounds: 8,
  feedbackTailBytes: 2048,
  contentPreviewBytes: 2048,
};

/**
 * Run the iterative repro loop. See module doc for behavior.
 *
 * Throws:
 *   - ReproCredentialsRequiredError when the baseline runner reports a
 *     terminal credentials-missing condition (the pipeline maps this to
 *     `awaiting-credentials`).
 *   - ReproUnreproducibleError when the budget is exhausted or the
 *     generator misbehaves repeatedly.
 */
export async function runReproLoop(
  input: ReproAgentInput,
  generator: IterativeReproGenerator,
  workspace: ReproWorkspace,
  baseline: BaselineRunner,
  options: ReproLoopOptions = {}
): Promise<ReproLoopSuccess> {
  if (input.language !== 'python') {
    throw new ReproAgentError(`unsupported language: ${input.language}`, 'validate');
  }
  const opts = { ...DEFAULTS, ...options };
  const log = options.log ?? (() => {});

  const attempts: ReproAttemptHistoryEntry[] = [];
  const loadedContext: ContextResult[] = [];
  const seenCandidateHashes = new Set<string>();

  let baselineAttempts = 0;
  let contextRounds = 0;
  let lastReason = 'no attempts made';

  const repoTreeSummary = safeRepoTree(workspace);

  for (let iter = 1; iter <= opts.maxIterations; iter++) {
    if ('beginTurn' in workspace && typeof (workspace as any).beginTurn === 'function') {
      (workspace as any).beginTurn();
    }
    const remainingIterations = opts.maxIterations - iter;
    const remainingBaselineAttempts = opts.maxBaselineAttempts - baselineAttempts;
    const remainingContextRequests = Math.max(0, opts.maxContextRequestRounds - contextRounds);

    const turnInput: IterativeReproGeneratorInput = {
      ...input,
      repoTreeSummary,
      previousAttempts: attempts,
      loadedContext,
      iteration: iter,
      remainingIterations,
      remainingBaselineAttempts,
      remainingContextRequests,
    };

    let action: ReproGeneratorAction;
    try {
      log(
        `[repro-loop] iteration ${iter}/${opts.maxIterations} ` +
          `(baselineAttempts=${baselineAttempts}/${opts.maxBaselineAttempts}, ` +
          `contextRounds=${contextRounds}/${opts.maxContextRequestRounds}, ` +
          `loadedContext=${loadedContext.length})`
      );
      action = await generator.generate(turnInput);
    } catch (err: any) {
      lastReason = `generator threw: ${err?.message ?? String(err)}`;
      log(`[repro-loop] generator error: ${lastReason}`);
      // Record as an attempt so the diagnostic carries through.
      attempts.push({
        attempt: iter,
        stage: 'schema',
        reason: lastReason,
      });
      // Generator errors are usually transient (parse / schema). Keep going
      // until the iteration budget runs out.
      continue;
    }

    if (action.kind === 'request_context') {
      if (contextRounds >= opts.maxContextRequestRounds) {
        lastReason = `LLM requested more context but the context-request budget is exhausted (${opts.maxContextRequestRounds})`;
        log(`[repro-loop] ${lastReason}`);
        attempts.push({ attempt: iter, stage: 'schema', reason: lastReason });
        continue; // give it one more turn to commit to a repro
      }
      contextRounds++;
      const requests = (action.requests ?? []).slice(0, 12); // cap per turn
      log(`[repro-loop] servicing ${requests.length} context request(s): ${action.reasoning?.slice(0, 120) ?? ''}`);
      let added = 0;
      for (const req of requests) {
        const result = serviceContextRequest(workspace, req);
        if (!result) continue;
        if (isDuplicateContext(loadedContext, req, result)) continue;
        loadedContext.push(result);
        added++;
      }
      if (added === 0) {
        // No new info → record so the LLM doesn't keep asking for the same thing.
        attempts.push({
          attempt: iter,
          stage: 'schema',
          reason: 'context request returned no new information (duplicate or denied)',
        });
      }
      continue;
    }

    // action.kind === 'repro'
    const out = action.output;
    let spec: ReproSpec;
    try {
      spec = validateAndBuildReproSpec(out, input.preferredTestDir);
    } catch (err: any) {
      const stage: ReproAttemptStage = classifyValidationError(err);
      const reason = err?.message ?? String(err);
      lastReason = reason;
      log(`[repro-loop] candidate rejected (${stage}): ${reason}`);
      attempts.push({
        attempt: iter,
        candidate: candidatePreview(out, opts.contentPreviewBytes),
        stage,
        reason,
      });
      continue;
    }

    const hash = candidateHash(spec);
    if (seenCandidateHashes.has(hash)) {
      lastReason = 'identical candidate emitted twice';
      log(`[repro-loop] duplicate candidate ${hash}; skipping baseline`);
      attempts.push({
        attempt: iter,
        candidate: candidatePreview(out, opts.contentPreviewBytes),
        stage: 'schema',
        reason: 'this exact candidate (same content/sentinel/setup) was already tried — change something',
      });
      continue;
    }
    seenCandidateHashes.add(hash);

    // Auto-inject editableInstalls when the LLM forgot to declare them and
    // its test imports an in-repo package. Without this, attempt 1 typically
    // dies with ModuleNotFoundError before any real bug-trigger runs, and
    // the LLM tends to burn its context-request budget hunting for "where is
    // the package?" rather than refining the assertion. The cost of an
    // unnecessary editable install is small; the cost of a wasted baseline
    // attempt is large.
    if (!spec.editableInstalls || spec.editableInstalls.length === 0) {
      const injected = inferEditableInstalls(spec.content, workspace);
      if (injected.length > 0) {
        log(
          `[repro-loop] auto-injecting editableInstalls (LLM omitted them): ${injected.join(', ')}`
        );
        spec = { ...spec, editableInstalls: injected };
      }
    }

    if (baselineAttempts >= opts.maxBaselineAttempts) {
      lastReason = `baseline-attempt budget exhausted (${opts.maxBaselineAttempts})`;
      log(`[repro-loop] ${lastReason}`);
      // Record this candidate too so the user-facing diagnostic shows what
      // we'd have run.
      attempts.push({
        attempt: iter,
        candidate: candidatePreview(out, opts.contentPreviewBytes),
        stage: 'schema',
        reason: lastReason,
      });
      break;
    }

    baselineAttempts++;
    let result: BaselineRunResult;
    try {
      result = await baseline(spec);
    } catch (err: any) {
      lastReason = `baseline runner threw: ${err?.message ?? String(err)}`;
      log(`[repro-loop] ${lastReason}`);
      attempts.push({
        attempt: iter,
        candidate: candidatePreview(out, opts.contentPreviewBytes),
        stage: 'workspace_setup',
        reason: lastReason,
      });
      continue;
    }

    if (result.credentialsTerminal) {
      throw new ReproCredentialsRequiredError({
        missingEnvVars: result.credentialsTerminal.inferredEnvVars,
        detectionContext:
          `inferred from baseline output (${result.credentialsTerminal.matchedPattern ?? 'unknown'})`,
        attempts: [
          ...attempts,
          {
            attempt: iter,
            candidate: candidatePreview(out, opts.contentPreviewBytes),
            stage: 'baseline_failed_to_repro',
            reason: result.reason ?? 'credentials required',
            stdoutTail: tail(result.stdout, opts.feedbackTailBytes),
            stderrTail: tail(result.stderr, opts.feedbackTailBytes),
            exitCode: result.exitCode,
          },
        ],
      });
    }

    if (result.ok) {
      log(`[repro-loop] success on attempt ${iter} (baseline run #${baselineAttempts})`);
      const entry: ReproAttemptHistoryEntry = {
        attempt: iter,
        candidate: candidatePreview(out, opts.contentPreviewBytes),
        stage: 'baseline_failed_to_repro', // unused on success; kept for shape
        reason: 'baseline reproduced the bug',
        exitCode: result.exitCode,
      };
      attempts.push(entry);
      return { spec, baseline: result, attempts };
    }

    const stage: ReproAttemptStage = result.stage ?? 'baseline_failed_to_repro';
    const reason = result.reason ?? 'baseline did not reproduce the bug';
    lastReason = reason;
    log(`[repro-loop] baseline attempt ${baselineAttempts} failed (${stage}): ${reason}`);
    attempts.push({
      attempt: iter,
      candidate: candidatePreview(out, opts.contentPreviewBytes),
      stage,
      reason,
      stdoutTail: tail(result.stdout, opts.feedbackTailBytes),
      stderrTail: tail(result.stderr, opts.feedbackTailBytes),
      exitCode: result.exitCode,
      failedSetupCommand: result.failedSetupCommand,
    });
  }

  throw new ReproUnreproducibleError({
    attempts,
    lastReason,
    terminalCategory: 'budget_exhausted',
  });
}

// ---------------------------------------------------------------------------

function serviceContextRequest(
  workspace: ReproWorkspace,
  req: ContextRequest
): ContextResult | null {
  switch (req.op) {
    case 'read_file':
      return workspace.readFile(req);
    case 'list_dir':
      return workspace.listDir(req);
    case 'find_file':
      return workspace.findFile(req);
    case 'grep':
      return workspace.grep(req);
    default:
      return null;
  }
}

function isDuplicateContext(
  prior: ContextResult[],
  req: ContextRequest,
  fresh: ContextResult
): boolean {
  for (const p of prior) {
    if (p.op !== fresh.op) continue;
    if (p.op === 'read_file' && fresh.op === 'read_file') {
      if (p.path === fresh.path && p.status === fresh.status && p.content === fresh.content) {
        return true;
      }
    } else if (p.op === 'list_dir' && fresh.op === 'list_dir') {
      if (p.path === fresh.path) return true;
    } else if (p.op === 'find_file' && fresh.op === 'find_file') {
      if (p.suffix === fresh.suffix) return true;
    } else if (p.op === 'grep' && fresh.op === 'grep') {
      if (p.query === fresh.query) return true;
    }
  }
  void req;
  return false;
}

function candidateHash(spec: ReproSpec): string {
  const setup = JSON.stringify({
    pip: spec.pipPackages ?? [],
    edit: spec.editableInstalls ?? [],
  });
  // Cheap stable hash; not cryptographic.
  let h = 5381;
  const s = `${spec.path}\0${spec.failureSentinel}\0${spec.content}\0${setup}`;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return `c${h >>> 0}`;
}

function candidatePreview(
  out: ReproGeneratorOutput,
  bytes: number
): NonNullable<ReproAttemptHistoryEntry['candidate']> {
  return {
    path: out.path,
    failureSentinel: out.failureSentinel,
    summary: out.summary,
    contentPreview: out.content.slice(0, bytes),
    pipPackages: out.pipPackages,
    editableInstalls: out.editableInstalls,
  };
}

function classifyValidationError(err: unknown): ReproAttemptStage {
  const msg = err instanceof Error ? err.message : String(err);
  if (/path|repo-relative|\.py$|disallowed characters|under /.test(msg)) {
    return 'path_validation';
  }
  if (/sentinel|failureSentinel/i.test(msg)) {
    return 'sentinel_validation';
  }
  if (/editableInstall|pipPackage|setup/i.test(msg)) {
    return 'setup_validation';
  }
  return 'schema';
}

function tail(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  return s.length <= max ? s : s.slice(s.length - max);
}

function safeRepoTree(workspace: ReproWorkspace): string {
  try {
    return workspace.repoTreeSummary();
  } catch {
    return '(repo tree unavailable)';
  }
}

/**
 * Best-effort: parse `import foo` / `from foo.bar import ...` statements
 * from a Python repro and return the subset of repo-relative
 * `editableInstallCandidates()` whose directory path contains a segment
 * matching the top-level import (or a `<anything>-<top>` form, which is
 * the standard monorepo layout, e.g. `openinference-instrumentation-X`).
 *
 * Conservative: only fires when candidates are advertised by the workspace,
 * the test content actually imports something, and the match is clear.
 * Returns innermost first; callers should de-dup. Capped at 5 results.
 */
function inferEditableInstalls(
  content: string,
  workspace: ReproWorkspace
): string[] {
  if (typeof workspace.editableInstallCandidates !== 'function') return [];
  let candidates: string[];
  try {
    candidates = workspace.editableInstallCandidates();
  } catch {
    return [];
  }
  if (!candidates || candidates.length === 0) return [];

  const tops = extractTopLevelImports(content);
  if (tops.size === 0) return [];

  // Score each candidate dir by how many of the imported top-level modules
  // its path segments mention. We accept exact segment match or
  // suffix-segment match (e.g. segment `openinference-instrumentation-smolagents`
  // matches top-level `openinference` AND `smolagents`).
  const scored: Array<{ dir: string; score: number }> = [];
  for (const dir of candidates) {
    const segs = dir.split('/').filter((s) => s.length > 0);
    let score = 0;
    for (const top of tops) {
      for (const seg of segs) {
        if (seg === top || seg.endsWith(`-${top}`) || seg.includes(`-${top}-`)) {
          score++;
          break;
        }
      }
    }
    if (score > 0) scored.push({ dir, score });
  }
  if (scored.length === 0) return [];
  // Higher score first, then longer (more specific) path first.
  scored.sort((a, b) => b.score - a.score || b.dir.length - a.dir.length);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { dir } of scored) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
    if (out.length >= 5) break;
  }
  return out;
}

function extractTopLevelImports(content: string): Set<string> {
  const tops = new Set<string>();
  const stdlib = new Set([
    'os', 'sys', 'json', 'time', 'threading', 'asyncio', 'logging', 're',
    'pathlib', 'subprocess', 'tempfile', 'typing', 'functools', 'itertools',
    'collections', 'unittest', 'pytest', 'dataclasses', 'enum', 'abc',
    'io', 'math', 'random', 'datetime', 'traceback', 'warnings', 'inspect',
    'contextlib', 'concurrent', 'multiprocessing', 'queue', 'socket',
    'struct', 'hashlib', 'base64', 'copy', 'string', 'textwrap',
    '__future__', 'argparse', 'pickle', 'csv', 'urllib', 'http',
  ]);
  const reFrom = /^\s*from\s+([\w][\w.]*)\s+import\b/gm;
  const reImp = /^\s*import\s+([\w][\w.]*(?:\s*,\s*[\w][\w.]*)*)/gm;
  let m: RegExpExecArray | null;
  while ((m = reFrom.exec(content)) !== null) {
    const top = m[1].split('.')[0];
    if (top && !stdlib.has(top)) tops.add(top);
  }
  while ((m = reImp.exec(content)) !== null) {
    for (const piece of m[1].split(',')) {
      const top = piece.trim().split('.')[0];
      if (top && !stdlib.has(top)) tops.add(top);
    }
  }
  // Filter out very generic third-party hints that aren't in-repo packages.
  for (const t of [
    'opentelemetry', 'wrapt', 'pydantic', 'openai', 'anthropic', 'httpx',
    'requests', 'numpy', 'pandas', 'attrs', 'click', 'rich', 'tqdm',
    'aiohttp', 'starlette', 'fastapi', 'flask', 'django', 'sqlalchemy',
    'boto3', 'redis', 'pymongo', 'psycopg2',
  ]) {
    tops.delete(t);
  }
  return tops;
}

