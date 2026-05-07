/**
 * Unit tests for cost guardrails, fork cleanup, and run history dashboard (US-019).
 * Covers per-run token/cost caps, fork cleanup policies, run history dashboard,
 * and all four PRD section 8.1 scenario types.
 */

import { RunState } from './orchestrator/types';
import {
  CostConfig,
  RunUsage,
  RunHistoryEntry,
  RunHistoryStore,
  RunHistoryFilter,
  RunHistoryStats,
  ForkCleaner,
  ForkCleanupConfig,
  CostCapBreachedError,
  ForkCleanupError,
  DEFAULT_FORK_CLEANUP_POLICY,
  DEFAULT_CLEANUP_DELAY_HOURS,
  DEFAULT_COST_PER_1K_TOKENS,
  DEFAULT_MAX_TOKENS_PER_RUN,
  DEFAULT_MAX_COST_PER_RUN,
  COST_BREACH_EMAIL_SUBJECT_PREFIX,
} from './cost-guardrails-types';
import {
  createCostConfig,
  checkCostCap,
  recordAndCheckUsage,
  buildCostBreachNotification,
  formatCostBreachEmail,
  formatCostBreachSubject,
  validateForkCleanupPolicy,
  createForkCleanupConfig,
  executeForkCleanup,
  executeDelayedCleanup,
  formatRunHistoryEntry,
  formatDuration,
  formatRunHistoryStats,
  renderDashboard,
  queryRunHistory,
  calculateStats,
  validateScenarioOutcome,
  ScenarioType,
} from './cost-guardrails';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function createMockStore(usageMap: Map<string, RunUsage> = new Map()): RunHistoryStore {
  return {
    recordUsage(runId: string, tokens: number, cost: number) {
      const existing = usageMap.get(runId);
      if (existing) {
        existing.tokensUsed += tokens;
        existing.costUsd += cost;
        existing.lastUpdated = new Date().toISOString();
      } else {
        usageMap.set(runId, {
          runId,
          tokensUsed: tokens,
          costUsd: cost,
          lastUpdated: new Date().toISOString(),
        });
      }
    },
    getUsage(runId: string) {
      return usageMap.get(runId) || null;
    },
    getHistory(_filter: RunHistoryFilter) {
      return [];
    },
    getStats(_filter?: Partial<RunHistoryFilter>): RunHistoryStats {
      return {
        totalRuns: 0,
        byState: {},
        totalCostUsd: 0,
        totalTokensUsed: 0,
        avgDurationSeconds: 0,
        successRate: 0,
      };
    },
    recordPrUrl(_runId: string, _prUrl: string) {},
  };
}

function createMockCleaner(branches: string[] = ['main']): ForkCleaner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async deleteBranch(forkFullName: string, branchName: string) {
      calls.push(`deleteBranch:${forkFullName}:${branchName}`);
    },
    async deleteFork(forkFullName: string) {
      calls.push(`deleteFork:${forkFullName}`);
    },
    async listBranches(_forkFullName: string) {
      return branches;
    },
  };
}

// ─── Cost Config Tests ─────────────────────────────────────────────────────────

describe('createCostConfig', () => {
  it('creates config with defaults when no overrides', () => {
    const config = createCostConfig();
    expect(config.max_tokens_per_run).toBeNull();
    expect(config.max_cost_per_run).toBeNull();
    expect(config.cost_per_1k_tokens).toBe(DEFAULT_COST_PER_1K_TOKENS);
  });

  it('applies overrides', () => {
    const config = createCostConfig({
      max_tokens_per_run: 50000,
      max_cost_per_run: 2.0,
      cost_per_1k_tokens: 0.06,
    });
    expect(config.max_tokens_per_run).toBe(50000);
    expect(config.max_cost_per_run).toBe(2.0);
    expect(config.cost_per_1k_tokens).toBe(0.06);
  });

  it('allows partial overrides', () => {
    const config = createCostConfig({ max_tokens_per_run: 100000 });
    expect(config.max_tokens_per_run).toBe(100000);
    expect(config.max_cost_per_run).toBeNull();
    expect(config.cost_per_1k_tokens).toBe(DEFAULT_COST_PER_1K_TOKENS);
  });
});

