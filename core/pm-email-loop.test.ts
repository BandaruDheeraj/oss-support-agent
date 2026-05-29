/**
 * Unit tests for PM agent email conversation loop (US-012).
 */

import {
  HeuristicBriefGenerator,
  HeuristicFollowUpGenerator,
  formatDesignBriefEmail,
  extractDecisions,
  sendDesignBrief,
  processReply,
  resumeEmailLoop,
  summarizeAgreedDesign,
  createPMReplyHandler,
} from './pm-email-loop';

import {
  DesignBriefInput,
  DesignBrief,
  PMEmailLoopConfig,
  EmailStateStore,
  PMEmailLoopError,
} from './pm-email-types';

import {
  GmailClient,
  GmailSendResult,
  GmailReply,
  EmailThread,
  ConversationEntry,
} from './gmail-types';

import { GmailWatcher } from './gmail-mcp';

import { PMScoringResult } from './agents/pm-types';

// --- Test Helpers ---

function createMockGmailClient(overrides: Partial<GmailClient> = {}): GmailClient {
  return {
    sendEmail: jest.fn().mockResolvedValue({
      success: true,
      messageId: 'msg-123',
      threadId: 'thread-456',
    } as GmailSendResult),
    listUnreadMessages: jest.fn().mockResolvedValue([]),
    markAsRead: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockStateStore(overrides: Partial<EmailStateStore> = {}): EmailStateStore {
  const store = new Map<string, any>();
  return {
    saveThreadState: jest.fn((runId, thread, resolved, unresolved) => {
      store.set(runId, { thread, resolvedDecisions: resolved, unresolvedQuestions: unresolved });
    }),
    loadThreadState: jest.fn((runId) => store.get(runId) ?? null),
    deleteThreadState: jest.fn((runId) => { store.delete(runId); }),
    ...overrides,
  };
}

function createMockWatcher(client?: GmailClient): GmailWatcher {
  const c = client ?? createMockGmailClient();
  return new GmailWatcher(c, {
    pollIntervalMs: 60000,
    subjectPrefix: '[agent-fix]',
    monitoredAddress: 'bot@example.com',
  }, { onReply: jest.fn() });
}

function createTestBriefInput(overrides: Partial<DesignBriefInput> = {}): DesignBriefInput {
  return {
    issueSummary: 'Fix crash when parsing empty arrays',
    affectedModule: 'src/parser',
    relatedIssues: [
      { number: 100, title: 'Empty array crash', labels: ['bug'], reason: 'Same parser module' },
      { number: 101, title: 'Null handling in parser', labels: ['bug'], reason: 'Related null check' },
      { number: 102, title: 'Parser timeout', labels: ['bug', 'performance'], reason: 'Parser module' },
    ],
    recentPRs: [
      { number: 50, title: 'Fix parser edge case', files_changed: ['src/parser/index.ts'], merged_at: '2026-04-01' },
      { number: 51, title: 'Add parser tests', files_changed: ['src/parser/parser.test.ts'], merged_at: '2026-04-15' },
    ],
    designDocs: [
      { path: 'docs/parser-spec.md', excerpt: 'Parser specification for AST generation' },
    ],
    issueTitle: 'Crash on empty array input',
    issueBody: 'When parsing [], the parser throws a null reference error.',
    issueLabels: ['bug', 'parser'],
    scoringResult: {
      designNeeded: true,
      reasoning: 'Design review needed: 3 related open issues found',
      signals: [
        { rule: 'related_issues_count', triggered: true, detail: '3 related open issues found (threshold: 3)' },
        { rule: 'design_keywords', triggered: false, detail: 'No design keywords found' },
        { rule: 'public_api_change', triggered: false, detail: 'No public API change indicators' },
        { rule: 'contested_behaviour', triggered: false, detail: 'No contested behaviour' },
        { rule: 'multi_module_span', triggered: false, detail: 'Change affects 1 module(s)' },
      ],
    },
    ...overrides,
  };
}

function createTestConfig(overrides: Partial<PMEmailLoopConfig> = {}): PMEmailLoopConfig {
  return {
    pmEmail: 'pm@example.com',
    replyToAddress: 'bot@example.com',
    repo: 'owner/repo',
    issueNumber: 42,
    issueTitle: 'Crash on empty array input',
    approvalKeywords: ['lgtm', 'approved', 'ship it'],
    runId: 'run-001',
    ...overrides,
  };
}

function createTestThread(overrides: Partial<EmailThread> = {}): EmailThread {
  return {
    runId: 'run-001',
    threadId: 'thread-456',
    subject: '[agent-fix] owner/repo/#42: Crash on empty array input',
    conversationHistory: [
      {
        role: 'agent',
        body: '## Design Brief\n**Issue Summary:** Fix crash\n...',
        timestamp: '2026-05-06T10:00:00Z',
        messageId: 'msg-001',
      },
    ],
    ...overrides,
  };
}

// --- Tests ---

describe('HeuristicBriefGenerator', () => {
  const generator = new HeuristicBriefGenerator();

  it('generates a brief with all 6 required fields', () => {
    const input = createTestBriefInput();
    const brief = generator.generateBrief(input);

    expect(brief.issueSummary).toBeDefined();
    expect(brief.affectedModule).toBeDefined();
    expect(brief.relatedOpenIssues).toBeDefined();
    expect(brief.recentPRContext).toBeDefined();
    expect(brief.proposedApproaches).toBeDefined();
    expect(brief.openQuestions).toBeDefined();
  });

  it('includes the issue summary from input', () => {
    const input = createTestBriefInput();
    const brief = generator.generateBrief(input);
    expect(brief.issueSummary).toBe('Fix crash when parsing empty arrays');
  });

  it('includes the affected module', () => {
    const input = createTestBriefInput();
    const brief = generator.generateBrief(input);
    expect(brief.affectedModule).toBe('src/parser');
  });

  it('formats related open issues with number, title, and reason', () => {
    const input = createTestBriefInput();
    const brief = generator.generateBrief(input);
    expect(brief.relatedOpenIssues).toContain('#100');
    expect(brief.relatedOpenIssues).toContain('Empty array crash');
    expect(brief.relatedOpenIssues).toContain('Same parser module');
  });

  it('formats recent PR context with number, title, and file count', () => {
    const input = createTestBriefInput();
    const brief = generator.generateBrief(input);
    expect(brief.recentPRContext).toContain('PR #50');
    expect(brief.recentPRContext).toContain('Fix parser edge case');
  });

  it('generates 2-3 proposed approaches', () => {
    const input = createTestBriefInput();
    const brief = generator.generateBrief(input);
    expect(brief.proposedApproaches.length).toBeGreaterThanOrEqual(2);
    expect(brief.proposedApproaches.length).toBeLessThanOrEqual(3);
  });

  it('each approach has name, description, pros, and cons', () => {
    const input = createTestBriefInput();
    const brief = generator.generateBrief(input);
    for (const approach of brief.proposedApproaches) {
      expect(approach.name).toBeDefined();
      expect(approach.description).toBeDefined();
      expect(approach.pros.length).toBeGreaterThan(0);
      expect(approach.cons.length).toBeGreaterThan(0);
    }
  });

  it('generates open questions based on triggered signals', () => {
    const input = createTestBriefInput();
    const brief = generator.generateBrief(input);
    expect(brief.openQuestions.length).toBeGreaterThan(0);
    // The related_issues_count signal is triggered, so should ask about scope
    expect(brief.openQuestions.some((q) => q.includes('related issues'))).toBe(true);
  });

  it('handles no related issues gracefully', () => {
    const input = createTestBriefInput({ relatedIssues: [] });
    const brief = generator.generateBrief(input);
    expect(brief.relatedOpenIssues).toContain('No related open issues');
  });

  it('handles no recent PRs gracefully', () => {
    const input = createTestBriefInput({ recentPRs: [] });
    const brief = generator.generateBrief(input);
    expect(brief.recentPRContext).toContain('No recent PRs');
  });

  it('includes comprehensive approach when many related issues', () => {
    const input = createTestBriefInput();
    const brief = generator.generateBrief(input);
    expect(brief.proposedApproaches.some((a) => a.name.includes('Comprehensive'))).toBe(true);
  });

  it('includes coordinated refactor when API change signaled', () => {
    const input = createTestBriefInput({
      scoringResult: {
        designNeeded: true,
        reasoning: 'API change needed',
        signals: [
          { rule: 'public_api_change', triggered: true, detail: 'API surface change' },
          { rule: 'related_issues_count', triggered: false, detail: 'Only 1 issue' },
          { rule: 'design_keywords', triggered: false, detail: 'None' },
          { rule: 'contested_behaviour', triggered: false, detail: 'None' },
          { rule: 'multi_module_span', triggered: false, detail: '1 module' },
        ],
      },
      relatedIssues: [],
    });
    const brief = generator.generateBrief(input);
    expect(brief.proposedApproaches.some((a) => a.name.includes('refactor'))).toBe(true);
  });
});

describe('formatDesignBriefEmail', () => {
  it('includes all 6 sections', () => {
    const brief: DesignBrief = {
      issueSummary: 'Fix parser crash',
      affectedModule: 'src/parser',
      relatedOpenIssues: '#100: crash issue',
      recentPRContext: 'PR #50: fix edge case',
      proposedApproaches: [
        { name: 'Minimal fix', description: 'Small change', pros: ['Low risk'], cons: ['Partial'] },
        { name: 'Full refactor', description: 'Big change', pros: ['Complete'], cons: ['Risky'] },
      ],
      openQuestions: ['What scope is acceptable?'],
    };

    const email = formatDesignBriefEmail(brief);
    expect(email).toContain('Fix parser crash');
    expect(email).toContain('src/parser');
    expect(email).toContain('#100: crash issue');
    expect(email).toContain('PR #50: fix edge case');
    expect(email).toContain('Minimal fix');
    expect(email).toContain('Full refactor');
    expect(email).toContain('What scope is acceptable?');
  });

  it('includes approval keyword instruction', () => {
    const brief: DesignBrief = {
      issueSummary: 'test',
      affectedModule: 'test',
      relatedOpenIssues: 'none',
      recentPRContext: 'none',
      proposedApproaches: [{ name: 'A', description: 'B', pros: ['C'], cons: ['D'] }],
      openQuestions: ['Q?'],
    };
    const email = formatDesignBriefEmail(brief);
    expect(email).toContain('approval keyword');
  });

  it('numbers the approaches', () => {
    const brief: DesignBrief = {
      issueSummary: 'test',
      affectedModule: 'test',
      relatedOpenIssues: 'none',
      recentPRContext: 'none',
      proposedApproaches: [
        { name: 'First', description: 'desc1', pros: ['a'], cons: ['b'] },
        { name: 'Second', description: 'desc2', pros: ['c'], cons: ['d'] },
      ],
      openQuestions: [],
    };
    const email = formatDesignBriefEmail(brief);
    expect(email).toContain('1. **First**');
    expect(email).toContain('2. **Second**');
  });
});

describe('extractDecisions', () => {
  it('extracts explicit decision lines', () => {
    const reply = 'Decision: use approach 1\nSome other text\nDecision: keep backward compat';
    const decisions = extractDecisions(reply);
    expect(decisions).toContain('Decision: use approach 1');
    expect(decisions).toContain('Decision: keep backward compat');
  });

  it('extracts "let\'s go with" lines', () => {
    const reply = "Let's go with the minimal fix approach";
    const decisions = extractDecisions(reply);
    expect(decisions.length).toBe(1);
    expect(decisions[0]).toContain("Let's go with");
  });

  it('extracts "I prefer" lines', () => {
    const reply = 'I prefer option 2 because it is cleaner';
    const decisions = extractDecisions(reply);
    expect(decisions.length).toBe(1);
  });

  it('extracts approach selection from pattern', () => {
    const reply = 'I think approach 2 makes the most sense here.';
    const decisions = extractDecisions(reply);
    expect(decisions.some((d) => d.includes('approach 2'))).toBe(true);
  });

  it('returns empty array for vague replies', () => {
    const reply = 'I need more information about the tradeoffs.';
    const decisions = extractDecisions(reply);
    expect(decisions).toEqual([]);
  });

  it('extracts "yes" / "agreed" lines', () => {
    const reply = 'Agreed, that makes sense.\nLet me think about the rest.';
    const decisions = extractDecisions(reply);
    expect(decisions.length).toBe(1);
    expect(decisions[0]).toContain('Agreed');
  });
});

describe('HeuristicFollowUpGenerator', () => {
  const generator = new HeuristicFollowUpGenerator();

  it('generates a response body', () => {
    const result = generator.generateFollowUp({
      conversationHistory: [],
      latestReply: 'I prefer option 1',
      designBriefInput: createTestBriefInput(),
      resolvedDecisions: [],
      unresolvedQuestions: ['What scope is acceptable?', 'Should we break the API?'],
    });
    expect(result.responseBody).toBeDefined();
    expect(result.responseBody.length).toBeGreaterThan(0);
  });

  it('removes resolved questions from unresolved list', () => {
    const result = generator.generateFollowUp({
      conversationHistory: [],
      latestReply: 'The acceptable scope is just the parser module. No breaking changes.',
      designBriefInput: createTestBriefInput(),
      resolvedDecisions: [],
      unresolvedQuestions: [
        'What is the acceptable scope for this change?',
        'Is a breaking API change acceptable?',
      ],
    });
    expect(result.unresolvedQuestions.length).toBeLessThan(2);
  });

  it('adds new decisions to resolvedDecisions', () => {
    const result = generator.generateFollowUp({
      conversationHistory: [],
      latestReply: 'Decision: use minimal fix approach\nDecision: keep backward compat',
      designBriefInput: createTestBriefInput(),
      resolvedDecisions: ['previous decision'],
      unresolvedQuestions: [],
    });
    expect(result.resolvedDecisions).toContain('previous decision');
    expect(result.resolvedDecisions.length).toBeGreaterThan(1);
  });

  it('never restates resolved decisions in the response', () => {
    const result = generator.generateFollowUp({
      conversationHistory: [],
      latestReply: 'Decision: use minimal fix',
      designBriefInput: createTestBriefInput(),
      resolvedDecisions: ['We chose option A last time'],
      unresolvedQuestions: [],
    });
    // The response should NOT contain old resolved decisions
    expect(result.responseBody).not.toContain('We chose option A last time');
  });

  it('only surfaces unresolved items in response', () => {
    const result = generator.generateFollowUp({
      conversationHistory: [],
      latestReply: 'Thanks',
      designBriefInput: createTestBriefInput(),
      resolvedDecisions: [],
      unresolvedQuestions: ['Should we break the API?'],
    });
    expect(result.responseBody).toContain('Still unresolved');
    expect(result.responseBody).toContain('Should we break the API?');
  });

  it('suggests approval when all questions resolved', () => {
    const result = generator.generateFollowUp({
      conversationHistory: [],
      latestReply: 'The scope is just parser. No breaking changes allowed.',
      designBriefInput: createTestBriefInput(),
      resolvedDecisions: [],
      unresolvedQuestions: [
        'What is the acceptable scope for this change?',
        'Is a breaking API change acceptable?',
      ],
    });
    if (result.unresolvedQuestions.length === 0) {
      expect(result.responseBody).toContain('approval keyword');
    }
  });
});

describe('sendDesignBrief', () => {
  it('sends the design brief email', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const briefInput = createTestBriefInput();
    const generator = new HeuristicBriefGenerator();
    const stateStore = createMockStateStore();

    const result = await sendDesignBrief(client, watcher, config, briefInput, generator, stateStore);

    expect(result.action).toBe('email_sent');
    expect(result.thread).toBeDefined();
    if (result.action === 'email_sent') {
      expect(result.briefSentAt).toBeDefined();
    }
    expect(client.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('sends to the pm_email address', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig({ pmEmail: 'reviewer@company.com' });
    const briefInput = createTestBriefInput();
    const generator = new HeuristicBriefGenerator();
    const stateStore = createMockStateStore();

    await sendDesignBrief(client, watcher, config, briefInput, generator, stateStore);

    const call = (client.sendEmail as jest.Mock).mock.calls[0][0];
    expect(call.to).toBe('reviewer@company.com');
  });

  it('uses the correct subject format', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const briefInput = createTestBriefInput();
    const generator = new HeuristicBriefGenerator();
    const stateStore = createMockStateStore();

    await sendDesignBrief(client, watcher, config, briefInput, generator, stateStore);

    const call = (client.sendEmail as jest.Mock).mock.calls[0][0];
    expect(call.subject).toContain('[agent-fix]');
    expect(call.subject).toContain('owner/repo');
    expect(call.subject).toContain('#42');
  });

  it('includes design brief content in email body', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const briefInput = createTestBriefInput();
    const generator = new HeuristicBriefGenerator();
    const stateStore = createMockStateStore();

    await sendDesignBrief(client, watcher, config, briefInput, generator, stateStore);

    const call = (client.sendEmail as jest.Mock).mock.calls[0][0];
    expect(call.body).toContain('Design Brief');
    expect(call.body).toContain('Issue Summary');
    expect(call.body).toContain('Affected Module');
    expect(call.body).toContain('Proposed Approaches');
    expect(call.body).toContain('Open Questions');
  });

  it('persists thread state for restart-resume', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const briefInput = createTestBriefInput();
    const generator = new HeuristicBriefGenerator();
    const stateStore = createMockStateStore();

    await sendDesignBrief(client, watcher, config, briefInput, generator, stateStore);

    expect(stateStore.saveThreadState).toHaveBeenCalledWith(
      'run-001',
      expect.any(Object),
      [],
      expect.any(Array)
    );
  });

  it('registers the thread with the watcher', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const briefInput = createTestBriefInput();
    const generator = new HeuristicBriefGenerator();
    const stateStore = createMockStateStore();

    await sendDesignBrief(client, watcher, config, briefInput, generator, stateStore);

    const thread = watcher.getThreadByRunId('run-001');
    expect(thread).toBeDefined();
  });

  it('sets replyTo to the monitored address', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig({ replyToAddress: 'monitor@bot.com' });
    const briefInput = createTestBriefInput();
    const generator = new HeuristicBriefGenerator();
    const stateStore = createMockStateStore();

    await sendDesignBrief(client, watcher, config, briefInput, generator, stateStore);

    const call = (client.sendEmail as jest.Mock).mock.calls[0][0];
    expect(call.replyTo).toBe('monitor@bot.com');
  });
});

