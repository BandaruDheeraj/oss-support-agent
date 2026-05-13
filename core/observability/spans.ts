/**
 * Span helpers.
 */

import { context, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import { getTracer } from './tracing';
import { redactString } from './redact';

export type OpenInferenceSpanKind = 'AGENT' | 'TOOL' | 'LLM' | 'RETRIEVER' | 'CHAIN';

export interface BaseSpanAttrs extends Attributes {
  issue_number?: number;
  attempt_id?: string;
  dossier_snapshot_id?: string;
  agent_name?: string;
}

function redactedAttrs<T extends Attributes>(attrs: T | undefined): Attributes {
  if (!attrs) return {};
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (typeof v === 'string') out[k] = redactString(v);
    else if (Array.isArray(v) || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = String(v);
  }
  return out;
}

function setKind(span: Span, kind: OpenInferenceSpanKind): void {
  span.setAttribute('openinference.span.kind', kind);
}

async function runWithSpan<T>(
  name: string,
  kind: OpenInferenceSpanKind,
  attrs: Attributes | undefined,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  return await tracer.startActiveSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes: redactedAttrs(attrs) },
    async (span) => {
      setKind(span, kind);
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: redactString(msg) });
        span.recordException(err instanceof Error ? err : new Error(msg));
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

export function withAgentSpan<T>(
  agentName: string,
  attrs: BaseSpanAttrs,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return runWithSpan(`agent.${agentName}`, 'AGENT', { agent_name: agentName, ...attrs }, fn);
}

export function withToolSpan<T>(
  toolName: string,
  tier: string,
  attrs: BaseSpanAttrs & { tool_args?: string },
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return runWithSpan(
    `tool.${toolName}`,
    'TOOL',
    { 'tool.name': toolName, 'tool.tier': tier, ...attrs },
    async (span) => {
      try {
        const result = await fn(span);
        span.setAttribute('tool.success', true);
        return result;
      } catch (err) {
        span.setAttribute('tool.success', false);
        const msg = err instanceof Error ? err.message : String(err);
        span.setAttribute('tool.error', redactString(msg));
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
