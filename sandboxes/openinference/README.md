# OpenInference Sandbox Tests

Per-SDK sandbox tests that grow with each fixed issue. These are used by the repro
builder to provide context when generating new repros for the same SDK, and as a
regression suite to verify future fixes don't re-break resolved issues.

## Structure

```
sandboxes/openinference/
  shared/
    arize_trace_helper.py     ← OTLP exporter + Arize AX URL builder
  openllmetry/
    conftest.py               ← pytest fixtures: tracer, memory_exporter, Arize export
    test_issue_64_*.py        ← Tool span mapping bug (issue #64, fixed in PR #65)
  langchain/                  ← grows when first LangChain issue is fixed
  llamaindex/                 ← grows when first LlamaIndex issue is fixed
  ...
```

## How tests are added

1. When the repro builder fixes a new issue, it checks the sandbox registry for the
   relevant SDK (e.g. `openllmetry`) and loads existing tests as context.
2. After a successful repro, `sandbox-registry.ts:registerNewTest()` persists the
   new test file here.
3. Each test exports broken spans to Arize AX (project: `osa-repro`) so reviewers
   can see the actual trace — not just a pass/fail.

## Running locally

```bash
# From repo root — install openinference + OTel deps first
pip install openinference-instrumentation-openllmetry \
            opentelemetry-sdk \
            opentelemetry-exporter-otlp-proto-http

# Run all sandbox tests (no Arize export — creds not set)
pytest sandboxes/openinference/ -v

# Run with Arize AX export
ARIZE_API_KEY=... ARIZE_SPACE_ID=... ARIZE_UI_BASE_URL=... \
  pytest sandboxes/openinference/openllmetry/ -v
```

## Env vars for Arize AX export

| Var | Description |
|-----|-------------|
| `ARIZE_API_KEY` | Arize AX API key (secret) |
| `ARIZE_SPACE_ID` | Arize AX space ID (secret) |
| `ARIZE_UI_BASE_URL` | Base URL for trace deep links, e.g. `https://app.arize.com/organizations/{org}/spaces/{space}/projects/osa-repro/traces` |
| `ARIZE_PROJECT_NAME` | Project name in Arize AX (default: `osa-repro`) |
