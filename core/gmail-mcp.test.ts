/**
 * Unit tests for Gmail MCP integration (US-011).
 * Covers: send, poll, approval detection (positive + negative), threading.
 */

import {
  formatSubject,
  buildEmailMessage,
  sendEmail,
  detectApproval,
  createEmailThread,
  appendReplyToThread,
  appendAgentMessageToThread,
  buildWatcherQuery,
  GmailWatcher,
  sendAndTrack,
} from './gmail-mcp';

import {
  GmailClient,
  GmailMessage,
  GmailSendResult,
  GmailReply,
  GmailWatcherConfig,
  EmailThread,
  ReplyHandler,
  GmailSendError,
  GmailWatcherError,
  SUBJECT_PREFIX,
  DEFAULT_POLL_INTERVAL_MS,
} from './gmail-types';

// --- Mock helpers ---

function createMockClient(overrides: Partial<GmailClient> = {}): GmailClient {
  return {
    sendEmail: jest.fn().mockResolvedValue({
      success: true,
      messageId: 'msg-001',
      threadId: 'thread-001',
    }),
    listUnreadMessages: jest.fn().mockResolvedValue([]),
    markAsRead: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockReplyHandler(): ReplyHandler & { calls: Array<{ runId: string; reply: GmailReply; thread: EmailThread }> } {
  const calls: Array<{ runId: string; reply: GmailReply; thread: EmailThread }> = [];
  return {
    calls,
    onReply: jest.fn().mockImplementation(async (runId, reply, thread) => {
      calls.push({ runId, reply, thread });
    }),
  };
}

function createDefaultWatcherConfig(): GmailWatcherConfig {
  return {
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    subjectPrefix: SUBJECT_PREFIX,
    monitoredAddress: 'bot@example.com',
  };
}

function createMockReply(overrides: Partial<GmailReply> = {}): GmailReply {
  return {
    messageId: 'reply-msg-001',
    threadId: 'thread-001',
    body: 'This is my reply',
    from: 'user@example.com',
    receivedAt: '2026-05-06T12:00:00Z',
    subject: '[agent-fix] owner/repo/#42: Fix the bug',
    ...overrides,
  };
}

// --- Tests ---

describe('Gmail MCP Integration (US-011)', () => {
  describe('formatSubject', () => {
    it('formats subject with [agent-fix] prefix', () => {
      const result = formatSubject('owner/repo', 42, 'Fix the bug');
      expect(result).toBe('[agent-fix] owner/repo/#42: Fix the bug');
    });

    it('handles special characters in title', () => {
      const result = formatSubject('org/project', 100, 'Handle "quotes" & symbols');
      expect(result).toBe('[agent-fix] org/project/#100: Handle "quotes" & symbols');
    });

    it('includes the subject prefix constant', () => {
      const result = formatSubject('a/b', 1, 'title');
      expect(result.startsWith(SUBJECT_PREFIX)).toBe(true);
    });
  });

  describe('buildEmailMessage', () => {
    it('builds a message with all fields', () => {
      const msg = buildEmailMessage({
        to: 'pm@example.com',
        repo: 'owner/repo',
        issueNumber: 42,
        issueTitle: 'Fix the bug',
        body: 'Design brief content',
        replyTo: 'bot@example.com',
      });

      expect(msg.to).toBe('pm@example.com');
      expect(msg.subject).toBe('[agent-fix] owner/repo/#42: Fix the bug');
      expect(msg.body).toBe('Design brief content');
      expect(msg.replyTo).toBe('bot@example.com');
      expect(msg.threadId).toBeUndefined();
    });

    it('includes threadId when provided for reply threading', () => {
      const msg = buildEmailMessage({
        to: 'pm@example.com',
        repo: 'owner/repo',
        issueNumber: 42,
        issueTitle: 'Fix the bug',
        body: 'Follow-up',
        replyTo: 'bot@example.com',
        threadId: 'thread-123',
      });

      expect(msg.threadId).toBe('thread-123');
    });

    it('reply-to points to monitored address', () => {
      const msg = buildEmailMessage({
        to: 'pm@example.com',
        repo: 'owner/repo',
        issueNumber: 1,
        issueTitle: 'Title',
        body: 'Body',
        replyTo: 'monitored@orchestrator.com',
      });

      expect(msg.replyTo).toBe('monitored@orchestrator.com');
    });
  });

  describe('sendEmail', () => {
    it('sends via Gmail MCP and returns result', async () => {
      const client = createMockClient();
      const message: GmailMessage = {
        to: 'pm@example.com',
        subject: '[agent-fix] owner/repo/#42: Fix',
        body: 'Content',
        replyTo: 'bot@example.com',
      };

      const result = await sendEmail(client, message);

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-001');
      expect(result.threadId).toBe('thread-001');
      expect(client.sendEmail).toHaveBeenCalledWith(message);
    });

    it('throws GmailSendError on failure', async () => {
      const client = createMockClient({
        sendEmail: jest.fn().mockRejectedValue(new Error('Network error')),
      });
      const message: GmailMessage = {
        to: 'pm@example.com',
        subject: '[agent-fix] test',
        body: 'Content',
        replyTo: 'bot@example.com',
      };

      await expect(sendEmail(client, message)).rejects.toThrow(GmailSendError);
      await expect(sendEmail(client, message)).rejects.toThrow('Failed to send email');
    });

    it('GmailSendError includes to and subject', async () => {
      const client = createMockClient({
        sendEmail: jest.fn().mockRejectedValue(new Error('fail')),
      });
      const message: GmailMessage = {
        to: 'target@example.com',
        subject: '[agent-fix] subject line',
        body: 'Content',
        replyTo: 'bot@example.com',
      };

      try {
        await sendEmail(client, message);
      } catch (err) {
        expect(err).toBeInstanceOf(GmailSendError);
        expect((err as GmailSendError).to).toBe('target@example.com');
        expect((err as GmailSendError).subject).toBe('[agent-fix] subject line');
      }
    });
  });

  describe('detectApproval', () => {
    const keywords = ['approved', 'lgtm', 'ship it'];

    it('detects approval keyword (case-insensitive)', () => {
      const result = detectApproval('Looks good, APPROVED!', keywords);
      expect(result.approved).toBe(true);
      expect(result.matchedKeyword).toBe('approved');
    });

    it('detects "lgtm" as approval', () => {
      const result = detectApproval('LGTM, go ahead', keywords);
      expect(result.approved).toBe(true);
      expect(result.matchedKeyword).toBe('lgtm');
    });

    it('detects "ship it" as approval (multi-word)', () => {
      const result = detectApproval('Let\'s ship it now', keywords);
      expect(result.approved).toBe(true);
      expect(result.matchedKeyword).toBe('ship it');
    });

    it('returns not approved when no keywords match', () => {
      const result = detectApproval('I have some concerns about this approach', keywords);
      expect(result.approved).toBe(false);
      expect(result.matchedKeyword).toBeNull();
    });

    it('returns not approved on empty body', () => {
      const result = detectApproval('', keywords);
      expect(result.approved).toBe(false);
      expect(result.matchedKeyword).toBeNull();
    });

    it('returns not approved with empty keywords list', () => {
      const result = detectApproval('approved lgtm ship it', []);
      expect(result.approved).toBe(false);
      expect(result.matchedKeyword).toBeNull();
    });

    it('matches substring within larger text', () => {
      const result = detectApproval(
        'After reviewing everything, I think this is approved and we should move forward.',
        keywords
      );
      expect(result.approved).toBe(true);
      expect(result.matchedKeyword).toBe('approved');
    });

    it('is case-insensitive', () => {
      const result = detectApproval('LgTm', keywords);
      expect(result.approved).toBe(true);
    });

    it('returns the first matching keyword', () => {
      const result = detectApproval('approved and lgtm', keywords);
      expect(result.approved).toBe(true);
      expect(result.matchedKeyword).toBe('approved');
    });

    it('detects implied approval phrase "yes proceed"', () => {
      const result = detectApproval('Yes, proceed.', keywords);
      expect(result.approved).toBe(true);
      expect(result.matchedKeyword).toBe('yes proceed');
    });

    it('detects implied approval phrase "go ahead"', () => {
      const result = detectApproval('Please go ahead with this plan.', keywords);
      expect(result.approved).toBe(true);
      expect(result.matchedKeyword).toBe('go ahead');
    });

    it('ignores approval keywords in quoted reply sections', () => {
      const result = detectApproval(
        [
          'I still have one question before we proceed.',
          '',
          'On Tue, bot wrote:',
          '> LGTM, ship it',
        ].join('\n'),
        keywords
      );
      expect(result.approved).toBe(false);
      expect(result.matchedKeyword).toBeNull();
    });

    it('does not treat negated phrases as approval', () => {
      const result = detectApproval('Please do not proceed yet.', keywords);
      expect(result.approved).toBe(false);
      expect(result.matchedKeyword).toBeNull();
    });

    it('includes reply body in result', () => {
      const body = 'Some reply text';
      const result = detectApproval(body, keywords);
      expect(result.replyBody).toBe(body);
    });
  });

  describe('createEmailThread', () => {
    it('creates a new thread with initial agent message', () => {
      const thread = createEmailThread(
        'run-001',
        'thread-001',
        '[agent-fix] owner/repo/#42: Fix',
        'Design brief body',
        'msg-001',
        '2026-05-06T10:00:00Z'
      );

      expect(thread.runId).toBe('run-001');
      expect(thread.threadId).toBe('thread-001');
      expect(thread.subject).toBe('[agent-fix] owner/repo/#42: Fix');
      expect(thread.conversationHistory).toHaveLength(1);
      expect(thread.conversationHistory[0].role).toBe('agent');
      expect(thread.conversationHistory[0].body).toBe('Design brief body');
      expect(thread.conversationHistory[0].messageId).toBe('msg-001');
    });
  });

  describe('appendReplyToThread', () => {
    it('appends a user reply to the conversation history', () => {
      const thread = createEmailThread(
        'run-001', 'thread-001', 'Subject',
        'Initial', 'msg-001', '2026-05-06T10:00:00Z'
      );

      const reply = createMockReply({
        body: 'User response',
        messageId: 'reply-001',
        receivedAt: '2026-05-06T11:00:00Z',
      });

      const updated = appendReplyToThread(thread, reply);

      expect(updated.conversationHistory).toHaveLength(2);
      expect(updated.conversationHistory[1].role).toBe('user');
      expect(updated.conversationHistory[1].body).toBe('User response');
      expect(updated.conversationHistory[1].messageId).toBe('reply-001');
    });

    it('does not mutate the original thread', () => {
      const thread = createEmailThread(
        'run-001', 'thread-001', 'Subject',
        'Initial', 'msg-001', '2026-05-06T10:00:00Z'
      );

      const reply = createMockReply();
      appendReplyToThread(thread, reply);

      expect(thread.conversationHistory).toHaveLength(1);
    });
  });

  describe('appendAgentMessageToThread', () => {
    it('appends an agent message to the conversation history', () => {
      const thread = createEmailThread(
        'run-001', 'thread-001', 'Subject',
        'Initial', 'msg-001', '2026-05-06T10:00:00Z'
      );

      const updated = appendAgentMessageToThread(
        thread, 'Follow-up', 'msg-002', '2026-05-06T11:00:00Z'
      );

      expect(updated.conversationHistory).toHaveLength(2);
      expect(updated.conversationHistory[1].role).toBe('agent');
      expect(updated.conversationHistory[1].body).toBe('Follow-up');
    });
  });

  describe('buildWatcherQuery', () => {
    it('builds Gmail search query for unread [agent-fix] messages', () => {
      const config = createDefaultWatcherConfig();
      const query = buildWatcherQuery(config);

      expect(query).toContain('is:unread');
      expect(query).toContain(SUBJECT_PREFIX);
      expect(query).toContain('bot@example.com');
    });

    it('uses the configured subject prefix', () => {
      const config: GmailWatcherConfig = {
        pollIntervalMs: 30000,
        subjectPrefix: '[custom-prefix]',
        monitoredAddress: 'custom@example.com',
      };
      const query = buildWatcherQuery(config);

      expect(query).toContain('[custom-prefix]');
      expect(query).toContain('custom@example.com');
    });
  });

  describe('GmailWatcher', () => {
    let client: GmailClient;
    let handler: ReturnType<typeof createMockReplyHandler>;
    let watcher: GmailWatcher;

    beforeEach(() => {
      client = createMockClient();
      handler = createMockReplyHandler();
      watcher = new GmailWatcher(client, createDefaultWatcherConfig(), handler);
    });

    afterEach(() => {
      watcher.stop();
    });

    describe('thread registration', () => {
      it('registers a thread', () => {
        const thread = createEmailThread(
          'run-001', 'thread-001', 'Subject',
          'Body', 'msg-001', '2026-05-06T10:00:00Z'
        );
        watcher.registerThread(thread);

        expect(watcher.getThread('thread-001')).toEqual(thread);
      });

      it('unregisters a thread', () => {
        const thread = createEmailThread(
          'run-001', 'thread-001', 'Subject',
          'Body', 'msg-001', '2026-05-06T10:00:00Z'
        );
        watcher.registerThread(thread);
        watcher.unregisterThread('thread-001');

        expect(watcher.getThread('thread-001')).toBeUndefined();
      });

      it('finds thread by run ID', () => {
        const thread = createEmailThread(
          'run-xyz', 'thread-001', 'Subject',
          'Body', 'msg-001', '2026-05-06T10:00:00Z'
        );
        watcher.registerThread(thread);

        expect(watcher.getThreadByRunId('run-xyz')).toEqual(thread);
        expect(watcher.getThreadByRunId('run-other')).toBeUndefined();
      });

      it('lists all registered threads', () => {
        const t1 = createEmailThread('run-1', 'thread-1', 'S1', 'B1', 'm1', '2026-05-06T10:00:00Z');
        const t2 = createEmailThread('run-2', 'thread-2', 'S2', 'B2', 'm2', '2026-05-06T10:00:00Z');
        watcher.registerThread(t1);
        watcher.registerThread(t2);

        expect(watcher.getRegisteredThreads()).toHaveLength(2);
      });
    });

    describe('start/stop', () => {
      it('starts and reports running', () => {
        watcher.start();
        expect(watcher.isRunning()).toBe(true);
      });

      it('stops and reports not running', () => {
        watcher.start();
        watcher.stop();
        expect(watcher.isRunning()).toBe(false);
      });

      it('start is idempotent', () => {
        watcher.start();
        watcher.start();
        expect(watcher.isRunning()).toBe(true);
      });
    });

    describe('poll', () => {
      it('polls Gmail MCP for unread messages', async () => {
        await watcher.poll();
        expect(client.listUnreadMessages).toHaveBeenCalled();
      });

      it('uses correct query for polling', async () => {
        await watcher.poll();
        const query = (client.listUnreadMessages as jest.Mock).mock.calls[0][0];
        expect(query).toContain('is:unread');
        expect(query).toContain(SUBJECT_PREFIX);
      });

      it('matches reply to registered thread and notifies handler', async () => {
        const thread = createEmailThread(
          'run-001', 'thread-001', 'Subject',
          'Body', 'msg-001', '2026-05-06T10:00:00Z'
        );
        watcher.registerThread(thread);

        const reply = createMockReply({ threadId: 'thread-001' });
        (client.listUnreadMessages as jest.Mock).mockResolvedValue([reply]);

        const matched = await watcher.poll();

        expect(matched).toHaveLength(1);
        expect(handler.onReply).toHaveBeenCalledTimes(1);
        expect(handler.calls[0].runId).toBe('run-001');
        expect(handler.calls[0].reply).toEqual(reply);
      });

      it('ignores replies for unregistered threads', async () => {
        const reply = createMockReply({ threadId: 'unknown-thread' });
        (client.listUnreadMessages as jest.Mock).mockResolvedValue([reply]);

        const matched = await watcher.poll();

        expect(matched).toHaveLength(0);
        expect(handler.onReply).not.toHaveBeenCalled();
      });

      it('appends reply to thread conversation history', async () => {
        const thread = createEmailThread(
          'run-001', 'thread-001', 'Subject',
          'Body', 'msg-001', '2026-05-06T10:00:00Z'
        );
        watcher.registerThread(thread);

        const reply = createMockReply({ threadId: 'thread-001', body: 'User reply' });
        (client.listUnreadMessages as jest.Mock).mockResolvedValue([reply]);

        await watcher.poll();

        const updated = watcher.getThread('thread-001')!;
        expect(updated.conversationHistory).toHaveLength(2);
        expect(updated.conversationHistory[1].role).toBe('user');
        expect(updated.conversationHistory[1].body).toBe('User reply');
      });

      it('marks matched replies as read', async () => {
        const thread = createEmailThread(
          'run-001', 'thread-001', 'Subject',
          'Body', 'msg-001', '2026-05-06T10:00:00Z'
        );
        watcher.registerThread(thread);

        const reply = createMockReply({ threadId: 'thread-001', messageId: 'reply-123' });
        (client.listUnreadMessages as jest.Mock).mockResolvedValue([reply]);

        await watcher.poll();

        expect(client.markAsRead).toHaveBeenCalledWith('reply-123');
      });

      it('handles multiple replies in one poll', async () => {
        const t1 = createEmailThread('run-1', 'thread-1', 'S1', 'B1', 'm1', '2026-05-06T10:00:00Z');
        const t2 = createEmailThread('run-2', 'thread-2', 'S2', 'B2', 'm2', '2026-05-06T10:00:00Z');
        watcher.registerThread(t1);
        watcher.registerThread(t2);

        const replies = [
          createMockReply({ threadId: 'thread-1', messageId: 'r1' }),
          createMockReply({ threadId: 'thread-2', messageId: 'r2' }),
        ];
        (client.listUnreadMessages as jest.Mock).mockResolvedValue(replies);

        const matched = await watcher.poll();

        expect(matched).toHaveLength(2);
        expect(handler.onReply).toHaveBeenCalledTimes(2);
      });

      it('throws GmailWatcherError on poll failure', async () => {
        (client.listUnreadMessages as jest.Mock).mockRejectedValue(new Error('API error'));

        await expect(watcher.poll()).rejects.toThrow(GmailWatcherError);
        await expect(watcher.poll()).rejects.toThrow('Failed to poll');
      });

      it('tolerates markAsRead failure (non-fatal)', async () => {
        const thread = createEmailThread(
          'run-001', 'thread-001', 'Subject',
          'Body', 'msg-001', '2026-05-06T10:00:00Z'
        );
        watcher.registerThread(thread);

        const reply = createMockReply({ threadId: 'thread-001' });
        (client.listUnreadMessages as jest.Mock).mockResolvedValue([reply]);
        (client.markAsRead as jest.Mock).mockRejectedValue(new Error('fail'));

        // Should not throw
        const matched = await watcher.poll();
        expect(matched).toHaveLength(1);
        expect(handler.onReply).toHaveBeenCalled();
      });
    });
  });

  describe('sendAndTrack', () => {
    it('sends email and registers new thread', async () => {
      const client = createMockClient();
      const handler = createMockReplyHandler();
      const watcher = new GmailWatcher(client, createDefaultWatcherConfig(), handler);

      const thread = await sendAndTrack(client, watcher, {
        runId: 'run-001',
        to: 'pm@example.com',
        repo: 'owner/repo',
        issueNumber: 42,
        issueTitle: 'Fix the bug',
        body: 'Design brief',
        replyTo: 'bot@example.com',
      });

      expect(thread.runId).toBe('run-001');
      expect(thread.threadId).toBe('thread-001');
      expect(thread.subject).toBe('[agent-fix] owner/repo/#42: Fix the bug');
      expect(thread.conversationHistory).toHaveLength(1);
      expect(thread.conversationHistory[0].role).toBe('agent');

      // Thread is registered in watcher
      expect(watcher.getThread('thread-001')).toBeDefined();
    });

    it('appends to existing thread when threadId provided', async () => {
      const client = createMockClient({
        sendEmail: jest.fn().mockResolvedValue({
          success: true,
          messageId: 'msg-002',
          threadId: 'thread-001',
        }),
      });
      const handler = createMockReplyHandler();
      const watcher = new GmailWatcher(client, createDefaultWatcherConfig(), handler);

      // Register existing thread
      const existing = createEmailThread(
        'run-001', 'thread-001', 'Subject',
        'Initial body', 'msg-001', '2026-05-06T10:00:00Z'
      );
      watcher.registerThread(existing);

      const thread = await sendAndTrack(client, watcher, {
        runId: 'run-001',
        to: 'pm@example.com',
        repo: 'owner/repo',
        issueNumber: 42,
        issueTitle: 'Fix the bug',
        body: 'Follow-up message',
        replyTo: 'bot@example.com',
        existingThreadId: 'thread-001',
      });

      expect(thread.conversationHistory).toHaveLength(2);
      expect(thread.conversationHistory[1].role).toBe('agent');
      expect(thread.conversationHistory[1].body).toBe('Follow-up message');
    });

    it('maintains same subject and thread ID across conversation', async () => {
      const client = createMockClient();
      const handler = createMockReplyHandler();
      const watcher = new GmailWatcher(client, createDefaultWatcherConfig(), handler);

      const thread = await sendAndTrack(client, watcher, {
        runId: 'run-001',
        to: 'pm@example.com',
        repo: 'owner/repo',
        issueNumber: 42,
        issueTitle: 'Fix the bug',
        body: 'Initial',
        replyTo: 'bot@example.com',
      });

      // Subject stays the same
      expect(thread.subject).toContain('[agent-fix]');
      expect(thread.subject).toContain('owner/repo');
      expect(thread.subject).toContain('#42');
    });

    it('propagates GmailSendError on failure', async () => {
      const client = createMockClient({
        sendEmail: jest.fn().mockRejectedValue(new Error('send failed')),
      });
      const handler = createMockReplyHandler();
      const watcher = new GmailWatcher(client, createDefaultWatcherConfig(), handler);

      await expect(
        sendAndTrack(client, watcher, {
          runId: 'run-001',
          to: 'pm@example.com',
          repo: 'owner/repo',
          issueNumber: 42,
          issueTitle: 'Fix',
          body: 'Body',
          replyTo: 'bot@example.com',
        })
      ).rejects.toThrow(GmailSendError);
    });
  });

  describe('constants', () => {
    it('DEFAULT_POLL_INTERVAL_MS is 60 seconds', () => {
      expect(DEFAULT_POLL_INTERVAL_MS).toBe(60_000);
    });

    it('SUBJECT_PREFIX is [agent-fix]', () => {
      expect(SUBJECT_PREFIX).toBe('[agent-fix]');
    });
  });

  describe('threading integrity', () => {
    it('same thread ID maintained across full conversation', async () => {
      const client = createMockClient();
      const handler = createMockReplyHandler();
      const watcher = new GmailWatcher(client, createDefaultWatcherConfig(), handler);

      // Agent sends initial email
      const thread = await sendAndTrack(client, watcher, {
        runId: 'run-001',
        to: 'pm@example.com',
        repo: 'owner/repo',
        issueNumber: 42,
        issueTitle: 'Fix the bug',
        body: 'Design brief',
        replyTo: 'bot@example.com',
      });

      // User replies
      const reply = createMockReply({
        threadId: 'thread-001',
        body: 'What about option B?',
        messageId: 'reply-001',
      });
      (client.listUnreadMessages as jest.Mock).mockResolvedValue([reply]);
      await watcher.poll();

      // Check conversation history
      const updated = watcher.getThread('thread-001')!;
      expect(updated.threadId).toBe('thread-001');
      expect(updated.conversationHistory).toHaveLength(2);
      expect(updated.conversationHistory[0].role).toBe('agent');
      expect(updated.conversationHistory[1].role).toBe('user');
    });

    it('watcher wakes PM agent (handler) for the correct run', async () => {
      const client = createMockClient();
      const handler = createMockReplyHandler();
      const watcher = new GmailWatcher(client, createDefaultWatcherConfig(), handler);

      const t1 = createEmailThread('run-AAA', 'thread-AAA', 'S1', 'B1', 'm1', '2026-05-06T10:00:00Z');
      const t2 = createEmailThread('run-BBB', 'thread-BBB', 'S2', 'B2', 'm2', '2026-05-06T10:00:00Z');
      watcher.registerThread(t1);
      watcher.registerThread(t2);

      const reply = createMockReply({ threadId: 'thread-BBB', body: 'Reply for run B' });
      (client.listUnreadMessages as jest.Mock).mockResolvedValue([reply]);

      await watcher.poll();

      expect(handler.calls).toHaveLength(1);
      expect(handler.calls[0].runId).toBe('run-BBB');
    });
  });
});
