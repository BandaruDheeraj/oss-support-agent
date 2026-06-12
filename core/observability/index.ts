/**
 * Public observability surface for the pluggable Tracer.
 *
 * Existing call-sites that use withAgentSpan / withToolSpan / redactString
 * keep working, and new call-sites can import the full public surface here.
 */
export type {
  Tracer,
  Span,
  StartSpanOpts,
  SpanKind,
  OpenInferenceSpanKind,
  BackendName,
} from './tracer';
export {
  OPENINFERENCE_SPAN_KIND_ATTRIBUTE,
  OPENINFERENCE_SPAN_KINDS,
  getTracer,
  currentSpan,
  runWithSpan,
  normalizeOpenInferenceSpanKind,
  withOpenInferenceSpanKind,
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
export {
  withOpenInferenceSpan,
  withAgentSpan,
  withToolSpan,
  currentTraceIds,
  type BaseSpanAttrs,
} from './spans';
