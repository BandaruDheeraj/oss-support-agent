import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as yaml from 'js-yaml';
import { manifestSchema } from './schema';
import { Manifest, ManifestLoadError, ManifestValidationError } from './types';

const DEFAULTS: Partial<Manifest> = {
  trigger_label: 'agent-fix',
  branch_prefix: 'agent/scope-',
  max_retries: 3,
  approval_keywords: ['approved', 'lgtm', 'ship it'],
  issue_types: ['bug_fix', 'new_feature', 'docs'],
  sandbox_services: [],
  skip_pm_gate: false,
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
export function validateManifest(data: unknown): Manifest {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ManifestLoadError([
      { field: '(root)', message: 'Manifest must be a JSON object' },
    ]);
  }

  // Apply defaults before validation
  const withDefaults = { ...DEFAULTS, ...(data as Record<string, unknown>) };

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
