/**
 * Pluggable Tracer interface — backend-agnostic LLM observability.
 *
 * One Tracer instance is selected at process start via OBSERVABILITY_BACKEND:
 *   - "langsmith" → LangSmithTracer (langsmith SDK)
 *   - "arize"     → ArizeTracer (OTel + OpenInference semantic conventions)
 *   - "braintrust"→ BraintrustTracer (braintrust SDK)
 *   - "none"      → NoopTracer (default — zero overhead, no extra deps loaded)
 *
 * Span parent context flows via AsyncLocalStorage so call-site wrappers
 * (e.g. the LLM chokepoint in core/llm/client.ts) don't have to thread it
 * through call signatures.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type SpanKind = 'phase' | 'llm' | 'tool';

export interface Span {
  setAttributes(attrs: Record<string, unknown>): void;
  setInput(input: unknown): void;
  setOutput(output: unknown): void;
  recordError(err: unknown): void;
  end(): void;
}

export interface StartSpanOpts {
  parent?: Span;
  attributes?: Record<string, unknown>;
  kind?: SpanKind;
}

export interface Tracer {
  startSpan(name: string, opts?: StartSpanOpts): Span;
  flush(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* AsyncLocalStorage-based parent context                                     */
/* -------------------------------------------------------------------------- */

const spanStorage = new AsyncLocalStorage<Span>();

/**
 * Returns the Span currently active on this async context, or undefined.
 * Used by the LLM chokepoint to attach LLM spans to the enclosing phase span.
 */
export function currentSpan(): Span | undefined {
  return spanStorage.getStore();
}

/**
 * Execute `fn` with `span` as the active parent on this async chain.
 * Does not end the span — caller is still responsible for span.end().
 */
export async function runWithSpan<T>(span: Span, fn: () => Promise<T>): Promise<T> {
  return spanStorage.run(span, fn);
}

/* -------------------------------------------------------------------------- */
/* NoopTracer + NoopSpan                                                       */
/* -------------------------------------------------------------------------- */

class NoopSpan implements Span {
  setAttributes(): void {}
  setInput(): void {}
  setOutput(): void {}
  recordError(): void {}
  end(): void {}
}

const SINGLETON_NOOP_SPAN = new NoopSpan();

