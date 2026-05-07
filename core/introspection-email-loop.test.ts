/**
 * Unit tests for introspection email review loop (US-106).
 */

import {
  sendIntrospectionEmail,
  processIntrospectionReply,
  resumeIntrospectionEmailLoop,
  stripQuotedReplyText,
  isApproval,
} from './introspection-email-loop';

import type {
  IntrospectionEmailLoopConfig,
  IntrospectionStateStore,
} from './introspection-email-types';

import type { DraftAdapter, RepoSignals } from './agents/introspection-types';

import type { GmailClient, GmailSendResult } from './gmail-types';
import { GmailWatcher } from './gmail-mcp';
import { MockLLMClient } from './llm/test-utils';

function baseSignals(): RepoSignals {
  return {
    repoFullName: 'acme/demo',
    ciWorkflows: [{ path: '.github/workflows/ci.yml', commands: ['npm ci', 'npm test'] }],
    packageManifests: [{ path: 'package.json', kind: 'package.json', stack: 'node', testHint: 'npm test' }],
    makefileTargets: [],
    contributingDocs: [],
    composeServices: [],
    readme: '',
    monorepoLayout: {},
  };
}

function draft(version: string): DraftAdapter {
  return {
    adapterTs: `export default class DemoAdapter { /* ${version} */ }`,
    manifestYaml: `repo: acme/demo\nfork_org: acme\npm_email: pm@example.com\n# ${version}\n`,
    rationale: { source: version },
    openItems: [],
  };
}

