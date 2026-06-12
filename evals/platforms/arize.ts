/**
 * Arize AX adapter — manual OpenTelemetry instrumentation.
 *
 * Spans are tagged with OpenInference semantic conventions so Arize AX
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
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api';
import {
  OpenInferenceSpanKind,
  SEMRESATTRS_PROJECT_NAME,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';

import type {
  PlatformAdapter,
  PingResult,
  RunSummary,
  TraceEvent,
} from '../../core/telemetry';

const DEFAULT_ARIZE_AX_ENDPOINT = 'https://otlp.arize.com/v1/traces';
const PROJECT_NAME_DEFAULT = 'oss-fix-loop';

interface ExporterTarget {
  label: 'ax';
  endpoint: string;
  headers: Record<string, string>;
}

export class ArizeAdapter implements PlatformAdapter {
  public readonly name = 'arize';
  private provider: BasicTracerProvider | null = null;
  private tracer: Tracer | null = null;
  private notes: string[] = [];
  private targets: ExporterTarget[] = [];
  private issueSpanContexts = new Map<string, SpanContext>();

  async connect(): Promise<void> {
    const targets = this.resolveTargets();
    if (targets.length === 0) {
      throw new Error(
        'Arize adapter requires ARIZE_API_KEY, ARIZE_SPACE_ID, and ARIZE_PROJECT_NAME.'
      );
    }
    this.targets = targets;

    const exporters: SpanExporter[] = targets.map(
      (t) =>
        new OTLPTraceExporter({
          url: t.endpoint,
          headers: t.headers,
        })
    );

    this.provider = new BasicTracerProvider({
      resource: new Resource({
        'service.name': process.env.ARIZE_PROJECT_NAME || PROJECT_NAME_DEFAULT,
        [SEMRESATTRS_PROJECT_NAME]: process.env.ARIZE_PROJECT_NAME || PROJECT_NAME_DEFAULT,
      }) as any,
    });
    for (const exporter of exporters) {
      this.provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    }
    // Note: not calling provider.register() — we use the local tracer directly
    // so we don't clobber the global tracer provider used by other adapters.
    this.tracer = this.provider.getTracer('oss-fix-loop.arize-adapter');

    this.notes.push(
      `Arize AX needs OpenTelemetry + OpenInference packages to manually instrument: ` +
        `@opentelemetry/sdk-trace-base, @opentelemetry/exporter-trace-otlp-http, ` +
        `@opentelemetry/resources, @arizeai/openinference-semantic-conventions.`
    );
    this.notes.push(
      `Arize AX routing uses the arize-space-id/arize-api-key OTLP headers and ` +
        `the ${SEMRESATTRS_PROJECT_NAME} resource attribute.`
    );
  }

  async ping(): Promise<PingResult> {
    const start = Date.now();
    const target = this.targets[0];
    if (!target) {
      return {
        platform: this.name,
        connected: false,
        latency_ms: 0,
        error: 'no target configured',
      };
    }
    return { platform: this.name, connected: true, latency_ms: Date.now() - start };
  }

  async logTrace(t: TraceEvent): Promise<void> {
    if (!this.tracer) throw new Error('Arize adapter not connected');
    const span = this.tracer.startSpan(t.span_name, {
      kind: SpanKind.INTERNAL,
      startTime: t.start_time_ms,
      attributes: this.buildAttributes(t),
    });
    this.issueSpanContexts.set(this.issueKey(t.ctx.run_id, t.ctx.issue_number), span.spanContext());
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
    const runSpan = this.tracer.startSpan('pipeline.run', {
      kind: SpanKind.INTERNAL,
      startTime: run.start_time_ms,
      attributes: {
        [SemanticConventions.OPENINFERENCE_SPAN_KIND ?? 'openinference.span.kind']:
          OpenInferenceSpanKind.CHAIN,
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
    const runContext = trace.setSpanContext(context.active(), runSpan.spanContext());

    for (const issue of run.per_issue) {
      const issueContext = this.getIssueContext(run.run_id, issue.issue_number);
      const evaluatorIssueSpan = this.tracer.startSpan(
        `evaluator.issue.${issue.issue_number}`,
        {
          kind: SpanKind.INTERNAL,
          startTime: run.end_time_ms,
          attributes: {
            [SemanticConventions.OPENINFERENCE_SPAN_KIND ?? 'openinference.span.kind']:
              OpenInferenceSpanKind.EVALUATOR,
            [SemanticConventions.INPUT_VALUE]: JSON.stringify({
              issue_number: issue.issue_number,
              title: issue.title,
              difficulty: issue.difficulty,
            }),
            [SemanticConventions.INPUT_MIME_TYPE]: 'application/json',
            [SemanticConventions.OUTPUT_VALUE]: JSON.stringify({
              triage: issue.triage_result,
              pm: issue.pm_result,
              scores: issue.scores,
            }),
            [SemanticConventions.OUTPUT_MIME_TYPE]: 'application/json',
            'evaluation.key.triage_accuracy': issue.scores.triage_accuracy,
            'evaluation.key.pm_design_score_accuracy': issue.scores.pm_accuracy,
            'evaluation.issue_number': issue.issue_number,
            'evaluation.repo': run.repo_name,
          },
        },
        issueContext
      );
      evaluatorIssueSpan.setStatus({ code: SpanStatusCode.OK });
      evaluatorIssueSpan.end(run.end_time_ms);
    }

    const evaluatorSummarySpan = this.tracer.startSpan(
      'evaluator.run',
      {
        kind: SpanKind.INTERNAL,
        startTime: run.end_time_ms,
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND ?? 'openinference.span.kind']:
            OpenInferenceSpanKind.EVALUATOR,
          [SemanticConventions.INPUT_VALUE]: JSON.stringify({
            run_id: run.run_id,
            repo: run.repo_name,
          }),
          [SemanticConventions.INPUT_MIME_TYPE]: 'application/json',
          [SemanticConventions.OUTPUT_VALUE]: JSON.stringify({
            triage_accuracy_overall: run.aggregate.triage_accuracy_overall,
            pm_design_score_accuracy_overall: run.aggregate.pm_accuracy_overall,
          }),
          [SemanticConventions.OUTPUT_MIME_TYPE]: 'application/json',
          'evaluation.key.triage_accuracy_overall': run.aggregate.triage_accuracy_overall,
          'evaluation.key.pm_design_score_accuracy_overall': run.aggregate.pm_accuracy_overall,
          'evaluation.total_issues': run.total_issues,
          'evaluation.repo': run.repo_name,
        },
      },
      runContext
    );
    evaluatorSummarySpan.setStatus({ code: SpanStatusCode.OK });
    evaluatorSummarySpan.end(run.end_time_ms);

    runSpan.setStatus({ code: SpanStatusCode.OK });
    runSpan.end(run.end_time_ms);
    this.clearIssueContexts(run.run_id);

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
    const apiKey = process.env.ARIZE_API_KEY?.trim();
    const spaceId = process.env.ARIZE_SPACE_ID?.trim();
    const projectName = (process.env.ARIZE_PROJECT_NAME || PROJECT_NAME_DEFAULT).trim();
    if (!apiKey || !spaceId || !projectName) {
      return [];
    }
    process.env.ARIZE_PROJECT_NAME = projectName;
    return [
      {
        label: 'ax',
        endpoint: normalizeTraceEndpoint(process.env.ARIZE_ENDPOINT),
        headers: {
          'arize-api-key': apiKey,
          'arize-space-id': spaceId,
        },
      },
    ];
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

  private issueKey(runId: string, issueNumber: number): string {
    return `${runId}:${issueNumber}`;
  }

  private getIssueContext(runId: string, issueNumber: number) {
    const spanContext = this.issueSpanContexts.get(this.issueKey(runId, issueNumber));
    if (!spanContext) return context.active();
    return trace.setSpanContext(context.active(), spanContext);
  }

  private clearIssueContexts(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.issueSpanContexts.keys()) {
      if (key.startsWith(prefix)) this.issueSpanContexts.delete(key);
    }
  }
}

function normalizeTraceEndpoint(raw: string | undefined): string {
  const endpoint = (raw ?? DEFAULT_ARIZE_AX_ENDPOINT).trim().replace(/\/+$/, '');
  if (endpoint.endsWith('/v1/traces')) return endpoint;
  if (endpoint.endsWith('/v1')) return `${endpoint}/traces`;
  return `${endpoint}/v1/traces`;
}