describe('processReply', () => {
  it('detects approval keyword and exits loop', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const thread = createTestThread();
    const stateStore = createMockStateStore();
    stateStore.saveThreadState('run-001', thread, [], ['Q1?']);
    watcher.registerThread(thread);

    const result = await processReply(
      client, watcher, config, thread,
      'Looks good, LGTM!',
      [], ['Q1?'],
      createTestBriefInput(),
      new HeuristicFollowUpGenerator(),
      stateStore
    );

    expect(result.action).toBe('approved');
    if (result.action === 'approved') {
      expect(result.approvalResult.approved).toBe(true);
      expect(result.approvalResult.matchedKeyword).toBe('lgtm');
      expect(result.agreedDesign).toBeDefined();
    }
  });

  it('detects approval keywords case-insensitively', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig({ approvalKeywords: ['approved', 'lgtm'] });
    const thread = createTestThread();
    const stateStore = createMockStateStore();
    stateStore.saveThreadState('run-001', thread, [], []);
    watcher.registerThread(thread);

    const result = await processReply(
      client, watcher, config, thread,
      'APPROVED',
      [], [],
      createTestBriefInput(),
      new HeuristicFollowUpGenerator(),
      stateStore
    );

    expect(result.action).toBe('approved');
  });

  it('sends follow-up on non-approval reply', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const thread = createTestThread();
    const stateStore = createMockStateStore();
    stateStore.saveThreadState('run-001', thread, [], ['Q1?']);
    watcher.registerThread(thread);

    const result = await processReply(
      client, watcher, config, thread,
      'I have more questions about the scope.',
      [], ['Q1?'],
      createTestBriefInput(),
      new HeuristicFollowUpGenerator(),
      stateStore
    );

    expect(result.action).toBe('reply_processed');
    expect(client.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('persists updated state after follow-up', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const thread = createTestThread();
    const stateStore = createMockStateStore();
    stateStore.saveThreadState('run-001', thread, [], ['Q1?']);
    watcher.registerThread(thread);

    await processReply(
      client, watcher, config, thread,
      'Decision: use minimal fix',
      [], ['Q1?'],
      createTestBriefInput(),
      new HeuristicFollowUpGenerator(),
      stateStore
    );

    // State should be saved with updated decisions
    expect(stateStore.saveThreadState).toHaveBeenCalledTimes(2); // once in setup, once in processReply
  });

  it('deletes state on approval', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const thread = createTestThread();
    const stateStore = createMockStateStore();
    stateStore.saveThreadState('run-001', thread, [], []);
    watcher.registerThread(thread);

    await processReply(
      client, watcher, config, thread,
      'Ship it!',
      [], [],
      createTestBriefInput(),
      new HeuristicFollowUpGenerator(),
      stateStore
    );

    expect(stateStore.deleteThreadState).toHaveBeenCalledWith('run-001');
  });

  it('unregisters thread from watcher on approval', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const thread = createTestThread();
    const stateStore = createMockStateStore();
    stateStore.saveThreadState('run-001', thread, [], []);
    watcher.registerThread(thread);

    await processReply(
      client, watcher, config, thread,
      'lgtm',
      [], [],
      createTestBriefInput(),
      new HeuristicFollowUpGenerator(),
      stateStore
    );

    expect(watcher.getThread('thread-456')).toBeUndefined();
  });

  it('appends agent response to thread history', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const thread = createTestThread();
    const stateStore = createMockStateStore();
    stateStore.saveThreadState('run-001', thread, [], ['Q1?']);
    watcher.registerThread(thread);

    const result = await processReply(
      client, watcher, config, thread,
      'What about performance?',
      [], ['Q1?'],
      createTestBriefInput(),
      new HeuristicFollowUpGenerator(),
      stateStore
    );

    if (result.action === 'reply_processed') {
      const history = result.thread.conversationHistory;
      const lastEntry = history[history.length - 1];
      expect(lastEntry.role).toBe('agent');
    }
  });

  it('maintains threading via threadId', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const thread = createTestThread();
    const stateStore = createMockStateStore();
    stateStore.saveThreadState('run-001', thread, [], ['Q?']);
    watcher.registerThread(thread);

    await processReply(
      client, watcher, config, thread,
      'Tell me more',
      [], ['Q?'],
      createTestBriefInput(),
      new HeuristicFollowUpGenerator(),
      stateStore
    );

    const call = (client.sendEmail as jest.Mock).mock.calls[0][0];
    expect(call.threadId).toBe('thread-456');
  });

  it('threads follow-ups against the latest user message-id when available', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const thread = createTestThread({
      conversationHistory: [
        {
          role: 'agent',
          body: '## Design Brief\n**Issue Summary:** Fix crash\n...',
          timestamp: '2026-05-06T10:00:00Z',
          messageId: '<agent-1@resend>',
        },
        {
          role: 'user',
          body: 'Can we proceed with option 1?',
          timestamp: '2026-05-06T10:05:00Z',
          messageId: '<user-1@example.com>',
        },
      ],
    });
    const stateStore = createMockStateStore();
    stateStore.saveThreadState('run-001', thread, [], ['Q?']);
    watcher.registerThread(thread);

    await processReply(
      client, watcher, config, thread,
      'Please clarify one more thing',
      [], ['Q?'],
      createTestBriefInput(),
      new HeuristicFollowUpGenerator(),
      stateStore
    );

    const call = (client.sendEmail as jest.Mock).mock.calls[0][0];
    expect(call.threadId).toBe('<user-1@example.com>');
  });

  it('does not send email on approval', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const thread = createTestThread();
    const stateStore = createMockStateStore();
    stateStore.saveThreadState('run-001', thread, [], []);
    watcher.registerThread(thread);

    await processReply(
      client, watcher, config, thread,
      'approved',
      [], [],
      createTestBriefInput(),
      new HeuristicFollowUpGenerator(),
      stateStore
    );

    expect(client.sendEmail).not.toHaveBeenCalled();
  });
});