function createMockGmailClient(overrides: Partial<GmailClient> = {}): GmailClient {
  return {
    sendEmail: jest.fn().mockResolvedValue({
      success: true,
      messageId: 'msg-1',
      threadId: 'thread-1',
    } as GmailSendResult),
    listUnreadMessages: jest.fn().mockResolvedValue([]),
    markAsRead: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockStateStore(): { store: Map<string, any>; impl: IntrospectionStateStore } {
  const store = new Map<string, any>();
  return {
    store,
    impl: {
      saveState: jest.fn((repoFullName, state) => { store.set(repoFullName, state); }),
      loadState: jest.fn((repoFullName) => store.get(repoFullName) ?? null),
      deleteState: jest.fn((repoFullName) => { store.delete(repoFullName); }),
    },
  };
}

function createWatcher(client: GmailClient): GmailWatcher {
  return new GmailWatcher(
    client,
    { pollIntervalMs: 60_000, subjectPrefix: '[agent-fix]', monitoredAddress: 'bot@example.com' },
    { onReply: jest.fn() }
  );
}

function config(overrides: Partial<IntrospectionEmailLoopConfig> = {}): IntrospectionEmailLoopConfig {
  return {
    pmEmail: 'pm@example.com',
    replyToAddress: 'bot@example.com',
    repoFullName: 'acme/demo',
    approvalKeywords: ['approved', 'lgtm', 'ship it'],
    ...overrides,
  };
}

describe('stripQuotedReplyText / isApproval', () => {
  test('strips quoted lines and common reply separators', () => {
    const input = [
      'Please revise the manifest.',
      '',
      'On Tue, someone wrote:',
      '> lgtm',
      '> more quote',
    ].join('\n');

    expect(stripQuotedReplyText(input)).toBe('Please revise the manifest.');
    expect(isApproval(input, ['lgtm'])).toBe(false);
  });

  test('detects approval keyword in non-quoted text', () => {
    const input = 'LGTM\n\nOn Tue, someone wrote:\n> please approve';
    expect(isApproval(input, ['lgtm'])).toBe(true);
  });
});

describe('introspection email loop (US-106)', () => {
  test('first-reply approval closes the loop and clears state', async () => {
    const client = createMockGmailClient();
    const watcher = createWatcher(client);
    const { impl: stateStore } = createMockStateStore();

    await sendIntrospectionEmail(client, watcher, config(), draft('v1'), stateStore);

    const llm = new MockLLMClient({
      chatJson: async <T>() => {
        throw new Error('should not be called');
      },
    });

    const res = await processIntrospectionReply({
      client,
      watcher,
      config: config(),
      signals: baseSignals(),
      llm,
      replyBody: 'approved',
      stateStore,
    });

    expect(res.action).toBe('approved');
    expect(stateStore.deleteState).toHaveBeenCalledWith('acme/demo');
    expect(watcher.getThread('thread-1')).toBeUndefined();
  });

  test('two revisions then approval', async () => {
    const client = createMockGmailClient({
      sendEmail: jest
        .fn()
        .mockResolvedValueOnce({ success: true, messageId: 'msg-1', threadId: 'thread-1' })
        .mockResolvedValueOnce({ success: true, messageId: 'msg-2', threadId: 'thread-1' })
        .mockResolvedValueOnce({ success: true, messageId: 'msg-3', threadId: 'thread-1' }),
    });
    const watcher = createWatcher(client);
    const { impl: stateStore } = createMockStateStore();

    await sendIntrospectionEmail(client, watcher, config(), draft('v1'), stateStore);

    let call = 0;
    const llm = new MockLLMClient({
      chatJson: async <T>() => {
        call++;
        return {
          data: draft(call === 1 ? 'v2' : 'v3') as any as T,
          usage: null,
          raw: null,
        };
      },
    });

    const r1 = await processIntrospectionReply({
      client,
      watcher,
      config: config(),
      signals: baseSignals(),
      llm,
      replyBody: 'Please change the test command ordering.',
      stateStore,
    });
    expect(r1.action).toBe('revised');
    expect(r1.iteration).toBe(1);

    const r2 = await processIntrospectionReply({
      client,
      watcher,
      config: config(),
      signals: baseSignals(),
      llm,
      replyBody: 'Also add a service health check URL.',
      stateStore,
    });
    expect(r2.action).toBe('revised');
    expect(r2.iteration).toBe(2);

    const r3 = await processIntrospectionReply({
      client,
      watcher,
      config: config(),
      signals: baseSignals(),
      llm,
      replyBody: 'lgtm',
      stateStore,
    });
    expect(r3.action).toBe('approved');
    if (r3.action !== 'approved') {
      throw new Error('Expected approval');
    }
    expect(r3.iteration).toBe(2);
    expect(r3.finalDraft.manifestYaml).toContain('v3');
  });

  test('max-iterations exceeded throws a clear error', async () => {
    const client = createMockGmailClient({
      sendEmail: jest
        .fn()
        .mockResolvedValueOnce({ success: true, messageId: 'msg-1', threadId: 'thread-1' })
        .mockResolvedValueOnce({ success: true, messageId: 'msg-2', threadId: 'thread-1' }),
    });
    const watcher = createWatcher(client);
    const { impl: stateStore } = createMockStateStore();

    await sendIntrospectionEmail(client, watcher, config({ maxIterations: 1 }), draft('v1'), stateStore);

    const llm = new MockLLMClient({
      chatJson: async <T>() => ({ data: draft('v2') as any as T, usage: null, raw: null }),
    });

    await processIntrospectionReply({
      client,
      watcher,
      config: config({ maxIterations: 1 }),
      signals: baseSignals(),
      llm,
      replyBody: 'revise 1',
      stateStore,
    });

    await expect(
      processIntrospectionReply({
        client,
        watcher,
        config: config({ maxIterations: 1 }),
        signals: baseSignals(),
        llm,
        replyBody: 'revise 2',
        stateStore,
      })
    ).rejects.toThrow(/Max introspection email iterations exceeded/i);
  });

  test('resume after restart re-registers watcher thread', async () => {
    const client = createMockGmailClient();
    const watcher1 = createWatcher(client);
    const { impl: stateStore } = createMockStateStore();

    await sendIntrospectionEmail(client, watcher1, config(), draft('v1'), stateStore);

    const watcher2 = createWatcher(client);
    const resumed = resumeIntrospectionEmailLoop(watcher2, stateStore, 'acme/demo');

    expect(resumed).not.toBeNull();
    expect(watcher2.getThread(resumed!.thread.threadId)).toBeDefined();
  });

  test('quoted-text approval keyword does not false-positive', async () => {
    const client = createMockGmailClient();
    const watcher = createWatcher(client);
    const { impl: stateStore } = createMockStateStore();

    await sendIntrospectionEmail(client, watcher, config(), draft('v1'), stateStore);

    const llm = new MockLLMClient({
      chatJson: async <T>() => ({ data: draft('v2') as any as T, usage: null, raw: null }),
    });

    const replyBody = [
      'Please revise the rationale section.',
      '',
      'On Tue, you wrote:',
      '> lgtm',
    ].join('\n');

    const res = await processIntrospectionReply({
      client,
      watcher,
      config: config(),
      signals: baseSignals(),
      llm,
      replyBody,
      stateStore,
    });

    expect(res.action).toBe('revised');
  });
});
