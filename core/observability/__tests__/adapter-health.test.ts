import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  deliverWithRetryAndSpool,
  getAdapterDiagnostics,
  initializeAdapterDiagnostics,
  resetAdapterDiagnostics,
} from '../adapter-health';

describe('adapter-health delivery diagnostics', () => {
  const ORIGINAL_ENV = { ...process.env };
  let spoolDir = '';

  beforeEach(() => {
    spoolDir = path.join(os.tmpdir(), `osa-telemetry-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    process.env.OBSERVABILITY_SPOOL_DIR = spoolDir;
    process.env.OBSERVABILITY_RETRY_ATTEMPTS = '2';
    process.env.OBSERVABILITY_RETRY_BASE_MS = '1';
    initializeAdapterDiagnostics([
      { adapter: 'langsmith', requested: true, missing_env: [] },
      { adapter: 'arize', requested: false, missing_env: [] },
      { adapter: 'braintrust', requested: false, missing_env: [] },
    ]);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(spoolDir, { force: true, recursive: true });
    resetAdapterDiagnostics();
  });

  it('retries transient failures and records a sent delivery on eventual success', async () => {
    let attempts = 0;
    const ok = await deliverWithRetryAndSpool({
      adapter: 'langsmith',
      operation: 'createRun',
      payload: { id: 'run-1' },
      run: async () => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('socket hang up') as Error & { code?: string };
          err.code = 'ECONNRESET';
          throw err;
        }
      },
    });

    expect(ok).toBe(true);
    const langsmith = getAdapterDiagnostics().find((d) => d.adapter === 'langsmith')!;
    expect(langsmith.delivery.sent).toBe(1);
    expect(langsmith.delivery.retries).toBe(1);
    expect(langsmith.delivery.failed).toBe(0);
    expect(fs.existsSync(langsmith.spool_path)).toBe(false);
  });

  it('spools payloads after transient failures exhaust retry budget', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ok = await deliverWithRetryAndSpool({
      adapter: 'langsmith',
      operation: 'createRun',
      payload: { id: 'run-2' },
      run: async () => {
        const err = new Error('request timed out') as Error & { code?: string };
        err.code = 'ETIMEDOUT';
        throw err;
      },
    });
    warn.mockRestore();

    expect(ok).toBe(false);
    const langsmith = getAdapterDiagnostics().find((d) => d.adapter === 'langsmith')!;
    expect(langsmith.delivery.failed).toBe(1);
    expect(langsmith.delivery.spooled).toBe(1);
    expect(fs.existsSync(langsmith.spool_path)).toBe(true);
  });
});
