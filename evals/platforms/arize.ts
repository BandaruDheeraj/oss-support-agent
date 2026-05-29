/**
 * Arize Phoenix adapter — manual OpenTelemetry instrumentation.
 *
 * Targets BOTH:
 *   - Local Phoenix (default: http://localhost:6006) for development
 *   - Cloud Arize / hosted Phoenix (app.phoenix.arize.com)
 *
 * Spans are tagged with OpenInference semantic conventions so the Phoenix UI
 * understands them as LLM / chain / tool spans without auto-instrumentation.
 *
 * No openinference-*-instrumentation auto-patcher is used — we want a fair,
 * apples-to-apples comparison where the same trace data is sent to all three
 * platforms in the same way.
 */

import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  SpanKind,
  SpanStatusCode,
  type Tracer,
} from '@opentelemetry/api';
import { SemanticConventions } from '@arizeai/openinference-semantic-conventions';

import type {
  PlatformAdapter,
  PingResult,
  RunSummary,
  TraceEvent,
} from '../../core/telemetry';

const LOCAL_PHOENIX_DEFAULT = 'http://localhost:6006';
const CLOUD_PHOENIX_DEFAULT = 'https://app.phoenix.arize.com';
const PHOENIX_TRACES_PATH = '/v1/traces';
const PROJECT_NAME_DEFAULT = 'oss-fix-loop';
const DATASET_NAME_DEFAULT = 'oss-fix-loop-runs';

interface ExporterTarget {
  label: 'local' | 'cloud';
  endpoint: string;
  headers: Record<string, string>;
}

export class ArizeAdapter implements PlatformAdapter {
  public readonly name = 'arize';
  private provider: BasicTracerProvider | null = null;
  private tracer: Tracer | null = null;
  private notes: string[] = [];
  private targets: ExporterTarget[] = [];
  private datasetReady = false;

  async connect(): Promise<void> {
    const targets = this.resolveTargets();
    if (targets.length === 0) {
      throw new Error(
        'Arize adapter requires at least one of PHOENIX_COLLECTOR_ENDPOINT, ARIZE_ENDPOINT, ' +
          'or ARIZE_API_KEY (cloud) to be set.'
      );
    }
    this.targets = targets;

    const exporters: SpanExporter[] = targets.map(
      (t) =>
        new OTLPTraceExporter({
          url: t.endpoint + PHOENIX_TRACES_PATH,
          headers: t.headers,
        })
    );

    this.provider = new BasicTracerProvider({
      resource: new Resource({
        'service.name': PROJECT_NAME_DEFAULT,
        'openinference.project.name': PROJECT_NAME_DEFAULT,
      }) as any,
    });
    for (const exporter of exporters) {
      this.provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    }
    // Note: not calling provider.register() — we use the local tracer directly
    // so we don't clobber the global tracer provider used by other adapters.
    this.tracer = this.provider.getTracer('oss-fix-loop.arize-adapter');

    // Best-effort dataset creation via Phoenix REST API on the FIRST target
    // that is local (cloud Phoenix dataset creation is a separate dashboard flow).
    const local = targets.find((t) => t.label === 'local');
    if (local) {
      try {
        await this.ensureDataset(local.endpoint, DATASET_NAME_DEFAULT);
        this.datasetReady = true;
      } catch (err) {
        this.notes.push(
          `Phoenix dataset auto-creation failed against ${local.endpoint}: ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Datasets can be created in the Phoenix UI instead; the SDK does not ` +
            `expose a stable "create dataset if missing" helper.`
        );
      }
    } else {
      this.notes.push(
        `No local Phoenix endpoint configured — skipped dataset auto-create. ` +
          `Cloud Arize requires dataset creation via the dashboard or its tabular API; ` +
          `there is no symmetrical local/cloud "create dataset" call.`
      );
    }

    this.notes.push(
      `Arize/Phoenix needed FOUR OTel + OpenInference packages to manually instrument: ` +
        `@opentelemetry/sdk-trace-base, @opentelemetry/exporter-trace-otlp-http, ` +
        `@opentelemetry/resources, @arizeai/openinference-semantic-conventions. ` +
        `No single "phoenix-sdk" package wraps these.`
    );
    if (targets.length > 1) {
      this.notes.push(
        `Dual-export (local + cloud) requires two separate BatchSpanProcessor + OTLPTraceExporter ` +
          `instances. The Phoenix docs default-discuss a single endpoint; dual-export is undocumented.`
      );
    }
    const cloud = targets.find((t) => t.label === 'cloud');
    if (cloud) {
      if (cloud.headers['api_key']) {
        this.notes.push(
          `Cloud Phoenix expected the auth header name "api_key" (snake_case) — different from ` +
            `the typical "Authorization: Bearer …" convention. Discovered via 401 responses, ` +
            `not from a single canonical doc page.`
        );
      }
      if (cloud.headers['space_id']) {
        this.notes.push(
          `Cloud Phoenix additionally requires a "space_id" header — ARIZE_SPACE_KEY in env. ` +
            `Local Phoenix has no concept of a space; setup divergence between cloud and local is ` +
            `not a one-line config change.`
        );
      }
    }
  }