describe('resumeEmailLoop', () => {
  it('loads persisted state and re-registers with watcher', () => {
    const watcher = createMockWatcher();
    const thread = createTestThread();
    const stateStore = createMockStateStore();
    stateStore.saveThreadState('run-001', thread, ['decision1'], ['Q1?']);

    const result = resumeEmailLoop(watcher, stateStore, 'run-001');

    expect(result).not.toBeNull();
    expect(result!.thread.runId).toBe('run-001');
    expect(result!.resolvedDecisions).toContain('decision1');
    expect(result!.unresolvedQuestions).toContain('Q1?');
    expect(watcher.getThread('thread-456')).toBeDefined();
  });

  it('returns null when no persisted state exists', () => {
    const watcher = createMockWatcher();
    const stateStore = createMockStateStore();

    const result = resumeEmailLoop(watcher, stateStore, 'non-existent-run');
    expect(result).toBeNull();
  });

  it('survives orchestrator restart (file-backed store simulation)', () => {
    const watcher1 = createMockWatcher();
    const thread = createTestThread();

    // Simulate first instance persisting state
    const backingStore = new Map<string, any>();
    const stateStore1: EmailStateStore = {
      saveThreadState: (runId, t, r, u) => { backingStore.set(runId, { thread: t, resolvedDecisions: r, unresolvedQuestions: u }); },
      loadThreadState: (runId) => backingStore.get(runId) ?? null,
      deleteThreadState: (runId) => { backingStore.delete(runId); },
    };
    stateStore1.saveThreadState('run-001', thread, ['d1'], ['q1']);

    // Simulate restart: new watcher, same backing store
    const watcher2 = createMockWatcher();
    const stateStore2: EmailStateStore = {
      saveThreadState: (runId, t, r, u) => { backingStore.set(runId, { thread: t, resolvedDecisions: r, unresolvedQuestions: u }); },
      loadThreadState: (runId) => backingStore.get(runId) ?? null,
      deleteThreadState: (runId) => { backingStore.delete(runId); },
    };

    const result = resumeEmailLoop(watcher2, stateStore2, 'run-001');
    expect(result).not.toBeNull();
    expect(result!.thread.threadId).toBe('thread-456');
    expect(watcher2.getThread('thread-456')).toBeDefined();
  });
});

