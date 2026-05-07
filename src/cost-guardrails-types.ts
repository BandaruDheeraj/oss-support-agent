/**
 * Types for cost guardrails, fork cleanup, and run history dashboard (US-019).
 * Provides per-run token/cost caps, fork cleanup policies, and a run history view.
 */

import { RunState } from './orchestrator/types';

// ─── Cost Guardrails ───────────────────────────────────────────────────────────

/**
 * Per-run cost configuration, added to the manifest.
 */
export interface CostConfig {
  /** Maximum tokens allowed per run (null = unlimited) */
  max_tokens_per_run: number | null;
  /** Maximum cost in USD per run (null = unlimited) */
  max_cost_per_run: number | null;
  /** Cost per 1K tokens (for estimation) */
  cost_per_1k_tokens: number;
}

/**
 * Token/cost usage tracked during a run.
 */
export interface RunUsage {
  /** Run ID */
  runId: string;
  /** Total tokens consumed so far */
  tokensUsed: number;
  /** Estimated cost in USD so far */
  costUsd: number;
  /** Timestamps of usage increments */
  lastUpdated: string;
}

/**
 * Result of a cost check.
 */
export interface CostCheckResult {
  /** Whether the run is within budget */
  withinBudget: boolean;
  /** Which cap was breached (null if within budget) */
  breachedCap: 'token' | 'cost' | null;
  /** Current usage */
  usage: RunUsage;
  /** The configured limits */
  config: CostConfig;
  /** Human-readable message */
  message: string;
}

/**
 * Partial state snapshot sent to the user on cost breach.
 */
export interface CostBreachNotification {
  /** Run ID */
  runId: string;
  /** Upstream repo */
  upstreamRepo: string;
  /** Primary issue number */
  primaryIssueNumber: number;
  /** Current state when halted */
  haltedAtState: RunState;
  /** Usage at halt */
  usage: RunUsage;
  /** Configured caps */
  config: CostConfig;
  /** Summary message */
  summary: string;
}

// ─── Fork Cleanup ──────────────────────────────────────────────────────────────

/**
 * Fork cleanup policy options.
 */
export type ForkCleanupPolicy = 'immediate-after-merge' | 'delayed' | 'never';

/** Default cleanup policy */
export const DEFAULT_FORK_CLEANUP_POLICY: ForkCleanupPolicy = 'delayed';

/** Default delay for delayed cleanup (in hours) */
export const DEFAULT_CLEANUP_DELAY_HOURS = 72;

/**
 * Fork cleanup configuration.
 */
export interface ForkCleanupConfig {
  /** Cleanup policy */
  policy: ForkCleanupPolicy;
  /** Delay in hours for 'delayed' policy */
  delayHours: number;
  /** Fork full name (org/repo) */
  forkFullName: string;
  /** Branch name to clean up */
  branchName: string;
}

/**
 * Result of a fork cleanup operation.
 */
export interface ForkCleanupResult {
  /** Whether cleanup was executed */
  executed: boolean;
  /** Action taken */
  action: 'branch_deleted' | 'fork_deleted' | 'scheduled' | 'skipped';
  /** When scheduled cleanup will occur (ISO timestamp, null if not scheduled) */
  scheduledAt: string | null;
  /** Message describing what happened */
  message: string;
}

/**
 * Interface for fork cleanup operations (for testability).
 */
export interface ForkCleaner {
  /** Delete a branch from the fork */
  deleteBranch(forkFullName: string, branchName: string): Promise<void>;
  /** Delete the entire fork (only if no other branches exist) */
  deleteFork(forkFullName: string): Promise<void>;
  /** List branches in the fork */
  listBranches(forkFullName: string): Promise<string[]>;
}

// ─── Run History Dashboard ─────────────────────────────────────────────────────

/**
 * A run history entry for the dashboard.
 */