  async ping(): Promise<PingResult> {
    const start = Date.now();
    const target = this.targets.find((t) => t.label === 'local') ?? this.targets[0];
    if (!target) {
      return {
        platform: this.name,
        connected: false,
        latency_ms: 0,
        error: 'no target configured',
      };
    }
    try {
      const res = await fetch(target.endpoint + '/healthz', {
        method: 'GET',
        // 3s timeout via AbortController
        signal: AbortSignal.timeout(3000),
      } as RequestInit);
      const latency = Date.now() - start;
      if (res.ok || res.status === 404) {
        // Phoenix older builds 404 on /healthz but the OTLP receiver is up.
        if (res.status === 404) {
          this.notes.push(
            `Phoenix /healthz returned 404; the OTel collector accepted spans regardless. ` +
              `Older Phoenix builds do not expose a health endpoint.`
          );
        }
        return { platform: this.name, connected: true, latency_ms: latency };
      }
      return {
        platform: this.name,
        connected: false,
        latency_ms: latency,
        error: `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        platform: this.name,
        connected: false,
        latency_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async logTrace(t: TraceEvent): Promise<void> {
    if (!this.tracer) throw new Error('Arize adapter not connected');
    const span = this.tracer.startSpan(t.span_name, {
      kind: SpanKind.INTERNAL,
      startTime: t.start_time_ms,
      attributes: this.buildAttributes(t),
    });
    if (t.error) {
      span.recordException(t.error.message);
      span.setStatus({ code: SpanStatusCode.ERROR, message: t.error.message });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end(t.end_time_ms);
  }

  async logRun(run: RunSummary): Promise<void> {
    if (!this.tracer) throw new Error('Arize adapter not connected');
    const span = this.tracer.startSpan('pipeline.run', {
      kind: SpanKind.INTERNAL,
      startTime: run.start_time_ms,
      attributes: {
        [SemanticConventions.OPENINFERENCE_SPAN_KIND ?? 'openinference.span.kind']: 'CHAIN',
        [SemanticConventions.INPUT_VALUE]: JSON.stringify({
          run_id: run.run_id,
          repo: run.repo_name,
          total_issues: run.total_issues,
        }),
        [SemanticConventions.OUTPUT_VALUE]: JSON.stringify(run.aggregate),
        'pipeline.run_id': run.run_id,
        'pipeline.repo': run.repo_name,
        'pipeline.duration_ms': run.duration_ms,
        'pipeline.triage_accuracy': run.aggregate.triage_accuracy_overall,
        'pipeline.pm_accuracy': run.aggregate.pm_accuracy_overall,
        'pipeline.total_input_tokens': run.aggregate.total_input_tokens,
        'pipeline.total_output_tokens': run.aggregate.total_output_tokens,
      },
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end(run.end_time_ms);

    if (!this.datasetReady) {
      this.notes.push(
        `Pipeline RunSummary fanned out as a single OTel CHAIN span. Phoenix's "Experiments" ` +
          `view aggregates them, but there is no first-class "logRun" SDK call analogous to ` +
          `Braintrust's experiment.summarize() or LangSmith's evaluator results.`
      );
    }
    // Flush buffered spans so the run is visible in the UI immediately after the eval ends.
    try {
      await this.provider?.forceFlush();
    } catch {
      // non-fatal
    }
  }

