# Setup friction log

_Auto-generated from each platform adapter's `getSetupNotes()` after the eval runner finished._

## arize

- Arize AX needed FOUR OTel + OpenInference packages to manually instrument: @opentelemetry/sdk-trace-base, @opentelemetry/exporter-trace-otlp-http, @opentelemetry/resources, @arizeai/openinference-semantic-conventions. No single "Arize AX SDK" package wraps these.
- We intentionally avoided the OpenInference auto-instrumentation patchers for this benchmark so all three platforms received equivalent manually-emitted spans; that increased setup and maintenance burden in the Arize path.
- Arize AX routing uses the `arize-api-key` and `arize-space-id` OTLP headers plus `ARIZE_PROJECT_NAME` as the OpenInference project resource.
- Pipeline RunSummary is emitted as one OTel CHAIN span plus per-issue EVALUATOR spans. Arize AX's experiments UI can aggregate these metrics, but the JS ecosystem still lacks a first-class "log evaluation row" helper comparable to Braintrust's Eval().

## langsmith

- LangSmith SDK has no .ping() / .health() — verifying credentials required iterating listProjects(). Discovered after a TypeError when treating it as a Promise.
- LangSmith's official tracing surface assumes LangChain code: most docs examples wrap a RunnableLambda with traceable(). For non-LangChain code (like ours), the SDK works but every trace requires explicit RunTree construction or explicit Client.createRun + Client.updateRun pairs. Parent/child must be passed via parent_run_id every time.
- Dataset evaluation (running an evaluator against a dataset) is a separate code path from tracing. There is no "while tracing this run, also score it against dataset X" — you must call client.evaluate() or use the Eval SDK as a post-pass.

## braintrust

- Braintrust scorers are evaluated INSIDE Eval() — they take expected/output and return a score. To log a custom score for an arbitrary already-recorded span, the only path is span.log({ scores: { ... } }) on the span you created. There's no separate "addScore" API for an external reviewer to attach scores to existing experiment rows.
- Braintrust experiment URL: https://www.braintrust.dev/app/OSS-Support-Bot/p/oss-fix-loop/experiments/oss-fix-loop-2026-05-29T06-05-02-898Z

## Cross-platform observations

- **No standard exists for parent/child agent traces.** Each platform models a multi-stage pipeline differently: OpenInference uses OTel spans with `openinference.span.kind`; LangSmith uses `RunTree` with explicit parent IDs; Braintrust uses nested `startSpan` calls inside an Experiment row. Every platform required custom adapter code to express the same triage → PM flow.
- **None of the SDKs auto-detected a pre-existing OTel SDK setup.** When the OpenInference instrumentation registers a tracer provider, neither LangSmith nor Braintrust hook into it; each platform requires its own initialisation path.
- **"Evaluations" mean three different things.** Arize AX evaluations are post-hoc LLM-as-a-judge over recorded traces, LangSmith evaluations re-run the pipeline against a dataset on demand, and Braintrust evaluations are first-class Experiments with custom scorers. Picking which abstraction to use is itself a research project.
- **Token tracking only happens if the adapter populates token attributes.** None of the platforms inferred input/output token counts from the Anthropic response shape; every platform required us to extract `usage.input_tokens` / `usage.output_tokens` manually and set the platform-specific attribute keys.
- **Non-LLM pipeline steps (the PM heuristic) are awkward on all three.** OpenInference has no clean span kind for "deterministic stage"; LangSmith expects an `inputs`/`outputs` JSON object; Braintrust expects an `input`/`output` pair on a span. We emitted shim "stage" spans that contain a JSON-stringified summary instead of an LLM prompt — readable, but not native to any platform.
