/**
 * Integration test for US-112 onboarding auto-trigger path.
 *
 * Simulates: webhook receives issue.labeled for a repo with no adapter ->
 * handleIssueEvent calls real runIntrospection (with stubbed gather/generate/approval/labels) ->
 * configs/<org>/<repo>/{manifest.yaml, adapter.ts} get written ->
 * required labels are created on the upstream repo ->
 * the original issue event is processed end-to-end by the pipeline.
 */

import * as fs from 'fs';
import * as path from 'path';

import { handleIssueEvent } from '../handle-issue-event';
import {
  runIntrospection,
  REQUIRED_REPO_LABELS,
  type RepoLabelClient,
  type IntrospectionApprovalLoop,
} from '../agents/introspection-orchestration';
import type { IssueEvent } from '../webhook/types';
import type { DraftAdapter, RepoSignals } from '../agents/introspection-types';

function makeFixtureSignals(repoFullName: string): RepoSignals {
  return {
    repoFullName,
    ciWorkflows: [{ path: '.github/workflows/ci.yml', commands: ['npm test'] }],
    packageManifests: [{ path: 'package.json', kind: 'package.json', stack: 'node', testHint: 'npm test' }],
    makefileTargets: [],
    contributingDocs: [],
    composeServices: [],
    readme: '',
    monorepoLayout: {},
  };
}

function makeFixtureDraft(): DraftAdapter {
  const adapterTs = `export default class WidgetsAdapter {
  async classifyModule() { return '.'; }
  async getTestCommands() { return ['npm test']; }
  async getSandboxServices() { return []; }
  async runCustomEval() { return { passed: true, summary: 'ok', retryContext: [] }; }
  async getPRMetadata() { return { extraLabels: ['widgets'], extraBodySections: [] }; }
}
`;
  const manifestYaml = [
    'repo: "acme/widgets"',
    'fork_org: "fork-org"',
    'pm_email: "pm@example.com"',
    '',
  ].join('\n');

  return {
    adapterTs,
    manifestYaml,
    rationale: { tests: 'jest from package.json', services: 'none' },
    openItems: [],
  };
}

describe('US-112 onboarding integration: webhook -> introspection -> activation -> pipeline', () => {
  const prevEnv = { ...process.env };

  afterAll(() => {
    process.env = prevEnv;
  });

  test('full auto-trigger path activates configs and reprocesses original issue', async () => {
    const root = fs.mkdtempSync(path.join(__dirname, 'tmp-us112-integration-'));
    try {
      process.env = { ...prevEnv, DEFAULT_PM_EMAIL: 'pm@example.com', DEFAULT_FORK_ORG: 'fork-org' };

      const repoFullName = 'acme/widgets';
      const event: IssueEvent = {
        action: 'labeled',
        issue: { number: 42, title: 'Bug', body: 'Bug body', labels: [{ name: 'agent-fix' }], user: { login: 'reporter' } },
        label: { name: 'agent-fix' },
        repository: { full_name: repoFullName },
      };

      // Stubbed signal gathering (no real git clone).
      const gatherStub = async (rfn: string) => makeFixtureSignals(rfn);

      // Stubbed draft generator (no real LLM call).
      const generateStub = async () => makeFixtureDraft();

      // Simulated approval loop: approves immediately.
      const approvalLoopCalls: string[] = [];
      const approvalLoop: IntrospectionApprovalLoop = async (args) => {
        approvalLoopCalls.push(args.repoFullName);
        return args.draft;
      };

      // Label client tracks calls.
      const createdLabels: string[] = [];
      const labelClient: RepoLabelClient = {
        getLabel: async () => null,
        createLabel: async (_repo, label) => {
          createdLabels.push(label.name);
        },
      };

      // Pipeline records what it received.
      const pipelineCalls: Array<{ repo: string; manifestRepo: string; classifyResult: string; extraLabels: string[] }> = [];

      const onboardedRunIntrospection = async (
        repo: string,
        pmEmail: string,
        forkOrg: string,
        opts: any
      ) => {
        return runIntrospection(repo, pmEmail, forkOrg, {
          repoRoot: opts.repoRoot,
          gatherRepoSignals: gatherStub,
          generateDraftAdapter: generateStub,
          approvalLoop,
          deps: {
            // gmailClient/watcher/stateStore/replyWaiter/llm unused when approvalLoop is overridden.
            gmailClient: {} as any,
            watcher: {} as any,
            stateStore: {} as any,
            replyWaiter: {} as any,
            llm: {} as any,
            labelClient,
          },
        });
      };

      await handleIssueEvent({
        event,
        repoRoot: root,
        runIntrospection: onboardedRunIntrospection as any,
        runPipeline: async ({ event: ev, manifest, adapter }) => {
          const cls = await adapter.classifyModule(ev.issue as any);
          const meta = await adapter.getPRMetadata([ev.issue as any]);
          pipelineCalls.push({
            repo: ev.repository.full_name,
            manifestRepo: manifest.repo,
            classifyResult: cls,
            extraLabels: meta.extraLabels,
          });
        },
      });

      // configs/ written
      const manifestPath = path.join(root, 'configs', 'acme', 'widgets', 'manifest.yaml');
      const adapterPath = path.join(root, 'configs', 'acme', 'widgets', 'adapter.ts');
      expect(fs.existsSync(manifestPath)).toBe(true);
      expect(fs.existsSync(adapterPath)).toBe(true);

      // Email-approval loop was invoked
      expect(approvalLoopCalls).toEqual([repoFullName]);

      // All required labels were created on the upstream repo
      expect(createdLabels.sort()).toEqual([...REQUIRED_REPO_LABELS].sort());

      // Original issue was processed end-to-end by the pipeline
      expect(pipelineCalls).toHaveLength(1);
      expect(pipelineCalls[0].repo).toBe(repoFullName);
      expect(pipelineCalls[0].manifestRepo).toBe(repoFullName);
      expect(pipelineCalls[0].classifyResult).toBe('.');
      expect(pipelineCalls[0].extraLabels).toEqual(['widgets']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
