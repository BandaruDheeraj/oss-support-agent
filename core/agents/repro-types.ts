/**
 * Types for the repro-first verification stage.
 *
 * The repro agent produces a self-contained executable test that demonstrates
 * the reported bug BEFORE we attempt any fix. The pipeline runs it on baseline
 * (expects failure with a controlled sentinel) and again after each fix attempt
 * (expects success). This is what proves the bug is actually fixed.
 *
 * Design choices (security / robustness):
 *  - The LLM produces ONLY file content + a failure sentinel string. Shell
 *    commands (setup + how-to-run) are constructed by the runner from adapter
 *    metadata + the repro path. We do not execute LLM-authored shell.
 *  - The repro is checked for "valid failure" using both exit code AND sentinel
 *    presence, so ModuleNotFoundError / SyntaxError don't masquerade as a
 *    valid reproduction.
 */

import type { ConfirmedIssue, ModuleFile } from './fix-types';

export interface ReproAgentInput {
  /** Confirmed issues being fixed (for context) */
  confirmedIssues: ConfirmedIssue[];
  /** Affected module path */
  affectedModule: string;
  /** Source files already loaded by the pipeline (issue-mentioned + module sample) */
  moduleSource: ModuleFile[];
  /**
   * Language hint for the repro. Currently only 'python' is fully supported by
   * the openinference adapter, but the agent accepts a hint to keep future
   * adapters (js/ts/go) extensible.
   */
  language: 'python';
  /**
   * Optional preferred test directory (e.g. "tests/"). The LLM should put the
   * repro under this prefix so it doesn't conflict with the package layout.
   */
  preferredTestDir?: string;
}

/**
 * Output from the repro generator.
 */
export interface ReproGeneratorOutput {
  /**
   * Repo-relative path for the new test file. MUST be under preferredTestDir
   * (or the workspace root if no preference given). Pipeline validates this.
   */
  path: string;
  /**
   * Full file content. The test, when run, must:
   *   - exit non-zero on the buggy code
   *   - exit zero after the fix is applied
   *   - print the literal `failureSentinel` string on baseline (proves the
   *     failure mode is the one we expected, not a setup error)
   */
  content: string;
  /**
   * A unique-ish marker that the repro MUST print to stdout/stderr ONLY when
   * the bug-specific failure path is hit (e.g. "EXPECTED_REPRO_FAILURE:NonRecordingSpan_status").
   * Used by baseline validation to reject ModuleNotFoundError-style false positives.
   */
  failureSentinel: string;
  /**
   * Short one-line summary of what the repro asserts. Goes into the PR body.
   */
  summary: string;
  /**
   * Environment variables (credentials, API keys, base URLs) the test reads
   * either directly via `os.environ[...]` or transitively through the
   * libraries it imports (e.g. `OPENAI_API_KEY` when calling the OpenAI
   * client). The LLM MUST enumerate every one it relies on — missing
   * declarations cause the pipeline to halt for credentials BEFORE we
   * waste a sandbox run.
   */
  requiredCredentials?: RequiredCredential[];
  /**
   * In-repo editable installs the repro needs. Each entry is a repo-relative
   * directory containing a Python package (with pyproject.toml / setup.py).
   * The pipeline runs `pip install -e <path>` for each before the baseline.
   *
   * Use this when the repro imports a package that lives in the monorepo
   * (e.g. `python/instrumentation/openinference-instrumentation-smolagents`)
   * and a `sys.path` trick at the top of the test file isn't sufficient
   * (entry points, package metadata, plugin discovery).
   *
   * Security: each path is validated to:
   *  - be repo-relative (no `..`, no leading `/`)
   *  - resolve to an existing directory in the workspace
   *  - contain a recognizable Python package manifest
   * Anything that doesn't match → halt-and-email.
   */
  editableInstalls?: string[];
  /**
   * Additional PyPI packages (and version specs) the repro needs at runtime.
   * Each entry is a single PEP-508 package spec — e.g. `pytest`,
   * `requests>=2.0`, `openai==1.30.1`, `pydantic[email]`.
   *
   * Security: each spec is validated against a strict allowlist of
   * characters and rejected if it looks like a flag (`-r`, `--index-url`),
   * a URL (`http://`, `git+`), a local path, or contains shell metachars.
   */
  pipPackages?: string[];
}

/**
 * A single env var the repro needs available at run time.
 */