// ─── Cost Cap Check Tests ──────────────────────────────────────────────────────

describe('checkCostCap', () => {
  const baseUsage: RunUsage = {
    runId: 'run-1',
    tokensUsed: 5000,
    costUsd: 0.15,
    lastUpdated: '2026-05-06T00:00:00Z',
  };

  it('returns within budget when no caps set', () => {
    const config = createCostConfig();
    const result = checkCostCap(baseUsage, config);
    expect(result.withinBudget).toBe(true);
    expect(result.breachedCap).toBeNull();
    expect(result.message).toBe('Within budget');
  });

  it('returns within budget when under token cap', () => {
    const config = createCostConfig({ max_tokens_per_run: 10000 });
    const result = checkCostCap(baseUsage, config);
    expect(result.withinBudget).toBe(true);
  });

  it('detects token cap breach', () => {
    const config = createCostConfig({ max_tokens_per_run: 4000 });
    const result = checkCostCap(baseUsage, config);
    expect(result.withinBudget).toBe(false);
    expect(result.breachedCap).toBe('token');
    expect(result.message).toContain('5000');
    expect(result.message).toContain('4000');
  });

  it('returns within budget when under cost cap', () => {
    const config = createCostConfig({ max_cost_per_run: 1.0 });
    const result = checkCostCap(baseUsage, config);
    expect(result.withinBudget).toBe(true);
  });

  it('detects cost cap breach', () => {
    const config = createCostConfig({ max_cost_per_run: 0.10 });
    const result = checkCostCap(baseUsage, config);
    expect(result.withinBudget).toBe(false);
    expect(result.breachedCap).toBe('cost');
    expect(result.message).toContain('0.1500');
    expect(result.message).toContain('0.1');
  });

  it('token cap checked before cost cap', () => {
    const config = createCostConfig({ max_tokens_per_run: 1000, max_cost_per_run: 0.01 });
    const result = checkCostCap(baseUsage, config);
    expect(result.breachedCap).toBe('token');
  });

  it('includes usage and config in result', () => {
    const config = createCostConfig({ max_tokens_per_run: 10000 });
    const result = checkCostCap(baseUsage, config);
    expect(result.usage).toBe(baseUsage);
    expect(result.config).toBe(config);
  });
});

// ─── Record And Check Usage Tests ──────────────────────────────────────────────

describe('recordAndCheckUsage', () => {
  it('records usage and returns within budget', () => {
    const store = createMockStore();
    const config = createCostConfig({ max_tokens_per_run: 100000 });
    const result = recordAndCheckUsage(store, 'run-1', 5000, config);
    expect(result.withinBudget).toBe(true);
    const usage = store.getUsage('run-1');
    expect(usage!.tokensUsed).toBe(5000);
  });

  it('accumulates usage across calls', () => {
    const store = createMockStore();
    const config = createCostConfig({ max_tokens_per_run: 100000 });
    recordAndCheckUsage(store, 'run-1', 3000, config);
    recordAndCheckUsage(store, 'run-1', 4000, config);
    const usage = store.getUsage('run-1');
    expect(usage!.tokensUsed).toBe(7000);
  });

  it('detects breach after accumulation', () => {
    const store = createMockStore();
    const config = createCostConfig({ max_tokens_per_run: 8000 });
    recordAndCheckUsage(store, 'run-1', 5000, config);
    const result = recordAndCheckUsage(store, 'run-1', 5000, config);
    expect(result.withinBudget).toBe(false);
    expect(result.breachedCap).toBe('token');
  });

  it('calculates cost from tokens and rate', () => {
    const store = createMockStore();
    const config = createCostConfig({ cost_per_1k_tokens: 0.06 });
    recordAndCheckUsage(store, 'run-1', 10000, config);
    const usage = store.getUsage('run-1');
    expect(usage!.costUsd).toBeCloseTo(0.60);
  });
});

