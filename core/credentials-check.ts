/**
 * Credential / API-key gating for the repro stage.
 *
 * Two responsibilities:
 *  1. Proactive check — given the env vars the LLM said the repro needs,
 *     return the ones not currently set in process.env. Run BEFORE the
 *     baseline sandbox so we don't waste a run when we know it'll fail.
 *  2. Reactive check — given the stdout/stderr of a baseline run that
 *     failed without printing the failure sentinel, infer whether the
 *     failure is "missing credentials" and, if so, extract the env var
 *     names referenced in error messages. This is the safety net for
 *     LLMs that under-declare requiredCredentials.
 *
 * Why parse stderr instead of asking the LLM again? Cheaper, deterministic,
 * and we can run it on ALL infra-failures even when no requiredCredentials
 * were declared.
 */

import type { RequiredCredential } from './agents/repro-types';

/**
 * Result of comparing declared required credentials against process env.
 */
export interface MissingCredentialCheck {
  missing: RequiredCredential[];
}

/**
 * Returns the subset of `required` whose envVar is unset or empty in `env`.
 * "Unset or empty" is intentional: people sometimes export an empty string
 * for an API key, which fails identically at run time but wouldn't be
 * caught by a presence check.
 */
export function findMissingDeclaredCredentials(
  required: ReadonlyArray<RequiredCredential> | undefined,
  env: NodeJS.ProcessEnv = process.env
): MissingCredentialCheck {
  if (!required || required.length === 0) return { missing: [] };
  const missing: RequiredCredential[] = [];
  for (const cred of required) {
    const raw = env[cred.envVar];
    if (raw === undefined || raw.trim() === '') {
      missing.push(cred);
    }
  }
  return { missing };
}

/**
 * Result of stderr-based credential failure detection.
 * `inferredEnvVars` is best-effort — caller should combine with any LLM-declared
 * names before emailing the user, so the user doesn't get conflicting lists.
 */
export interface CredentialErrorDetection {
  isCredentialError: boolean;
  /** Env-var-like tokens we found in the error text (uppercase identifiers). */
  inferredEnvVars: string[];
  /** Short tag for logging/labels — first matched pattern. */
  matchedPattern?: string;
}

/**
 * Patterns that strongly indicate an auth/credential failure (not "the bug").
 * Ordered roughly by specificity.
 */
const CREDENTIAL_ERROR_PATTERNS: Array<{ name: string; rx: RegExp }> = [
  { name: 'authentication-error', rx: /\bAuthenticationError\b/ },
  { name: 'permission-denied', rx: /\bPermissionDeniedError\b/ },
  { name: 'invalid-api-key', rx: /\b(invalid|incorrect|missing).{0,40}(api[\s_-]?key|token|credential)/i },
  { name: 'api-key-not-set', rx: /(set|provide|configure).{0,40}(env(ironment)?\s+variable|api[\s_-]?key)/i },
  { name: 'http-401', rx: /\b401\b.{0,80}\b(unauthor|auth)/i },
  { name: 'http-403', rx: /\b403\b.{0,80}\b(forbid|auth|access)/i },
  // The OpenAI / Anthropic SDKs print "The api_key client option must be set
  // either by passing api_key to the client or by setting the OPENAI_API_KEY
  // environment variable" — catch that family generically.
  { name: 'sdk-key-missing', rx: /(api_key|api[\s_-]?key).{0,80}(must be set|is required|not\s+provided|environment\s+variable)/i },
  // Plain "OPENAI_API_KEY is not set" / "ANTHROPIC_API_KEY is missing"
  { name: 'env-not-set', rx: /\b([A-Z][A-Z0-9_]{4,})\b.{0,40}(not\s+set|is\s+missing|is\s+required|unset)/ },
];

/**
 * Recognized env-var-like token: ALL_CAPS_UNDERSCORE, ≥5 chars, containing
 * an underscore (so we don't catch generic SHOUTING in stack traces).
 */
const ENV_TOKEN_RX = /\b[A-Z][A-Z0-9]{0,}_[A-Z0-9_]{2,}\b/g;

/**
 * Common false-positive tokens that match the env regex but aren't credentials.
 * Kept narrow on purpose — anything not here gets surfaced for human review.
 */
const ENV_TOKEN_BLOCKLIST = new Set<string>([
  'TRUE', 'FALSE', 'NULL', 'NONE', 'PYTHON_PATH', 'PYTHONPATH',
  'LD_LIBRARY_PATH', 'PATH_INFO', 'WORK_DIR', 'TMP_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'TRACEBACK_MOST_RECENT_CALL_LAST',
  'MODULE_NOT_FOUND_ERROR', 'ATTRIBUTE_ERROR', 'TYPE_ERROR', 'VALUE_ERROR',
  'RUNTIME_ERROR', 'IMPORT_ERROR', 'KEY_ERROR', 'INDEX_ERROR',
  'OS_ERROR', 'IO_ERROR', 'FILE_NOT_FOUND_ERROR',
]);

/**
 * Detect whether stdout/stderr indicate a credential failure, and best-effort
 * extract env var names referenced in the error text.
 *
 * IMPORTANT: caller should ALSO check that the failure sentinel was NOT
 * printed — if the sentinel was printed the failure IS the bug, even if
 * stderr happens to contain an auth-shaped phrase.
 */
export function detectCredentialError(
  stdout: string,
  stderr: string
): CredentialErrorDetection {
  const combined = `${stdout}\n${stderr}`;
  let matchedPattern: string | undefined;
  for (const { name, rx } of CREDENTIAL_ERROR_PATTERNS) {
    if (rx.test(combined)) {
      matchedPattern = name;
      break;
    }
  }
  if (!matchedPattern) {
    return { isCredentialError: false, inferredEnvVars: [] };
  }

  const tokens = combined.match(ENV_TOKEN_RX) ?? [];
  const seen = new Set<string>();
  const inferred: string[] = [];
  for (const t of tokens) {
    if (ENV_TOKEN_BLOCKLIST.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    inferred.push(t);
  }
  return {
    isCredentialError: true,
    inferredEnvVars: inferred,
    matchedPattern,
  };
}

/**
 * Merge declared + inferred credential lists, preferring declared metadata
 * (which has purpose / whereToGet) when env names overlap.
 *
 * Inferred-only env vars get a placeholder purpose so the email is honest
 * about what we know versus what we guessed.
 */
export function mergeCredentialSources(
  declared: ReadonlyArray<RequiredCredential>,
  inferredEnvVars: ReadonlyArray<string>
): RequiredCredential[] {
  const byName = new Map<string, RequiredCredential>();
  for (const cred of declared) {
    byName.set(cred.envVar, cred);
  }
  for (const name of inferredEnvVars) {
    if (byName.has(name)) continue;
    byName.set(name, {
      envVar: name,
      purpose: 'inferred from sandbox error output; verify before adding',
    });
  }
  return Array.from(byName.values());
}
