/**
 * Cost guardrails, fork cleanup, and run history dashboard (US-019).
 * Provides per-run token/cost caps, fork cleanup policies, and a run history CLI view.
 */

import { RunState } from './orchestrator/types';
import {
  CostConfig,
  CostCheckResult,
  CostBreachNotification,
  CostCapBreachedError,
  ForkCleanupConfig,
  ForkCleanupResult,
  ForkCleanupError,
  ForkCleanupPolicy,
  ForkCleaner,
  RunUsage,
  RunHistoryEntry,
  RunHistoryFilter,
  RunHistoryStats,
  RunHistoryStore,
  DEFAULT_FORK_CLEANUP_POLICY,
  DEFAULT_CLEANUP_DELAY_HOURS,
  DEFAULT_COST_PER_1K_TOKENS,
  DEFAULT_MAX_TOKENS_PER_RUN,
  DEFAULT_MAX_COST_PER_RUN,
  COST_BREACH_EMAIL_SUBJECT_PREFIX,
} from './cost-guardrails-types';

// ─── Cost Guardrails ───────────────────────────────────────────────────────────

/**
 * Creates a default CostConfig with optional overrides.
 */
export function createCostConfig(overrides?: Partial<CostConfig>): CostConfig {
  return {
    max_tokens_per_run: DEFAULT_MAX_TOKENS_PER_RUN,
    max_cost_per_run: DEFAULT_MAX_COST_PER_RUN,
    cost_per_1k_tokens: DEFAULT_COST_PER_1K_TOKENS,
    ...overrides,
  };
}

/**
 * Checks whether current usage is within the configured cost/token caps.
 */
export function checkCostCap(usage: RunUsage, config: CostConfig): CostCheckResult {
  // Check token cap
  if (config.max_tokens_per_run !== null && usage.tokensUsed > config.max_tokens_per_run) {
    return {
      withinBudget: false,
      breachedCap: 'token',
      usage,
      config,
      message: `Token cap breached: ${usage.tokensUsed} tokens used, limit is ${config.max_tokens_per_run}`,
    };
  }

  // Check cost cap
  if (config.max_cost_per_run !== null && usage.costUsd > config.max_cost_per_run) {
    return {
      withinBudget: false,
      breachedCap: 'cost',
      usage,
      config,
      message: `Cost cap breached: $${usage.costUsd.toFixed(4)} spent, limit is $${config.max_cost_per_run}`,
    };
  }

  return {
    withinBudget: true,
    breachedCap: null,
    usage,
    config,
    message: 'Within budget',
  };
}

/**
 * Records token usage and checks against caps. Throws CostCapBreachedError on breach.
 */
export function recordAndCheckUsage(
  store: RunHistoryStore,
  runId: string,
  newTokens: number,
  config: CostConfig
): CostCheckResult {
  const newCost = (newTokens / 1000) * config.cost_per_1k_tokens;
  store.recordUsage(runId, newTokens, newCost);
  const usage = store.getUsage(runId);
  if (!usage) {
    // Should not happen after recording, but handle gracefully
    const emptyUsage: RunUsage = {
      runId,
      tokensUsed: newTokens,
      costUsd: newCost,
      lastUpdated: new Date().toISOString(),
    };
    return checkCostCap(emptyUsage, config);
  }
  return checkCostCap(usage, config);
}

/**
 * Builds a cost breach notification for emailing the user.
 */
export function buildCostBreachNotification(
  runId: string,
  upstreamRepo: string,
  primaryIssueNumber: number,
  haltedAtState: RunState,
  usage: RunUsage,
  config: CostConfig
): CostBreachNotification {
  const breachType = config.max_tokens_per_run !== null && usage.tokensUsed > config.max_tokens_per_run
    ? 'token'
    : 'cost';
  const limit = breachType === 'token'
    ? `${config.max_tokens_per_run} tokens`
    : `$${config.max_cost_per_run}`;
  const current = breachType === 'token'
    ? `${usage.tokensUsed} tokens`
    : `$${usage.costUsd.toFixed(4)}`;

  return {
    runId,
    upstreamRepo,
    primaryIssueNumber,
    haltedAtState,
    usage,
    config,
    summary: `Run halted: ${current} exceeds configured limit of ${limit}. ` +
      `Run was in state ${haltedAtState} when halted. ` +
      `Repo: ${upstreamRepo}, Issue: #${primaryIssueNumber}.`,
  };
}

/**
 * Formats the cost breach notification as an email body.
 */
export function formatCostBreachEmail(notification: CostBreachNotification): string {
  const lines: string[] = [
    `# Cost Limit Reached`,
    '',
    `**Run ID:** ${notification.runId}`,
    `**Repository:** ${notification.upstreamRepo}`,
    `**Issue:** #${notification.primaryIssueNumber}`,
    `**Halted at state:** ${notification.haltedAtState}`,
    '',
    '## Usage at Halt',
    '',
    `- **Tokens used:** ${notification.usage.tokensUsed}`,
    `- **Estimated cost:** $${notification.usage.costUsd.toFixed(4)}`,
    '',
    '## Configured Limits',
    '',
  ];

  if (notification.config.max_tokens_per_run !== null) {
    lines.push(`- **Token cap:** ${notification.config.max_tokens_per_run}`);
  }
  if (notification.config.max_cost_per_run !== null) {
    lines.push(`- **Cost cap:** $${notification.config.max_cost_per_run}`);
  }

  lines.push('', '---', '', notification.summary);

  return lines.join('\n');
}

