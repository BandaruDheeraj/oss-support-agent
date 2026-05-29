/**
 * Generic tool-using agent loop runner.
 *
 * Drives a Vercel AI SDK `generateText` call with `maxSteps`, surfaces
 * registry guard errors back to the model as tool responses, and stops on:
 *   - registry termination (done | abandon)
 *   - maxTurns hit
 *   - SDK finishReason !== 'tool-calls' (i.e. model returned final text)
 *
 * Emits an agent-level OTEL span around the whole call. LLM spans are
 * emitted by the SDK's experimental_telemetry; tool spans are emitted
 * by the registry.
 */

import { generateText, type CoreMessage } from 'ai';
import { getModel, type PhaseEAgent } from '../llm/v2/client';
import { withAgentSpan } from '../observability/spans';
import { ToolRegistry } from './tools/registry';

export interface RunAgentLoopArgs {
  agent: PhaseEAgent;
  registry: ToolRegistry;
  system: string;
  user: string;
  /** Optional priming messages (e.g. dossier markdown). */
  priming?: CoreMessage[];
  attemptId: string;
  issueNumber: number;
  dossierSnapshotId?: string;
  /** Override the model id (defaults to env-based selection). */
  modelOverride?: string;
}

export interface AgentLoopResult {
  text: string;
  terminated: 'done' | 'abandon' | 'max_turns' | 'finished' | 'error';
  reason?: string;
  turns: number;
  toolCalls: number;
  toolCallsByTier: Record<string, number>;
  transcriptSummary: string;
}

