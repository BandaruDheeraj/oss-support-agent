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
          maxSteps: 30,
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
      } catch (err) {
        terminated = 'error';
        reason = err instanceof Error ? err.message : String(err);
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