export interface RequiredCredential {
  /** Env var name, e.g. "OPENAI_API_KEY". */
  envVar: string;
  /** One-line explanation of what it's used for. */
  purpose: string;
  /**
   * Best-effort guidance on where the user can obtain this credential
   * (e.g. "https://platform.openai.com/api-keys"). Free-form; surfaced
   * verbatim in the credentials-needed email.
   */
  whereToGet?: string;
}

/**
 * Final spec accepted by the pipeline after generator + validation.
 * `runCommand` is built by the runner — not the LLM.
 */
export interface ReproSpec extends ReproGeneratorOutput {
  /** Shell command the runner will execute to invoke the repro. */
  runCommand: string;
}

export interface ReproGenerator {
  generate(input: ReproAgentInput): Promise<ReproGeneratorOutput>;
}

export class ReproAgentError extends Error {
  public readonly phase: string;
  constructor(message: string, phase: string) {
    super(message);
    this.name = 'ReproAgentError';
    this.phase = phase;
  }
}

// ---------------------------------------------------------------------------
// Iterative repro loop types
//
// The iterative repro generator is allowed to do one of two things per turn:
//   1. Ask for additional context (read a file, list a dir, find by suffix,
//      grep) — used when the LLM doesn't have enough code to write a
//      faithful repro.
//   2. Emit a candidate repro (same shape as the one-shot generator).
//
// The loop services context requests through a workspace adapter (which
// applies the safety/size caps) and runs candidate repros against a
// baseline runner (callback). It feeds back structured outcomes for each
// failed attempt so the next turn can refine.
// ---------------------------------------------------------------------------

/** A single context request the LLM can make per turn. */
export type ContextRequest =
  | { op: 'read_file'; path: string; purpose: string }
  | { op: 'list_dir'; path: string; purpose: string; maxEntries?: number }
  | { op: 'find_file'; suffix: string; purpose: string; maxResults?: number }
  | {
      op: 'grep';
      query: string;
      purpose: string;
      pathPrefix?: string;
      extensions?: string[];
      fixedString?: boolean;
      maxResults?: number;
    };

/** Structured response to a context request. Shape mirrors the request `op`. */
export type ContextResult =
  | {
      op: 'read_file';
      path: string;
      status: 'ok' | 'denied' | 'not_found' | 'too_large' | 'binary' | 'truncated';
      content?: string;
      bytes?: number;
      reason?: string;
    }
  | {
      op: 'list_dir';
      path: string;
      status: 'ok' | 'denied' | 'not_found';
      entries?: Array<{ name: string; kind: 'file' | 'dir' }>;
      truncated?: boolean;
      reason?: string;
    }
  | {
      op: 'find_file';
      suffix: string;
      status: 'ok' | 'denied';
      matches?: string[];
      truncated?: boolean;
      reason?: string;
    }
  | {
      op: 'grep';
      query: string;
      status: 'ok' | 'denied';
      hits?: Array<{ path: string; line: number; preview: string }>;
      truncated?: boolean;
      reason?: string;
    };

/** Workspace adapter the loop uses to service context requests. */
export interface ReproWorkspace {
  readFile(req: Extract<ContextRequest, { op: 'read_file' }>): ContextResult;
  listDir(req: Extract<ContextRequest, { op: 'list_dir' }>): ContextResult;
  findFile(req: Extract<ContextRequest, { op: 'find_file' }>): ContextResult;
  grep(req: Extract<ContextRequest, { op: 'grep' }>): ContextResult;
  /**
   * Brief summary of the top-level repo layout, included once at the start of
   * the loop so the LLM has a map. Implementation-defined; recommended:
   * top-level dirs + the affected module's subtree (a few levels deep).
   */
  repoTreeSummary(): string;
}

/**
 * Validation stage at which a candidate repro failed. Surfaced verbatim to
 * the LLM in the next turn's history so it can target its retry.
 */
export type ReproAttemptStage =
  | 'schema'
  | 'path_validation'
  | 'sentinel_validation'
  | 'setup_validation'
  | 'workspace_setup'
  | 'baseline_failed_to_repro'
  | 'baseline_setup_command_failed'
  | 'baseline_timeout';