export class NoopTracer implements Tracer {
  startSpan(): Span {
    return SINGLETON_NOOP_SPAN;
  }
  async flush(): Promise<void> {}
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export type BackendName = 'langsmith' | 'arize' | 'braintrust' | 'all' | 'none';

let cached: Tracer | null = null;
let cachedBackend: BackendName | null = null;
let warnedUnknown = false;

function resolveBackend(raw: string | undefined): BackendName {
  const normalized = (raw ?? 'none').trim().toLowerCase();
  if (
    normalized === 'langsmith' ||
    normalized === 'arize' ||
    normalized === 'braintrust' ||
    normalized === 'all' ||
    normalized === 'none'
  ) {
    return normalized;
  }
  if (!warnedUnknown) {
    warnedUnknown = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[observability] Unknown OBSERVABILITY_BACKEND="${raw}" — falling back to NoopTracer.`
    );
  }
  return 'none';
}

/**
 * Return the process-wide Tracer instance.
 * Resolved once from OBSERVABILITY_BACKEND on first call.
 */
export function getTracer(): Tracer {
  if (cached) return cached;
  const backend = resolveBackend(process.env.OBSERVABILITY_BACKEND);
  cachedBackend = backend;
  cached = instantiate(backend);
  return cached;
}

function instantiate(backend: BackendName): Tracer {
  if (backend === 'none') return new NoopTracer();
  if (backend === 'all') return instantiateAll();
  // Lazy require so we don't load SDK modules when not selected.
  if (backend === 'langsmith') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LangSmithTracer } = require('./langsmith') as typeof import('./langsmith');
    return new LangSmithTracer();
  }
  if (backend === 'arize') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ArizeTracer } = require('./arize') as typeof import('./arize');
    return new ArizeTracer();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BraintrustTracer } = require('./braintrust') as typeof import('./braintrust');
  return new BraintrustTracer();
}

/**
 * Instantiate all three real tracers and wrap them in a MultiTracer.
 * Any individual tracer that fails to initialise is skipped with a console.warn —
 * a misconfigured platform must never block the agent or the other platforms.
 */
function instantiateAll(): Tracer {
  const children: Array<{ name: string; tracer: Tracer }> = [];
  const tryInit = (name: string, factory: () => Tracer): void => {
    try {
      children.push({ name, tracer: factory() });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[observability] Failed to initialise ${name} for OBSERVABILITY_BACKEND=all: ` +
          `${err instanceof Error ? err.message : String(err)}. Continuing without it.`
      );
    }
  };
  tryInit('langsmith', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LangSmithTracer } = require('./langsmith') as typeof import('./langsmith');
    return new LangSmithTracer();
  });
  tryInit('arize', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ArizeTracer } = require('./arize') as typeof import('./arize');
    return new ArizeTracer();
  });
  tryInit('braintrust', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BraintrustTracer } = require('./braintrust') as typeof import('./braintrust');
    return new BraintrustTracer();
  });
  if (children.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[observability] OBSERVABILITY_BACKEND=all but no backend initialised; using NoopTracer.`
    );
    return new NoopTracer();
  }
  return new MultiTracer(children);
}

/* -------------------------------------------------------------------------- */
/* MultiTracer — fans out to multiple backends, isolating per-backend errors  */
/* -------------------------------------------------------------------------- */

class MultiSpan implements Span {
  // public so MultiTracer can route parent-child relationships per backend
  public readonly entries: ReadonlyArray<{ name: string; span: Span }>;
  constructor(entries: Array<{ name: string; span: Span }>) {
    this.entries = entries;
  }
  private safe(op: string, fn: (e: { name: string; span: Span }) => void): void {
    for (const e of this.entries) {
      try {
        fn(e);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[observability] ${e.name}.${op} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  setAttributes(attrs: Record<string, unknown>): void {
    this.safe('setAttributes', (e) => e.span.setAttributes(attrs));
  }
  setInput(input: unknown): void {
    this.safe('setInput', (e) => e.span.setInput(input));
  }
  setOutput(output: unknown): void {
    this.safe('setOutput', (e) => e.span.setOutput(output));
  }
  recordError(err: unknown): void {
    this.safe('recordError', (e) => e.span.recordError(err));
  }
  end(): void {
    this.safe('end', (e) => e.span.end());
  }
}

class MultiTracer implements Tracer {
  constructor(
    private readonly children: Array<{ name: string; tracer: Tracer }>
  ) {}
  startSpan(name: string, opts?: StartSpanOpts): Span {
    // If a MultiSpan parent is supplied, route each child tracer's startSpan
    // through that child's own parent span — otherwise the parent context
    // would be lost (each backend has its own internal span ID space).
    const parentEntries =
      opts?.parent instanceof MultiSpan ? opts.parent.entries : null;
    const entries: Array<{ name: string; span: Span }> = [];
    for (const c of this.children) {
      try {
        const childParent = parentEntries?.find((p) => p.name === c.name)?.span;
        const childOpts: StartSpanOpts = childParent
          ? { ...opts, parent: childParent }
          : { ...opts, parent: undefined };
        entries.push({ name: c.name, span: c.tracer.startSpan(name, childOpts) });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[observability] ${c.name}.startSpan(${name}) failed: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return new MultiSpan(entries);
  }
  async flush(): Promise<void> {
    await Promise.all(
      this.children.map(async (c) => {
        try {
          await c.tracer.flush();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[observability] ${c.name}.flush failed: ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        }
      })
    );
  }
}

/** Test-only: reset the cached tracer so factory selection can be re-run. */
export function _resetTracer(): void {
  cached = null;
  cachedBackend = null;
  warnedUnknown = false;
}

/** Returns the backend name that getTracer() resolved to, or null if not yet called. */
export function activeBackend(): BackendName | null {
  return cachedBackend;
}
