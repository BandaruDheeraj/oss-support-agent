/**
 * Span helpers.
 */

import { context, trace } from '@opentelemetry/api';
import {
  currentSpan,
  getTracer,
  runWithSpan as runWithActiveSpan,
  type OpenInferenceSpanKind,
  type Span,
} from './tracer';
import { redactString } from './redact';

export interface BaseSpanAttrs extends Record<string, unknown> {
  issue_number?: number;
  attempt_id?: string;
  dossier_snapshot_id?: string;
  agent_name?: string;
}

function redactedAttrs<T extends Record<string, unknown>>(attrs: T | undefined): Record<string, unknown> {
  if (!attrs) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (typeof v === 'string') out[k] = redactString(v);
    else if (Array.isArray(v) || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = String(v);
  }
  return out;
}

export async function withOpenInferenceSpan<T>(
  name: string,
  kind: OpenInferenceSpanKind,
  attrs: Record<string, unknown> | undefined,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  const parent = currentSpan();
  const span = tracer.startSpan(name, {
    kind,
    parent,
    attributes: redactedAttrs(attrs),
  });
  try {
    return await runWithActiveSpan(span, () => fn(span));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    span.recordError(new Error(redactString(msg)));
    throw err;
  } finally {
    span.end();
  }
}

export function withAgentSpan<T>(
  agentName: string,
  attrs: BaseSpanAttrs,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return withOpenInferenceSpan(`agent.${agentName}`, 'AGENT', { agent_name: agentName, ...attrs }, fn);
}

export function withToolSpan<T>(
  toolName: string,
  tier: string,
  attrs: BaseSpanAttrs & { tool_args?: string },
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return withOpenInferenceSpan(
    `tool.${toolName}`,
    'TOOL',
    { 'tool.name': toolName, 'tool.tier': tier, ...attrs },
    async (span) => {
      try {
        const result = await fn(span);
        span.setAttributes({ 'tool.success': true });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        span.setAttributes({ 'tool.success': false, 'tool.error': redactString(msg) });
        throw err;
      }
    }
  );
}

export function currentTraceIds(): { traceId: string | null; spanId: string | null } {
  const span = trace.getSpan(context.active());
  if (!span) return { traceId: null, spanId: null };
  const sc = span.spanContext();
  return { traceId: sc.traceId, spanId: sc.spanId };
}
