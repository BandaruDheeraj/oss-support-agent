/**
 * Braintrust adapter — uses the braintrust SDK logger.
 *
 * On construction we call initLogger() once; thereafter each Tracer.startSpan
 * either starts a top-level logger span or a child of the parent's BT span.
 *
 * Auth env:
 *   BRAINTRUST_API_KEY  (required)
 *   BRAINTRUST_PROJECT  (default: oss-support-agent)
 */
import type { Span, StartSpanOpts, Tracer } from './tracer';
import {
  normalizeOpenInferenceSpanKind,
  withOpenInferenceSpanKind,
  type OpenInferenceSpanKind,
} from './tracer';
import { redactString } from './redact';
import {
  deliverWithRetryAndSpool,
  markAdapterEnabled,
  recordAdapterDropped,
  recordAdapterFailed,
} from './adapter-health';
import { redactIo } from './io-redact';

type BtSpan = {
  log: (input: Record<string, unknown>) => void;
  startSpan: (opts: { name: string; type?: string; spanAttributes?: Record<string, unknown> }) => BtSpan;
  end: () => void;
};

type BtLogger = BtSpan;

type BraintrustModule = {
  initLogger: (opts: {
    projectName: string;
    apiKey?: string;
    apiUrl?: string;
    asyncFlush?: boolean;
  }) => BtLogger;
};

const btSpanSymbol = Symbol('braintrust.span');

function btSpanType(kind: OpenInferenceSpanKind): string {
  switch (kind) {
    case 'LLM':
      return 'llm';
    case 'TOOL':
      return 'tool';
    default:
      return 'task';
  }
}

function extractEvaluation(
  metadata: Record<string, unknown>
): { key: string; score: number } | null {
  const rawKey = metadata['evaluation.name'];
  const rawScore = metadata['evaluation.score'];
  if (typeof rawKey !== 'string') return null;
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) return null;
  return { key: rawKey, score: rawScore };
}

export class BraintrustTracer implements Tracer {
  private logger: BtLogger | null = null;
  private initError: Error | null = null;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly maxPending = (() => {
    const parsed = Number.parseInt(process.env.OBSERVABILITY_MAX_PENDING ?? '2000', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 2000;
  })();

  constructor() {
    try {
      if (!process.env.BRAINTRUST_API_KEY) {
        throw new Error(
          'OBSERVABILITY_BACKEND=braintrust requires BRAINTRUST_API_KEY in the environment.'
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bt = require('braintrust') as BraintrustModule;
      this.logger = bt.initLogger({
        projectName: process.env.BRAINTRUST_PROJECT || 'oss-support-agent',
        apiKey: process.env.BRAINTRUST_API_KEY,
        apiUrl: process.env.BRAINTRUST_API_URL,
        asyncFlush: true,
      });
      markAdapterEnabled('braintrust', true);
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err));
      markAdapterEnabled('braintrust', false, this.initError.message);
    }
  }

  startSpan(name: string, opts: StartSpanOpts = {}): Span {
    if (!this.logger) {
      this.warnInitFailureOnce();
      recordAdapterDropped('braintrust', this.initError ?? 'braintrust not initialized');
      return new NoopBtSpan();
    }
    const openInferenceKind = normalizeOpenInferenceSpanKind(opts.kind, opts.attributes);
    const attributes = withOpenInferenceSpanKind(opts.attributes, openInferenceKind);
    const parentBt = opts.parent ? (opts.parent as unknown as { [btSpanSymbol]?: BtSpan })[btSpanSymbol] : undefined;
    const carrier: BtSpan = parentBt ?? this.logger;
    let bt: BtSpan;
    try {
      bt = carrier.startSpan({
        name,
        type: btSpanType(openInferenceKind),
        spanAttributes: attributes,
      });
    } catch (err) {
      recordAdapterDropped('braintrust', err);
      // eslint-disable-next-line no-console
      console.warn(
        `[observability:braintrust] startSpan failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return new NoopBtSpan();
    }

    const buffer: { input?: unknown; output?: unknown; metadata: Record<string, unknown>; error?: string } = {
      metadata: { ...attributes },
    };
    const tracer = this;

    const wrapped: Span & { [btSpanSymbol]: BtSpan } = {
      [btSpanSymbol]: bt,
      setAttributes(attrs) {
        Object.assign(buffer.metadata, attrs);
      },
      setInput(input) {
        buffer.input = redactIo('input', input);
      },
      setOutput(output) {
        buffer.output = redactIo('output', output);
      },
      recordError(err) {
        buffer.error = redactString(err instanceof Error ? err.message : String(err));
      },
      end() {
        const payload: Record<string, unknown> = { metadata: buffer.metadata };
        const evaluation = extractEvaluation(buffer.metadata);
        if (buffer.input !== undefined) payload.input = buffer.input;
        if (buffer.output !== undefined) payload.output = buffer.output;
        if (buffer.error) payload.error = buffer.error;
        if (evaluation) payload.scores = { [evaluation.key]: evaluation.score };
        tracer.track(
          deliverWithRetryAndSpool({
            adapter: 'braintrust',
            operation: 'log',
            payload,
            run: async () => bt.log(payload),
          })
        );
        try {
          bt.end();
        } catch (err) {
          recordAdapterFailed('braintrust', err);
        }
      },
    };
    return wrapped;
  }

  async flush(): Promise<void> {
    if (!this.logger) return;
    const inFlight = Array.from(this.pending);
    await Promise.allSettled(inFlight);
    try {
      // braintrust SDK exposes flush via the module-level function.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bt = require('braintrust') as { flush?: () => Promise<void> };
      if (bt.flush) {
        await deliverWithRetryAndSpool({
          adapter: 'braintrust',
          operation: 'flush',
          payload: { pending: inFlight.length },
          run: () => bt.flush!(),
        });
      }
    } catch (err) {
      recordAdapterFailed('braintrust', err);
    }
  }

  private track(p: Promise<unknown>): void {
    if (this.pending.size >= this.maxPending) {
      recordAdapterDropped('braintrust', `pending queue exceeded max=${this.maxPending}`);
      return;
    }
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => undefined);
  }

  private warnedInitFailure = false;
  private warnInitFailureOnce(): void {
    if (this.warnedInitFailure) return;
    this.warnedInitFailure = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[observability:braintrust] disabled — ${this.initError?.message ?? 'initialization failed'}`
    );
  }
}

class NoopBtSpan implements Span {
  setAttributes(): void {}
  setInput(): void {}
  setOutput(): void {}
  recordError(): void {}
  end(): void {}
}