// ─── Cost Breach Notification Tests ────────────────────────────────────────────

describe('buildCostBreachNotification', () => {
  const usage: RunUsage = {
    runId: 'run-1',
    tokensUsed: 60000,
    costUsd: 1.80,
    lastUpdated: '2026-05-06T00:00:00Z',
  };

  it('builds notification for token breach', () => {
    const config = createCostConfig({ max_tokens_per_run: 50000 });
    const notification = buildCostBreachNotification(
      'run-1', 'org/repo', 42, RunState.AGENT_RUNNING, usage, config
    );
    expect(notification.runId).toBe('run-1');
    expect(notification.upstreamRepo).toBe('org/repo');
    expect(notification.primaryIssueNumber).toBe(42);
    expect(notification.haltedAtState).toBe(RunState.AGENT_RUNNING);
    expect(notification.summary).toContain('60000 tokens');
    expect(notification.summary).toContain('50000 tokens');
  });

  it('builds notification for cost breach', () => {
    const config = createCostConfig({ max_cost_per_run: 1.0 });
    const notification = buildCostBreachNotification(
      'run-1', 'org/repo', 42, RunState.SANDBOX_RUNNING, usage, config
    );
    expect(notification.summary).toContain('$1.8000');
    expect(notification.summary).toContain('$1');
    expect(notification.haltedAtState).toBe(RunState.SANDBOX_RUNNING);
  });

  it('includes state in summary', () => {
    const config = createCostConfig({ max_tokens_per_run: 50000 });
    const notification = buildCostBreachNotification(
      'run-1', 'org/repo', 42, RunState.EVAL_RUNNING, usage, config
    );
    expect(notification.summary).toContain('EVAL_RUNNING');
  });
});

describe('formatCostBreachEmail', () => {
  it('contains all required sections', () => {
    const usage: RunUsage = { runId: 'run-1', tokensUsed: 60000, costUsd: 1.80, lastUpdated: '2026-05-06T00:00:00Z' };
    const config = createCostConfig({ max_tokens_per_run: 50000, max_cost_per_run: 1.5 });
    const notification = buildCostBreachNotification('run-1', 'org/repo', 42, RunState.AGENT_RUNNING, usage, config);
    const email = formatCostBreachEmail(notification);
    expect(email).toContain('# Cost Limit Reached');
    expect(email).toContain('run-1');
    expect(email).toContain('org/repo');
    expect(email).toContain('#42');
    expect(email).toContain('AGENT_RUNNING');
    expect(email).toContain('60000');
    expect(email).toContain('50000');
    expect(email).toContain('$1.5');
  });
});

describe('formatCostBreachSubject', () => {
  it('uses correct prefix', () => {
    const subject = formatCostBreachSubject('org/repo', 42);
    expect(subject).toBe('[agent-fix] COST LIMIT: org/repo#42');
  });
});

// ─── CostCapBreachedError Tests ────────────────────────────────────────────────

describe('CostCapBreachedError', () => {
  it('has correct fields for token breach', () => {
    const usage: RunUsage = { runId: 'run-1', tokensUsed: 60000, costUsd: 1.80, lastUpdated: '2026-05-06T00:00:00Z' };
    const config = createCostConfig({ max_tokens_per_run: 50000 });
    const error = new CostCapBreachedError('run-1', 'token', usage, config);
    expect(error.name).toBe('CostCapBreachedError');
    expect(error.runId).toBe('run-1');
    expect(error.breachedCap).toBe('token');
    expect(error.message).toContain('60000 tokens');
    expect(error.message).toContain('50000 tokens');
  });

  it('has correct fields for cost breach', () => {
    const usage: RunUsage = { runId: 'run-1', tokensUsed: 60000, costUsd: 1.80, lastUpdated: '2026-05-06T00:00:00Z' };
    const config = createCostConfig({ max_cost_per_run: 1.0 });
    const error = new CostCapBreachedError('run-1', 'cost', usage, config);
    expect(error.breachedCap).toBe('cost');
    expect(error.message).toContain('$1.8000');
    expect(error.message).toContain('$1');
  });
});

