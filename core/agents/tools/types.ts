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
