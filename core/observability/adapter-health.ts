import fs from 'node:fs';
import path from 'node:path';

export type AdapterName = 'langsmith' | 'arize' | 'braintrust';

const ADAPTERS: AdapterName[] = ['langsmith', 'arize', 'braintrust'];

export interface AdapterDeliveryCounters {
  sent: number;
  failed: number;
  dropped: number;
  retries: number;
  spooled: number;
}

export interface AdapterDiagnostics {
  adapter: AdapterName;
  requested: boolean;
  enabled: boolean;
  missing_env: string[];
  init_error: string | null;
  last_error: string | null;
  connected: boolean | null;
  smoke_at: string | null;
  spool_path: string;
  delivery: AdapterDeliveryCounters;
}

interface MutableAdapterDiagnostics extends AdapterDiagnostics {}

interface AdapterContract {
  adapter: AdapterName;
  requested: boolean;
  missing_env: string[];
}

interface RetryAndSpoolOptions {
  adapter: AdapterName;
  operation: string;
  payload: unknown;
  run: () => Promise<unknown>;
}

let diagnostics: Record<AdapterName, MutableAdapterDiagnostics> = {
  langsmith: newDefaultState('langsmith'),
  arize: newDefaultState('arize'),
  braintrust: newDefaultState('braintrust'),
};

function newDefaultState(adapter: AdapterName): MutableAdapterDiagnostics {
  return {
    adapter,
    requested: false,
    enabled: false,
    missing_env: [],
    init_error: null,
    last_error: null,
    connected: null,
    smoke_at: null,
    spool_path: spoolPathFor(adapter),
    delivery: {
      sent: 0,
      failed: 0,
      dropped: 0,
      retries: 0,
      spooled: 0,
    },
  };
}

function spoolRootDir(): string {
  return process.env.OBSERVABILITY_SPOOL_DIR || '.osa-telemetry-spool';
}

function spoolPathFor(adapter: AdapterName): string {
  return path.resolve(spoolRootDir(), `${adapter}.jsonl`);
}

function ensure(adapter: AdapterName): MutableAdapterDiagnostics {
  if (!diagnostics[adapter]) diagnostics[adapter] = newDefaultState(adapter);
  const state = diagnostics[adapter];
  // Keep spool path in sync with env if it changes in tests/runtime.
  state.spool_path = spoolPathFor(adapter);
  return state;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function readStatusCode(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const maybe = err as { status?: unknown; statusCode?: unknown; code?: unknown };
  if (typeof maybe.status === 'number') return maybe.status;
  if (typeof maybe.statusCode === 'number') return maybe.statusCode;
  if (typeof maybe.code === 'number') return maybe.code;
  return null;
}

function readStringCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const maybe = err as { code?: unknown };
  if (typeof maybe.code === 'string') return maybe.code.toUpperCase();
  return null;
}

function isTransientError(err: unknown): boolean {
  const status = readStatusCode(err);
  if (status === 408 || status === 429) return true;
  if (status !== null && status >= 500) return true;

  const code = readStringCode(err);
  if (
    code &&
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code)
  ) {
    return true;
  }

  const msg = toErrorMessage(err).toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('temporar') ||
    msg.includes('network') ||
    msg.includes('connection reset') ||
    msg.includes('socket hang up') ||
    msg.includes('service unavailable')
  );
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function retryAttempts(): number {
  return parsePositiveInt(process.env.OBSERVABILITY_RETRY_ATTEMPTS, 3);
}

const RETRY_BASE_DELAY_MS = parsePositiveInt(process.env.OBSERVABILITY_RETRY_BASE_MS, 200);

function backoffDelayMs(attempt: number): number {
  // attempt starts at 1 for first retry
  return RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendSpoolEntry(
  adapter: AdapterName,
  entry: {
    ts: string;
    adapter: AdapterName;
    operation: string;
    attempts: number;
    error: string;
    payload: unknown;
  }
): boolean {
  const state = ensure(adapter);
  try {
    fs.mkdirSync(path.dirname(state.spool_path), { recursive: true });
    fs.appendFileSync(state.spool_path, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' });
    state.delivery.spooled += 1;
    return true;
  } catch (err) {
    state.last_error = `spool-write-failed: ${toErrorMessage(err)}`;
    state.delivery.dropped += 1;
    return false;
  }
}

export function initializeAdapterDiagnostics(contracts: AdapterContract[]): void {
  diagnostics = {
    langsmith: newDefaultState('langsmith'),
    arize: newDefaultState('arize'),
    braintrust: newDefaultState('braintrust'),
  };
  for (const contract of contracts) {
    const state = ensure(contract.adapter);
    state.requested = contract.requested;
    state.missing_env = [...contract.missing_env];
  }
}

export function markAdapterEnabled(adapter: AdapterName, enabled: boolean, initError?: string): void {
  const state = ensure(adapter);
  state.enabled = enabled;
  if (!enabled && initError) {
    state.init_error = initError;
    state.last_error = initError;
  }
}

export function markAdapterSmoke(adapter: AdapterName, connected: boolean, error?: string): void {
  const state = ensure(adapter);
  state.connected = connected;
  state.smoke_at = new Date().toISOString();
  if (error) state.last_error = error;
}

export function recordAdapterSent(adapter: AdapterName, count = 1): void {
  const state = ensure(adapter);
  state.delivery.sent += count;
}

export function recordAdapterFailed(adapter: AdapterName, err: unknown): void {
  const state = ensure(adapter);
  state.delivery.failed += 1;
  state.last_error = toErrorMessage(err);
}

export function recordAdapterDropped(adapter: AdapterName, err?: unknown): void {
  const state = ensure(adapter);
  state.delivery.dropped += 1;
  if (err !== undefined) state.last_error = toErrorMessage(err);
}

export function getAdapterDiagnostics(): AdapterDiagnostics[] {
  return ADAPTERS.map((name) => {
    const s = ensure(name);
    return {
      adapter: s.adapter,
      requested: s.requested,
      enabled: s.enabled,
      missing_env: [...s.missing_env],
      init_error: s.init_error,
      last_error: s.last_error,
      connected: s.connected,
      smoke_at: s.smoke_at,
      spool_path: s.spool_path,
      delivery: {
        sent: s.delivery.sent,
        failed: s.delivery.failed,
        dropped: s.delivery.dropped,
        retries: s.delivery.retries,
        spooled: s.delivery.spooled,
      },
    };
  });
}

export async function deliverWithRetryAndSpool(options: RetryAndSpoolOptions): Promise<boolean> {
  const attempts = retryAttempts();
  let attempt = 1;
  while (true) {
    try {
      await options.run();
      recordAdapterSent(options.adapter);
      return true;
    } catch (err) {
      const transient = isTransientError(err);
      if (transient && attempt < attempts) {
        const state = ensure(options.adapter);
        state.delivery.retries += 1;
        await sleep(backoffDelayMs(attempt));
        attempt += 1;
        continue;
      }
      recordAdapterFailed(options.adapter, err);
      if (transient) {
        appendSpoolEntry(options.adapter, {
          ts: new Date().toISOString(),
          adapter: options.adapter,
          operation: options.operation,
          attempts: attempt,
          error: toErrorMessage(err),
          payload: options.payload,
        });
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[observability:${options.adapter}] ${options.operation} failed: ${toErrorMessage(err)}`
      );
      return false;
    }
  }
}

export function resetAdapterDiagnostics(): void {
  diagnostics = {
    langsmith: newDefaultState('langsmith'),
    arize: newDefaultState('arize'),
    braintrust: newDefaultState('braintrust'),
  };
}