// ─── Fork Cleanup Policy Tests ─────────────────────────────────────────────────

describe('validateForkCleanupPolicy', () => {
  it('accepts immediate-after-merge', () => {
    expect(validateForkCleanupPolicy('immediate-after-merge')).toBe(true);
  });

  it('accepts delayed', () => {
    expect(validateForkCleanupPolicy('delayed')).toBe(true);
  });

  it('accepts never', () => {
    expect(validateForkCleanupPolicy('never')).toBe(true);
  });

  it('rejects invalid policy', () => {
    expect(validateForkCleanupPolicy('always')).toBe(false);
    expect(validateForkCleanupPolicy('')).toBe(false);
    expect(validateForkCleanupPolicy('immediate')).toBe(false);
  });
});

describe('createForkCleanupConfig', () => {
  it('uses default policy and delay', () => {
    const config = createForkCleanupConfig('org/repo', 'agent/scope-42');
    expect(config.policy).toBe(DEFAULT_FORK_CLEANUP_POLICY);
    expect(config.delayHours).toBe(DEFAULT_CLEANUP_DELAY_HOURS);
    expect(config.forkFullName).toBe('org/repo');
    expect(config.branchName).toBe('agent/scope-42');
  });

  it('applies custom policy and delay', () => {
    const config = createForkCleanupConfig('org/repo', 'agent/scope-42', 'never', 24);
    expect(config.policy).toBe('never');
    expect(config.delayHours).toBe(24);
  });
});

describe('executeForkCleanup', () => {
  it('skips cleanup when policy is never', async () => {
    const cleaner = createMockCleaner();
    const config = createForkCleanupConfig('org/repo', 'agent/scope-42', 'never');
    const result = await executeForkCleanup(config, cleaner);
    expect(result.executed).toBe(false);
    expect(result.action).toBe('skipped');
    expect(result.scheduledAt).toBeNull();
    expect(result.message).toContain('never');
    expect(cleaner.calls).toHaveLength(0);
  });

  it('schedules cleanup when policy is delayed', async () => {
    const cleaner = createMockCleaner();
    const config = createForkCleanupConfig('org/repo', 'agent/scope-42', 'delayed', 48);
    const result = await executeForkCleanup(config, cleaner);
    expect(result.executed).toBe(false);
    expect(result.action).toBe('scheduled');
    expect(result.scheduledAt).not.toBeNull();
    expect(result.message).toContain('48h');
    expect(cleaner.calls).toHaveLength(0);
  });

  it('deletes branch immediately when policy is immediate-after-merge', async () => {
    const cleaner = createMockCleaner(['main', 'agent/scope-99']);
    const config = createForkCleanupConfig('org/repo', 'agent/scope-42', 'immediate-after-merge');
    const result = await executeForkCleanup(config, cleaner);
    expect(result.executed).toBe(true);
    expect(result.action).toBe('branch_deleted');
    expect(cleaner.calls).toContain('deleteBranch:org/repo:agent/scope-42');
  });

  it('deletes fork when no non-default branches remain', async () => {
    const cleaner = createMockCleaner(['main']);
    const config = createForkCleanupConfig('org/repo', 'agent/scope-42', 'immediate-after-merge');
    const result = await executeForkCleanup(config, cleaner);
    expect(result.executed).toBe(true);
    expect(result.action).toBe('fork_deleted');
    expect(cleaner.calls).toContain('deleteFork:org/repo');
  });

  it('throws ForkCleanupError on failure', async () => {
    const cleaner: ForkCleaner = {
      async deleteBranch() { throw new Error('API error'); },
      async deleteFork() {},
      async listBranches() { return []; },
    };
    const config = createForkCleanupConfig('org/repo', 'agent/scope-42', 'immediate-after-merge');
    await expect(executeForkCleanup(config, cleaner)).rejects.toThrow(ForkCleanupError);
  });
});

