/**
 * Repro agent — orchestrates the generation step and validates the output
 * before the pipeline writes/commits it.
 *
 * Validation here is structural only (path under preferredTestDir, no parent
 * traversal, sentinel actually appears in the test content). Behavioral
 * validation (does it actually fail on baseline?) is the pipeline's job, since
 * that requires executing the sandbox.
 */

import {
  type ReproAgentInput,
  type ReproGenerator,
  type ReproGeneratorOutput,
  type ReproSpec,
  ReproAgentError,
} from './repro-types';

function assertSafePath(p: string, preferredDir: string | undefined): void {
  if (!p) throw new ReproAgentError('repro path is empty', 'validate');
  // Strict allowlist: alphanumerics, dot, underscore, dash, forward slash.
  // Rejects backslashes, spaces, and any shell metacharacter (`;`, `|`, `&`,
  // `$`, backtick, parens, quotes, redirects, etc.). The runCommand is
  // executed via `shell: true` in the sandbox, so we MUST keep this strict.
  if (!/^[A-Za-z0-9._/-]+$/.test(p)) {
    throw new ReproAgentError(
      `repro path contains disallowed characters (only A-Z, a-z, 0-9, ., _, -, / are permitted): ${p}`,
      'validate'
    );
  }
  if (p.includes('..')) throw new ReproAgentError(`repro path contains "..": ${p}`, 'validate');
  if (p.startsWith('/')) {
    throw new ReproAgentError(`repro path must be repo-relative: ${p}`, 'validate');
  }
  if (preferredDir) {
    const norm = preferredDir.replace(/\\/g, '/').replace(/\/$/, '');
    if (!p.startsWith(`${norm}/`)) {
      throw new ReproAgentError(`repro path must be under ${norm}/: ${p}`, 'validate');
    }
  }
  if (!/\.py$/i.test(p)) {
    throw new ReproAgentError(`repro path must end with .py: ${p}`, 'validate');
  }
}

function assertSentinelInContent(sentinel: string, content: string): void {
  if (sentinel.length < 6) {
    throw new ReproAgentError(`failureSentinel too short: ${sentinel}`, 'validate');
  }
  if (!content.includes(sentinel)) {
    throw new ReproAgentError(
      `repro content does not reference its failureSentinel (${sentinel})`,
      'validate'
    );
  }
}

/**
 * Build the spec (incl. runCommand) without executing anything.
 * `runCommand` is constructed by the runner, not the LLM.
 */
export function buildReproSpec(out: ReproGeneratorOutput): ReproSpec {
  // Python only for now. Adapter-language matrix lives in the pipeline.
  return {
    ...out,
    runCommand: `python ${out.path}`,
  };
}

export async function runReproAgent(
  input: ReproAgentInput,
  generator: ReproGenerator
): Promise<ReproSpec> {
  if (input.language !== 'python') {
    throw new ReproAgentError(`unsupported language: ${input.language}`, 'validate');
  }
  const out = await generator.generate(input);
  assertSafePath(out.path, input.preferredTestDir);
  assertSentinelInContent(out.failureSentinel, out.content);
  return buildReproSpec(out);
}
