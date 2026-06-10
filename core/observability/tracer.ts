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
 * (e.g. the LLM chokepoint in core/llm/v2/chat-client.ts) don't have to thread it
 * through call signatures.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getAdapterDiagnostics,
  initializeAdapterDiagnostics,
  markAdapterEnabled,
  markAdapterSmoke,
  recordAdapterDropped,
  resetAdapterDiagnostics,
  type AdapterDiagnostics,
  type AdapterName,
} from './adapter-health';

export type SpanKind = 'phase' | 'llm' | 'tool' | 'evaluator';

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
type ConcreteBackendName = AdapterName;

const CONCRETE_BACKENDS: ConcreteBackendName[] = ['langsmith', 'arize', 'braintrust'];

let cached: Tracer | null = null;
let cachedBackend: BackendName | null = null;
let cachedAdapters: Array<{ name: AdapterName; tracer: Tracer }> = [];
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

function hasValue(raw: string | undefined): boolean {
  return Boolean(raw && raw.trim().length > 0);
}

function missingConfigForAdapter(adapter: AdapterName): string[] {
  const missing: string[] = [];
  if (adapter === 'langsmith') {
    if (!hasValue(process.env.LANGSMITH_API_KEY) && !hasValue(process.env.LANGCHAIN_API_KEY)) {
      missing.push('LANGSMITH_API_KEY (or LANGCHAIN_API_KEY)');
    }
  }
  if (adapter === 'arize') {
    if (!hasValue(process.env.ARIZE_ENDPOINT) && !hasValue(process.env.PHOENIX_OTLP_ENDPOINT)) {
      missing.push('ARIZE_ENDPOINT (or PHOENIX_OTLP_ENDPOINT)');
    }
  }
  if (adapter === 'braintrust') {
    if (!hasValue(process.env.BRAINTRUST_API_KEY)) {
      missing.push('BRAINTRUST_API_KEY');
    }
  }
  return missing;
}

export interface ObservabilityAdapterContract {
  adapter: AdapterName;
  requested: boolean;
  missing_env: string[];
}

function requestedAdapters(backend: BackendName): Set<AdapterName> {
  if (backend === 'all') return new Set(CONCRETE_BACKENDS);
  if (backend === 'langsmith' || backend === 'arize' || backend === 'braintrust') {
    return new Set([backend]);
  }
  return new Set();
}

export function getObservabilityAdapterContracts(
  rawBackend = process.env.OBSERVABILITY_BACKEND
): ObservabilityAdapterContract[] {
  const backend = resolveBackend(rawBackend);
  const requested = requestedAdapters(backend);
  return CONCRETE_BACKENDS.map((adapter) => ({
    adapter,
    requested: requested.has(adapter),
    missing_env: missingConfigForAdapter(adapter),
  }));
}

/**
 * Validate that required runtime env is present for the selected observability backend.
 * Returns a list of missing environment variables (empty when ready).
 */
export function getObservabilityConfigErrors(rawBackend = process.env.OBSERVABILITY_BACKEND): string[] {
  const normalized = (rawBackend ?? 'none').trim().toLowerCase();
  if (
    normalized !== 'langsmith' &&
    normalized !== 'arize' &&
    normalized !== 'braintrust' &&
    normalized !== 'all' &&
    normalized !== 'none'
  ) {
    return [
      `Unknown OBSERVABILITY_BACKEND="${rawBackend}". Expected one of: langsmith, arize, braintrust, all, none.`,
    ];
  }
  const backend = resolveBackend(rawBackend);
  if (backend === 'none') return [];
  return getObservabilityAdapterContracts(rawBackend)
    .filter((contract) => contract.requested && contract.missing_env.length > 0)
    .flatMap((contract) => contract.missing_env.map((name) => `${contract.adapter}: ${name}`));
}

/**
 * Throw when the selected backend is misconfigured, so the caller can fail fast
 * instead of silently dropping external observability exports.
 */
export function assertObservabilityConfigured(rawBackend = process.env.OBSERVABILITY_BACKEND): void {
  const errors = getObservabilityConfigErrors(rawBackend);
  if (errors.length === 0) return;
  throw new Error(`[observability] Missing required runtime config: ${errors.join(', ')}`);
}

/**
 * Return the process-wide Tracer instance.
 * Resolved once from OBSERVABILITY_BACKEND on first call.
 */
export function getTracer(): Tracer {
  if (cached) return cached;
  const backend = resolveBackend(process.env.OBSERVABILITY_BACKEND);
  cachedBackend = backend;
  const contracts = getObservabilityAdapterContracts(process.env.OBSERVABILITY_BACKEND);
  initializeAdapterDiagnostics(contracts);
  const result = instantiate(backend);
  cached = result.tracer;
  cachedAdapters = result.adapters;
  return result.tracer;
}

function instantiate(backend: BackendName): {
  tracer: Tracer;
  adapters: Array<{ name: AdapterName; tracer: Tracer }>;
} {
  if (backend === 'none') return { tracer: new NoopTracer(), adapters: [] };
  if (backend === 'all') return instantiateAll();
  // Lazy require so we don't load SDK modules when not selected.
  if (backend === 'langsmith') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LangSmithTracer } = require('./langsmith') as typeof import('./langsmith');
    const tracer = new LangSmithTracer();
    return { tracer, adapters: [{ name: 'langsmith', tracer }] };
  }
  if (backend === 'arize') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ArizeTracer } = require('./arize') as typeof import('./arize');
    const tracer = new ArizeTracer();
    return { tracer, adapters: [{ name: 'arize', tracer }] };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BraintrustTracer } = require('./braintrust') as typeof import('./braintrust');
  const tracer = new BraintrustTracer();
  return { tracer, adapters: [{ name: 'braintrust', tracer }] };
}

