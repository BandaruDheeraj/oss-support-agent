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

function btSpanType(kind: StartSpanOpts['kind']): string {
  switch (kind) {
    case 'llm':
      return 'llm';
    case 'tool':
      return 'tool';
    case 'phase':
      return 'task';
    default:
      return 'task';
  }
}

export class BraintrustTracer implements Tracer {
  private logger: BtLogger | null = null;
  private initError: Error | null = null;

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
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err));
    }
  }

  startSpan(name: string, opts: StartSpanOpts = {}): Span {
    if (!this.logger) {
      this.warnInitFailureOnce();
      return new NoopBtSpan();
    }
    const parentBt = opts.parent ? (opts.parent as unknown as { [btSpanSymbol]?: BtSpan })[btSpanSymbol] : undefined;
    const carrier: BtSpan = parentBt ?? this.logger;
    let bt: BtSpan;
    try {
      bt = carrier.startSpan({
        name,
        type: btSpanType(opts.kind),
        spanAttributes: opts.attributes ?? {},
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[observability:braintrust] startSpan failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return new NoopBtSpan();
    }

    const buffer: { input?: unknown; output?: unknown; metadata: Record<string, unknown>; error?: string } = {
      metadata: { ...(opts.attributes ?? {}) },
    };

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
        buffer.error = err instanceof Error ? err.message : String(err);
      },
      end() {
        try {
          const payload: Record<string, unknown> = { metadata: buffer.metadata };
          if (buffer.input !== undefined) payload.input = buffer.input;
          if (buffer.output !== undefined) payload.output = buffer.output;
          if (buffer.error) payload.error = buffer.error;
          bt.log(payload);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[observability:braintrust] log failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        try {
          bt.end();
        } catch {
          // ignore
        }
      },
    };
    return wrapped;
  }

  async flush(): Promise<void> {
    if (!this.logger) return;
    try {
      // braintrust SDK exposes flush via the module-level function.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bt = require('braintrust') as { flush?: () => Promise<void> };
      if (bt.flush) await bt.flush();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[observability:braintrust] flush failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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
