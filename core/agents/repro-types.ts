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
