import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as yaml from 'js-yaml';
import { manifestSchema } from './schema';
import { Manifest, ManifestLoadError, ManifestValidationError } from './types';

const DEFAULTS: Partial<Manifest> = {
  trigger_label: 'agent-fix',
  skip_pm_gate_label: 'trivial-fix',
  branch_prefix: 'agent/scope-',
  max_retries: 3,
  approval_keywords: ['approved', 'lgtm', 'ship it'],
  sandbox_timeout_mins: 15,
};

/**
 * Load and validate a manifest from a file path.
 * Supports both JSON and YAML formats (detected by extension).
 */
export function loadManifest(filePath: string): Manifest {
  const resolvedPath = path.resolve(filePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new ManifestLoadError([
      { field: '(file)', message: `Manifest file not found: ${resolvedPath}` },
    ]);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  let parsed: unknown;

  const ext = path.extname(resolvedPath).toLowerCase();
  try {
    if (ext === '.yaml' || ext === '.yml') {
      parsed = yaml.load(raw);
    } else {
      parsed = JSON.parse(raw);
    }
  } catch (err: any) {
    throw new ManifestLoadError([
      { field: '(file)', message: `Failed to parse manifest: ${err.message}` },
    ]);
  }

  return validateManifest(parsed);
}

/**
 * Validate a parsed manifest object against the schema and apply defaults.
 */
const LEGACY_FIELDS: Record<string, string> = {
  test_command: 'test_command is adapter-owned; use adapter.getTestCommands() instead',
  sandbox_services: 'sandbox_services is adapter-owned; use adapter.getSandboxServices() instead',
  issue_types: 'issue_types is no longer needed; triage emits the issue type',
  skip_pm_gate: 'skip_pm_gate is removed; use skip_pm_gate_label on the issue instead',
};

export function migrateLegacyManifest(
  input: Record<string, unknown>,
  onWarn: (msg: string) => void = (m) => console.warn(m)
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const k of Object.keys(LEGACY_FIELDS)) {
    if (k in out) {
      onWarn(`[manifest] stripping legacy field: ${k}`);
      delete out[k];
    }
  }

  if (input.skip_pm_gate === true && typeof out.skip_pm_gate_label !== 'string') {
    out.skip_pm_gate_label = 'trivial-fix';
  }

  return out;
}

export function validateManifest(data: unknown): Manifest {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ManifestLoadError([
      { field: '(root)', message: 'Manifest must be a JSON object' },
    ]);
  }

  const raw = data as Record<string, unknown>;
  for (const [k, hint] of Object.entries(LEGACY_FIELDS)) {
    if (k in raw) {
      throw new ManifestLoadError([
        { field: k, message: `Legacy field is not allowed: ${hint}` },
      ]);
    }
  }

  // Apply defaults before validation
  const withDefaults = { ...DEFAULTS, ...raw };

  const ajv = new Ajv({ allErrors: true, useDefaults: false });
  addFormats(ajv);
  const validate = ajv.compile(manifestSchema);
  const valid = validate(withDefaults);

  if (!valid && validate.errors) {
    const errors: ManifestValidationError[] = validate.errors.map((err) => ({
      field: err.instancePath ? err.instancePath.replace(/^\//, '') : err.params?.missingProperty || '(root)',
      message: err.message || 'Validation failed',
    }));
    throw new ManifestLoadError(errors);
  }

  return withDefaults as Manifest;
}