export interface RunHistoryEntry {
  /** Run ID */
  runId: string;
  /** Upstream repo */
  repo: string;
  /** Issue IDs in scope */
  issueIds: number[];
  /** Current state */
  state: RunState;
  /** Duration in seconds (from creation to last state change) */
  durationSeconds: number;
  /** Number of retries */
  retryCount: number;
  /** Estimated cost in USD */
  costUsd: number;
  /** Tokens used */
  tokensUsed: number;
  /** When the run started */
  createdAt: string;
  /** When the run last changed state */
  updatedAt: string;
  /** PR URL if one was opened */
  prUrl: string | null;
}

/**
 * Filters for run history queries.
 */
export interface RunHistoryFilter {
  /** Filter by repo */
  repo?: string;
  /** Filter by state */
  state?: RunState;
  /** Filter by start date (ISO timestamp) */
  since?: string;
  /** Filter by end date (ISO timestamp) */
  until?: string;
  /** Maximum results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * Summary statistics for the dashboard.
 */
export interface RunHistoryStats {
  /** Total runs */
  totalRuns: number;
  /** Runs by state */
  byState: Record<string, number>;
  /** Total cost across all runs */
  totalCostUsd: number;
  /** Total tokens used */
  totalTokensUsed: number;
  /** Average duration in seconds */
  avgDurationSeconds: number;
  /** Success rate (PR_OPEN / completed runs) */
  successRate: number;
}

/**
 * Interface for run history persistence (for testability).
 */
export interface RunHistoryStore {
  /** Record usage increment for a run */
  recordUsage(runId: string, tokensUsed: number, costUsd: number): void;
  /** Get current usage for a run */
  getUsage(runId: string): RunUsage | null;
  /** Get run history entries */
  getHistory(filter: RunHistoryFilter): RunHistoryEntry[];
  /** Get aggregate stats */
  getStats(filter?: Partial<RunHistoryFilter>): RunHistoryStats;
  /** Record PR URL for a run */
  recordPrUrl(runId: string, prUrl: string): void;
}

// ─── Errors ────────────────────────────────────────────────────────────────────

/**
 * Error thrown when a cost cap is breached.
 */
export class CostCapBreachedError extends Error {
  public readonly runId: string;
  public readonly breachedCap: 'token' | 'cost';
  public readonly usage: RunUsage;
  public readonly config: CostConfig;

  constructor(runId: string, breachedCap: 'token' | 'cost', usage: RunUsage, config: CostConfig) {
    const limit = breachedCap === 'token'
      ? `${config.max_tokens_per_run} tokens`
      : `$${config.max_cost_per_run}`;
    const current = breachedCap === 'token'
      ? `${usage.tokensUsed} tokens`
      : `$${usage.costUsd.toFixed(4)}`;
    super(`Cost cap breached for run '${runId}': ${current} exceeds limit of ${limit}`);
    this.name = 'CostCapBreachedError';
    this.runId = runId;
    this.breachedCap = breachedCap;
    this.usage = usage;
    this.config = config;
  }
}

/**
 * Error during fork cleanup.
 */
export class ForkCleanupError extends Error {
  public readonly phase: string;
  public readonly forkFullName: string;

  constructor(message: string, phase: string, forkFullName: string) {
    super(message);
    this.name = 'ForkCleanupError';
    this.phase = phase;
    this.forkFullName = forkFullName;
  }
}

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Default cost per 1K tokens (GPT-4 class pricing estimate) */
export const DEFAULT_COST_PER_1K_TOKENS = 0.03;

/** Default max tokens per run (null = unlimited) */
export const DEFAULT_MAX_TOKENS_PER_RUN: number | null = null;

/** Default max cost per run (null = unlimited) */
export const DEFAULT_MAX_COST_PER_RUN: number | null = null;

/** Email subject prefix for cost breach notifications */
export const COST_BREACH_EMAIL_SUBJECT_PREFIX = '[agent-fix] COST LIMIT:';