/** One past attempt, sent back to the LLM so it can refine. */
export interface ReproAttemptHistoryEntry {
  attempt: number;
  /** What the LLM tried to write (path + truncated content preview). */
  candidate?: {
    path: string;
    failureSentinel: string;
    summary: string;
    contentPreview: string; // first ~2KB
    pipPackages?: string[];
    editableInstalls?: string[];
  };
  stage: ReproAttemptStage;
  /** Short human-readable reason. */
  reason: string;
  /** Tail of stdout (≤2 KB, redacted). */
  stdoutTail?: string;
  /** Tail of stderr (≤2 KB, redacted). */
  stderrTail?: string;
  exitCode?: number | null;
  failedSetupCommand?: string;
}

/**
 * Result of a baseline run. The loop calls this back via the runner injected
 * by the pipeline; the runner is responsible for executing setup commands +
 * the repro and reporting back. The runner MUST reset the workspace to a
 * clean state before returning so attempt N+1 starts fresh.
 */
export interface BaselineRunResult {
  ok: boolean;
  /** When ok=false, why (mapped to ReproAttemptStage). */
  stage?: Exclude<ReproAttemptStage, 'schema' | 'path_validation' | 'sentinel_validation' | 'setup_validation'>;
  reason?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Setup command that failed (when stage = baseline_setup_command_failed). */
  failedSetupCommand?: string;
  /** True iff inferred-credentials path was hit (terminal — do not retry). */
  credentialsTerminal?: {
    inferredEnvVars: string[];
    matchedPattern: string | null;
  };
}

/** Function the pipeline injects to run a candidate spec on the sandbox. */
export type BaselineRunner = (spec: ReproSpec) => Promise<BaselineRunResult>;

/** What the iterative generator returns each turn. */
export type ReproGeneratorAction =
  | { kind: 'request_context'; reasoning: string; requests: ContextRequest[] }
  | { kind: 'repro'; reasoning: string; output: ReproGeneratorOutput };

/** Input passed to the iterative generator each turn. */
export interface IterativeReproGeneratorInput extends ReproAgentInput {
  /** Brief tree summary so the LLM knows what exists. */
  repoTreeSummary: string;
  /** Past attempts (oldest → newest). */
  previousAttempts: ReproAttemptHistoryEntry[];
  /** Context requests already serviced (deduped & truncated). */
  loadedContext: ContextResult[];
  /**
   * Iteration index (1-based) and remaining budget so the LLM can choose
   * between requesting more context vs. committing to a repro.
   */
  iteration: number;
  remainingIterations: number;
  remainingBaselineAttempts: number;
}

export interface IterativeReproGenerator {
  generate(input: IterativeReproGeneratorInput): Promise<ReproGeneratorAction>;
}

/** Final result of the iterative loop on success. */
export interface ReproLoopSuccess {
  spec: ReproSpec;
  baseline: BaselineRunResult;
  attempts: ReproAttemptHistoryEntry[];
}

/**
 * Thrown when the loop exhausts its budget without a verified repro.
 * Carries enough diagnostics for the pipeline to surface a useful
 * halt-and-email message.
 */
export class ReproUnreproducibleError extends Error {
  public readonly attempts: ReproAttemptHistoryEntry[];
  public readonly lastReason: string;
  public readonly terminalCategory:
    | 'budget_exhausted'
    | 'credentials_required'
    | 'generator_error'
    | 'no_progress';

  constructor(args: {
    attempts: ReproAttemptHistoryEntry[];
    lastReason: string;
    terminalCategory: ReproUnreproducibleError['terminalCategory'];
  }) {
    super(`repro loop exhausted: ${args.lastReason}`);
    this.name = 'ReproUnreproducibleError';
    this.attempts = args.attempts;
    this.lastReason = args.lastReason;
    this.terminalCategory = args.terminalCategory;
  }
}

/**
 * Surfaced when the loop detects (proactively or reactively) that the repro
 * needs credentials we don't have. Pipeline maps this to its existing
 * `awaiting-credentials` halt path.
 */
export class ReproCredentialsRequiredError extends Error {
  public readonly missingEnvVars: string[];
  public readonly detectionContext: string;
  public readonly attempts: ReproAttemptHistoryEntry[];

  constructor(args: {
    missingEnvVars: string[];
    detectionContext: string;
    attempts: ReproAttemptHistoryEntry[];
  }) {
    super(`repro requires credentials: ${args.missingEnvVars.join(', ')}`);
    this.name = 'ReproCredentialsRequiredError';
    this.missingEnvVars = args.missingEnvVars;
    this.detectionContext = args.detectionContext;
    this.attempts = args.attempts;
  }
}