describe('executeDelayedCleanup', () => {
  it('executes immediate cleanup', async () => {
    const cleaner = createMockCleaner(['main']);
    const config = createForkCleanupConfig('org/repo', 'agent/scope-42', 'delayed');
    const result = await executeDelayedCleanup(config, cleaner);
    expect(result.executed).toBe(true);
    expect(cleaner.calls).toContain('deleteBranch:org/repo:agent/scope-42');
  });
});

// ─── ForkCleanupError Tests ────────────────────────────────────────────────────

describe('ForkCleanupError', () => {
  it('has correct fields', () => {
    const error = new ForkCleanupError('failed', 'cleanup', 'org/repo');
    expect(error.name).toBe('ForkCleanupError');
    expect(error.phase).toBe('cleanup');
    expect(error.forkFullName).toBe('org/repo');
    expect(error.message).toBe('failed');
  });
});

// ─── Run History Dashboard Tests ───────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats seconds', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2m 5s');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(7260)).toBe('2h 1m');
  });
});

describe('formatRunHistoryEntry', () => {
  it('formats a complete entry', () => {
    const entry: RunHistoryEntry = {
      runId: 'run-1',
      repo: 'org/repo',
      issueIds: [42, 56],
      state: RunState.PR_OPEN,
      durationSeconds: 300,
      retryCount: 1,
      costUsd: 0.45,
      tokensUsed: 15000,
      createdAt: '2026-05-06T00:00:00Z',
      updatedAt: '2026-05-06T00:05:00Z',
      prUrl: 'https://github.com/org/repo/pull/1',
    };
    const formatted = formatRunHistoryEntry(entry);
    expect(formatted).toContain('run-1');
    expect(formatted).toContain('org/repo');
    expect(formatted).toContain('#42');
    expect(formatted).toContain('#56');
    expect(formatted).toContain('PR_OPEN');
    expect(formatted).toContain('5m 0s');
    expect(formatted).toContain('retries: 1');
    expect(formatted).toContain('$0.4500');
    expect(formatted).toContain('https://github.com/org/repo/pull/1');
  });

  it('shows dash for zero cost', () => {
    const entry: RunHistoryEntry = {
      runId: 'run-2',
      repo: 'org/repo',
      issueIds: [10],
      state: RunState.FAILED,
      durationSeconds: 60,
      retryCount: 0,
      costUsd: 0,
      tokensUsed: 0,
      createdAt: '2026-05-06T00:00:00Z',
      updatedAt: '2026-05-06T00:01:00Z',
      prUrl: null,
    };
    const formatted = formatRunHistoryEntry(entry);
    expect(formatted).toContain('cost: -');
    expect(formatted).not.toContain('→');
  });
});

describe('calculateStats', () => {
  it('returns zeros for empty entries', () => {
    const stats = calculateStats([]);
    expect(stats.totalRuns).toBe(0);
    expect(stats.totalCostUsd).toBe(0);
    expect(stats.successRate).toBe(0);
  });

  it('calculates stats for multiple entries', () => {
    const entries: RunHistoryEntry[] = [
      {
        runId: 'r1', repo: 'org/repo', issueIds: [1], state: RunState.PR_OPEN,
        durationSeconds: 100, retryCount: 0, costUsd: 0.5, tokensUsed: 10000,
        createdAt: '', updatedAt: '', prUrl: 'url1',
      },
      {
        runId: 'r2', repo: 'org/repo', issueIds: [2], state: RunState.FAILED,
        durationSeconds: 200, retryCount: 3, costUsd: 1.5, tokensUsed: 50000,
        createdAt: '', updatedAt: '', prUrl: null,
      },
      {
        runId: 'r3', repo: 'org/other', issueIds: [3], state: RunState.PR_OPEN,
        durationSeconds: 150, retryCount: 1, costUsd: 0.8, tokensUsed: 20000,
        createdAt: '', updatedAt: '', prUrl: 'url3',
      },
    ];
    const stats = calculateStats(entries);
    expect(stats.totalRuns).toBe(3);
    expect(stats.totalCostUsd).toBeCloseTo(2.8);
    expect(stats.totalTokensUsed).toBe(80000);
    expect(stats.avgDurationSeconds).toBe(150);
    expect(stats.successRate).toBeCloseTo(2 / 3);
    expect(stats.byState[RunState.PR_OPEN]).toBe(2);
    expect(stats.byState[RunState.FAILED]).toBe(1);
  });

  it('success rate is 0 when no completed runs', () => {
    const entries: RunHistoryEntry[] = [
      {
        runId: 'r1', repo: 'org/repo', issueIds: [1], state: RunState.AGENT_RUNNING,
        durationSeconds: 50, retryCount: 0, costUsd: 0.1, tokensUsed: 2000,
        createdAt: '', updatedAt: '', prUrl: null,
      },
    ];
    const stats = calculateStats(entries);
    expect(stats.successRate).toBe(0);
  });
});

