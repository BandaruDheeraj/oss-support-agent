/**
 * Optional input/output redaction for span payloads.
 *
 * When OBSERVABILITY_REDACT_IO=true, full prompt/response bodies are replaced
 * with `{ redacted: true, length, sha1 }` so the trace remains useful (latency,
 * tokens, shape) without exfiltrating raw content to the backend.
 *
 * String-level secret scrubbing (API keys, tokens) is delegated to
 * core/observability/redact.ts so it runs in *both* modes.
 */
import { createHash } from 'node:crypto';
import { redactValue } from './redact';

export function ioRedactionEnabled(): boolean {
  return (process.env.OBSERVABILITY_REDACT_IO ?? '').toLowerCase() === 'true';
}

function summarize(label: string, value: unknown): unknown {
  const serialized = (() => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  })();
  return {
    redacted: true,
    label,
    length: serialized.length,
    sha1: createHash('sha1').update(serialized).digest('hex'),
  };
}

/** Apply IO-mode redaction if enabled; always run string secret scrubbing. */
export function redactIo(label: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (ioRedactionEnabled()) return summarize(label, value);
  return redactValue(value);
}
