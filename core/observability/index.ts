/**
 * Public observability surface for the pluggable Tracer.
 *
 * Existing call-sites that use withAgentSpan / withToolSpan / redactString
 * keep importing directly from ./spans and ./redact — they are not affected.
 *
 * New call-sites (the LLM chokepoint in core/llm/client.ts and the phase
 * wrappers in core/agents/run-v2.ts) import getTracer from here.
 */
export type { Tracer, Span, StartSpanOpts, SpanKind, BackendName } from './tracer';
export {
  getTracer,
  currentSpan,
  runWithSpan,
  NoopTracer,
  activeBackend,
  getObservabilityAdapterContracts,
  getObservabilityDiagnostics,
  runObservabilityStartupSmoke,
  getObservabilityConfigErrors,
  assertObservabilityConfigured,
  _resetTracer,
} from './tracer';
export type { AdapterDiagnostics } from './adapter-health';