describe('formatRunHistoryStats', () => {
  it('includes all summary fields', () => {
    const stats: RunHistoryStats = {
      totalRuns: 10,
      byState: { PR_OPEN: 7, FAILED: 3 },
      totalCostUsd: 5.5,
      totalTokensUsed: 200000,
      avgDurationSeconds: 300,
      successRate: 0.7,
    };
    const formatted = formatRunHistoryStats(stats);
    expect(formatted).toContain('Total runs:       10');
    expect(formatted).toContain('70.0%');
    expect(formatted).toContain('$5.5000');
    expect(formatted).toContain('200000');
    expect(formatted).toContain('5m 0s');
    expect(formatted).toContain('PR_OPEN: 7');
    expect(formatted).toContain('FAILED: 3');
  });
});

describe('renderDashboard', () => {
  it('shows no runs message when empty', () => {
    const stats: RunHistoryStats = {
      totalRuns: 0, byState: {}, totalCostUsd: 0,
      totalTokensUsed: 0, avgDurationSeconds: 0, successRate: 0,
    };
    const output = renderDashboard([], stats);
    expect(output).toContain('No runs found');
  });

  it('includes stats and entries', () => {
    const entries: RunHistoryEntry[] = [{
      runId: 'r1', repo: 'org/repo', issueIds: [1], state: RunState.PR_OPEN,
      durationSeconds: 100, retryCount: 0, costUsd: 0.5, tokensUsed: 10000,
      createdAt: '', updatedAt: '', prUrl: null,
    }];
    const stats = calculateStats(entries);
    const output = renderDashboard(entries, stats);
    expect(output).toContain('Run History Summary');
    expect(output).toContain('Recent Runs');
    expect(output).toContain('r1');
  });
});

describe('queryRunHistory', () => {
  it('calls store with filter', () => {
    const mockEntries: RunHistoryEntry[] = [{
      runId: 'r1', repo: 'org/repo', issueIds: [1], state: RunState.PR_OPEN,
      durationSeconds: 100, retryCount: 0, costUsd: 0.5, tokensUsed: 10000,
      createdAt: '', updatedAt: '', prUrl: null,
    }];
    const store: RunHistoryStore = {
      recordUsage() {},
      getUsage() { return null; },
      getHistory(_f: RunHistoryFilter) { return mockEntries; },
      getStats() {
        return { totalRuns: 1, byState: {}, totalCostUsd: 0.5, totalTokensUsed: 10000, avgDurationSeconds: 100, successRate: 1 };
      },
      recordPrUrl() {},
    };
    const result = queryRunHistory(store, { repo: 'org/repo' });
    expect(result.entries).toHaveLength(1);
    expect(result.stats.totalRuns).toBe(1);
  });
});

// ─── Scenario Validation Tests (PRD Section 8.1) ──────────────────────────────

