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
