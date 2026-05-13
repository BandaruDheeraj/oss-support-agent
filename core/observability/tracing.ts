/**
 * OTEL tracing with dual export to Phoenix + Braintrust.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace, type Tracer } from '@opentelemetry/api';

let sdk: NodeSDK | null = null;
let started = false;
let shutdownHooked = false;

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const result: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k && v) result[k] = v;
  }
  return result;
}

function makeProcessors(): SpanProcessor[] {
  const processors: SpanProcessor[] = [];

  if (process.env.PHOENIX_OTLP_ENDPOINT) {
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: process.env.PHOENIX_OTLP_ENDPOINT,
          headers: parseHeaders(process.env.PHOENIX_OTLP_HEADERS),
        })
      )
    );
  }

  if (process.env.BRAINTRUST_OTLP_ENDPOINT && process.env.BRAINTRUST_API_KEY) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${process.env.BRAINTRUST_API_KEY}`,
    };
    if (process.env.BRAINTRUST_PROJECT) {
      headers['x-bt-parent'] = `project_name:${process.env.BRAINTRUST_PROJECT}`;
    }
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: process.env.BRAINTRUST_OTLP_ENDPOINT,
          headers,
        })
      )
    );
  }

  return processors;
}

export async function initTracing(): Promise<void> {
  if (started) return;
  const processors = makeProcessors();
  if (processors.length === 0) {
    started = true;
    return;
  }

  sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]:
        process.env.OTEL_SERVICE_NAME || 'oss-support-agent',
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || '0.1.0',
    }),
    spanProcessors: processors as any,
  });

  sdk.start();
  started = true;

  if (!shutdownHooked) {
    shutdownHooked = true;
    const onExit = () => {
      flushTracing().catch(() => undefined);
    };
    process.on('SIGTERM', onExit);
    process.on('SIGINT', onExit);
    process.on('beforeExit', onExit);
  }
}

export async function flushTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // ignore
  }
  sdk = null;
  started = false;
}

export function getTracer(name = 'oss-support-agent'): Tracer {
  return trace.getTracer(name);
}

export function tracingConfigured(): boolean {
  return Boolean(
    process.env.PHOENIX_OTLP_ENDPOINT ||
      (process.env.BRAINTRUST_OTLP_ENDPOINT && process.env.BRAINTRUST_API_KEY)
  );
}