/**
 * Formats the cost breach email subject.
 */
export function formatCostBreachSubject(upstreamRepo: string, issueNumber: number): string {
  return `${COST_BREACH_EMAIL_SUBJECT_PREFIX} ${upstreamRepo}#${issueNumber}`;
}

// ─── Fork Cleanup ──────────────────────────────────────────────────────────────

/**
 * Validates a fork cleanup policy string.
 */
export function validateForkCleanupPolicy(policy: string): policy is ForkCleanupPolicy {
  return ['immediate-after-merge', 'delayed', 'never'].includes(policy);
}

/**
 * Creates a ForkCleanupConfig with defaults.
 */
export function createForkCleanupConfig(
  forkFullName: string,
  branchName: string,
  policy?: ForkCleanupPolicy,
  delayHours?: number
): ForkCleanupConfig {
  return {
    policy: policy ?? DEFAULT_FORK_CLEANUP_POLICY,
    delayHours: delayHours ?? DEFAULT_CLEANUP_DELAY_HOURS,
    forkFullName,
    branchName,
  };
}

/**
 * Executes fork cleanup based on the configured policy.
 */
export async function executeForkCleanup(
  config: ForkCleanupConfig,
  cleaner: ForkCleaner
): Promise<ForkCleanupResult> {
  if (config.policy === 'never') {
    return {
      executed: false,
      action: 'skipped',
      scheduledAt: null,
      message: `Fork cleanup skipped (policy: never) for ${config.forkFullName}`,
    };
  }

  if (config.policy === 'delayed') {
    const scheduledAt = new Date(Date.now() + config.delayHours * 60 * 60 * 1000).toISOString();
    return {
      executed: false,
      action: 'scheduled',
      scheduledAt,
      message: `Fork cleanup scheduled for ${config.delayHours}h from now for ${config.forkFullName}:${config.branchName}`,
    };
  }

  // immediate-after-merge
  try {
    await cleaner.deleteBranch(config.forkFullName, config.branchName);

    // Check if there are other branches; if only default remains, delete the fork
    const branches = await cleaner.listBranches(config.forkFullName);
    const nonDefaultBranches = branches.filter(b => b !== 'main' && b !== 'master');

    if (nonDefaultBranches.length === 0) {
      await cleaner.deleteFork(config.forkFullName);
      return {
        executed: true,
        action: 'fork_deleted',
        scheduledAt: null,
        message: `Fork ${config.forkFullName} deleted (no remaining branches)`,
      };
    }

    return {
      executed: true,
      action: 'branch_deleted',
      scheduledAt: null,
      message: `Branch ${config.branchName} deleted from ${config.forkFullName}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new ForkCleanupError(
      `Failed to clean up fork: ${msg}`,
      'cleanup',
      config.forkFullName
    );
  }
}

/**
 * Executes delayed cleanup (called by a scheduled job).
 */
export async function executeDelayedCleanup(
  config: ForkCleanupConfig,
  cleaner: ForkCleaner
): Promise<ForkCleanupResult> {
  const immediateConfig: ForkCleanupConfig = {
    ...config,
    policy: 'immediate-after-merge',
  };
  return executeForkCleanup(immediateConfig, cleaner);
}

// ─── Run History Dashboard ─────────────────────────────────────────────────────

/**
 * Formats a run history entry for CLI display.
 */
export function formatRunHistoryEntry(entry: RunHistoryEntry): string {
  const duration = formatDuration(entry.durationSeconds);
  const cost = entry.costUsd > 0 ? `$${entry.costUsd.toFixed(4)}` : '-';
  const issues = entry.issueIds.map(id => `#${id}`).join(', ');
  const pr = entry.prUrl ? ` → ${entry.prUrl}` : '';

  return `${entry.runId} | ${entry.repo} | ${issues} | ${entry.state} | ${duration} | retries: ${entry.retryCount} | cost: ${cost}${pr}`;
}

/**
 * Formats duration seconds into a human-readable string.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Formats run history stats for CLI display.
 */
export function formatRunHistoryStats(stats: RunHistoryStats): string {
  const lines: string[] = [
    '═══ Run History Summary ═══',
    '',
    `Total runs:       ${stats.totalRuns}`,
    `Success rate:     ${(stats.successRate * 100).toFixed(1)}%`,
    `Total cost:       $${stats.totalCostUsd.toFixed(4)}`,
    `Total tokens:     ${stats.totalTokensUsed}`,
    `Avg duration:     ${formatDuration(stats.avgDurationSeconds)}`,
    '',
    '── By State ──',
  ];

  for (const [state, count] of Object.entries(stats.byState)) {
    lines.push(`  ${state}: ${count}`);
  }

  return lines.join('\n');
}

/**
 * Renders a full run history dashboard (CLI output).
 */
export function renderDashboard(
  entries: RunHistoryEntry[],
  stats: RunHistoryStats
): string {
  const lines: string[] = [
    formatRunHistoryStats(stats),
    '',
    '═══ Recent Runs ═══',
    '',
  ];

  if (entries.length === 0) {
    lines.push('  No runs found.');
  } else {
    for (const entry of entries) {
      lines.push(`  ${formatRunHistoryEntry(entry)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Queries run history from the store with optional filters.
 */
export function queryRunHistory(
  store: RunHistoryStore,
  filter?: RunHistoryFilter
): { entries: RunHistoryEntry[]; stats: RunHistoryStats } {
  const entries = store.getHistory(filter ?? {});
  const stats = store.getStats(filter);
  return { entries, stats };
}

/**
 * Calculates stats from an array of run history entries.
 */
export function calculateStats(entries: RunHistoryEntry[]): RunHistoryStats {
  if (entries.length === 0) {
    return {
      totalRuns: 0,
      byState: {},
      totalCostUsd: 0,
      totalTokensUsed: 0,
      avgDurationSeconds: 0,
      successRate: 0,
    };
  }

  const byState: Record<string, number> = {};
  let totalCost = 0;
  let totalTokens = 0;
  let totalDuration = 0;
  let completedRuns = 0;
  let successfulRuns = 0;

  for (const entry of entries) {
    byState[entry.state] = (byState[entry.state] || 0) + 1;
    totalCost += entry.costUsd;
    totalTokens += entry.tokensUsed;
    totalDuration += entry.durationSeconds;

    if (entry.state === RunState.PR_OPEN || entry.state === RunState.FAILED) {
      completedRuns++;
      if (entry.state === RunState.PR_OPEN) {
        successfulRuns++;
      }
    }
  }

  return {
    totalRuns: entries.length,
    byState,
    totalCostUsd: totalCost,
    totalTokensUsed: totalTokens,
    avgDurationSeconds: Math.round(totalDuration / entries.length),
    successRate: completedRuns > 0 ? successfulRuns / completedRuns : 0,
  };
}

// ─── Scenario Integration Tests Support ────────────────────────────────────────

/**
 * Scenario types from PRD section 8.1 for end-to-end test coverage.
 */
export type ScenarioType =
  | 'simple_bug_fix'
  | 'feature_with_design'
  | 'retry_success'
  | 'max_retries_exceeded';

/**
 * Scenario test result.
 */
export interface ScenarioTestResult {
  scenario: ScenarioType;
  passed: boolean;
  finalState: RunState;
  retryCount: number;
  costUsd: number;
  tokensUsed: number;
  durationSeconds: number;
  prUrl: string | null;
  notes: string;
}

/**
 * Validates that a scenario ran to the expected end state.
 */
export function validateScenarioOutcome(
  scenario: ScenarioType,
  finalState: RunState,
  retryCount: number,
  prUrl: string | null
): { valid: boolean; reason: string } {
  switch (scenario) {
    case 'simple_bug_fix':
      if (finalState !== RunState.PR_OPEN) {
        return { valid: false, reason: `Expected PR_OPEN, got ${finalState}` };
      }
      if (retryCount > 0) {
        return { valid: false, reason: `Simple bug fix should not need retries, got ${retryCount}` };
      }
      if (!prUrl) {
        return { valid: false, reason: 'Expected PR URL for simple bug fix' };
      }
      return { valid: true, reason: 'Simple bug fix completed successfully' };

    case 'feature_with_design':
      if (finalState !== RunState.PR_OPEN) {
        return { valid: false, reason: `Expected PR_OPEN, got ${finalState}` };
      }
      if (!prUrl) {
        return { valid: false, reason: 'Expected PR URL for feature with design' };
      }
      return { valid: true, reason: 'Feature with design completed successfully' };

    case 'retry_success':
      if (finalState !== RunState.PR_OPEN) {
        return { valid: false, reason: `Expected PR_OPEN, got ${finalState}` };
      }
      if (retryCount === 0) {
        return { valid: false, reason: 'Retry success should have retryCount > 0' };
      }
      if (!prUrl) {
        return { valid: false, reason: 'Expected PR URL for retry success' };
      }
      return { valid: true, reason: `Retry success after ${retryCount} retries` };

    case 'max_retries_exceeded':
      if (finalState !== RunState.FAILED) {
        return { valid: false, reason: `Expected FAILED, got ${finalState}` };
      }
      if (prUrl) {
        return { valid: false, reason: 'Max retries exceeded should not have PR URL' };
      }
      return { valid: true, reason: 'Max retries exceeded, correctly failed' };

    default:
      return { valid: false, reason: `Unknown scenario: ${scenario}` };
  }
}
