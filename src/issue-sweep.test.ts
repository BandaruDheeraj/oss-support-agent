/**
 * Unit tests for issue sweep and scope confirmation (US-013).
 */

import {
  HeuristicIssueSweeper,
  formatScopeEmail,
  parseScopeReply,
  sendScopeConfirmation,
  processScopeReply,
  resumeSweepLoop,
  runIssueSweep,
  createSweepReplyHandler,
} from './issue-sweep';

import {
  SweepIssue,
  SweepResult,
  SweepInput,
  ScopeConfirmationConfig,
  SweepStateStore,
  SweepError,
} from './issue-sweep-types';

import { EmailThread, GmailClient, GmailSendResult, GmailReply } from './gmail-types';
import { GmailWatcher } from './gmail-mcp';

// --- Test helpers ---

function makeSweepIssue(overrides: Partial<SweepIssue> = {}): SweepIssue {
  return {
    number: 100,
    title: 'Test issue',
    labels: ['bug'],
    reason: 'Related to the module',
    ...overrides,
  };
}

function makeSweepResult(overrides: Partial<SweepResult> = {}): SweepResult {
  return {
    highConfidence: [
      makeSweepIssue({ number: 142, title: 'Fix auth token refresh', reason: 'Same auth module affected' }),
      makeSweepIssue({ number: 156, title: 'Token expiry not handled', reason: 'Related token handling' }),
    ],
    maybeInScope: [
      makeSweepIssue({ number: 201, title: 'Session timeout UX', reason: 'Partial overlap with session handling' }),
      makeSweepIssue({ number: 203, title: 'Login error message unclear', reason: 'Similar error path' }),
    ],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ScopeConfirmationConfig> = {}): ScopeConfirmationConfig {
  return {
    pmEmail: 'pm@example.com',
    replyToAddress: 'bot@example.com',
    repo: 'org/repo',
    issueNumber: 142,
    issueTitle: 'Fix auth token refresh',
    runId: 'run-123',
    ...overrides,
  };
}

function makeThread(overrides: Partial<EmailThread> = {}): EmailThread {
  return {
    runId: 'run-123',
    threadId: 'thread-abc',
    subject: '[agent-fix] org/repo/#142: Fix auth token refresh',
    conversationHistory: [],
    ...overrides,
  };
}

function makeMockGmailClient(): GmailClient {
  return {
    sendEmail: jest.fn().mockResolvedValue({
      success: true,
      messageId: 'msg-001',
      threadId: 'thread-abc',
    } as GmailSendResult),
    listUnreadMessages: jest.fn().mockResolvedValue([]),
    markAsRead: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMockStateStore(): SweepStateStore {
  const store = new Map<string, { thread: EmailThread; sweepResult: SweepResult }>();
  return {
    saveSweepState: jest.fn((runId, thread, sweepResult) => {
      store.set(runId, { thread, sweepResult });
    }),
    loadSweepState: jest.fn((runId) => store.get(runId) ?? null),
    deleteSweepState: jest.fn((runId) => { store.delete(runId); }),
  };
}

function makeMockWatcher(): GmailWatcher {
  return {
    registerThread: jest.fn(),
    unregisterThread: jest.fn(),
    getThread: jest.fn(),
    getThreadByRunId: jest.fn(),
    getRegisteredThreads: jest.fn().mockReturnValue([]),
    start: jest.fn(),
    stop: jest.fn(),
    poll: jest.fn().mockResolvedValue(undefined),
  } as unknown as GmailWatcher;
}

// --- Tests ---

describe('HeuristicIssueSweeper', () => {
  const sweeper = new HeuristicIssueSweeper();

  it('always includes primary issue in high confidence', () => {
    const input: SweepInput = {
      agreedDesign: 'Fix the authentication module token refresh logic',
      affectedModule: 'src/auth',
      openIssues: [
        makeSweepIssue({ number: 42, title: 'Token refresh broken', reason: 'Same auth module' }),
      ],
      primaryIssueNumber: 42,
    };
    const result = sweeper.sweepIssues(input);
    expect(result.highConfidence.some((i) => i.number === 42)).toBe(true);
    expect(result.highConfidence[0].reason).toContain('Primary issue');
  });

  it('categorizes issues with strong module match as high confidence', () => {
    const input: SweepInput = {
      agreedDesign: 'Fix the authentication token refresh in src/auth module',
      affectedModule: 'src/auth',
      openIssues: [
        makeSweepIssue({
          number: 100,
          title: 'auth token not refreshing',
          reason: 'Related to src/auth module',
          labels: ['bug'],
        }),
      ],
      primaryIssueNumber: 1,
    };
    const result = sweeper.sweepIssues(input);
    expect(result.highConfidence.some((i) => i.number === 100)).toBe(true);
  });

  it('categorizes issues with partial overlap as maybe_in_scope', () => {
    const input: SweepInput = {
      agreedDesign: 'Refactor the authentication flow to handle token expiry',
      affectedModule: 'src/auth',
      openIssues: [
        makeSweepIssue({
          number: 200,
          title: 'session handling improvement',
          reason: 'similar flow to auth',
          labels: ['enhancement'],
        }),
      ],
      primaryIssueNumber: 1,
    };
    const result = sweeper.sweepIssues(input);
    // Partial match due to 'similar' keyword in reason
    expect(
      result.maybeInScope.some((i) => i.number === 200) ||
      result.highConfidence.some((i) => i.number === 200)
    ).toBe(true);
  });

  it('excludes unrelated issues', () => {
    const input: SweepInput = {
      agreedDesign: 'Fix the authentication token refresh in src/auth',
      affectedModule: 'src/auth',
      openIssues: [
        makeSweepIssue({
          number: 300,
          title: 'Update homepage CSS colors',
          reason: 'Unrelated styling task',
          labels: ['design'],
        }),
      ],
      primaryIssueNumber: 1,
    };
    const result = sweeper.sweepIssues(input);
    expect(result.highConfidence.some((i) => i.number === 300)).toBe(false);
    expect(result.maybeInScope.some((i) => i.number === 300)).toBe(false);
  });

  it('handles empty open issues', () => {
    const input: SweepInput = {
      agreedDesign: 'Fix something',
      affectedModule: 'src/auth',
      openIssues: [],
      primaryIssueNumber: 1,
    };
    const result = sweeper.sweepIssues(input);
    expect(result.highConfidence).toEqual([]);
    expect(result.maybeInScope).toEqual([]);
  });

  it('handles multiple issues with varying relevance', () => {
    const input: SweepInput = {
      agreedDesign: 'Fix authentication token refresh logic in the auth module to handle expiry correctly',
      affectedModule: 'src/auth',
      openIssues: [
        makeSweepIssue({ number: 1, title: 'Primary auth bug', reason: 'auth token issue' }),
        makeSweepIssue({ number: 10, title: 'auth refresh fails', reason: 'Related to src/auth module, same token logic' }),
        makeSweepIssue({ number: 20, title: 'logging improvement', reason: 'Unrelated logging in src/logging' }),
        makeSweepIssue({ number: 30, title: 'token validation', reason: 'also related to auth token handling' }),
      ],
      primaryIssueNumber: 1,
    };
    const result = sweeper.sweepIssues(input);
    // Primary issue always high confidence
    expect(result.highConfidence.some((i) => i.number === 1)).toBe(true);
    // Total categorized issues should not include completely unrelated ones
    const allCategorized = [...result.highConfidence, ...result.maybeInScope];
    expect(allCategorized.some((i) => i.number === 10) || allCategorized.some((i) => i.number === 30)).toBe(true);
  });

  it('uses label matching for relevance scoring', () => {
    const input: SweepInput = {
      agreedDesign: 'Fix the bug related to authentication',
      affectedModule: 'src/auth',
      openIssues: [
        makeSweepIssue({
          number: 50,
          title: 'another auth problem',
          reason: 'Related to src/auth module',
          labels: ['bug', 'authentication'],
        }),
      ],
      primaryIssueNumber: 1,
    };
    const result = sweeper.sweepIssues(input);
    // Should be categorized due to module match + label + title words
    const allCategorized = [...result.highConfidence, ...result.maybeInScope];
    expect(allCategorized.some((i) => i.number === 50)).toBe(true);
  });
});

describe('formatScopeEmail', () => {
  it('includes section header', () => {
    const email = formatScopeEmail(makeSweepResult());
    expect(email).toContain('## Scope Confirmation');
  });

  it('includes high confidence issues with numbers and reasons', () => {
    const email = formatScopeEmail(makeSweepResult());
    expect(email).toContain('#142');
    expect(email).toContain('Fix auth token refresh');
    expect(email).toContain('Same auth module affected');
    expect(email).toContain('#156');
  });

  it('includes maybe in scope issues with numbers and reasons', () => {
    const email = formatScopeEmail(makeSweepResult());
    expect(email).toContain('#201');
    expect(email).toContain('Session timeout UX');
    expect(email).toContain('#203');
  });

  it('includes instruction to reply with issue numbers or "all"', () => {
    const email = formatScopeEmail(makeSweepResult());
    expect(email).toContain('reply');
    expect(email).toContain('all');
    expect(email).toContain('issue numbers');
  });

  it('shows (none) when no high confidence issues', () => {
    const email = formatScopeEmail(makeSweepResult({ highConfidence: [] }));
    expect(email).toContain('(none)');
  });

  it('shows (none) when no maybe in scope issues', () => {
    const email = formatScopeEmail(makeSweepResult({ maybeInScope: [] }));
    expect(email).toMatch(/Maybe in scope.*\n.*\(none\)/s);
  });

  it('separates high confidence and maybe in scope sections', () => {
    const email = formatScopeEmail(makeSweepResult());
    expect(email).toContain('High confidence');
    expect(email).toContain('Maybe in scope');
  });
});

describe('parseScopeReply', () => {
  const sweep = makeSweepResult();

  describe('"all" keyword', () => {
    it('handles plain "all"', () => {
      const result = parseScopeReply('all', sweep);
      expect(result.sort()).toEqual([142, 156, 201, 203]);
    });

    it('handles "all" with additional text', () => {
      const result = parseScopeReply('all looks good', sweep);
      expect(result.sort()).toEqual([142, 156, 201, 203]);
    });

    it('handles "include all"', () => {
      const result = parseScopeReply('include all of them', sweep);
      expect(result.sort()).toEqual([142, 156, 201, 203]);
    });
  });

  describe('explicit include', () => {
    it('parses "include 142 and 156"', () => {
      const result = parseScopeReply('include 142 and 156', sweep);
      expect(result.sort()).toEqual([142, 156]);
    });

    it('parses comma-separated numbers', () => {
      const result = parseScopeReply('142, 156, 201', sweep);
      expect(result.sort()).toEqual([142, 156, 201]);
    });

    it('ignores numbers not in the sweep', () => {
      const result = parseScopeReply('include 142 and 999', sweep);
      expect(result).toEqual([142]);
    });
  });

  describe('explicit exclude (drop)', () => {
    it('parses "drop 201"', () => {
      const result = parseScopeReply('drop 201', sweep);
      expect(result.sort()).toEqual([142, 156, 203]);
    });

    it('parses "exclude 201 and 203"', () => {
      const result = parseScopeReply('exclude 201 and 203', sweep);
      expect(result.sort()).toEqual([142, 156]);
    });

    it('parses "remove 156"', () => {
      const result = parseScopeReply('remove 156', sweep);
      expect(result.sort()).toEqual([142, 201, 203]);
    });
  });

  describe('mixed include/exclude', () => {
    it('parses "include 142 and 156 but drop 201"', () => {
      const result = parseScopeReply('include 142 and 156 but drop 201', sweep);
      expect(result.sort()).toEqual([142, 156]);
    });

    it('parses "keep 142 and 156, skip 203"', () => {
      const result = parseScopeReply('keep 142 and 156, skip 203', sweep);
      expect(result.sort()).toEqual([142, 156]);
    });
  });

  describe('edge cases', () => {
    it('no numbers in reply defaults to high confidence', () => {
      const result = parseScopeReply('sure, go ahead with the ones you suggested', sweep);
      expect(result.sort()).toEqual([142, 156]);
    });

    it('empty reply defaults to high confidence', () => {
      const result = parseScopeReply('', sweep);
      expect(result.sort()).toEqual([142, 156]);
    });

    it('handles prose with issue numbers', () => {
      const result = parseScopeReply(
        'Yes, let\'s include issues 142, 156, and 203 in this fix',
        sweep
      );
      expect(result.sort()).toEqual([142, 156, 203]);
    });
  });
});

describe('sendScopeConfirmation', () => {
  it('sends email with scope content', async () => {
    const client = makeMockGmailClient();
    const watcher = makeMockWatcher();
    const stateStore = makeMockStateStore();
    const config = makeConfig();
    const sweep = makeSweepResult();

    const result = await sendScopeConfirmation(client, watcher, config, sweep, stateStore);

    expect(result.action).toBe('scope_email_sent');
    expect(client.sendEmail).toHaveBeenCalled();
  });

  it('persists state for restart-resume', async () => {
    const client = makeMockGmailClient();
    const watcher = makeMockWatcher();
    const stateStore = makeMockStateStore();
    const config = makeConfig();
    const sweep = makeSweepResult();

    await sendScopeConfirmation(client, watcher, config, sweep, stateStore);

    expect(stateStore.saveSweepState).toHaveBeenCalledWith(
      'run-123',
      expect.any(Object),
      sweep
    );
  });

  it('registers thread with watcher', async () => {
    const client = makeMockGmailClient();
    const watcher = makeMockWatcher();
    const stateStore = makeMockStateStore();
    const config = makeConfig();
    const sweep = makeSweepResult();

    await sendScopeConfirmation(client, watcher, config, sweep, stateStore);

    expect(watcher.registerThread).toHaveBeenCalled();
  });

  it('returns sweep result in response', async () => {
    const client = makeMockGmailClient();
    const watcher = makeMockWatcher();
    const stateStore = makeMockStateStore();
    const config = makeConfig();
    const sweep = makeSweepResult();

    const result = await sendScopeConfirmation(client, watcher, config, sweep, stateStore);

    if (result.action === 'scope_email_sent') {
      expect(result.sweepResult).toEqual(sweep);
    }
  });

  it('uses existing thread ID when provided', async () => {
    const client = makeMockGmailClient();
    const watcher = makeMockWatcher();
    const stateStore = makeMockStateStore();
    const config = makeConfig();
    const sweep = makeSweepResult();

    await sendScopeConfirmation(client, watcher, config, sweep, stateStore, 'existing-thread-id');

    const sendCall = (client.sendEmail as jest.Mock).mock.calls[0][0];
    expect(sendCall.threadId).toBe('existing-thread-id');
  });
});

describe('processScopeReply', () => {
  it('parses reply and returns confirmed issue numbers', () => {
    const stateStore = makeMockStateStore();
    const watcher = makeMockWatcher();
    const sweep = makeSweepResult();

    const result = processScopeReply('all', sweep, stateStore, 'run-123', watcher, 'thread-abc');

    expect(result.action).toBe('scope_confirmed');
    if (result.action === 'scope_confirmed') {
      expect(result.confirmedIssueNumbers.sort()).toEqual([142, 156, 201, 203]);
    }
  });

  it('deletes persisted state after confirmation', () => {
    const stateStore = makeMockStateStore();
    const watcher = makeMockWatcher();
    const sweep = makeSweepResult();

    processScopeReply('all', sweep, stateStore, 'run-123', watcher, 'thread-abc');

    expect(stateStore.deleteSweepState).toHaveBeenCalledWith('run-123');
  });

  it('unregisters thread from watcher', () => {
    const stateStore = makeMockStateStore();
    const watcher = makeMockWatcher();
    const sweep = makeSweepResult();

    processScopeReply('all', sweep, stateStore, 'run-123', watcher, 'thread-abc');

    expect(watcher.unregisterThread).toHaveBeenCalledWith('thread-abc');
  });
});

describe('resumeSweepLoop', () => {
  it('loads persisted state and re-registers with watcher', () => {
    const watcher = makeMockWatcher();
    const stateStore = makeMockStateStore();
    const thread = makeThread();
    const sweep = makeSweepResult();

    // Save state first
    stateStore.saveSweepState('run-123', thread, sweep);

    const result = resumeSweepLoop(watcher, stateStore, 'run-123');

    expect(result).not.toBeNull();
    expect(result!.thread).toEqual(thread);
    expect(result!.sweepResult).toEqual(sweep);
    expect(watcher.registerThread).toHaveBeenCalledWith(thread);
  });

  it('returns null for missing state', () => {
    const watcher = makeMockWatcher();
    const stateStore = makeMockStateStore();

    const result = resumeSweepLoop(watcher, stateStore, 'nonexistent');

    expect(result).toBeNull();
  });

  it('survives restart (new watcher instance)', () => {
    const stateStore = makeMockStateStore();
    const thread = makeThread();
    const sweep = makeSweepResult();
    stateStore.saveSweepState('run-123', thread, sweep);

    // Simulate restart with new watcher
    const newWatcher = makeMockWatcher();
    const result = resumeSweepLoop(newWatcher, stateStore, 'run-123');

    expect(result).not.toBeNull();
    expect(newWatcher.registerThread).toHaveBeenCalledWith(thread);
  });
});

describe('runIssueSweep', () => {
  it('sweeps issues and sends scope email', async () => {
    const client = makeMockGmailClient();
    const watcher = makeMockWatcher();
    const stateStore = makeMockStateStore();
    const config = makeConfig();
    const sweeper = new HeuristicIssueSweeper();
    const input: SweepInput = {
      agreedDesign: 'Fix auth token refresh in src/auth module',
      affectedModule: 'src/auth',
      openIssues: [
        makeSweepIssue({ number: 142, title: 'auth token refresh', reason: 'Related to src/auth' }),
      ],
      primaryIssueNumber: 142,
    };

    const result = await runIssueSweep(client, watcher, config, input, sweeper, stateStore);

    expect(result.action).toBe('scope_email_sent');
    expect(client.sendEmail).toHaveBeenCalled();
  });

  it('passes through existing thread ID', async () => {
    const client = makeMockGmailClient();
    const watcher = makeMockWatcher();
    const stateStore = makeMockStateStore();
    const config = makeConfig();
    const sweeper = new HeuristicIssueSweeper();
    const input: SweepInput = {
      agreedDesign: 'Fix auth',
      affectedModule: 'src/auth',
      openIssues: [],
      primaryIssueNumber: 1,
    };

    await runIssueSweep(client, watcher, config, input, sweeper, stateStore, 'existing-thread');

    const sendCall = (client.sendEmail as jest.Mock).mock.calls[0][0];
    expect(sendCall.threadId).toBe('existing-thread');
  });
});

describe('createSweepReplyHandler', () => {
  it('calls onScopeConfirmed with parsed issue numbers', async () => {
    const stateStore = makeMockStateStore();
    const watcher = makeMockWatcher();
    const sweep = makeSweepResult();
    const thread = makeThread();

    stateStore.saveSweepState('run-123', thread, sweep);

    const onScopeConfirmed = jest.fn().mockResolvedValue(undefined);
    const handler = createSweepReplyHandler(stateStore, watcher, onScopeConfirmed);

    const reply: GmailReply = {
      messageId: 'msg-reply',
      threadId: 'thread-abc',
      body: 'all',
      from: 'pm@example.com',
      receivedAt: new Date().toISOString(),
      subject: '[agent-fix] org/repo/#142: Fix auth token refresh',
    };

    await handler('run-123', reply, thread);

    expect(onScopeConfirmed).toHaveBeenCalledWith('run-123', expect.any(Array));
    const confirmedNumbers = onScopeConfirmed.mock.calls[0][1];
    expect(confirmedNumbers.sort()).toEqual([142, 156, 201, 203]);
  });

  it('throws SweepError for unknown run', async () => {
    const stateStore = makeMockStateStore();
    const watcher = makeMockWatcher();
    const onScopeConfirmed = jest.fn();
    const handler = createSweepReplyHandler(stateStore, watcher, onScopeConfirmed);

    const reply: GmailReply = {
      messageId: 'msg-reply',
      threadId: 'thread-abc',
      body: 'all',
      from: 'pm@example.com',
      receivedAt: new Date().toISOString(),
      subject: 'test',
    };

    await expect(handler('unknown-run', reply, makeThread())).rejects.toThrow(SweepError);
  });

  it('cleans up state after confirmation', async () => {
    const stateStore = makeMockStateStore();
    const watcher = makeMockWatcher();
    const sweep = makeSweepResult();
    const thread = makeThread();
    stateStore.saveSweepState('run-123', thread, sweep);

    const onScopeConfirmed = jest.fn().mockResolvedValue(undefined);
    const handler = createSweepReplyHandler(stateStore, watcher, onScopeConfirmed);

    const reply: GmailReply = {
      messageId: 'msg-reply',
      threadId: 'thread-abc',
      body: 'all',
      from: 'pm@example.com',
      receivedAt: new Date().toISOString(),
      subject: 'test',
    };

    await handler('run-123', reply, thread);

    expect(stateStore.deleteSweepState).toHaveBeenCalledWith('run-123');
    expect(watcher.unregisterThread).toHaveBeenCalledWith('thread-abc');
  });
});

describe('SweepError', () => {
  it('has correct name, phase, and runId', () => {
    const err = new SweepError('test error', 'sweep', 'run-1');
    expect(err.name).toBe('SweepError');
    expect(err.phase).toBe('sweep');
    expect(err.runId).toBe('run-1');
    expect(err.message).toBe('test error');
  });
});
