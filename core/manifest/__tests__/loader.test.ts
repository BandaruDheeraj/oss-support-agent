import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { loadManifest, validateManifest, ManifestLoadError } from '../index';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

beforeAll(() => {
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }
});

function writeFixture(name: string, content: string): string {
  const filePath = path.join(FIXTURES_DIR, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

const VALID_MANIFEST = {
  repo: 'Arize-ai/openinference',
  fork_org: 'oss-fix-bot',
  test_command: 'python -m pytest tests/ -x --timeout=300',
  pm_email: 'pm@example.com',
};

describe('Manifest Loader', () => {
  describe('valid manifests', () => {
    it('loads a valid JSON manifest with all required fields', () => {
      const filePath = writeFixture('valid.json', JSON.stringify(VALID_MANIFEST));
      const manifest = loadManifest(filePath);

      expect(manifest.repo).toBe('Arize-ai/openinference');
      expect(manifest.fork_org).toBe('oss-fix-bot');
      expect(manifest.test_command).toBe('python -m pytest tests/ -x --timeout=300');
      expect(manifest.pm_email).toBe('pm@example.com');
    });

    it('loads a valid YAML manifest', () => {
      const yamlContent = `
repo: "Arize-ai/openinference"
fork_org: "oss-fix-bot"
test_command: "python -m pytest tests/ -x --timeout=300"
pm_email: "pm@example.com"
`;
      const filePath = writeFixture('valid.yaml', yamlContent);
      const manifest = loadManifest(filePath);

      expect(manifest.repo).toBe('Arize-ai/openinference');
      expect(manifest.fork_org).toBe('oss-fix-bot');
    });

    it('loads the example openinference manifest', () => {
      const examplePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'configs',
        'arize-ai',
        'openinference',
        'manifest.yaml'
      );
      const manifest = loadManifest(examplePath);

      expect(manifest.repo).toBe('Arize-ai/openinference');
      expect(manifest.fork_org).toBe('oss-fix-bot');
      expect(manifest.trigger_label).toBe('agent-fix');
      expect(manifest.branch_prefix).toBe('agent/scope-');
      expect(manifest.test_command).toBe('python -m pytest tests/ -x --timeout=300');
      expect(manifest.approval_keywords).toEqual(['approved', 'lgtm', 'ship it']);
      expect(manifest.pm_email).toBe('pm@example.com');
      expect(manifest.issue_types).toEqual(['bug_fix', 'new_feature', 'docs']);
      expect(manifest.sandbox_services).toEqual(['pypi.org']);
      expect(manifest.max_retries).toBe(3);
      expect(manifest.skip_pm_gate).toBe(false);
    });
  });

  describe('defaults applied', () => {
    it('applies default trigger_label when omitted', () => {
      const manifest = validateManifest(VALID_MANIFEST);
      expect(manifest.trigger_label).toBe('agent-fix');
    });

    it('applies default branch_prefix when omitted', () => {
      const manifest = validateManifest(VALID_MANIFEST);
      expect(manifest.branch_prefix).toBe('agent/scope-');
    });

    it('applies default max_retries when omitted', () => {
      const manifest = validateManifest(VALID_MANIFEST);
      expect(manifest.max_retries).toBe(3);
    });

    it('applies default approval_keywords when omitted', () => {
      const manifest = validateManifest(VALID_MANIFEST);
      expect(manifest.approval_keywords).toEqual(['approved', 'lgtm', 'ship it']);
    });

    it('applies default issue_types when omitted', () => {
      const manifest = validateManifest(VALID_MANIFEST);
      expect(manifest.issue_types).toEqual(['bug_fix', 'new_feature', 'docs']);
    });

    it('applies default sandbox_services when omitted', () => {
      const manifest = validateManifest(VALID_MANIFEST);
      expect(manifest.sandbox_services).toEqual([]);
    });

    it('applies default skip_pm_gate when omitted', () => {
      const manifest = validateManifest(VALID_MANIFEST);
      expect(manifest.skip_pm_gate).toBe(false);
    });

    it('does not override explicitly provided values with defaults', () => {
      const custom = { ...VALID_MANIFEST, trigger_label: 'custom-label', max_retries: 5 };
      const manifest = validateManifest(custom);
      expect(manifest.trigger_label).toBe('custom-label');
      expect(manifest.max_retries).toBe(5);
    });
  });

  describe('missing required fields', () => {
    it('fails when repo is missing', () => {
      const { repo, ...noRepo } = VALID_MANIFEST;
      expect(() => validateManifest(noRepo)).toThrow(ManifestLoadError);
      try {
        validateManifest(noRepo);
      } catch (e: any) {
        expect(e.errors.some((err: any) => err.field === 'repo')).toBe(true);
      }
    });

    it('fails when fork_org is missing', () => {
      const { fork_org, ...noForkOrg } = VALID_MANIFEST;
      expect(() => validateManifest(noForkOrg)).toThrow(ManifestLoadError);
      try {
        validateManifest(noForkOrg);
      } catch (e: any) {
        expect(e.errors.some((err: any) => err.field === 'fork_org')).toBe(true);
      }
    });

    it('fails when test_command is missing', () => {
      const { test_command, ...noTestCmd } = VALID_MANIFEST;
      expect(() => validateManifest(noTestCmd)).toThrow(ManifestLoadError);
      try {
        validateManifest(noTestCmd);
      } catch (e: any) {
        expect(e.errors.some((err: any) => err.field === 'test_command')).toBe(true);
      }
    });

    it('fails when pm_email is missing', () => {
      const { pm_email, ...noPmEmail } = VALID_MANIFEST;
      expect(() => validateManifest(noPmEmail)).toThrow(ManifestLoadError);
      try {
        validateManifest(noPmEmail);
      } catch (e: any) {
        expect(e.errors.some((err: any) => err.field === 'pm_email')).toBe(true);
      }
    });
  });

  describe('invalid types', () => {
    it('fails when repo is not a string', () => {
      expect(() => validateManifest({ ...VALID_MANIFEST, repo: 123 })).toThrow(ManifestLoadError);
    });

    it('fails when repo format is invalid', () => {
      expect(() => validateManifest({ ...VALID_MANIFEST, repo: 'not-a-repo' })).toThrow(ManifestLoadError);
    });

    it('fails when max_retries is not an integer', () => {
      expect(() => validateManifest({ ...VALID_MANIFEST, max_retries: 'three' })).toThrow(ManifestLoadError);
    });

    it('fails when issue_types contains invalid values', () => {
      expect(() => validateManifest({ ...VALID_MANIFEST, issue_types: ['invalid_type'] })).toThrow(ManifestLoadError);
    });

    it('fails when pm_email is not a valid email', () => {
      expect(() => validateManifest({ ...VALID_MANIFEST, pm_email: 'not-an-email' })).toThrow(ManifestLoadError);
    });

    it('fails when skip_pm_gate is not a boolean', () => {
      expect(() => validateManifest({ ...VALID_MANIFEST, skip_pm_gate: 'yes' })).toThrow(ManifestLoadError);
    });

    it('fails with additional unknown properties', () => {
      expect(() => validateManifest({ ...VALID_MANIFEST, unknown_field: 'value' })).toThrow(ManifestLoadError);
    });
  });

  describe('file loading errors', () => {
    it('fails when file does not exist', () => {
      expect(() => loadManifest('/nonexistent/path.json')).toThrow(ManifestLoadError);
      try {
        loadManifest('/nonexistent/path.json');
      } catch (e: any) {
        expect(e.errors[0].field).toBe('(file)');
      }
    });

    it('fails when JSON is malformed', () => {
      const filePath = writeFixture('malformed.json', '{ invalid json }');
      expect(() => loadManifest(filePath)).toThrow(ManifestLoadError);
    });

    it('rejects non-object values', () => {
      expect(() => validateManifest(null)).toThrow(ManifestLoadError);
      expect(() => validateManifest('string')).toThrow(ManifestLoadError);
      expect(() => validateManifest([1, 2, 3])).toThrow(ManifestLoadError);
    });
  });
});
