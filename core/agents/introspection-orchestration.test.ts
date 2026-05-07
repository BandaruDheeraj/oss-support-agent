/**
 * Unit tests for introspection orchestration and activation (US-107).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { DraftAdapter, RepoSignals } from './introspection-types';

import {
  runIntrospection,
  writeAdapterFiles,
  rollbackWrittenAdapterFiles,
  addGitHubLabels,
} from './introspection-orchestration';

import type { RepoLabelClient, RunIntrospectionDependencies, IntrospectionWatcher } from './introspection-orchestration';

function makeSignals(repoFullName = 'acme/widgets'): RepoSignals {
  return {
    repoFullName,
    ciWorkflows: [],
    packageManifests: [],
    makefileTargets: [],
    contributingDocs: [],
    composeServices: [],
    readme: '',
    monorepoLayout: {},
  };
}

function makeDraft(): DraftAdapter {
  return {
    adapterTs: 'export default class WidgetsAdapter { }\n',
    manifestYaml: 'repo: acme/widgets\n',
    rationale: { test: 'because' },
    openItems: [],
  };
}

function makeTempRepoRoot(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'oss-agent-us107-'));
}

function makeWatcher(): IntrospectionWatcher {
  const byId = new Map<string, any>();
  return {
    registerThread(t: any) {
      byId.set(t.threadId, t);
    },
    unregisterThread(id: string) {
      byId.delete(id);
    },
    getThread(id: string) {
      return byId.get(id);
    },
  };
}

function makeDeps(labelClient: RepoLabelClient): RunIntrospectionDependencies {
  return {
    gmailClient: {
      sendEmail: jest.fn().mockResolvedValue({ success: true, messageId: 'm1', threadId: 't1' }),
      listUnreadMessages: jest.fn().mockResolvedValue([]),
      markAsRead: jest.fn().mockResolvedValue(undefined),
    },
    watcher: makeWatcher(),
    stateStore: {
      saveState: jest.fn(),
      loadState: jest.fn().mockReturnValue(null),
      deleteState: jest.fn(),
    },
    // Not used when approvalLoop is overridden.
    replyWaiter: { waitForEmailReply: jest.fn() } as any,
    llm: { chat: jest.fn(), chatJson: jest.fn() } as any,
    labelClient,
  };
}

describe('US-107 introspection orchestration', () => {
  it('writeAdapterFiles refuses to overwrite without force', async () => {
    const repoRoot = await makeTempRepoRoot();
    const repoFullName = 'acme/widgets';

    const first = await writeAdapterFiles({ repoRoot, repoFullName, draft: makeDraft() });
    expect(await fs.promises.readFile(first.adapterPath, 'utf-8')).toContain('export default');

    await expect(
      writeAdapterFiles({ repoRoot, repoFullName, draft: makeDraft(), force: false })
    ).rejects.toThrow(/Refusing to overwrite/);
  });

  it('rolls back newly written files when label activation fails', async () => {
    const repoRoot = await makeTempRepoRoot();
    const repoFullName = 'acme/widgets';

    const labelClient: RepoLabelClient = {
      getLabel: jest.fn().mockResolvedValue(null),
      createLabel: jest.fn().mockRejectedValue(new Error('label create failed')),
    };

    const deps = makeDeps(labelClient);

    await expect(
      runIntrospection(repoFullName, 'pm@example.com', 'fork-org', {
        repoRoot,
        deps,
        gatherRepoSignals: async () => makeSignals(repoFullName),
        generateDraftAdapter: async () => makeDraft(),
        approvalLoop: async () => makeDraft(),
      })
    ).rejects.toThrow(/Failed to add required GitHub labels/);

    const configDir = path.join(repoRoot, 'configs', 'acme', 'widgets');
    expect(fs.existsSync(path.join(configDir, 'manifest.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'adapter.ts'))).toBe(false);
  });

  it('queues concurrent introspection for the same repo (single execution)', async () => {
    const repoRoot = await makeTempRepoRoot();
    const repoFullName = 'acme/widgets';

    let started = 0;
    let unblockApproval!: () => void;

    const slowApproval = async (): Promise<DraftAdapter> => {
      started += 1;
      await new Promise<void>((resolve) => {
        unblockApproval = () => resolve();
      });
      return makeDraft();
    };

    const labelClient: RepoLabelClient = {
      getLabel: jest.fn().mockResolvedValue(null),
      createLabel: jest.fn().mockResolvedValue(undefined),
    };

    const deps = makeDeps(labelClient);

    const gather = jest.fn().mockResolvedValue(makeSignals(repoFullName));
    const generate = jest.fn().mockResolvedValue(makeDraft());

    const p1 = runIntrospection(repoFullName, 'pm@example.com', 'fork-org', {
      repoRoot,
      deps,
      gatherRepoSignals: gather,
      generateDraftAdapter: generate,
      approvalLoop: slowApproval,
    });

    const p2 = runIntrospection(repoFullName, 'pm@example.com', 'fork-org', {
      repoRoot,
      deps,
      gatherRepoSignals: gather,
      generateDraftAdapter: generate,
      approvalLoop: slowApproval,
    });

    // Ensure the first invocation reached the slow approval loop.
    await new Promise((r) => setImmediate(r));
    expect(started).toBe(1);
    expect(gather).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);

    unblockApproval();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.adapterPath).toBe(r2.adapterPath);
  });

  it('re-queues triggering event after activation', async () => {
    const repoRoot = await makeTempRepoRoot();
    const repoFullName = 'acme/widgets';

    const labelClient: RepoLabelClient = {
      getLabel: jest.fn().mockResolvedValue(null),
      createLabel: jest.fn().mockResolvedValue(undefined),
    };

    const deps = makeDeps(labelClient);

    const queue = { enqueue: jest.fn() };
    const event = { type: 'issues.labeled', repo: repoFullName, n: 1 };

    await runIntrospection(repoFullName, 'pm@example.com', 'fork-org', {
      repoRoot,
      deps,
      gatherRepoSignals: async () => makeSignals(repoFullName),
      generateDraftAdapter: async () => makeDraft(),
      approvalLoop: async () => makeDraft(),
      triggeringEvent: event,
      eventQueue: queue,
    });

    expect(queue.enqueue).toHaveBeenCalledWith(event);
  });

  it('addGitHubLabels is idempotent (skips existing labels)', async () => {
    const client: RepoLabelClient = {
      getLabel: jest
        .fn()
        .mockImplementation(async (_repo, name: string) => (name === 'agent-fix' ? { name } : null)),
      createLabel: jest.fn().mockResolvedValue(undefined),
    };

    const result = await addGitHubLabels(client, 'acme/widgets');
    expect(result.skipped).toContain('agent-fix');
    expect(result.created.length).toBeGreaterThan(0);
    expect(client.createLabel).toHaveBeenCalled();
  });

  it('rollbackWrittenAdapterFiles only deletes newly created files', async () => {
    const repoRoot = await makeTempRepoRoot();
    const repoFullName = 'acme/widgets';

    const write = await writeAdapterFiles({ repoRoot, repoFullName, draft: makeDraft() });

    // Simulate existing files by marking them as existedBefore.
    await rollbackWrittenAdapterFiles({
      configDir: write.configDir,
      written: write.written.map((w) => ({ ...w, existedBefore: true })),
      dirExistedBefore: true,
    });

    expect(fs.existsSync(write.adapterPath)).toBe(true);
    expect(fs.existsSync(write.manifestPath)).toBe(true);
  });
});
