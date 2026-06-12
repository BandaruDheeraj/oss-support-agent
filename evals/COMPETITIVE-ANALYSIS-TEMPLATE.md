# Observability platform comparison: Arize AX vs LangSmith vs Braintrust

> Test subject: the OSS Fix Loop multi-agent harness (`BandaruDheeraj/oss-support-agent`). The eval ran 20 real-looking openinference issues through the triage and PM scoring stages, fanning every span out to all three platforms in parallel using a single shared wrapper at `core/telemetry.ts`.

> Run `run-1780034709711` — 2026-05-29T06:05:09.711Z

## 1. Test methodology

The OSS Fix Loop is a multi-stage agent harness (triage → PM → fix → build → eval) that opens real PRs against real OSS repos. For this study we instrumented only the read-only stages (triage + PM scoring) so the comparison would be reproducible without side effects:

- **Triage**: a heuristic classifier picks the issue type (bug_fix / new_feature / docs) and the per-repo `OpenInferenceAdapter` routes to an affected module path.
- **PM scoring**: a deterministic heuristic that decides whether a design review is needed before code is written.
- Both stages emit spans through `core/telemetry.ts`, which fans out to every registered platform via `Promise.all` and swallows individual platform failures so the harness is never blocked.

Why this is a good eval subject: the pipeline is multi-stage, it mixes LLM and non-LLM steps, and it produces measurable outputs (module path, design-needed bool) that can be scored against a labelled golden set.

We measured:
- **Triage accuracy**: 1.0 for exact module match, 0.5 if the parent directory matches, 0.0 otherwise.
- **PM design-score accuracy**: 1.0 if `design_needed` matches the labelled expectation, else 0.0.
- **Latency per stage** and **token usage** captured by the wrapper.

## 2. Quantitative results

### Per-platform telemetry stats

| Platform | Traces sent | Errors | Avg trace latency |
|----------|------------:|-------:|------------------:|
| arize | 41 | 0 | 0.0 ms |
| langsmith | 41 | 0 | 0.0 ms |
| braintrust | 41 | 0 | 0.0 ms |

### Aggregate scoring

- **PM accuracy overall:** 55.0%
- **Triage accuracy by difficulty:**
  - easy: 80.0%
  - medium: 25.0%
  - hard: 50.0%
- **Avg latency:** triage 6.0 ms, PM 4.3 ms
- **Total tokens:** 0 input / 0 output

## 3. Setup experience — by platform

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


## 4. Developer productivity observations — by platform

### Arize AX
- **Time to first trace visible in UI:** [MANUAL]
- **Trace UI quality for multi-agent pipelines:** [MANUAL]
- **Dataset and eval management workflow:** [MANUAL]
- **Prompt / experiment versioning:** [MANUAL]
- **Debugging workflow when an agent run fails:** [MANUAL]
- **Documentation quality and completeness:** [MANUAL]
- **Missing features I wanted but couldn't find:** [MANUAL]

### LangSmith
- **Time to first trace visible in UI:** [MANUAL]
- **Trace UI quality for multi-agent pipelines:** [MANUAL]
- **Dataset and eval management workflow:** [MANUAL]
- **Prompt / experiment versioning:** [MANUAL]
- **Debugging workflow when an agent run fails:** [MANUAL]
- **Documentation quality and completeness:** [MANUAL]
- **Missing features I wanted but couldn't find:** [MANUAL]

### Braintrust
- **Time to first trace visible in UI:** [MANUAL]
- **Trace UI quality for multi-agent pipelines:** [MANUAL]
- **Dataset and eval management workflow:** [MANUAL]
- **Prompt / experiment versioning:** [MANUAL]
- **Debugging workflow when an agent run fails:** [MANUAL]
- **Documentation quality and completeness:** [MANUAL]
- **Missing features I wanted but couldn't find:** [MANUAL]

## 5. Systematic evaluator review (keep this updated each run)

### 5.1 Weighted scorecard for this run

Scoring scale: 1 (poor) to 5 (excellent). Keep these weights stable across runs so platform trends remain comparable.