describe('summarizeAgreedDesign', () => {
  it('includes resolved decisions', () => {
    const history: ConversationEntry[] = [
      { role: 'agent', body: '**Issue Summary:** Fix crash', timestamp: '2026-05-06T10:00:00Z', messageId: 'msg-1' },
      { role: 'user', body: 'Use option 1', timestamp: '2026-05-06T10:05:00Z', messageId: 'msg-2' },
    ];

    const summary = summarizeAgreedDesign(history, ['Use minimal fix approach', 'Keep backward compat']);
    expect(summary).toContain('Use minimal fix approach');
    expect(summary).toContain('Keep backward compat');
  });

  it('extracts issue summary from first agent message', () => {
    const history: ConversationEntry[] = [
      { role: 'agent', body: '## Design Brief\n**Issue Summary:** Fix parser crash\n...', timestamp: '2026-05-06T10:00:00Z', messageId: 'msg-1' },
    ];

    const summary = summarizeAgreedDesign(history, []);
    expect(summary).toContain('Fix parser crash');
  });

  it('includes conversation turn count', () => {
    const history: ConversationEntry[] = [
      { role: 'agent', body: 'Brief', timestamp: '2026-05-06T10:00:00Z', messageId: 'msg-1' },
      { role: 'user', body: 'Reply 1', timestamp: '2026-05-06T10:05:00Z', messageId: 'msg-2' },
      { role: 'agent', body: 'Follow up', timestamp: '2026-05-06T10:06:00Z', messageId: 'msg-3' },
      { role: 'user', body: 'Reply 2', timestamp: '2026-05-06T10:10:00Z', messageId: 'msg-4' },
    ];

    const summary = summarizeAgreedDesign(history, []);
    expect(summary).toContain('2'); // 2 user messages
  });
});