export async function runAgentLoop(args: RunAgentLoopArgs): Promise<AgentLoopResult> {
  const first = await runAgentLoopOnce(args);

  // SAFETY NET — when generateText throws (e.g. Vercel AI SDK's
  // InvalidToolArgumentsError from a missing required field on a strict
  // tool schema), the model never sees the error and can't self-correct.
  // We retry exactly once, surfacing the error into the user prompt so the
  // model has a concrete signal to fix its next tool call. This benefits
  // ALL agents (analyst, planner, executor, critic) — every one of them
  // has at least one strict structured tool that an LLM can mis-emit.
  if (first.terminated !== 'error' || !first.reason) return first;

  const isJsonParseFailure = first.reason.includes('JSON parsing failed');
  const corrective = isJsonParseFailure
    ? `${args.user}\n\n[ORCHESTRATOR REMINDER] Your previous terminal tool call failed JSON parsing:\n` +
      `  ${truncate(first.reason, 800)}\n\n` +
      `This usually happens when the model appends extra tokens after the JSON object (e.g. XML envelope tokens like </parameter></invoke>, prose, or partial duplicate keys). ` +
      `Emit your tool call with VALID JSON arguments — ONE single JSON object, no trailing text, no XML tags, no commentary. ` +
      `If your previous call was too large (>4KB), drop optional fields like \`candidateRepro\` and \`evidence[].detail\` text to slim it down. ` +
      `When in doubt, omit candidateRepro entirely.`
    : `${args.user}\n\n[ORCHESTRATOR REMINDER] Your previous attempt aborted with a tool-validation error:\n` +
      `  ${truncate(first.reason, 1200)}\n\n` +
      `Re-emit your terminal tool call with VALID arguments. Inspect the tool's parameter schema carefully — ` +
      `all fields without an "optional" marker are required. Do NOT drop any required field. ` +
      `If you need to record evidence, every evidence item needs id, kind, source, and summary at minimum.`;

  const retry = await runAgentLoopOnce({ ...args, user: corrective });
  return {
    ...retry,
    toolCalls: first.toolCalls + retry.toolCalls,
    turns: first.turns + retry.turns,
    transcriptSummary: retry.transcriptSummary,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Classify common upstream model-provider errors that the AI SDK rethrows
 * as opaque strings. Tagging them up front makes the halt comment in
 * GitHub (and the maintainer email) actionable instead of a generic
 * stack-trace dump.
 */
function classifyAgentLoopError(raw: string): string {
  const lower = raw.toLowerCase();
  const tag = (kind: string) => `[${kind}] ${truncate(raw, 800)}`;
  if (
    lower.includes('insufficient credit') ||
    lower.includes('out of credit') ||
    lower.includes('credit balance') ||
    lower.includes('quota exceeded') ||
    lower.includes('payment required') ||
    lower.includes('402')
  ) {
    return tag('credits-exhausted');
  }
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
    return tag('rate-limited');
  }
  if (lower.includes('overloaded') || lower.includes('503') || lower.includes('upstream') || lower.includes('bad gateway') || lower.includes('502')) {
    return tag('provider-unavailable');
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return tag('timeout');
  }
  if (lower.includes('invalid_request') || lower.includes('invalid request') || lower.includes('400')) {
    return tag('invalid-request');
  }
  return truncate(raw, 800);
}

async function runAgentLoopOnce(args: RunAgentLoopArgs): Promise<AgentLoopResult> {
  const { agent, registry } = args;
  const model = getModel(agent, args.modelOverride);
  const tools = registry.toAiSdkTools();

  return withAgentSpan(
    agent,
    {
      attempt_id: args.attemptId,
      issue_number: args.issueNumber,
      dossier_snapshot_id: args.dossierSnapshotId,
      'agent.tool_count': Object.keys(tools).length,
    },
    async () => {
      const messages: CoreMessage[] = [
        ...(args.priming ?? []),
        { role: 'user', content: args.user },
      ];

      let terminated: AgentLoopResult['terminated'] = 'finished';
      let reason: string | undefined;
      let finalText = '';
      let totalTurns = 0;

      try {
        const result = await generateText({
          model,
          system: args.system,
          messages,
          tools,
          toolChoice: 'auto',
          maxSteps: args.registry.maxTurns(),
          maxTokens: Number(process.env.AGENT_LOOP_MAX_TOKENS ?? 16000),
          experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
          onStepFinish: (step) => {
            totalTurns += 1;
            registry.beginTurn();
            const t = registry.isTerminated();
            if (t) {
              terminated = t.kind;
              reason = t.reason;
            }
          },
        });

        finalText = result.text;
        if (terminated === 'finished' && result.finishReason !== 'stop') {
          if (result.finishReason === 'length') {
            terminated = 'max_turns';
          }
        }
        // Even on terminated='finished' with finishReason='stop', the model
        // may have abandoned silently (plain-text exit with no terminal tool
        // call). Surface finishReason + a finalText preview into `reason` so
        // downstream halt-comments and emails self-diagnose instead of
        // rendering as a bare "(finished)".
        if (!reason && (terminated === 'finished' || terminated === 'max_turns')) {
          const preview = truncate((finalText || '').replace(/\s+/g, ' ').trim(), 320);
          const fr = result.finishReason ?? 'unknown';
          reason = preview
            ? `finishReason=${fr}; finalText=${JSON.stringify(preview)}`
            : `finishReason=${fr}; finalText=(empty)`;
        }
      } catch (err) {
        terminated = 'error';
        const raw = err instanceof Error ? err.message : String(err);
        reason = classifyAgentLoopError(raw);
        finalText = '';
      }

      const transcript = registry.getTranscript();
      const tierUsage = registry.tierUsage();
      const summary = summariseTranscript(transcript);

      return {
        text: finalText,
        terminated,
        reason,
        turns: totalTurns,
        toolCalls: transcript.length,
        toolCallsByTier: tierUsage,
        transcriptSummary: summary,
      };
    }
  );
}

function summariseTranscript(transcript: { tool: string; tier: string; ok: boolean }[]): string {
  if (transcript.length === 0) return '(no tool calls)';
  const counts: Record<string, { ok: number; err: number }> = {};
  for (const e of transcript) {
    counts[e.tool] = counts[e.tool] || { ok: 0, err: 0 };
    if (e.ok) counts[e.tool].ok += 1;
    else counts[e.tool].err += 1;
  }
  return Object.entries(counts)
    .map(([k, v]) => `${k}(${v.ok}${v.err ? `/${v.err}err` : ''})`)
    .join(' ');
}