| Criterion | Weight (%) | Arize | LangSmith | Braintrust | Winner | Evidence / notes |
|-----------|-----------:|------:|----------:|-----------:|--------|------------------|
| Multi-agent trace readability | 20 | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| Evaluator authoring + execution workflow | 20 | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| Discrepancy debugging speed | 15 | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| Dataset/experiment management | 15 | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| API/SDK ergonomics | 15 | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| Documentation quality | 15 | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| **Weighted total (0-5)** | **100** | **[MANUAL]** | **[MANUAL]** | **[MANUAL]** | **[MANUAL]** | **[MANUAL]** |

### 5.2 Run-over-run leaderboard

| Run ID | Arize weighted total | LangSmith weighted total | Braintrust weighted total | Best overall | Biggest change vs previous run | Notes |
|--------|---------------------:|-------------------------:|--------------------------:|--------------|--------------------------------|------|
| `run-1780034709711` | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |

### 5.3 Discrepancy register (how evaluators differ)

Record every meaningful mismatch in evaluator behavior, not just outright failures.

| Run ID | Issue / scenario | Expected evaluator behavior | Arize observed | LangSmith observed | Braintrust observed | Discrepancy type | Severity | Follow-up |
|--------|------------------|-----------------------------|----------------|--------------------|---------------------|------------------|----------|-----------|
| `run-1780034709711` | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |

Discrepancy type taxonomy (recommended): `scoring`, `trace-model`, `dataset-eval`, `metadata/tokens`, `UI/ux`, `API/SDK`, `latency/reliability`.

## 6. Summary comparison

| Platform | Traces sent | Errors | Avg trace latency | UI for multi-agent | Eval workflow | Docs | Weighted total | Wins this run | Main discrepancy risk |
|----------|------------:|-------:|------------------:|--------------------|---------------|------|---------------:|--------------:|-----------------------|
| arize | 41 | 0 | 0.0 ms | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| langsmith | 41 | 0 | 0.0 ms | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| braintrust | 41 | 0 | 0.0 ms | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |

## 7. Recommendation

[MANUAL] Recommendation for a team building multi-agent pipelines in 2026.

## 8. Persistent setup gap ledger (skill-maintained)

Authoritative cross-run backlog for setup/SDK friction discovered in this repo. Each row must name exactly one owner (`arize-ax` or `openinference`) and explicitly explain competitor ease.

