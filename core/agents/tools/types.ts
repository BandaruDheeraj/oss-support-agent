/**
 * Tool registry types.
 */

import { z } from 'zod';

export type ToolTier = 'read' | 'note' | 'write-test' | 'mutation' | 'sandbox' | 'meta';

export const STATEFUL_TIERS: ToolTier[] = ['write-test', 'mutation', 'sandbox', 'meta'];
export const DONE_FORBIDDEN_SAME_TURN: ToolTier[] = ['mutation', 'sandbox', 'write-test'];

export interface ToolDef<TArgs, TResult> {
  name: string;
  tier: ToolTier;
  description: string;
  parameters: z.ZodType<TArgs, z.ZodTypeDef, any>;
  execute(args: TArgs, ctx: ToolContext): Promise<TResult>;
}

export interface ToolContext {
  agentName: string;
  attemptId: string;
  issueNumber: number;
  dossierSnapshotId?: string;
  handles: Record<string, unknown>;
  recordTranscript: (entry: TranscriptEntry) => void;
  getTranscript: () => TranscriptEntry[];
}

export interface TranscriptEntry {
  turn: number;
  tool: string;
  tier: ToolTier;
  args: unknown;
  result: unknown;
  ok: boolean;
  error?: string;
  startedAt: string;
  durationMs: number;
}

export interface RegistryBudgets {
  total: number;
  perTier: Partial<Record<ToolTier, number>>;
}

export interface RegistryOptions {
  budgets: RegistryBudgets;
  maxTurns: number;
  now?: () => Date;
  /**
   * Optional hard caps by tool name. Once a tool reaches its cap, further calls
   * return budget_exhausted so the model pivots instead of looping.
   */
  perToolCaps?: Partial<Record<string, number>>;
  /**
   * Reserve the last N tool calls for terminal/finalization tools. When the
   * remaining total budget is <= calls, only allowTools may execute.
   */
  finalizationReserve?: {
    calls: number;
    allowTools: string[];
  };
  /**
   * Optional predicate evaluated when the model calls `abandon`. Receives the
   * full transcript so far. Return null to allow the abandon, or a string
   * explaining why the abandon is premature — the registry will throw a
   * ToolGuardError with that message so the model keeps working.
   */
  abandonGate?: (transcript: TranscriptEntry[]) => string | null;
  /**
   * Optional per-tool soft gates evaluated BEFORE the tool runs. Keyed by
   * tool name. Each gate receives the transcript so far and returns null to
   * allow the call, or a string error message — the registry throws a
   * ToolGuardError so the model sees the message as an in-band tool response
   * and can react on the next turn.
   *
   * Used by the Repro Executor registry to enforce a probe-first procedure:
   *   - write_test: blocked until the verified-state ledger shows ≥1
   *     successful probe (run_python or python_module_check importable=true).
   *   - revise_test: blocked unless the most recent successful stateful tool
   *     call was run_repro (forces an observation between rewrites).
   */
  toolGates?: Record<string, (transcript: TranscriptEntry[]) => string | null>;
  /**
   * Optional post-execution hook that can wrap successful tool results before
   * they are returned to the model. Receives the tool def, the original
   * result, and the transcript-so-far (NOT yet including the in-flight call).
   * Return the original result to pass through, or a wrapped/augmented value
   * to surface additional hints to the model.
   *
   * Used by the Repro Prober registry to nudge the model out of research
   * spirals when the verified-state ledger shows write_test is unblocked but
   * the model keeps grepping. Errors thrown here are swallowed (the original
   * result is returned) so a bad augmenter cannot break a tool call.
   */
  responseAugmenter?: (args: {
    def: { name: string; tier: ToolTier };
    result: unknown;
    transcript: TranscriptEntry[];
  }) => unknown;
}

export class ToolGuardError extends Error {
  public readonly kind:
    | 'budget_exhausted'
    | 'parallel_forbidden'
    | 'done_in_same_turn'
    | 'done_without_prior_result'
    | 'tier_unauthorized'
    | 'tool_unknown'
    | 'invalid_args'
    | 'hypothesis_required'
    | 'patch_scope'
    | 'abandon_premature'
    | 'tool_gate_blocked';
  public readonly tool?: string;

  constructor(kind: ToolGuardError['kind'], message: string, tool?: string) {
    super(message);
    this.name = 'ToolGuardError';
    this.kind = kind;
    this.tool = tool;
  }
}

export const ZodNoArgs = z.object({}).strict();
export type NoArgs = z.infer<typeof ZodNoArgs>;
