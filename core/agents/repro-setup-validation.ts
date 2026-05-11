/**
 * Validation for the LLM-declared repro setup fields (`editableInstalls`,
 * `pipPackages`).
 *
 * The pipeline executes these via the sandbox runner, which uses
 * `shell: true`. To prevent shell injection / abuse we treat each entry as
 * STRUCTURED DATA and reject anything that doesn't pass a tight allowlist.
 * The pipeline builds the actual `pip install` command itself from the
 * validated tokens — the LLM never authors a shell string.
 */

export interface ValidatedReproSetup {
  /** Repo-relative dirs that pass shape checks (existence checked separately). */
  editableInstalls: string[];
  /** PEP-508 specs that pass shape checks. */
  pipPackages: string[];
}

export class ReproSetupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReproSetupValidationError';
  }
}

// Repo-relative directory: alphanumerics, dot, underscore, dash, slash.
// No leading slash. No "..". No backslashes. No drive letters.
// Length-capped to avoid pathological inputs.
const EDITABLE_PATH = /^[A-Za-z0-9_./-]+$/;

// PEP-508-ish: name with optional extras + version specs. Strict subset.
// Examples that pass:
//   pytest
//   requests>=2.0
//   openai==1.30.1
//   pydantic[email]
//   numpy~=1.26
// Examples rejected:
//   -r requirements.txt
//   --index-url=...
//   git+https://...
//   ./local
//   foo; python_version<'3.8'   (env markers — extra surface area we don't need)
//   foo bar                      (whitespace = two tokens)
const PIP_PACKAGE = /^[A-Za-z0-9_]([A-Za-z0-9_.-]*[A-Za-z0-9_])?(\[[A-Za-z0-9_.,-]+\])?([<>=!~]=?[A-Za-z0-9_.*+-]+)?$/;

const MAX_EDITABLE_INSTALLS = 5;
const MAX_PIP_PACKAGES = 30;
const MAX_TOKEN_LEN = 200;

export function validateReproSetup(args: {
  editableInstalls?: string[];
  pipPackages?: string[];
}): ValidatedReproSetup {
  const editableInstalls = args.editableInstalls ?? [];
  const pipPackages = args.pipPackages ?? [];

  if (editableInstalls.length > MAX_EDITABLE_INSTALLS) {
    throw new ReproSetupValidationError(
      `editableInstalls has ${editableInstalls.length} entries (max ${MAX_EDITABLE_INSTALLS})`
    );
  }
  if (pipPackages.length > MAX_PIP_PACKAGES) {
    throw new ReproSetupValidationError(
      `pipPackages has ${pipPackages.length} entries (max ${MAX_PIP_PACKAGES})`
    );
  }

  for (const p of editableInstalls) {
    if (typeof p !== 'string' || !p) {
      throw new ReproSetupValidationError(`editableInstalls entry empty or non-string: ${JSON.stringify(p)}`);
    }
    if (p.length > MAX_TOKEN_LEN) {
      throw new ReproSetupValidationError(`editableInstalls entry too long: ${p.slice(0, 80)}...`);
    }
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
      throw new ReproSetupValidationError(`editableInstalls entry must be repo-relative: ${p}`);
    }
    if (p.includes('..')) {
      throw new ReproSetupValidationError(`editableInstalls entry contains "..": ${p}`);
    }
    if (!EDITABLE_PATH.test(p)) {
      throw new ReproSetupValidationError(
        `editableInstalls entry has disallowed chars (only A-Za-z0-9._/- permitted): ${p}`
      );
    }
  }

  for (const p of pipPackages) {
    if (typeof p !== 'string' || !p) {
      throw new ReproSetupValidationError(`pipPackages entry empty or non-string: ${JSON.stringify(p)}`);
    }
    if (p.length > MAX_TOKEN_LEN) {
      throw new ReproSetupValidationError(`pipPackages entry too long: ${p.slice(0, 80)}...`);
    }
    if (!PIP_PACKAGE.test(p)) {
      throw new ReproSetupValidationError(
        `pipPackages entry must be a bare PEP-508 spec (e.g. "requests>=2.0"). Disallowed: flags, URLs, paths, env markers, whitespace. Got: ${p}`
      );
    }
  }

  return { editableInstalls, pipPackages };
}

/**
 * Build pip-install shell command strings from validated setup. Each
 * resulting command is one `pip install ...` invocation; argv comes from
 * pre-validated tokens, then is joined into a single shell line for the
 * sandbox runner (which uses `shell: true`).
 *
 * We split into separate commands per group so a failure in one is easier
 * to attribute in the email.
 */
export function buildPipInstallCommands(setup: ValidatedReproSetup): string[] {
  const out: string[] = [];
  if (setup.pipPackages.length > 0) {
    out.push(`pip install --quiet ${setup.pipPackages.join(' ')}`);
  }
  for (const dir of setup.editableInstalls) {
    out.push(`pip install --quiet -e ${dir}`);
  }
  return out;
}