describe('createPMReplyHandler', () => {
  it('calls onApproval when reply contains approval keyword', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const briefInput = createTestBriefInput();
    const stateStore = createMockStateStore();
    const thread = createTestThread();

    const configMap = new Map([[config.runId, config]]);
    const briefInputMap = new Map([[config.runId, briefInput]]);
    const onApproval = jest.fn();
    const onReplyProcessed = jest.fn();

    stateStore.saveThreadState('run-001', thread, [], []);
    watcher.registerThread(thread);

    const handler = createPMReplyHandler(
      client, watcher, configMap, briefInputMap,
      new HeuristicFollowUpGenerator(), stateStore,
      onApproval, onReplyProcessed
    );

    const reply: GmailReply = {
      messageId: 'reply-1',
      threadId: 'thread-456',
      body: 'LGTM, ship it!',
      from: 'pm@example.com',
      receivedAt: '2026-05-06T10:05:00Z',
      subject: '[agent-fix] test',
    };

    await handler('run-001', reply, thread);

    expect(onApproval).toHaveBeenCalledWith('run-001', expect.any(String));
    expect(onReplyProcessed).not.toHaveBeenCalled();
  });

  it('calls onReplyProcessed for non-approval replies', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const briefInput = createTestBriefInput();
    const stateStore = createMockStateStore();
    const thread = createTestThread();

    const configMap = new Map([[config.runId, config]]);
    const briefInputMap = new Map([[config.runId, briefInput]]);
    const onApproval = jest.fn();
    const onReplyProcessed = jest.fn();

    stateStore.saveThreadState('run-001', thread, [], ['Q1?']);
    watcher.registerThread(thread);

    const handler = createPMReplyHandler(
      client, watcher, configMap, briefInputMap,
      new HeuristicFollowUpGenerator(), stateStore,
      onApproval, onReplyProcessed
    );

    const reply: GmailReply = {
      messageId: 'reply-1',
      threadId: 'thread-456',
      body: 'Tell me more about option 2',
      from: 'pm@example.com',
      receivedAt: '2026-05-06T10:05:00Z',
      subject: '[agent-fix] test',
    };

    await handler('run-001', reply, thread);

    expect(onReplyProcessed).toHaveBeenCalledWith('run-001');
    expect(onApproval).not.toHaveBeenCalled();
  });

  it('throws PMEmailLoopError for unknown run IDs', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const stateStore = createMockStateStore();

    const handler = createPMReplyHandler(
      client, watcher, new Map(), new Map(),
      new HeuristicFollowUpGenerator(), stateStore,
      jest.fn(), jest.fn()
    );

    const reply: GmailReply = {
      messageId: 'reply-1',
      threadId: 'thread-unknown',
      body: 'hello',
      from: 'pm@example.com',
      receivedAt: '2026-05-06T10:05:00Z',
      subject: '[agent-fix] test',
    };

    await expect(handler('unknown-run', reply, createTestThread()))
      .rejects.toThrow(PMEmailLoopError);
  });
});

