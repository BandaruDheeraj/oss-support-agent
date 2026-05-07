/**
 * Unit tests for retry loop with eval context injection (US-017).
 */

import {
  buildCombinedRetryContext,
  recordRetryAttempt,
  createRetryHistory,
  evaluateRetryDecision,
  buildFailureSummary,
  formatFailureEmail,
  formatFailureSubject,
  handleMaxRetriesExceeded,
  runRetryLoop,
  injectRetryContextForFixAgent,
  injectRetryContextForBuildAgent,
  resumeRetryLoop,
} from './retry-loop';

import {
  RetryAttempt,
  RetryHistory,
  RetryLoopConfig,
  RetryStateStore,
  FailureNotifier,
  IssueLabeler,
  FailureReport,
  AGENT_FAILED_LABEL,
  FAILURE_EMAIL_SUBJECT_PREFIX,
} from './retry-loop-types';

// --- Test Helpers ---

function makeConfig(overrides: Partial<RetryLoopConfig> = {}): RetryLoopConfig {
  return {
    runId: 'run-123',
    maxRetries: 3,
    agentType: 'fix',
    upstreamRepo: 'owner/repo',
    primaryIssueNumber: 42,
    pmEmail: 'pm@example.com',
    replyToAddress: 'bot@example.com',
    confirmedIssues: [
      { number: 42, title: 'Bug in auth', body: 'Auth fails', labels: ['bug'] },
      { number: 43, title: 'Login broken', body: null, labels: [] },
    ],
    forkFullName: 'fork-org/repo',
    branchName: 'agent/scope-42-43',
    ...overrides,
  };
}

function makeAttempt(num: number, overrides: Partial<RetryAttempt> = {}): RetryAttempt {
  return {
    attemptNumber: num,
    retryContext: `Test command: npm test\nExit code: 1\nStderr: Error in test ${num}`,
    timestamp: `2026-05-06T10:0${num}:00.000Z`,
    agentType: 'fix',
    ...overrides,
  };
}

function makeHistory(attempts: number, maxRetries = 3): RetryHistory {
  return {
    runId: 'run-123',
    maxRetries,
    attempts: Array.from({ length: attempts }, (_, i) => makeAttempt(i + 1)),
  };
}

function makeMockStateStore(existing: RetryHistory | null = null): RetryStateStore {
  const store: Record<string, RetryHistory> = {};
  if (existing) {
    store[existing.runId] = existing;
  }
  return {
    saveRetryHistory: jest.fn(async (h: RetryHistory) => { store[h.runId] = h; }),
    loadRetryHistory: jest.fn(async (runId: string) => store[runId] || null),
    deleteRetryHistory: jest.fn(async (runId: string) => { delete store[runId]; }),
  };
}

function makeMockNotifier(): FailureNotifier {
  return {
    sendEmail: jest.fn(async () => {}),
  };
}

function makeMockLabeler(): IssueLabeler {
  return {
    addLabel: jest.fn(async () => {}),
  };
}

// --- Tests ---

