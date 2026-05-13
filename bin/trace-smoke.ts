#!/usr/bin/env node
/**
 * One-shot trace smoke test: emits a tiny agent+tool span tree and
 * asserts spans flush. Exit code 0 on success, non-zero on failure.
 */

import { initTracing } from '../core/observability/tracing';
import { runTraceSmoke } from '../core/observability/trace-smoke-test';

async function main(): Promise<number> {
  initTracing();
  const r = await runTraceSmoke();
  console.log(JSON.stringify(r, null, 2));
  if (!r.agentSpanEmitted || !r.toolSpanEmitted || !r.flushedOk || r.errors.length > 0) return 1;
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(2); });