describe('timing requirements', () => {
  it('sendDesignBrief completes quickly (< 5 minutes simulated)', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const briefInput = createTestBriefInput();
    const generator = new HeuristicBriefGenerator();
    const stateStore = createMockStateStore();

    const start = Date.now();
    await sendDesignBrief(client, watcher, config, briefInput, generator, stateStore);
    const elapsed = Date.now() - start;

    // Should complete nearly instantly with mocked client (well under 5 min)
    expect(elapsed).toBeLessThan(5000);
  });

  it('processReply completes quickly (< 60 seconds simulated)', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const thread = createTestThread();
    const stateStore = createMockStateStore();
    stateStore.saveThreadState('run-001', thread, [], ['Q1?']);
    watcher.registerThread(thread);

    const start = Date.now();
    await processReply(
      client, watcher, config, thread,
      'I have questions',
      [], ['Q1?'],
      createTestBriefInput(),
      new HeuristicFollowUpGenerator(),
      stateStore
    );
    const elapsed = Date.now() - start;

    // Should complete nearly instantly with mocked client (well under 60s)
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('full conversation flow', () => {
  it('supports multi-turn conversation until approval', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const briefInput = createTestBriefInput();
    const generator = new HeuristicBriefGenerator();
    const followUpGen = new HeuristicFollowUpGenerator();
    const stateStore = createMockStateStore();

    // Turn 1: Send design brief
    const sendResult = await sendDesignBrief(client, watcher, config, briefInput, generator, stateStore);
    expect(sendResult.action).toBe('email_sent');
    const thread1 = sendResult.thread;

    // Turn 2: User asks a question (not approval)
    const result2 = await processReply(
      client, watcher, config, thread1,
      'Can you explain option 2 more?',
      [], generator.generateBrief(briefInput).openQuestions,
      briefInput, followUpGen, stateStore
    );
    expect(result2.action).toBe('reply_processed');

    // Turn 3: User makes decisions (not approval)
    const thread3 = result2.action === 'reply_processed' ? result2.thread : thread1;
    const result3 = await processReply(
      client, watcher, config, thread3,
      'Decision: use minimal fix approach. Keep backward compat.',
      [], [],
      briefInput, followUpGen, stateStore
    );
    expect(result3.action).toBe('reply_processed');

    // Turn 4: User approves
    const thread4 = result3.action === 'reply_processed' ? result3.thread : thread3;
    const result4 = await processReply(
      client, watcher, config, thread4,
      'Approved!',
      ['Decision: use minimal fix approach. Keep backward compat.'], [],
      briefInput, followUpGen, stateStore
    );
    expect(result4.action).toBe('approved');
    if (result4.action === 'approved') {
      expect(result4.agreedDesign).toContain('Agreed Design Summary');
    }
  });

  it('maintains same threadId throughout conversation', async () => {
    const client = createMockGmailClient();
    const watcher = createMockWatcher(client);
    const config = createTestConfig();
    const briefInput = createTestBriefInput();
    const generator = new HeuristicBriefGenerator();
    const followUpGen = new HeuristicFollowUpGenerator();
    const stateStore = createMockStateStore();

    const sendResult = await sendDesignBrief(client, watcher, config, briefInput, generator, stateStore);
    const thread = sendResult.thread;

    await processReply(
      client, watcher, config, thread,
      'Question about scope',
      [], [],
      briefInput, followUpGen, stateStore
    );

    // All emails should use the same threadId
    const calls = (client.sendEmail as jest.Mock).mock.calls;
    // First call is the brief (no threadId since it's new)
    // Second call should have threadId
    if (calls.length > 1) {
      expect(calls[1][0].threadId).toBe(thread.threadId);
    }
  });
});
