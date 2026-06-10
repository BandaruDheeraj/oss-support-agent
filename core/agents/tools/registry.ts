/**
 * Tool registry shell with Phase E guards.
 */

import { tool as aiTool, type CoreTool } from 'ai';

/** Recursively convert null → undefined so Zod .optional()/.default() fire correctly. */
export function nullToUndefinedDeep(v: unknown): unknown {
  if (v === null) return undefined;
  if (Array.isArray(v)) return v.map(nullToUndefinedDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, nullToUndefinedDeep(val)])
    );
  }
  return v;
}
import { z } from 'zod';
import { withToolSpan } from '../../observability/spans';
import { redactValue } from '../../observability/redact';
import {
  DONE_FORBIDDEN_SAME_TURN,
  STATEFUL_TIERS,
  ToolGuardError,
  type RegistryOptions,
  type ToolContext,
  type ToolDef,
  type ToolTier,
  type TranscriptEntry,
} from './types';

type AnyToolDef = ToolDef<any, any>;

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDef>();
  private readonly tierCounts = new Map<ToolTier, number>();
  private readonly toolCounts = new Map<string, number>();
  private totalCalls = 0;
  private turn = 0;
  private currentTurnCalls: { name: string; tier: ToolTier }[] = [];
  private previousTurnHadResult = false;
  private terminated: { kind: 'done' | 'abandon'; reason?: string } | null = null;
  private readonly transcript: TranscriptEntry[] = [];
  private readonly opts: RegistryOptions;
  private readonly ctx: ToolContext;
  private readonly now: () => Date;

  constructor(opts: RegistryOptions, ctx: Omit<ToolContext, 'recordTranscript' | 'getTranscript'>) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
    this.ctx = {
      ...ctx,
      recordTranscript: (e) => this.transcript.push(e),
      getTranscript: () => this.transcript,
    };
  }

  /**
   * Per-registry hard cap on model turns. Used by `agent-loop.ts` to size
   * the Vercel AI SDK `maxSteps` so a Critic (maxTurns: 8) doesn't get the
   * same 40-step budget as a Repro Executor (maxTurns: 22). Historically
   * `maxSteps` was hardcoded to 40 across every agent — burning ~80% extra
   * tokens on the shorter-lived stages.
   */
  maxTurns(): number {
    return this.opts.maxTurns;
  }

  register(def: AnyToolDef): this {
    if (this.tools.has(def.name)) throw new Error(`Tool already registered: ${def.name}`);
    this.tools.set(def.name, def);
    return this;
  }

  registerMany(defs: AnyToolDef[]): this {
    defs.forEach((d) => this.register(d));
    return this;
  }

  beginTurn(): number {
    this.previousTurnHadResult = this.currentTurnCalls.length > 0;
    this.turn += 1;
    this.currentTurnCalls = [];
    return this.turn;
  }

  isTerminated(): { kind: 'done' | 'abandon'; reason?: string } | null {
    return this.terminated;
  }

  getTranscript(): TranscriptEntry[] {
    return this.transcript.slice();
  }

  getContext(): ToolContext {
    return this.ctx;
  }

  toolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  tierUsage(): Record<ToolTier, number> {
    const out: Record<ToolTier, number> = {
      read: 0,
      note: 0,
      'write-test': 0,
      mutation: 0,
      sandbox: 0,
      meta: 0,
    };
    for (const [k, v] of this.tierCounts.entries()) out[k] = v;
    return out;
  }

  toAiSdkTools(): Record<string, CoreTool> {
    const out: Record<string, CoreTool> = {};
    for (const def of this.tools.values()) {
      out[def.name] = aiTool({
        description: def.description,
        parameters: def.parameters as unknown as z.ZodSchema,
        execute: async (args: unknown) => this.dispatch(def, args),
      });
    }
    return out;
  }

  async dispatch<TArgs, TResult>(
    def: ToolDef<TArgs, TResult>,
    rawArgs: unknown
  ): Promise<TResult | { __toolError: string; __kind: string }> {
    // Convert null → undefined before Zod validates: LLMs (especially Anthropic)
    // emit null for absent optional fields. Zod's .optional()/.default() fire on
    // undefined but not null. This is safe for all tools since null is never
    // semantically distinct from undefined in our tool parameter schemas.
    const sanitizedArgs = nullToUndefinedDeep(rawArgs);
    const parsed = def.parameters.safeParse(sanitizedArgs);
    if (!parsed.success) {
      return errorReturn(
        new ToolGuardError('invalid_args', `Invalid args for ${def.name}: ${parsed.error.message}`, def.name)
      );
    }

    try {
      this.enforceGuards(def);
    } catch (err) {
      if (err instanceof ToolGuardError) {
        // Record blocked attempts in the transcript with ok:false so
        // post-mortems can see whether a gate fired and how often, without
        // consuming tier/total budget (which only increments on actual
        // execution). Verified-state derivation ignores !ok entries so
        // gate-blocked attempts don't pollute the ledger.
        this.transcript.push({
          turn: this.turn,
          tool: def.name,
          tier: def.tier,
          args: redactValue(parsed.data),
          result: undefined,
          ok: false,
          error: `[${err.kind}] ${err.message}`.slice(0, 2000),
          startedAt: (this.now()).toISOString(),
          durationMs: 0,
        });
        return errorReturn(err);
      }
      throw err;
    }

    const startedAt = this.now();
    const tier = def.tier;

    return withToolSpan(
      def.name,
      tier,
      {
        agent_name: this.ctx.agentName,
        attempt_id: this.ctx.attemptId,
        issue_number: this.ctx.issueNumber,
        dossier_snapshot_id: this.ctx.dossierSnapshotId,
        tool_args: safeJson(redactValue(parsed.data)),
      },
      async (span) => {
        let ok = true;
        let result: unknown = undefined;
        let errorMsg: string | undefined;
        try {
          result = await def.execute(parsed.data as TArgs, this.ctx);
          if (this.opts.responseAugmenter) {
            try {
              result = this.opts.responseAugmenter({
                def: { name: def.name, tier: def.tier },
                result,
                transcript: this.transcript,
              });
            } catch {
              /* swallow — never let an augmenter break a tool call */
            }
          }
          if (def.name === 'done') this.terminated = { kind: 'done' };
          if (def.name === 'abandon') {
            const reason = (parsed.data as any)?.reason;
            this.terminated = {
              kind: 'abandon',
              reason: typeof reason === 'string' ? reason : undefined,
            };
          }
          return result as TResult;
        } catch (err) {
          ok = false;
          errorMsg = err instanceof Error ? err.message : String(err);
          if (err instanceof ToolGuardError) {
            return errorReturn(err) as unknown as TResult;
          }
          throw err;
        } finally {
          this.totalCalls += 1;
          this.tierCounts.set(tier, (this.tierCounts.get(tier) ?? 0) + 1);
          this.toolCounts.set(def.name, (this.toolCounts.get(def.name) ?? 0) + 1);
          this.currentTurnCalls.push({ name: def.name, tier });
          const entry: TranscriptEntry = {
            turn: this.turn,
            tool: def.name,
            tier,
            args: redactValue(parsed.data),
            result: ok ? redactValue(result) : undefined,
            ok,
            error: errorMsg ? errorMsg.slice(0, 2000) : undefined,
            startedAt: startedAt.toISOString(),
            durationMs: Math.max(0, Date.now() - startedAt.getTime()),
          };
          this.transcript.push(entry);
          span.setAttribute('tool.turn', entry.turn);
        }
      }
    );
  }

  private enforceGuards(def: AnyToolDef): void {
    const reserve = this.opts.finalizationReserve;
    if (reserve && reserve.calls > 0) {
      const remaining = this.opts.budgets.total - this.totalCalls;
      const allowInReserve = reserve.allowTools.includes(def.name);
      if (remaining <= reserve.calls && !allowInReserve) {
        throw new ToolGuardError(
          'budget_exhausted',
          `Finalization reserve active (${reserve.calls} calls left). Only terminal tools may run: ${reserve.allowTools.join(', ')}.`,
          def.name
        );
      }
    }
    if (this.totalCalls >= this.opts.budgets.total) {
      throw new ToolGuardError(
        'budget_exhausted',
        `Total tool budget exhausted (${this.opts.budgets.total}). Emit abandon.`,
        def.name
      );
    }
    const cap = this.opts.budgets.perTier[def.tier];
    if (typeof cap === 'number' && (this.tierCounts.get(def.tier) ?? 0) >= cap) {
      throw new ToolGuardError(
        'budget_exhausted',
        `Tier "${def.tier}" budget exhausted (${cap}). Emit abandon.`,
        def.name
      );
    }
    const perToolCap = this.opts.perToolCaps?.[def.name];
    if (
      typeof perToolCap === 'number' &&
      Number.isFinite(perToolCap) &&
      (this.toolCounts.get(def.name) ?? 0) >= perToolCap
    ) {
      throw new ToolGuardError(
        'budget_exhausted',
        `Tool "${def.name}" budget exhausted (${perToolCap}). Choose a different tool or finalize.`,
        def.name
      );
    }

    if (STATEFUL_TIERS.includes(def.tier)) {
      const alreadyStateful = this.currentTurnCalls.some((c) => STATEFUL_TIERS.includes(c.tier));
      if (alreadyStateful) {
        throw new ToolGuardError(
          'parallel_forbidden',
          `Parallel tool calls forbidden for tier "${def.tier}". Make one stateful call per assistant turn.`,
          def.name
        );
      }
    }

    if (def.name === 'done') {
      const hasForbidden = this.currentTurnCalls.some((c) => DONE_FORBIDDEN_SAME_TURN.includes(c.tier));
      if (hasForbidden) {
        throw new ToolGuardError(
          'done_in_same_turn',
          `\`done\` is forbidden in the same model turn as mutation/sandbox/write-test calls. End this turn and emit \`done\` on the next turn after observing the result.`,
          def.name
        );
      }
      if (!this.previousTurnHadResult && this.turn > 1) {
        throw new ToolGuardError(
          'done_without_prior_result',
          '`done` is forbidden when the previous model turn produced no tool result.',
          def.name
        );
      }
    }

    if (def.name === 'abandon' && this.opts.abandonGate) {
      const blockReason = this.opts.abandonGate(this.transcript.slice());
      if (blockReason) {
        throw new ToolGuardError('abandon_premature', blockReason, def.name);
      }
    }

    const gate = this.opts.toolGates?.[def.name];
    if (gate) {
      const blockReason = gate(this.transcript.slice());
      if (blockReason) {
        throw new ToolGuardError('tool_gate_blocked', blockReason, def.name);
      }
    }
  }
}

function errorReturn(err: ToolGuardError) {
  return { __toolError: err.message, __kind: err.kind };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 4000);
  } catch {
    return '<unserializable>';
  }
}