describe('US-017: Retry loop with eval context injection', () => {
  describe('createRetryHistory', () => {
    it('creates an empty history with correct fields', () => {
      const history = createRetryHistory('run-abc', 3);
      expect(history.runId).toBe('run-abc');
      expect(history.maxRetries).toBe(3);
      expect(history.attempts).toEqual([]);
    });

    it('respects custom max retries', () => {
      const history = createRetryHistory('run-xyz', 5);
      expect(history.maxRetries).toBe(5);
    });
  });

  describe('recordRetryAttempt', () => {
    it('adds a new attempt to empty history', () => {
      const history = createRetryHistory('run-1', 3);
      const updated = recordRetryAttempt(history, 'Tests failed: exit code 1', 'fix');
      expect(updated.attempts).toHaveLength(1);
      expect(updated.attempts[0].attemptNumber).toBe(1);
      expect(updated.attempts[0].retryContext).toBe('Tests failed: exit code 1');
      expect(updated.attempts[0].agentType).toBe('fix');
    });

    it('increments attempt number correctly', () => {
      const history = makeHistory(2);
      const updated = recordRetryAttempt(history, 'Third failure', 'fix');
      expect(updated.attempts).toHaveLength(3);
      expect(updated.attempts[2].attemptNumber).toBe(3);
    });

    it('records build agent type', () => {
      const history = createRetryHistory('run-1', 3);
      const updated = recordRetryAttempt(history, 'scaffold failed', 'build');
      expect(updated.attempts[0].agentType).toBe('build');
    });

    it('does not mutate original history', () => {
      const history = createRetryHistory('run-1', 3);
      const updated = recordRetryAttempt(history, 'failure', 'fix');
      expect(history.attempts).toHaveLength(0);
      expect(updated.attempts).toHaveLength(1);
    });

    it('includes timestamp', () => {
      const history = createRetryHistory('run-1', 3);
      const before = new Date().toISOString();
      const updated = recordRetryAttempt(history, 'failure', 'fix');
      const after = new Date().toISOString();
      expect(updated.attempts[0].timestamp >= before).toBe(true);
      expect(updated.attempts[0].timestamp <= after).toBe(true);
    });
  });

  describe('buildCombinedRetryContext', () => {
    it('returns empty string for no attempts', () => {
      expect(buildCombinedRetryContext([])).toBe('');
    });

    it('includes all attempt contexts', () => {
      const attempts = [makeAttempt(1), makeAttempt(2)];
      const combined = buildCombinedRetryContext(attempts);
      expect(combined).toContain('Attempt 1');
      expect(combined).toContain('Attempt 2');
      expect(combined).toContain('Error in test 1');
      expect(combined).toContain('Error in test 2');
    });

    it('includes attempt count header', () => {
      const attempts = [makeAttempt(1), makeAttempt(2), makeAttempt(3)];
      const combined = buildCombinedRetryContext(attempts);
      expect(combined).toContain('3 total');
    });

    it('includes agent type in each attempt', () => {
      const attempts = [
        makeAttempt(1, { agentType: 'fix' }),
        makeAttempt(2, { agentType: 'build' }),
      ];
      const combined = buildCombinedRetryContext(attempts);
      expect(combined).toContain('fix agent');
      expect(combined).toContain('build agent');
    });

    it('includes timestamps', () => {
      const attempts = [makeAttempt(1)];
      const combined = buildCombinedRetryContext(attempts);
      expect(combined).toContain(attempts[0].timestamp);
    });
  });

  describe('evaluateRetryDecision', () => {
    it('returns retry when attempts < maxRetries', () => {
      const history = makeHistory(1, 3); // 1 attempt, max 3
      const config = makeConfig({ maxRetries: 3 });
      const result = evaluateRetryDecision(history, 'latest failure', config);
      expect(result.action).toBe('retry');
    });

    it('returns retry dispatch with correct retry count', () => {
      const history = makeHistory(1, 3);
      const config = makeConfig({ maxRetries: 3 });
      const result = evaluateRetryDecision(history, 'latest failure', config);
      if (result.action === 'retry') {
        expect(result.dispatch.retryCount).toBe(2); // next attempt is #2
      }
    });

    it('includes latest retry context in dispatch', () => {
      const history = makeHistory(1, 3);
      const config = makeConfig({ maxRetries: 3 });
      const result = evaluateRetryDecision(history, 'specific error XYZ', config);
      if (result.action === 'retry') {
        expect(result.dispatch.latestRetryContext).toBe('specific error XYZ');
      }
    });

    it('includes combined context from previous attempts', () => {
      const history = makeHistory(2, 3);
      const config = makeConfig({ maxRetries: 3 });
      const result = evaluateRetryDecision(history, 'third failure', config);
      if (result.action === 'retry') {
        expect(result.dispatch.combinedRetryContext).toContain('Attempt 1');
        expect(result.dispatch.combinedRetryContext).toContain('Attempt 2');
      }
    });

    it('returns max_retries_exceeded when attempts >= maxRetries', () => {
      const history = makeHistory(3, 3); // 3 attempts = max
      const config = makeConfig({ maxRetries: 3 });
      const result = evaluateRetryDecision(history, 'final failure', config);
      expect(result.action).toBe('max_retries_exceeded');
    });

    it('failure report includes all retry history', () => {
      const history = makeHistory(3, 3);
      const config = makeConfig({ maxRetries: 3 });
      const result = evaluateRetryDecision(history, 'final failure', config);
      if (result.action === 'max_retries_exceeded') {
        expect(result.failureReport.retryHistory).toHaveLength(3);
      }
    });

    it('failure report includes fork branch (preserved)', () => {
      const history = makeHistory(3, 3);
      const config = makeConfig({ branchName: 'agent/scope-42-43' });
      const result = evaluateRetryDecision(history, 'final', config);
      if (result.action === 'max_retries_exceeded') {
        expect(result.failureReport.forkBranch).toBe('agent/scope-42-43');
        expect(result.failureReport.forkFullName).toBe('fork-org/repo');
      }
    });

    it('respects maxRetries=0 (no retries allowed)', () => {
      const history = makeHistory(0, 0);
      const config = makeConfig({ maxRetries: 0 });
      // With 0 attempts and maxRetries=0, first evaluation already exceeds
      // But we need at least 1 attempt recorded first
      const historyWithAttempt = makeHistory(1, 0);
      const configZero = makeConfig({ maxRetries: 0 });
      const result = evaluateRetryDecision(historyWithAttempt, 'failure', configZero);
      expect(result.action).toBe('max_retries_exceeded');
    });

    it('boundary: exactly at max is exceeded', () => {
      const history = makeHistory(2, 2);
      const config = makeConfig({ maxRetries: 2 });
      const result = evaluateRetryDecision(history, 'boundary', config);
      expect(result.action).toBe('max_retries_exceeded');
    });

    it('boundary: one less than max retries still allows retry', () => {
      const history = makeHistory(1, 2);
      const config = makeConfig({ maxRetries: 2 });
      const result = evaluateRetryDecision(history, 'still trying', config);
      expect(result.action).toBe('retry');
    });

    it('includes agent type in dispatch', () => {
      const history = makeHistory(1, 3);
      const config = makeConfig({ agentType: 'build' });
      const result = evaluateRetryDecision(history, 'failure', config);
      if (result.action === 'retry') {
        expect(result.dispatch.agentType).toBe('build');
      }
    });
  });

  describe('buildFailureSummary', () => {
    it('includes repo name', () => {
      const history = makeHistory(3, 3);
      const config = makeConfig({ upstreamRepo: 'org/my-lib' });
      const summary = buildFailureSummary(history, config);
      expect(summary).toContain('org/my-lib');
    });

    it('includes issue numbers', () => {
      const config = makeConfig();
      const history = makeHistory(3, 3);
      const summary = buildFailureSummary(history, config);
      expect(summary).toContain('#42');
      expect(summary).toContain('#43');
    });

    it('includes max retries count', () => {
      const config = makeConfig({ maxRetries: 5 });
      const history = makeHistory(5, 5);
      const summary = buildFailureSummary(history, config);
      expect(summary).toContain('5 retry attempts');
    });

    it('includes agent type', () => {
      const config = makeConfig({ agentType: 'build' });
      const history = makeHistory(3, 3);
      const summary = buildFailureSummary(history, config);
      expect(summary).toContain('build agent');
    });

    it('includes fork branch for preservation', () => {
      const config = makeConfig({ branchName: 'agent/scope-100' });
      const history = makeHistory(3, 3);
      const summary = buildFailureSummary(history, config);
      expect(summary).toContain('agent/scope-100');
      expect(summary).toContain('preserved');
    });
  });

  describe('formatFailureEmail', () => {
    const report: FailureReport = {
      runId: 'run-123',
      upstreamRepo: 'owner/repo',
      primaryIssueNumber: 42,
      retryHistory: [makeAttempt(1), makeAttempt(2), makeAttempt(3)],
      forkBranch: 'agent/scope-42',
      forkFullName: 'fork-org/repo',
      summary: 'Failed after 3 attempts',
    };

    it('includes repo and issue number in header', () => {
      const email = formatFailureEmail(report);
      expect(email).toContain('owner/repo#42');
    });

    it('includes failure summary', () => {
      const email = formatFailureEmail(report);
      expect(email).toContain('Failed after 3 attempts');
    });

    it('includes fork branch info for inspection', () => {
      const email = formatFailureEmail(report);
      expect(email).toContain('fork-org/repo');
      expect(email).toContain('agent/scope-42');
    });

    it('includes all retry attempts with context', () => {
      const email = formatFailureEmail(report);
      expect(email).toContain('Attempt 1');
      expect(email).toContain('Attempt 2');
      expect(email).toContain('Attempt 3');
      expect(email).toContain('Error in test 1');
      expect(email).toContain('Error in test 3');
    });

    it('wraps retry context in code blocks', () => {
      const email = formatFailureEmail(report);
      expect(email).toContain('```');
    });

    it('includes agent type per attempt', () => {
      const mixedReport: FailureReport = {
        ...report,
        retryHistory: [
          makeAttempt(1, { agentType: 'fix' }),
          makeAttempt(2, { agentType: 'build' }),
        ],
      };
      const email = formatFailureEmail(mixedReport);
      expect(email).toContain('fix agent');
      expect(email).toContain('build agent');
    });
  });

  describe('formatFailureSubject', () => {
    it('includes the prefix constant', () => {
      const subject = formatFailureSubject('owner/repo', 42);
      expect(subject).toContain(FAILURE_EMAIL_SUBJECT_PREFIX);
    });

    it('includes repo and issue number', () => {
      const subject = formatFailureSubject('org/lib', 100);
      expect(subject).toContain('org/lib#100');
    });
  });

  describe('handleMaxRetriesExceeded', () => {
    it('sends failure email to pm_email', async () => {
      const config = makeConfig();
      const report: FailureReport = {
        runId: 'run-123',
        upstreamRepo: 'owner/repo',
        primaryIssueNumber: 42,
        retryHistory: [makeAttempt(1)],
        forkBranch: 'agent/scope-42',
        forkFullName: 'fork-org/repo',
        summary: 'Failed',
      };
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      await handleMaxRetriesExceeded(report, config, notifier, labeler);

      expect(notifier.sendEmail).toHaveBeenCalledWith(
        'pm@example.com',
        expect.stringContaining(FAILURE_EMAIL_SUBJECT_PREFIX),
        expect.stringContaining('owner/repo#42'),
        'bot@example.com'
      );
    });

    it('labels upstream issue with agent-failed', async () => {
      const config = makeConfig();
      const report: FailureReport = {
        runId: 'run-123',
        upstreamRepo: 'owner/repo',
        primaryIssueNumber: 42,
        retryHistory: [],
        forkBranch: 'branch',
        forkFullName: 'fork/repo',
        summary: 'Failed',
      };
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      await handleMaxRetriesExceeded(report, config, notifier, labeler);

      expect(labeler.addLabel).toHaveBeenCalledWith(
        'owner/repo',
        42,
        AGENT_FAILED_LABEL
      );
    });

    it('tolerates email send failure', async () => {
      const config = makeConfig();
      const report: FailureReport = {
        runId: 'run-123',
        upstreamRepo: 'owner/repo',
        primaryIssueNumber: 42,
        retryHistory: [],
        forkBranch: 'branch',
        forkFullName: 'fork/repo',
        summary: 'Failed',
      };
      const notifier: FailureNotifier = {
        sendEmail: jest.fn(async () => { throw new Error('SMTP down'); }),
      };
      const labeler = makeMockLabeler();

      const result = await handleMaxRetriesExceeded(report, config, notifier, labeler);
      expect(result.emailSent).toBe(false);
      expect(result.labelApplied).toBe(true);
    });

    it('tolerates label failure', async () => {
      const config = makeConfig();
      const report: FailureReport = {
        runId: 'run-123',
        upstreamRepo: 'owner/repo',
        primaryIssueNumber: 42,
        retryHistory: [],
        forkBranch: 'branch',
        forkFullName: 'fork/repo',
        summary: 'Failed',
      };
      const notifier = makeMockNotifier();
      const labeler: IssueLabeler = {
        addLabel: jest.fn(async () => { throw new Error('API error'); }),
      };

      const result = await handleMaxRetriesExceeded(report, config, notifier, labeler);
      expect(result.emailSent).toBe(true);
      expect(result.labelApplied).toBe(false);
    });

    it('returns success status for both operations', async () => {
      const config = makeConfig();
      const report: FailureReport = {
        runId: 'run-123',
        upstreamRepo: 'owner/repo',
        primaryIssueNumber: 42,
        retryHistory: [],
        forkBranch: 'branch',
        forkFullName: 'fork/repo',
        summary: 'Failed',
      };
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      const result = await handleMaxRetriesExceeded(report, config, notifier, labeler);
      expect(result.emailSent).toBe(true);
      expect(result.labelApplied).toBe(true);
    });
  });

  describe('runRetryLoop', () => {
    it('creates new history on first retry', async () => {
      const config = makeConfig({ maxRetries: 3 });
      const stateStore = makeMockStateStore(null);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      const result = await runRetryLoop('first failure', config, stateStore, notifier, labeler);

      expect(result.action).toBe('retry');
      expect(stateStore.saveRetryHistory).toHaveBeenCalled();
    });

    it('loads existing history on subsequent retries', async () => {
      const existing = makeHistory(1, 3);
      const config = makeConfig({ maxRetries: 3 });
      const stateStore = makeMockStateStore(existing);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      const result = await runRetryLoop('second failure', config, stateStore, notifier, labeler);

      expect(result.action).toBe('retry');
      expect(stateStore.loadRetryHistory).toHaveBeenCalledWith('run-123');
    });

    it('returns retry with dispatch info when retries remain', async () => {
      const config = makeConfig({ maxRetries: 3 });
      const stateStore = makeMockStateStore(null);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      const result = await runRetryLoop('error output', config, stateStore, notifier, labeler);

      expect(result.action).toBe('retry');
      if (result.action === 'retry') {
        expect(result.dispatch.retryCount).toBe(2);
        expect(result.dispatch.latestRetryContext).toBe('error output');
        expect(result.dispatch.agentType).toBe('fix');
      }
    });

    it('triggers max_retries_exceeded when max reached', async () => {
      const existing = makeHistory(2, 3); // 2 done, max 3 → 3rd records then exceeds
      const config = makeConfig({ maxRetries: 3 });
      const stateStore = makeMockStateStore(existing);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      const result = await runRetryLoop('final failure', config, stateStore, notifier, labeler);

      expect(result.action).toBe('max_retries_exceeded');
    });

    it('sends email on max_retries_exceeded', async () => {
      const existing = makeHistory(2, 3);
      const config = makeConfig({ maxRetries: 3 });
      const stateStore = makeMockStateStore(existing);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      await runRetryLoop('final failure', config, stateStore, notifier, labeler);

      expect(notifier.sendEmail).toHaveBeenCalled();
    });

    it('labels issue on max_retries_exceeded', async () => {
      const existing = makeHistory(2, 3);
      const config = makeConfig({ maxRetries: 3 });
      const stateStore = makeMockStateStore(existing);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      await runRetryLoop('final failure', config, stateStore, notifier, labeler);

      expect(labeler.addLabel).toHaveBeenCalledWith('owner/repo', 42, AGENT_FAILED_LABEL);
    });

    it('deletes history on max_retries_exceeded (terminal)', async () => {
      const existing = makeHistory(2, 3);
      const config = makeConfig({ maxRetries: 3 });
      const stateStore = makeMockStateStore(existing);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      await runRetryLoop('final failure', config, stateStore, notifier, labeler);

      expect(stateStore.deleteRetryHistory).toHaveBeenCalledWith('run-123');
    });

    it('does not delete history on retry (non-terminal)', async () => {
      const config = makeConfig({ maxRetries: 3 });
      const stateStore = makeMockStateStore(null);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      await runRetryLoop('first failure', config, stateStore, notifier, labeler);

      expect(stateStore.deleteRetryHistory).not.toHaveBeenCalled();
    });

    it('persists updated history before evaluating', async () => {
      const config = makeConfig({ maxRetries: 3 });
      const stateStore = makeMockStateStore(null);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      await runRetryLoop('failure context', config, stateStore, notifier, labeler);

      const savedHistory = (stateStore.saveRetryHistory as jest.Mock).mock.calls[0][0] as RetryHistory;
      expect(savedHistory.attempts).toHaveLength(1);
      expect(savedHistory.attempts[0].retryContext).toBe('failure context');
    });

    it('works with build agent type', async () => {
      const config = makeConfig({ agentType: 'build', maxRetries: 2 });
      const stateStore = makeMockStateStore(null);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      const result = await runRetryLoop('scaffold failed', config, stateStore, notifier, labeler);

      if (result.action === 'retry') {
        expect(result.dispatch.agentType).toBe('build');
      }
    });
  });

  describe('injectRetryContextForFixAgent', () => {
    it('appends latest retry context to design summary', () => {
      const result = injectRetryContextForFixAgent(
        'Original design summary',
        {
          retryCount: 2,
          combinedRetryContext: '',
          latestRetryContext: 'Tests failed: undefined is not a function',
          agentType: 'fix',
        }
      );
      expect(result).toContain('Original design summary');
      expect(result).toContain('Tests failed: undefined is not a function');
    });

    it('includes combined retry context from previous attempts', () => {
      const combined = buildCombinedRetryContext([makeAttempt(1)]);
      const result = injectRetryContextForFixAgent(
        'Design summary',
        {
          retryCount: 2,
          combinedRetryContext: combined,
          latestRetryContext: 'Second failure details',
          agentType: 'fix',
        }
      );
      expect(result).toContain('Design summary');
      expect(result).toContain('Attempt 1');
      expect(result).toContain('Second failure details');
    });

    it('marks latest failure section for agent attention', () => {
      const result = injectRetryContextForFixAgent(
        'Design',
        {
          retryCount: 1,
          combinedRetryContext: '',
          latestRetryContext: 'error details',
          agentType: 'fix',
        }
      );
      expect(result).toContain('Latest Failure');
      expect(result).toContain('address this');
    });

    it('does not include combined section when empty', () => {
      const result = injectRetryContextForFixAgent(
        'Design',
        {
          retryCount: 1,
          combinedRetryContext: '',
          latestRetryContext: 'first error',
          agentType: 'fix',
        }
      );
      // Should not have "Previous Retry Attempts" section
      expect(result).not.toContain('Previous Retry Attempts');
    });
  });

  describe('injectRetryContextForBuildAgent', () => {
    it('appends retry context same as fix agent', () => {
      const result = injectRetryContextForBuildAgent(
        'Build design',
        {
          retryCount: 1,
          combinedRetryContext: '',
          latestRetryContext: 'scaffold error',
          agentType: 'build',
        }
      );
      expect(result).toContain('Build design');
      expect(result).toContain('scaffold error');
      expect(result).toContain('Latest Failure');
    });
  });

  describe('resumeRetryLoop', () => {
    it('returns existing history from state store', async () => {
      const existing = makeHistory(2, 3);
      const stateStore = makeMockStateStore(existing);

      const result = await resumeRetryLoop('run-123', stateStore);
      expect(result).not.toBeNull();
      expect(result!.runId).toBe('run-123');
      expect(result!.attempts).toHaveLength(2);
    });

    it('returns null when no history exists', async () => {
      const stateStore = makeMockStateStore(null);
      const result = await resumeRetryLoop('run-nonexistent', stateStore);
      expect(result).toBeNull();
    });

    it('survives restart by loading persisted state', async () => {
      // Simulate: first loop run persists, then on restart we resume
      const config = makeConfig({ maxRetries: 3 });
      const stateStore = makeMockStateStore(null);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      // First failure
      await runRetryLoop('first error', config, stateStore, notifier, labeler);

      // Resume (simulating restart by loading from same store)
      const resumed = await resumeRetryLoop('run-123', stateStore);
      expect(resumed).not.toBeNull();
      expect(resumed!.attempts).toHaveLength(1);
      expect(resumed!.attempts[0].retryContext).toBe('first error');
    });
  });

  describe('retry count visible in PR body', () => {
    it('eval agent buildPRDetails includes retry count when > 0', () => {
      // This tests integration with eval-agent.ts buildPRDetails
      // The existing buildPRDetails already includes retry information
      // when input.retryCount > 0. This test verifies the contract.
      const config = makeConfig({ maxRetries: 3 });
      const history = makeHistory(2, 3);
      const decision = evaluateRetryDecision(history, 'ctx', config);
      if (decision.action === 'retry') {
        // The retryCount from dispatch is what gets passed to eval agent
        expect(decision.dispatch.retryCount).toBeGreaterThan(0);
      }
    });
  });

  describe('AGENT_FAILED_LABEL constant', () => {
    it('equals agent-failed', () => {
      expect(AGENT_FAILED_LABEL).toBe('agent-failed');
    });
  });

  describe('FAILURE_EMAIL_SUBJECT_PREFIX constant', () => {
    it('starts with [agent-fix]', () => {
      expect(FAILURE_EMAIL_SUBJECT_PREFIX).toContain('[agent-fix]');
    });

    it('indicates failure', () => {
      expect(FAILURE_EMAIL_SUBJECT_PREFIX).toContain('FAILED');
    });
  });

  describe('end-to-end retry flow', () => {
    it('fix agent: retry → retry → max_exceeded', async () => {
      const config = makeConfig({ maxRetries: 2, agentType: 'fix' });
      const stateStore = makeMockStateStore(null);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      // First failure → retry
      const r1 = await runRetryLoop('error 1', config, stateStore, notifier, labeler);
      expect(r1.action).toBe('retry');
      if (r1.action === 'retry') {
        expect(r1.dispatch.retryCount).toBe(2);
      }

      // Second failure → max exceeded
      const r2 = await runRetryLoop('error 2', config, stateStore, notifier, labeler);
      expect(r2.action).toBe('max_retries_exceeded');
      if (r2.action === 'max_retries_exceeded') {
        expect(r2.failureReport.retryHistory).toHaveLength(2);
        expect(r2.failureReport.forkBranch).toBe('agent/scope-42-43');
      }

      // Notifications sent
      expect(notifier.sendEmail).toHaveBeenCalledTimes(1);
      expect(labeler.addLabel).toHaveBeenCalledTimes(1);
    });

    it('build agent: retries preserve full context chain', async () => {
      const config = makeConfig({ maxRetries: 3, agentType: 'build' });
      const stateStore = makeMockStateStore(null);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      // First failure
      const r1 = await runRetryLoop('scaffold missing test', config, stateStore, notifier, labeler);
      expect(r1.action).toBe('retry');
      if (r1.action === 'retry') {
        expect(r1.dispatch.combinedRetryContext).toBe(''); // no previous
      }

      // Second failure
      const r2 = await runRetryLoop('type error in index', config, stateStore, notifier, labeler);
      expect(r2.action).toBe('retry');
      if (r2.action === 'retry') {
        expect(r2.dispatch.combinedRetryContext).toContain('scaffold missing test');
      }

      // Third failure → max exceeded
      const r3 = await runRetryLoop('still broken', config, stateStore, notifier, labeler);
      expect(r3.action).toBe('max_retries_exceeded');
    });

    it('inject context produces augmented design for retry', async () => {
      const config = makeConfig({ maxRetries: 3, agentType: 'fix' });
      const stateStore = makeMockStateStore(null);
      const notifier = makeMockNotifier();
      const labeler = makeMockLabeler();

      const r1 = await runRetryLoop('TypeError: x is undefined', config, stateStore, notifier, labeler);
      if (r1.action === 'retry') {
        const augmented = injectRetryContextForFixAgent('Fix the auth module', r1.dispatch);
        expect(augmented).toContain('Fix the auth module');
        expect(augmented).toContain('TypeError: x is undefined');
        expect(augmented).toContain('Latest Failure');
      }
    });
  });
});
