/**
 * OTEL tracing for the selected observability backend.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace, type Tracer } from '@opentelemetry/api';
import { SEMRESATTRS_PROJECT_NAME } from '@arizeai/openinference-semantic-conventions';

let sdk: NodeSDK | null = null;
let started = false;
let shutdownHooked = false;

const DEFAULT_ARIZE_AX_ENDPOINT = 'https://otlp.arize.com/v1/traces';

function backendEnabled(name: 'arize' | 'braintrust'): boolean {
  const backend = (process.env.OBSERVABILITY_BACKEND ?? 'none').trim().toLowerCase();
  return backend === name || backend === 'all';
}

function normalizeTraceEndpoint(raw: string | undefined): string {
  const endpoint = (raw ?? DEFAULT_ARIZE_AX_ENDPOINT).trim().replace(/\/+$/, '');
  if (endpoint.endsWith('/v1/traces')) return endpoint;
  if (endpoint.endsWith('/v1')) return `${endpoint}/traces`;
  return `${endpoint}/v1/traces`;
}

function makeProcessors(): SpanProcessor[] {
  const processors: SpanProcessor[] = [];

  if (
    backendEnabled('arize') &&
    process.env.ARIZE_API_KEY &&
    process.env.ARIZE_SPACE_ID &&
    process.env.ARIZE_PROJECT_NAME
  ) {
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: normalizeTraceEndpoint(process.env.ARIZE_ENDPOINT),
          headers: {
            'arize-space-id': process.env.ARIZE_SPACE_ID,
            'arize-api-key': process.env.ARIZE_API_KEY,
          },
        })
      )
    );
  }

  if (
    backendEnabled('braintrust') &&
    process.env.BRAINTRUST_OTLP_ENDPOINT &&
    process.env.BRAINTRUST_API_KEY
  ) {
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
      [SEMRESATTRS_PROJECT_NAME]:
        process.env.ARIZE_PROJECT_NAME || process.env.OTEL_SERVICE_NAME || 'oss-support-agent',
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
    (backendEnabled('arize') &&
      process.env.ARIZE_API_KEY &&
      process.env.ARIZE_SPACE_ID &&
      process.env.ARIZE_PROJECT_NAME) ||
      (backendEnabled('braintrust') &&
        process.env.BRAINTRUST_OTLP_ENDPOINT &&
        process.env.BRAINTRUST_API_KEY)
  );
}
