import * as fs from 'fs';
import * as path from 'path';

import { bootstrapWatchedRepos, parseWatchedReposJson } from './bootstrap';

function writeFile(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

describe('bootstrapWatchedRepos (US-112)', () => {
  test('triggers introspection for watched repos missing configs', async () => {
    const root = fs.mkdtempSync(path.join(__dirname, '__tests__', 'tmp-bootstrap-'));
    try {
      // Existing config for acme/has
      writeFile(
        path.join(root, 'configs', 'acme', 'has', 'adapter.ts'),
        'export default class HasAdapter { async classifyModule(){return ".";} async getTestCommands(){return [];} async getSandboxServices(){return [];} async runCustomEval(){return {passed:true,summary:"",retryContext:[]};} async getPRMetadata(){return {extraLabels:[],extraBodySections:[]};} }\n'
      );

      const watched = parseWatchedReposJson(JSON.stringify([
        { repo: 'acme/has', pm_email: 'pm@example.com', fork_org: 'fork' },
        { repo: 'acme/missing', pm_email: 'pm@example.com', fork_org: 'fork' },
      ]));

      const calls: string[] = [];
      const runIntrospection = async (repoFullName: string) => {
        calls.push(repoFullName);
        return {
          repoFullName,
          activated: true,
          configDir: '',
          manifestPath: '',
          adapterPath: '',
          labels: { created: [], skipped: [] },
        };
      };

      const res = await bootstrapWatchedRepos({ repoRoot: root, watchedRepos: watched, runIntrospection: runIntrospection as any });
      expect(res.triggered).toEqual(['acme/missing']);
      expect(res.skipped).toEqual(['acme/has']);
      expect(calls).toEqual(['acme/missing']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
