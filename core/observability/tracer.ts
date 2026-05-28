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

export type BackendName = 'langsmith' | 'arize' | 'braintrust' | 'none';

let cached: Tracer | null = null;
let cachedBackend: BackendName | null = null;
let warnedUnknown = false;

function resolveBackend(raw: string | undefined): BackendName {
  const normalized = (raw ?? 'none').trim().toLowerCase();
  if (normalized === 'langsmith' || normalized === 'arize' || normalized === 'braintrust' || normalized === 'none') {
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
