/**
 * Trace smoke test — invokes one span per OpenInference kind through the
 * pluggable observability tracer and asserts the path flushes cleanly.
 *
 * Run via: ts-node bin/trace-smoke.ts
 * Or as a one-off integration check in CI when OTEL endpoints are set.
 *
 * This module exports the assertion helpers used by the bin entrypoint.
 */

import {
  OPENINFERENCE_SPAN_KINDS,
  currentSpan,
  getTracer,
  type OpenInferenceSpanKind,
} from './tracer';
import { withOpenInferenceSpan } from './spans';

export interface SmokeResult {
  agentSpanEmitted: boolean;
  toolSpanEmitted: boolean;
  allKindSpansEmitted: boolean;
  emittedKinds: OpenInferenceSpanKind[];
  flushedOk: boolean;
  errors: string[];
}

export async function runTraceSmoke(): Promise<SmokeResult> {
  const errors: string[] = [];
  const emitted = new Set<OpenInferenceSpanKind>();

  await withOpenInferenceSpan('telemetry_smoke.chain', 'CHAIN', {
    issue_number: 0,
    attempt_id: 'smoke',
    agent_name: 'smoke',
  }, async (root) => {
    emitted.add('CHAIN');
    root.setInput({ synthetic: true, kind: 'CHAIN' });
    root.setOutput({ ok: true });

    for (const kind of OPENINFERENCE_SPAN_KINDS) {
      if (kind === 'CHAIN') continue;
      await withOpenInferenceSpan(`telemetry_smoke.${kind.toLowerCase()}`, kind, {
        issue_number: 0,
        attempt_id: 'smoke',
        agent_name: 'smoke',
      }, async (span) => {
        if (currentSpan()) emitted.add(kind);
        span.setInput({ synthetic: true, kind });
        span.setOutput({ ok: true });
        return 'ok';
      });
    }
    return 'ok';
  }).catch((e) => errors.push(`span error: ${(e as Error).message}`));

  let flushedOk = false;
  try {
    await getTracer().flush();
    flushedOk = true;
  } catch (e) {
    errors.push(`flush error: ${(e as Error).message}`);
  }

  const emittedKinds = OPENINFERENCE_SPAN_KINDS.filter((kind) => emitted.has(kind));
  return {
    agentSpanEmitted: emitted.has('AGENT'),
    toolSpanEmitted: emitted.has('TOOL'),
    allKindSpansEmitted: emittedKinds.length === OPENINFERENCE_SPAN_KINDS.length,
    emittedKinds,
    flushedOk,
    errors,
  };
}
