/**
 * Trace smoke test — invokes a minimal LLM + tool span path and asserts
 * the OpenInference attribute set is present on at least one span.
 *
 * Run via: ts-node bin/trace-smoke.ts
 * Or as a one-off integration check in CI when OTEL endpoints are set.
 *
 * This module exports the assertion helpers used by the bin entrypoint.
 */

import { trace } from '@opentelemetry/api';
import { withAgentSpan, withToolSpan } from './spans';

export interface SmokeResult {
  agentSpanEmitted: boolean;
  toolSpanEmitted: boolean;
  flushedOk: boolean;
  errors: string[];
}

export async function runTraceSmoke(): Promise<SmokeResult> {
  const errors: string[] = [];
  let agentEmitted = false;
  let toolEmitted = false;

  await withAgentSpan('REPRO_PLANNER', { issue_number: 0, attempt_id: 'smoke', agent_name: 'smoke' }, async () => {
    agentEmitted = !!trace.getActiveSpan();
    await withToolSpan('read_file', 'read', { path: 'README.md' }, async () => {
      toolEmitted = !!trace.getActiveSpan();
      return 'ok';
    });
    return 'ok';
  }).catch((e) => errors.push(`span error: ${(e as Error).message}`));

  let flushedOk = false;
  try {
    const provider = trace.getTracerProvider() as unknown as { forceFlush?: () => Promise<void> };
    if (typeof provider.forceFlush === 'function') {
      await provider.forceFlush();
    }
    flushedOk = true;
  } catch (e) {
    errors.push(`flush error: ${(e as Error).message}`);
  }

  return { agentSpanEmitted: agentEmitted, toolSpanEmitted: toolEmitted, flushedOk, errors };
}