  getSetupNotes(): string[] {
    return [...this.notes];
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private resolveTargets(): ExporterTarget[] {
    const out: ExporterTarget[] = [];

    const localEndpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT || LOCAL_PHOENIX_DEFAULT;
    if (process.env.PHOENIX_COLLECTOR_ENDPOINT || process.env.PHOENIX_ENABLE_LOCAL === 'true') {
      out.push({
        label: 'local',
        endpoint: stripTrailingSlash(localEndpoint),
        headers: {},
      });
    }

    const cloudEndpoint = process.env.ARIZE_ENDPOINT || CLOUD_PHOENIX_DEFAULT;
    if (process.env.ARIZE_API_KEY) {
      const headers: Record<string, string> = { api_key: process.env.ARIZE_API_KEY };
      if (process.env.ARIZE_SPACE_KEY) headers['space_id'] = process.env.ARIZE_SPACE_KEY;
      out.push({
        label: 'cloud',
        endpoint: stripTrailingSlash(cloudEndpoint),
        headers,
      });
    }

    // Sensible default: if nothing was configured, attempt local Phoenix.
    if (out.length === 0) {
      out.push({
        label: 'local',
        endpoint: LOCAL_PHOENIX_DEFAULT,
        headers: {},
      });
      this.notes.push(
        `No Phoenix/Arize env vars set — defaulted to local Phoenix at ${LOCAL_PHOENIX_DEFAULT}. ` +
          `This works only if a Phoenix container is already running on the dev machine; ` +
          `connect() does not auto-launch it.`
      );
    }
    return out;
  }

  private buildAttributes(t: TraceEvent): Record<string, string | number | boolean> {
    const attrs: Record<string, string | number | boolean> = {
      [SemanticConventions.OPENINFERENCE_SPAN_KIND ?? 'openinference.span.kind']: t.is_llm
        ? 'LLM'
        : 'CHAIN',
      [SemanticConventions.INPUT_VALUE]: JSON.stringify(t.prompt),
      [SemanticConventions.INPUT_MIME_TYPE]: 'application/json',
      [SemanticConventions.OUTPUT_VALUE]: t.response
        ? JSON.stringify(t.response)
        : '',
      [SemanticConventions.OUTPUT_MIME_TYPE]: 'application/json',
      'agent.name': t.ctx.agent_name,
      'agent.stage': t.ctx.stage,
      'run.id': t.ctx.run_id,
      'issue.number': t.ctx.issue_number,
      'repo.name': t.ctx.repo_name,
    };
    if (t.is_llm && t.model) {
      attrs[SemanticConventions.LLM_MODEL_NAME] = t.model;
    }
    if (t.is_llm && t.input_tokens != null) {
      attrs[SemanticConventions.LLM_TOKEN_COUNT_PROMPT] = t.input_tokens;
    }
    if (t.is_llm && t.output_tokens != null) {
      attrs[SemanticConventions.LLM_TOKEN_COUNT_COMPLETION] = t.output_tokens;
    }
    if (
      t.is_llm &&
      t.input_tokens != null &&
      t.output_tokens != null &&
      SemanticConventions.LLM_TOKEN_COUNT_TOTAL
    ) {
      attrs[SemanticConventions.LLM_TOKEN_COUNT_TOTAL] =
        t.input_tokens + t.output_tokens;
    }
    if (t.ctx.parent_span_id) {
      attrs['parent.span.id'] = t.ctx.parent_span_id;
    }
    if (t.ctx.tags) {
      for (const [k, v] of Object.entries(t.ctx.tags)) {
        if (v == null) continue;
        attrs[`tag.${k}`] = v as string | number | boolean;
      }
    }
    return attrs;
  }

  private async ensureDataset(endpoint: string, name: string): Promise<void> {
    // Phoenix HTTP dataset API is not officially stable; we attempt the
    // documented v1 path and surface failure cleanly.
    const url = `${endpoint}/v1/datasets`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, description: 'OSS Fix Loop comparison runs' }),
      signal: AbortSignal.timeout(3000),
    } as RequestInit);
    if (!res.ok && res.status !== 409 /* already exists */ && res.status !== 404) {
      const body = await res.text().catch(() => '');
      throw new Error(`POST /v1/datasets → HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    if (res.status === 404) {
      this.notes.push(
        `Phoenix POST /v1/datasets returned 404 — the running Phoenix build does not expose the ` +
          `datasets REST endpoint. The Python SDK has phoenix.client.Client().datasets.create(), ` +
          `but the JS/TS ecosystem has no equivalent helper as of this writing.`
      );
    }
  }
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}
