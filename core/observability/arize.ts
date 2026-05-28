/**
 * Arize / Phoenix adapter — OpenTelemetry-based.
 *
 * We use the OTLP/HTTP exporter to send OpenInference-conformant spans to
 * either:
 *   - Arize Cloud (set ARIZE_ENDPOINT + ARIZE_API_KEY + ARIZE_SPACE_ID)
 *   - Self-hosted / Phoenix Cloud (set ARIZE_ENDPOINT alone, or rely on PHOENIX_OTLP_ENDPOINT)
 *
 * This adapter is intentionally independent of the existing
 * core/observability/tracing.ts dual-export init: that module is still used by
 * call-sites that need the global OTel Tracer (withAgentSpan/withToolSpan). The
 * adapter manages its own provider so getTracer('arize') works even when
 * initTracing() was never called.
 *
 * Span attributes follow OpenInference semantic conventions where applicable.
 */
import type { Span as OtelSpan, Tracer as OtelTracer } from '@opentelemetry/api';
import { SpanKind as OtelSpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import type { Span, StartSpanOpts, Tracer } from './tracer';
import { redactIo } from './io-redact';

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function resolveEndpointAndHeaders(): { endpoint: string | null; headers: Record<string, string> } {
  const endpoint =
    process.env.ARIZE_ENDPOINT ||
    process.env.PHOENIX_OTLP_ENDPOINT ||
    null;
  const headers = parseHeaders(process.env.PHOENIX_OTLP_HEADERS);
  if (process.env.ARIZE_API_KEY) headers['api_key'] = process.env.ARIZE_API_KEY;
  if (process.env.ARIZE_SPACE_ID) headers['space_id'] = process.env.ARIZE_SPACE_ID;
  return { endpoint, headers };
}

function openinferenceKind(kind: StartSpanOpts['kind']): string {
  switch (kind) {
    case 'llm':
      return 'LLM';
    case 'tool':
      return 'TOOL';
    case 'phase':
      return 'CHAIN';
    default:
      return 'CHAIN';
  }
}

const otelSpanSymbol = Symbol('arize.otel.span');

export class ArizeTracer implements Tracer {
  private provider: BasicTracerProvider | null = null;
  private otelTracer: OtelTracer | null = null;
  private initError: Error | null = null;

  constructor() {
    try {
      const { endpoint, headers } = resolveEndpointAndHeaders();
      if (!endpoint) {
        throw new Error(
          'OBSERVABILITY_BACKEND=arize requires ARIZE_ENDPOINT (or PHOENIX_OTLP_ENDPOINT).'
        );
      }
      const exporter = new OTLPTraceExporter({ url: endpoint, headers });
      this.provider = new BasicTracerProvider({
        resource: new Resource({
          [SemanticResourceAttributes.SERVICE_NAME]:
            process.env.OTEL_SERVICE_NAME || 'oss-support-agent',
          [SemanticResourceAttributes.SERVICE_VERSION]:
            process.env.npm_package_version || '0.1.0',
        }),
        spanProcessors: [new BatchSpanProcessor(exporter)] as any,
      } as any);
      // Do NOT register globally — that would conflict with the existing
      // initTracing() global provider. Instead, build a private Tracer.
      this.otelTracer = this.provider.getTracer('oss-support-agent.observability');
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err));
    }
  }

  startSpan(name: string, opts: StartSpanOpts = {}): Span {
    if (!this.otelTracer) {
      this.warnInitFailureOnce();
      return new NoopArizeSpan();
    }
    const parentOtel = opts.parent ? (opts.parent as unknown as { [otelSpanSymbol]?: OtelSpan })[otelSpanSymbol] : undefined;

    let parentCtx;
    if (parentOtel) {
      parentCtx = trace.setSpan(otelContext(), parentOtel);
    }

    const otelSpan = this.otelTracer.startSpan(
      name,
      { kind: OtelSpanKind.INTERNAL, attributes: stringifyAttrs(opts.attributes) },
      parentCtx
    );
    otelSpan.setAttribute('openinference.span.kind', openinferenceKind(opts.kind));

    const wrapped: Span & { [otelSpanSymbol]: OtelSpan } = {
      [otelSpanSymbol]: otelSpan,
      setAttributes(attrs) {
        for (const [k, v] of Object.entries(stringifyAttrs(attrs))) {
          otelSpan.setAttribute(k, v as any);
        }
      },
      setInput(input) {
        const redacted = redactIo('input', input);
        otelSpan.setAttribute('input.value', serialize(redacted));
        otelSpan.setAttribute('input.mime_type', 'application/json');
      },
      setOutput(output) {
        const redacted = redactIo('output', output);
        otelSpan.setAttribute('output.value', serialize(redacted));
        otelSpan.setAttribute('output.mime_type', 'application/json');
      },
      recordError(err) {
        const msg = err instanceof Error ? err.message : String(err);
        otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: msg });
        otelSpan.recordException(err instanceof Error ? err : new Error(msg));
      },
      end() {
        otelSpan.end();
      },
    };
    return wrapped;
  }

  async flush(): Promise<void> {
    if (!this.provider) return;
    try {
      await this.provider.forceFlush();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[observability:arize] flush failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private warnedInitFailure = false;
  private warnInitFailureOnce(): void {
    if (this.warnedInitFailure) return;
    this.warnedInitFailure = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[observability:arize] disabled — ${this.initError?.message ?? 'initialization failed'}`
    );
  }
}

class NoopArizeSpan implements Span {
  setAttributes(): void {}
  setInput(): void {}
  setOutput(): void {}
  recordError(): void {}
  end(): void {}
}

function otelContext() {
  // Lazy import to avoid hard dep at module init.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const api = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
  return api.context.active();
}

function serialize(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringifyAttrs(attrs: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  if (!attrs) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
      out[k] = v;
    } else {
      out[k] = serialize(v);
    }
  }
  return out;
}