/**
 * Instantiate all three real tracers and wrap them in a MultiTracer.
 * Any individual tracer that fails to initialise is skipped with a console.warn —
 * a misconfigured platform must never block the agent or the other platforms.
 */
function instantiateAll(): {
  tracer: Tracer;
  adapters: Array<{ name: AdapterName; tracer: Tracer }>;
} {
  const children: Array<{ name: AdapterName; tracer: Tracer }> = [];
  const tryInit = (name: AdapterName, factory: () => Tracer): void => {
    try {
      children.push({ name, tracer: factory() });
    } catch (err) {
      markAdapterEnabled(name, false, err instanceof Error ? err.message : String(err));
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
    return { tracer: new NoopTracer(), adapters: [] };
  }
  return { tracer: new MultiTracer(children), adapters: children };
}

/* -------------------------------------------------------------------------- */
/* MultiTracer — fans out to multiple backends, isolating per-backend errors  */
/* -------------------------------------------------------------------------- */

class MultiSpan implements Span {
  // public so MultiTracer can route parent-child relationships per backend
  public readonly entries: ReadonlyArray<{ name: AdapterName; span: Span }>;
  constructor(entries: Array<{ name: AdapterName; span: Span }>) {
    this.entries = entries;
  }
  private safe(op: string, fn: (e: { name: AdapterName; span: Span }) => void): void {
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
    private readonly children: Array<{ name: AdapterName; tracer: Tracer }>
  ) {}
  startSpan(name: string, opts?: StartSpanOpts): Span {
    // If a MultiSpan parent is supplied, route each child tracer's startSpan
    // through that child's own parent span — otherwise the parent context
    // would be lost (each backend has its own internal span ID space).
    const parentEntries =
      opts?.parent instanceof MultiSpan ? opts.parent.entries : null;
    const entries: Array<{ name: AdapterName; span: Span }> = [];
    for (const c of this.children) {
      try {
        const childParent = parentEntries?.find((p) => p.name === c.name)?.span;
        const childOpts: StartSpanOpts = childParent
          ? { ...opts, parent: childParent }
          : { ...opts, parent: undefined };
        entries.push({ name: c.name, span: c.tracer.startSpan(name, childOpts) });
      } catch (err) {
        recordAdapterDropped(c.name, err);
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
          recordAdapterDropped(c.name, err);
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

export function getObservabilityDiagnostics(): AdapterDiagnostics[] {
  return getAdapterDiagnostics();
}

export interface ObservabilitySmokeResult {
  adapter: AdapterName;
  ok: boolean;
  detail: string;
}

function counterSnapshotByAdapter(): Record<AdapterName, AdapterDiagnostics['delivery']> {
  const snapshot = {} as Record<AdapterName, AdapterDiagnostics['delivery']>;
  for (const entry of getAdapterDiagnostics()) {
    snapshot[entry.adapter] = { ...entry.delivery };
  }
  return snapshot;
}

export async function runObservabilityStartupSmoke(): Promise<ObservabilitySmokeResult[]> {
  getTracer();
  const diagnostics = getAdapterDiagnostics();
  const enabledAdapters = new Set(
    diagnostics.filter((d) => d.requested && d.enabled).map((d) => d.adapter)
  );
  const results: ObservabilitySmokeResult[] = [];
  const deployId = process.env.RENDER_GIT_COMMIT || process.env.RENDER_DEPLOY_ID || 'local';

  for (const adapterEntry of cachedAdapters) {
    if (!enabledAdapters.has(adapterEntry.name)) continue;

    const before = counterSnapshotByAdapter()[adapterEntry.name] ?? {
      sent: 0,
      failed: 0,
      dropped: 0,
      retries: 0,
      spooled: 0,
    };

    try {
      const span = adapterEntry.tracer.startSpan('telemetry_smoke', {
        kind: 'evaluator',
        attributes: {
          'telemetry.synthetic': true,
          'telemetry.adapter': adapterEntry.name,
          'telemetry.deploy_id': deployId,
        },
      });
      span.setInput({ synthetic: true, adapter: adapterEntry.name, deployId });
      span.setOutput({ ok: true });
      span.end();
      await adapterEntry.tracer.flush();

      const after = counterSnapshotByAdapter()[adapterEntry.name] ?? before;
      const sentDelta = after.sent - before.sent;
      const failureDelta = after.failed - before.failed;
      const droppedDelta = after.dropped - before.dropped;

      if (failureDelta > 0 || droppedDelta > 0 || sentDelta <= 0) {
        const detail = `sentΔ=${sentDelta}, failedΔ=${failureDelta}, droppedΔ=${droppedDelta}`;
        markAdapterSmoke(adapterEntry.name, false, detail);
        results.push({ adapter: adapterEntry.name, ok: false, detail });
      } else {
        const detail = `sentΔ=${sentDelta}`;
        markAdapterSmoke(adapterEntry.name, true);
        results.push({ adapter: adapterEntry.name, ok: true, detail });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      markAdapterSmoke(adapterEntry.name, false, detail);
      recordAdapterDropped(adapterEntry.name, err);
      results.push({ adapter: adapterEntry.name, ok: false, detail });
    }
  }
  return results;
}

/** Test-only: reset the cached tracer so factory selection can be re-run. */
export function _resetTracer(): void {
  cached = null;
  cachedBackend = null;
  cachedAdapters = [];
  warnedUnknown = false;
  resetAdapterDiagnostics();
}

/** Returns the backend name that getTracer() resolved to, or null if not yet called. */
export function activeBackend(): BackendName | null {
  return cachedBackend;
}