| Gap ID | Owner | Job | Competitor platform | Competitor mechanism (why easier there) | Current behavior in oss-support-agent | Proposed fix | Status | Priority | Evidence (`path:line` + run artifact) | Created | Last validated |
|--------|-------|-----|---------------------|------------------------------------------|---------------------------------------|--------------|--------|----------|----------------------------------------|---------|----------------|
| AX-001 | arize-ax | Get first trace/eval from JS quickly | braintrust | `braintrust` exposes `init()`/`initLogger()` from one SDK, avoiding direct OTel pipeline composition. | Arize adapter manually creates OTLP exporters, span processors, and provider resources before emitting spans. | Add `@arizeai/ax-js` bootstrap (`initTracing`) that configures exporter/provider/resource defaults in one call. | new | P0 | `package.json:32-40`, `evals/platforms/arize.ts:74-93`, `evals/SETUP-FRICTION.md:8`, `evals/gap-runs/2026-06-01T00-44-12-411Z.json` | 2026-06-01 | 2026-06-01 |
| AX-002 | arize-ax | Configure cloud auth without trial-and-error | langsmith | LangSmith accepts a single API key (+ optional URL) without an extra space header requirement. | Arize AX setup now requires `arize-api-key`, `arize-space-id`, and `ARIZE_PROJECT_NAME`; missing fields fail preflight. | Keep preflight validation precise and document the project routing contract. | new | P0 | `evals/platforms/arize.ts`, `.env.example`, `evals/gap-runs/2026-06-01T00-44-12-411Z.json` | 2026-06-01 | 2026-06-01 |
| AX-003 | arize-ax | Create datasets uniformly in cloud | langsmith | LangSmith exposes `createDataset(...)` directly in SDK setup flow. | Arize AX tracing receives evaluator spans; separate dataset APIs are outside this runtime path. | Add a JS `createDatasetIfMissing` API for AX datasets when eval rows need dataset registration. | new | P0 | `evals/platforms/arize.ts`, `evals/platforms/langsmith.ts`, `evals/SETUP-FRICTION.md` | 2026-06-01 | 2026-06-01 |
| AX-004 | arize-ax | Confirm backend health before eval runs | braintrust | Braintrust ping path uses experiment summarize round-trip to verify real server responsiveness. | Arize AX ping verifies adapter configuration locally, then force-flushes spans after runs. | Add ingestion-backed health probe (emit probe span + confirm receipt) as the default readiness check. | new | P1 | `evals/platforms/arize.ts`, `evals/platforms/braintrust.ts`, `evals/SETUP-FRICTION.md` | 2026-06-01 | 2026-06-01 |
| AX-005 | arize-ax | Attach eval-row scores without manual span schemas | braintrust | Braintrust rows can call `span.log({ input, output, scores })` directly for evaluation records. | Arize path emits custom OI evaluator spans and hand-authored `evaluation.key.*` attributes for each row/summary. | Provide a first-class Arize JS eval logging helper (`logEvaluationRow` / `logEvaluationSummary`). | new | P0 | `evals/platforms/arize.ts:237-309`, `evals/platforms/braintrust.ts:195-211`, `evals/SETUP-FRICTION.md:14`, `evals/gap-runs/2026-06-01T00-44-12-411Z.json` | 2026-06-01 | 2026-06-01 |
| OI-001 | openinference | Represent deterministic non-LLM stages natively | langsmith | LangSmith captures deterministic steps as explicit runs with structured `inputs`/`outputs` payloads. | OpenInference mapping collapses non-LLM phases to `CHAIN`, so deterministic stage semantics are not first-class. | Add an OpenInference deterministic-stage kind/profile and companion guidance for adapters. | new | P1 | `core/observability/arize.ts:56-68`, `core/observability/langsmith.ts:143-154`, `evals/run-eval.ts:507`, `evals/SETUP-FRICTION.md:33`, `evals/gap-runs/2026-06-01T00-44-12-411Z.json` | 2026-06-01 | 2026-06-01 |
| OI-002 | openinference | Standardize parent/child pipeline trace shape | langsmith | LangSmith has explicit `parent_run_id` semantics baked into run creation and updates. | Cross-platform pipeline tracing required bespoke adapter logic to express triage → PM parent/child relationships. | Define an OpenInference trace-tree profile (required parent keys + examples + conformance tests). | new | P0 | `core/observability/langsmith.ts:143-156`, `evals/run-eval.ts:503`, `evals/SETUP-FRICTION.md:29`, `evals/gap-runs/2026-06-01T00-44-12-411Z.json` | 2026-06-01 | 2026-06-01 |
| OI-003 | openinference | Standardize eval-row and run-summary score semantics | braintrust | Braintrust `Eval`/row logging makes score attachment a native concept rather than ad hoc keys. | OpenInference eval logging currently relies on custom attribute names (`evaluation.key.*`) chosen by each adapter. | Publish OpenInference eval semantic conventions + helper mappers for row and summary score payloads. | new | P0 | `evals/platforms/braintrust.ts:195-211`, `evals/platforms/arize.ts:259-291`, `evals/run-eval.ts:505`, `evals/SETUP-FRICTION.md:31`, `evals/gap-runs/2026-06-01T00-44-12-411Z.json` | 2026-06-01 | 2026-06-01 |

## 9. Gap run history (skill-maintained)

One row per skill run artifact. Keep counts consistent with the ledger.

| Run artifact | Timestamp (UTC) | Scope | New gaps | Updated gaps | Validated gaps | Notes |
|--------------|-----------------|-------|---------:|-------------:|---------------:|-------|
| `evals/gap-runs/2026-06-01T00-44-12-411Z.json` | 2026-06-01T00:44:12.411Z | setup/evals/debugging/sdk | 8 | 0 | 0 | Baseline persisted run from existing setup + friction logs; 5 Arize AX gaps and 3 OpenInference gaps. Custom skill invocation returned "Skill not found", so this run followed SKILL.md manually. |
