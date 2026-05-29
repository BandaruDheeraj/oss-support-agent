/**
 * LangSmith adapter — manual run tree via the langsmith JS SDK.
 *
 * We deliberately avoid LangSmith's automatic LangChain instrumentation since
 * this codebase doesn't use LangChain. Spans become manual Run objects with
 * parent_run_id wiring so the LangSmith UI renders a phase → llm tree.
 *
 * Auth env:
 *   LANGSMITH_API_KEY  (required)
 *   LANGSMITH_PROJECT  (default: oss-support-agent)
 *   LANGSMITH_ENDPOINT (optional override; defaults to the SDK's cloud URL)
 */
import { randomUUID } from 'node:crypto';
import type { Span, StartSpanOpts, Tracer } from './tracer';
import { redactIo } from './io-redact';

type LangSmithClient = {
  createRun: (input: Record<string, unknown>) => Promise<void>;
  updateRun: (runId: string, patch: Record<string, unknown>) => Promise<void>;
  awaitPendingTraceBatches?: () => Promise<unknown>;
};

interface LangSmithSpanState {
  id: string;
  parentId: string | null;
  name: string;
  runType: string;
  startTimeMs: number;
  attrs: Record<string, unknown>;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  error: string | null;
  ended: boolean;
}

const kSymbol = Symbol('langsmith.state');

function runTypeFor(kind: StartSpanOpts['kind']): string {
  switch (kind) {
    case 'llm':
      return 'llm';
    case 'tool':
      return 'tool';
    case 'phase':
      return 'chain';
    default:
      return 'chain';
  }
}

export class LangSmithTracer implements Tracer {
  private client: LangSmithClient | null = null;
  private readonly project: string;
  private readonly pending = new Set<Promise<unknown>>();
  private initError: Error | null = null;

  constructor() {
    this.project =
      process.env.LANGSMITH_PROJECT || process.env.LANGCHAIN_PROJECT || 'oss-support-agent';
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ls = require('langsmith') as { Client: new (cfg?: Record<string, unknown>) => LangSmithClient };
      const apiKey = process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY;
      if (!apiKey) {
        throw new Error(
          'OBSERVABILITY_BACKEND=langsmith requires LANGSMITH_API_KEY (or LANGCHAIN_API_KEY) in the environment.'
        );
      }
      this.client = new ls.Client({
        apiKey,
        apiUrl: process.env.LANGSMITH_ENDPOINT || process.env.LANGCHAIN_ENDPOINT,
      });
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err));
      // Defer warning to first startSpan so importing the module is side-effect free.
    }
  }

  startSpan(name: string, opts: StartSpanOpts = {}): Span {
    if (!this.client) {
      this.warnInitFailureOnce();
      return new NoopLangSmithSpan();
    }

    const parentState = opts.parent ? (opts.parent as unknown as { [kSymbol]?: LangSmithSpanState })[kSymbol] : undefined;
    const state: LangSmithSpanState = {
      id: randomUUID(),
      parentId: parentState?.id ?? null,
      name,
      runType: runTypeFor(opts.kind),
      startTimeMs: Date.now(),
      attrs: { ...(opts.attributes ?? {}) },
      inputs: {},
      outputs: null,
      error: null,
      ended: false,
    };

    const client = this.client;
    const project = this.project;
    const tracer = this;

    const created = client
      .createRun({
        id: state.id,
        name,
        run_type: state.runType,
        start_time: state.startTimeMs,
        inputs: state.inputs,
        extra: { metadata: state.attrs },
        parent_run_id: state.parentId ?? undefined,
        project_name: project,
      })
      .catch((err) => {
        // Never let telemetry failures escape.
        // eslint-disable-next-line no-console
        console.warn(`[observability:langsmith] createRun failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    this.track(created);

    const span: Span & { [kSymbol]: LangSmithSpanState } = {
      [kSymbol]: state,
      setAttributes(attrs) {
        Object.assign(state.attrs, attrs);
      },
      setInput(input) {
        state.inputs = { value: redactIo('input', input) } as Record<string, unknown>;
      },
      setOutput(output) {
        state.outputs = { value: redactIo('output', output) } as Record<string, unknown>;
      },
      recordError(err) {
        state.error = err instanceof Error ? err.message : String(err);
      },
      end() {
        if (state.ended) return;
        state.ended = true;
        const patch: Record<string, unknown> = {
          end_time: Date.now(),
          extra: { metadata: state.attrs },
          outputs: state.outputs ?? undefined,
        };
        if (state.error) patch.error = state.error;
        if (state.inputs && Object.keys(state.inputs).length > 0) patch.inputs = state.inputs;
        const upd = client
          .updateRun(state.id, patch)
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.warn(`[observability:langsmith] updateRun failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        tracer.track(upd);
      },
    };
    return span;
  }

  async flush(): Promise<void> {
    const inFlight = Array.from(this.pending);
    await Promise.allSettled(inFlight);
    if (this.client?.awaitPendingTraceBatches) {
      try {
        await this.client.awaitPendingTraceBatches();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[observability:langsmith] flush failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => undefined);
  }

  private warnedInitFailure = false;
  private warnInitFailureOnce(): void {
    if (this.warnedInitFailure) return;
    this.warnedInitFailure = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[observability:langsmith] disabled — ${this.initError?.message ?? 'initialization failed'}`
    );
  }
}

class NoopLangSmithSpan implements Span {
  setAttributes(): void {}
  setInput(): void {}
  setOutput(): void {}
  recordError(): void {}
  end(): void {}
}
