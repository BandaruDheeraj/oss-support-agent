import * as fs from 'fs';
import * as path from 'path';

import { handleIssueEvent } from './handle-issue-event';

function writeFile(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

describe('handleIssueEvent onboarding (US-112)', () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...prevEnv };
  });

  afterAll(() => {
    process.env = prevEnv;
  });

  test('triggers introspection when manifest is missing, then runs pipeline', async () => {
    const root = fs.mkdtempSync(path.join(__dirname, '__tests__', 'tmp-handle-issue-'));
    try {
      process.env.DEFAULT_PM_EMAIL = 'pm@example.com';
      process.env.DEFAULT_FORK_ORG = 'fork-org';

      const event = {
        action: 'opened',
        issue: { number: 1, title: 't', body: '', labels: [] },
        repository: { full_name: 'acme/widgets' },
      } as any;

      const manifestPath = path.join(root, 'configs', 'acme', 'widgets', 'manifest.yaml');
      const adapterPath = path.join(root, 'configs', 'acme', 'widgets', 'adapter.ts');

      let introspectionCalls = 0;
      const runIntrospection = async (repoFullName: string) => {
        introspectionCalls++;
        // Write manifest + adapter like activation would.
        writeFile(
          manifestPath,
          [
            'repo: "acme/widgets"',
            'fork_org: "fork-org"',
            'pm_email: "pm@example.com"',
          ].join('\n') + '\n'
        );

        writeFile(
          adapterPath,
          `export default class WidgetsAdapter {
            async classifyModule() { return '.'; }
            async getTestCommands() { return ['npm test']; }
            async getSandboxServices() { return []; }
            async runCustomEval() { return { passed: true, summary: 'ok', retryContext: [] }; }
            async getPRMetadata() { return { extraLabels: [], extraBodySections: [] }; }
          }\n`
        );

        return {
          repoFullName,
          activated: true,
          configDir: path.dirname(adapterPath),
          manifestPath,
          adapterPath,
          labels: { created: [], skipped: [] },
        };
      };

      let pipelineCalls = 0;
      await handleIssueEvent({
        event,
        repoRoot: root,
        runPipeline: async ({ manifest, adapter }) => {
          pipelineCalls++;
          expect(manifest.repo).toBe('acme/widgets');
          expect(typeof adapter.classifyModule).toBe('function');
        },
        runIntrospection: runIntrospection as any,
      });

      expect(introspectionCalls).toBe(1);
      expect(pipelineCalls).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