describe('validateScenarioOutcome', () => {
  describe('simple_bug_fix', () => {
    it('passes with PR_OPEN, 0 retries, and PR URL', () => {
      const result = validateScenarioOutcome('simple_bug_fix', RunState.PR_OPEN, 0, 'https://pr');
      expect(result.valid).toBe(true);
    });

    it('fails if not PR_OPEN', () => {
      const result = validateScenarioOutcome('simple_bug_fix', RunState.FAILED, 0, null);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('FAILED');
    });

    it('fails if retries > 0', () => {
      const result = validateScenarioOutcome('simple_bug_fix', RunState.PR_OPEN, 1, 'https://pr');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('retries');
    });

    it('fails if no PR URL', () => {
      const result = validateScenarioOutcome('simple_bug_fix', RunState.PR_OPEN, 0, null);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('PR URL');
    });
  });

  describe('feature_with_design', () => {
    it('passes with PR_OPEN and PR URL', () => {
      const result = validateScenarioOutcome('feature_with_design', RunState.PR_OPEN, 0, 'https://pr');
      expect(result.valid).toBe(true);
    });

    it('allows retries (design iteration)', () => {
      const result = validateScenarioOutcome('feature_with_design', RunState.PR_OPEN, 2, 'https://pr');
      expect(result.valid).toBe(true);
    });

    it('fails if not PR_OPEN', () => {
      const result = validateScenarioOutcome('feature_with_design', RunState.FAILED, 0, null);
      expect(result.valid).toBe(false);
    });

    it('fails if no PR URL', () => {
      const result = validateScenarioOutcome('feature_with_design', RunState.PR_OPEN, 0, null);
      expect(result.valid).toBe(false);
    });
  });

  describe('retry_success', () => {
    it('passes with PR_OPEN, retries > 0, and PR URL', () => {
      const result = validateScenarioOutcome('retry_success', RunState.PR_OPEN, 2, 'https://pr');
      expect(result.valid).toBe(true);
    });

    it('fails if retryCount is 0', () => {
      const result = validateScenarioOutcome('retry_success', RunState.PR_OPEN, 0, 'https://pr');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('retryCount > 0');
    });

    it('fails if not PR_OPEN', () => {
      const result = validateScenarioOutcome('retry_success', RunState.FAILED, 2, null);
      expect(result.valid).toBe(false);
    });
  });

  describe('max_retries_exceeded', () => {
    it('passes with FAILED and no PR URL', () => {
      const result = validateScenarioOutcome('max_retries_exceeded', RunState.FAILED, 3, null);
      expect(result.valid).toBe(true);
    });

    it('fails if not FAILED', () => {
      const result = validateScenarioOutcome('max_retries_exceeded', RunState.PR_OPEN, 3, 'https://pr');
      expect(result.valid).toBe(false);
    });

    it('fails if has PR URL', () => {
      const result = validateScenarioOutcome('max_retries_exceeded', RunState.FAILED, 3, 'https://pr');
      expect(result.valid).toBe(false);
    });
  });

  it('handles unknown scenario', () => {
    const result = validateScenarioOutcome('unknown' as ScenarioType, RunState.PR_OPEN, 0, null);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Unknown scenario');
  });
});

// ─── Constants Tests ───────────────────────────────────────────────────────────

describe('constants', () => {
  it('DEFAULT_FORK_CLEANUP_POLICY is delayed', () => {
    expect(DEFAULT_FORK_CLEANUP_POLICY).toBe('delayed');
  });

  it('DEFAULT_CLEANUP_DELAY_HOURS is 72', () => {
    expect(DEFAULT_CLEANUP_DELAY_HOURS).toBe(72);
  });

  it('DEFAULT_COST_PER_1K_TOKENS is 0.03', () => {
    expect(DEFAULT_COST_PER_1K_TOKENS).toBe(0.03);
  });

  it('DEFAULT_MAX_TOKENS_PER_RUN is null', () => {
    expect(DEFAULT_MAX_TOKENS_PER_RUN).toBeNull();
  });

  it('DEFAULT_MAX_COST_PER_RUN is null', () => {
    expect(DEFAULT_MAX_COST_PER_RUN).toBeNull();
  });

  it('COST_BREACH_EMAIL_SUBJECT_PREFIX is correct', () => {
    expect(COST_BREACH_EMAIL_SUBJECT_PREFIX).toBe('[agent-fix] COST LIMIT:');
  });
});
