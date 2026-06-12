/**
 * Arize AX adapter — OpenTelemetry-based.
 *
 * We use the OTLP/HTTP exporter to send OpenInference-conformant spans to an
 * Arize AX tracing project. The project route is controlled by
 * ARIZE_PROJECT_NAME and is encoded as the OpenInference project resource
 * attribute expected by AX.
 *
 * This adapter is intentionally independent of the existing
 * core/observability/tracing.ts global OTel init: that module is still used by
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
import { SEMRESATTRS_PROJECT_NAME } from '@arizeai/openinference-semantic-conventions';
import type { Span, StartSpanOpts, Tracer } from './tracer';
import {
  OPENINFERENCE_SPAN_KIND_ATTRIBUTE,
  normalizeOpenInferenceSpanKind,
  withOpenInferenceSpanKind,
} from './tracer';
import {
  deliverWithRetryAndSpool,
  markAdapterEnabled,
  recordAdapterDropped,
  recordAdapterSent,
} from './adapter-health';
import { redactIo } from './io-redact';
import { redactString } from './redact';

const DEFAULT_ARIZE_AX_ENDPOINT = 'https://otlp.arize.com/v1/traces';

function normalizeTraceEndpoint(raw: string | undefined): string {
  const endpoint = (raw ?? DEFAULT_ARIZE_AX_ENDPOINT).trim().replace(/\/+$/, '');
  if (endpoint.endsWith('/v1/traces')) return endpoint;
  if (endpoint.endsWith('/v1')) return `${endpoint}/traces`;
  return `${endpoint}/v1/traces`;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`OBSERVABILITY_BACKEND=arize requires ${name}.`);
  return value;
}

function resolveArizeConfig(): {
  endpoint: string;
  headers: Record<string, string>;
  projectName: string;
} {
  const endpoint = normalizeTraceEndpoint(process.env.ARIZE_ENDPOINT);
  return {
    endpoint,
    headers: {
      'arize-space-id': requiredEnv('ARIZE_SPACE_ID'),
      'arize-api-key': requiredEnv('ARIZE_API_KEY'),
    },
    projectName: requiredEnv('ARIZE_PROJECT_NAME'),
  };
}

const otelSpanSymbol = Symbol('arize.otel.span');

export class ArizeTracer implements Tracer {
  private provider: BasicTracerProvider | null = null;
  private otelTracer: OtelTracer | null = null;
  private initError: Error | null = null;

  constructor() {
    try {
      const { endpoint, headers, projectName } = resolveArizeConfig();
      const exporter = new OTLPTraceExporter({ url: endpoint, headers });
      this.provider = new BasicTracerProvider({
        resource: new Resource({
          [SemanticResourceAttributes.SERVICE_NAME]:
            process.env.OTEL_SERVICE_NAME || 'oss-support-agent',
          [SemanticResourceAttributes.SERVICE_VERSION]:
            process.env.npm_package_version || '0.1.0',
          [SEMRESATTRS_PROJECT_NAME]: projectName,
        }),
        spanProcessors: [new BatchSpanProcessor(exporter)] as any,
      } as any);
      // Do NOT register globally — that would conflict with the existing
      // initTracing() global provider. Instead, build a private Tracer.
      this.otelTracer = this.provider.getTracer('oss-support-agent.observability');
      markAdapterEnabled('arize', true);
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err));
      markAdapterEnabled('arize', false, this.initError.message);
    }
  }

  startSpan(name: string, opts: StartSpanOpts = {}): Span {
    if (!this.otelTracer) {
      this.warnInitFailureOnce();
      recordAdapterDropped('arize', this.initError ?? 'arize not initialized');
      return new NoopArizeSpan();
    }
    const parentOtel = opts.parent ? (opts.parent as unknown as { [otelSpanSymbol]?: OtelSpan })[otelSpanSymbol] : undefined;

    let parentCtx;
    if (parentOtel) {
      parentCtx = trace.setSpan(otelContext(), parentOtel);
    }

    const openInferenceKind = normalizeOpenInferenceSpanKind(opts.kind, opts.attributes);
    const attributes = withOpenInferenceSpanKind(opts.attributes, openInferenceKind);
    const otelSpan = this.otelTracer.startSpan(
      name,
      { kind: OtelSpanKind.INTERNAL, attributes: stringifyAttrs(attributes) },
      parentCtx
    );
    otelSpan.setAttribute(OPENINFERENCE_SPAN_KIND_ATTRIBUTE, openInferenceKind);

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
        const msg = redactString(err instanceof Error ? err.message : String(err));
        otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: msg });
        otelSpan.recordException(new Error(msg));
      },
      end() {
        otelSpan.end();
        recordAdapterSent('arize');
      },
    };
    return wrapped;
  }

  async flush(): Promise<void> {
    if (!this.provider) return;
    await deliverWithRetryAndSpool({
      adapter: 'arize',
      operation: 'forceFlush',
      payload: null,
      run: () => this.provider!.forceFlush(),
    });
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
