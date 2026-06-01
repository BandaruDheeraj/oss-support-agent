# oss-support-agent

Repo-agnostic OSS autonomous fix loop harness.

## OpenRouter (US-100)

This harness supports a shared LLM client via OpenRouter (OpenAI-compatible `chat/completions`).

### Required

- `OPENROUTER_API_KEY`: primary OpenRouter API key.
  - Optional additional keys for quota failover: `OPENROUTER_API_KEYS` or `OPENROUTER_API_KEY_FALLBACKS` (comma-separated).

### Model selection

- `OPENROUTER_MODEL_DEFAULT`: default model when an agent-specific model is not set.
- `OPENROUTER_MODEL_FALLBACKS`: optional comma-separated model fallback chain applied after the selected model.
- `OPENROUTER_MODEL_FALLBACKS_<AGENT>`: optional per-agent fallback model chain (e.g. `OPENROUTER_MODEL_FALLBACKS_ANALYST`).
- Agent-specific overrides:
  - `OPENROUTER_MODEL_TRIAGE`
  - `OPENROUTER_MODEL_PM`
  - `OPENROUTER_MODEL_FIX`
  - `OPENROUTER_MODEL_BUILD`
  - `OPENROUTER_MODEL_EVAL`
  - `OPENROUTER_MODEL_DOCS`
  - `OPENROUTER_MODEL_USABILITY`
  - `OPENROUTER_MODEL_INTROSPECTION`

See OpenRouter’s model list: https://openrouter.ai/models

### Optional identification headers

OpenRouter recommends sending:
- `OPENROUTER_HTTP_REFERER` (sent as `HTTP-Referer`)
- `OPENROUTER_X_TITLE` (sent as `X-Title`)

These are included on all OpenRouter requests.

## Directory layout (US-102)

- `core/`: repo-agnostic harness code (orchestrator, agents, sandbox runner, etc.)
- `configs/`: per-repo configuration and adapters (`configs/<org>/<repo>/`)

### One-way dependency rule

`core/` must never import from `configs/`. This is enforced by `npm run lint`.
`configs/` may import from `core/` (typically from `core/adapter.interface.ts`).

## Onboarding a new repo (US-112)

High-level flow:
1. Ensure defaults are set: `DEFAULT_PM_EMAIL` and `DEFAULT_FORK_ORG`.
2. Trigger introspection either by:
   - adding the repo to an operator watched list and running `bootstrapWatchedRepos()`, or
   - labeling an issue with the trigger label (default `agent-fix`) and letting the handler call introspection when `configs/<org>/<repo>/manifest.yaml` is missing.
3. Introspection generates `configs/<org>/<repo>/{manifest.yaml,adapter.ts}`.
4. Required labels are created on the upstream repo (`agent-fix`, `trivial-fix`, `agent-failed`, `needs-design`).
5. The original issue event is re-processed through the normal pipeline now that the adapter/manifest exist.

## Live testing the full pipeline

`bin/server.ts` is a Phase 2 live entrypoint that wires the harness end-to-end for the
`skip_pm_gate` happy path: **triage → fork → fix (OpenRouter) → local sandbox → eval → draft PR**.

Live mode intentionally does **not** run introspection or the PM design email loop. The
target repo must already have `configs/<org>/<repo>/{manifest.yaml,adapter.ts}` and the
issue must carry the manifest's `skip_pm_gate_label`.

### Required env vars

| Name | Purpose |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT. Needs `issues:write` and `metadata:read` on upstream; `contents:write` and `pull-requests:write` on `<DEFAULT_FORK_ORG>/*`. |
| `WEBHOOK_SECRET` | Shared secret configured on the GitHub webhook. |
| `DEFAULT_FORK_ORG` | Org/user the agent forks into and pushes to. Must NOT be the upstream owner. |
| `OPENROUTER_API_KEY` | (recommended) Primary OpenRouter key for real LLM-backed triage + fix. |
| `OPENROUTER_API_KEYS` / `OPENROUTER_API_KEY_FALLBACKS` | Optional comma-separated backup OpenRouter keys used automatically on quota/rate/provider failures. |

### Optional env vars

| Name | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `REPO_ROOT` | `cwd` | Where `configs/` lives. |
| `WORKSPACE_ROOT` | `data/workspaces` | Where forks are cloned for fix + sandbox. |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `oss-support-agent` / `agent@users.noreply.github.com` | Author for commits. |

### Run it

```powershell
$env:GITHUB_TOKEN          = 'ghp_...'
$env:WEBHOOK_SECRET        = 'pick-a-secret'
$env:DEFAULT_FORK_ORG      = 'your-bot-account'   # NOT arize-ai
$env:OPENROUTER_API_KEY    = 'sk-or-...'
npm run start:dev
```

Expose the port with smee.io or ngrok and configure a GitHub webhook on a repo that has
configs (e.g. `arize-ai/openinference`):

```powershell
npx smee-client -u https://smee.io/<channel> -t http://localhost:3000/webhook
```

- Payload URL: smee channel
- Content type: `application/json`
- Secret: same as `WEBHOOK_SECRET`
- Events: **Issues** only

Then label an issue with the manifest's `skip_pm_gate_label` (default `trivial-fix`).
The server will:

1. Verify the HMAC signature
2. Load the manifest + adapter (with runtime contract checks)
3. Run triage (OpenRouter or heuristic) → must route to `route_fork`
4. Create/sync the fork under `DEFAULT_FORK_ORG` and create a per-issue branch
5. Clone the fork into `WORKSPACE_ROOT` and gather files for the affected module
6. Call OpenRouter fix generator; commit + push the patch to the fork branch
7. Run `adapter.getTestCommands()` locally as subprocesses (services like Phoenix must be
   started out-of-band, e.g. `docker run -p 6006:6006 arizephoenix/phoenix:latest`)
8. Call `adapter.runCustomEval(SandboxOutput)` to decide pass/fail
9. On pass, open a **draft PR** upstream and apply `extraLabels` from `getPRMetadata`

The webhook responds 202 immediately; the pipeline runs in the background and logs to stdout.

### What's still TODO in live mode

- Introspection (Gmail PM-approval loop) — only `skip_pm_gate` issues are processed
- PM design loop for non-trivial issues
- Build agent (new-feature scaffolding) and Docs agent
- Retry-on-sandbox-failure loop (eval is single-shot today)
- GitHub Actions sandbox path (`core/sandbox.ts`) — replaced by local subprocess runner here
- Cost guardrails enforcement at the live entrypoint
- Multi-repo coordinator and regression-guard wiring

## Phase E (v2) — tool-using agent loops

The v2 stack replaces one-shot LLM repro/fix calls with bounded tool-using loops, structured evidence, and HITL.

### Architecture

- **Analyst** (read-only loop) → writes versioned, append-only `EvidenceDossier` snapshots.
- **Repro loop**: Planner (one-shot) → Executor (tool loop, no `run_shell`) → AST preflight → mandatory Critic with independent re-run.
- **Fix loop**: Investigator → Planner → Executor → Critic + orchestrator-level final gate (green evidence audit, hypothesis-consumption audit, HEAD-drift check).
- **HITL**: `inbox_entries` state machine with CAS transitions, signed approval tokens, plus-addressed reply routing, eight typed email kinds (`triage_unrelated`, `need_credentials`, `repro_unreachable`, `fix_proposal`, `fix_failed`, `regression_blocker`, `human_decision_needed`, `pr_opened`).
- **Observability**: dual OTEL export (Phoenix + Braintrust) with redaction, agent/tool span ownership, and a per-run eval-recorder row (sqlite/jsonl) for shadow-mode comparison.

### Cutover

V2 is opt-in behind environment flags (defaults stay one-shot):

| Flag | Values |
| --- | --- |
| `REPRO_AGENT_MODE` | `oneshot` (default) / `shadow` / `loop` |
| `FIX_AGENT_MODE` | `oneshot` (default) / `shadow` / `loop` |

`shadow` runs the v2 loops dry alongside legacy and writes eval rows with `mode='shadow_loop'` for comparison. Promote to `loop` only after a green shadow baseline.

### Ops

- `npm run osa-admin -- inbox pending` — list outstanding decision-point emails.
- `npm run osa-admin -- inbox set-action <id> <action> [--hint ...]` — force-resolve a stuck entry.
- `npm run osa-admin -- inbox expire-sweep` — expire decision points past their TTL.
- `npm run trace-smoke` — assert OTEL spans flush against the configured backends.

See `.env.example` for the full v2 env table.


## Observability

The harness ships a pluggable observability layer that emits one parent span per pipeline phase and one child span per LLM call. Backends are selected at process start via `OBSERVABILITY_BACKEND`:

| Value | Backend | Notes |
| --- | --- | --- |
| `none` (default) | No-op | No SDK loaded, zero runtime overhead. |
| `langsmith` | LangSmith | Requires `LANGSMITH_API_KEY`. Spans appear in the LangSmith project named by `LANGSMITH_PROJECT` (default `oss-support-agent`). |
| `arize` | Arize / Phoenix | OTLP/HTTP exporter; set `ARIZE_ENDPOINT` (Arize Cloud) or `PHOENIX_OTLP_ENDPOINT` (self-hosted). Add `ARIZE_API_KEY` + `ARIZE_SPACE_ID` for Arize Cloud. Spans carry OpenInference semantic conventions. |
| `braintrust` | Braintrust | Requires `BRAINTRUST_API_KEY`. Project name comes from `BRAINTRUST_PROJECT` (default `oss-support-agent`). |
| `all` | LangSmith + Arize + Braintrust | Fans out the same spans to all three backends in one run. Startup is fail-fast on missing config, includes per-adapter contract logs, emits a `telemetry_smoke` span to each enabled backend, and tracks adapter delivery counters (`sent`, `failed`, `dropped`) exposed by `/healthz`. |

Adapter delivery now retries transient provider failures with exponential backoff and writes a local spool fallback when retries are exhausted. Configure `OBSERVABILITY_RETRY_ATTEMPTS`, `OBSERVABILITY_RETRY_BASE_MS`, and `OBSERVABILITY_SPOOL_DIR` as needed.

### What gets traced

- One `pipeline.repro` / `pipeline.fix` parent span around every `runReproPipeline` / `runFixPipeline` call, tagged with `attempt_id`, `issue_number`, `repo`, and `affected_module`.
- One `llm.<model>` child span per `LLMClient.chat()` call, with `llm.model_name`, `llm.temperature`, prompt + completion token counts, latency, and retry attempt count.
- One `evaluator.<stage>` span for online pass/fail checks (`repro`, `fix`, `build`, `verification`), including normalized `evaluation.*` attributes and score keys (`evaluation.key.<metric>`), so each run emits evaluator signals in all configured backends.
- Parent context flows through `AsyncLocalStorage`, so the LLM chokepoint automatically attaches to the enclosing phase span without threading anything through call signatures.

### Outcome-based backend comparison

Use this when you want to know whether the agent actually reproduced and resolved issues per backend (instead of only triage/PM golden-set scoring):

1. Enable recorder output:
   - `OSA_EVAL_BACKEND=sqlite` (or `jsonl`)
   - `OSA_EVAL_PATH=.osa-evals.sqlite`
2. Run the same issue set once per backend:
   - `OBSERVABILITY_BACKEND=arize`
   - `OBSERVABILITY_BACKEND=braintrust`
   - `OBSERVABILITY_BACKEND=langsmith`
3. Compare outcomes:
   - `npm run eval:observability`

The outcomes report is written to `evals/results/eval-outcomes-<timestamp>.json` and compares per-backend rates for:
- `repro_passed`
- `fix_passed`
- `verification_gate_passed` (skipped verification is tracked as `skipped_non_gha`, not counted as pass)
- resolved issues (`final_disposition=pr-opened`)

Legacy triage/PM golden-set comparison is still available via:
- `npm run eval:observability:triage`

### Redaction

Set `OBSERVABILITY_REDACT_IO=true` to replace each span's input/output payload with `{ redacted, length, sha1 }` — latency and token counts stay observable but raw prompt/completion text never leaves the process. String-level secret scrubbing (API keys, tokens, `Authorization:` headers) always runs via `core/observability/redact.ts`.

### Adding a backend

Drop a new file under `core/observability/<backend>.ts` that exports a class implementing `Tracer` from `./tracer`, then add the lazy-require branch in the factory in `tracer.ts`. No call sites need to change.

## Agent skill: observability-gap-analysis

This repo includes a reusable skill for competitive observability analysis:

- `.github/skills/observability-gap-analysis/SKILL.md` (Copilot)
- `.claude/skills/observability-gap-analysis/SKILL.md` (Claude-compatible hosts)
- `.agents/skills/observability-gap-analysis/SKILL.md` (generic agent hosts)

Use it when you want an agent to compare **Arize AX + OpenInference** against **Braintrust + LangSmith** and produce an evidence-backed, prioritized backlog split into:

1. Arize AX platform items
2. OpenInference spec/SDK items

The skill now also persists findings for future runs:

- Canonical ledger in `evals/COMPETITIVE-ANALYSIS-TEMPLATE.md` (`## 8` and `## 9` sections)
- Per-run structured artifact in `evals/gap-runs/<timestamp>.json`
- Latest artifact pointer in `evals/gap-runs/latest.json`
- Each gap must capture competitor-specific ease (`how they do it`) and a single owner label: `arize-ax` or `openinference`

## Agent skill: observability-gap-one-pagers

This repo also includes a follow-on skill that turns persisted gaps into one-page briefs:

- `.github/skills/observability-gap-one-pagers/SKILL.md` (Copilot)
- `.claude/skills/observability-gap-one-pagers/SKILL.md` (Claude-compatible hosts)
- `.agents/skills/observability-gap-one-pagers/SKILL.md` (generic agent hosts)

Use it after `observability-gap-analysis` when you want one document per gap that clearly states:

1. What the competitor does (and why it is easier)
2. What oss-support-agent does today
3. The exact gap
4. The proposed fix and measurable success criteria

Persisted outputs for this workflow:

- Per-gap pages in `evals/gap-one-pagers/<gap_id>.md`
- Index in `evals/gap-one-pagers/index.md`
- Latest pointer in `evals/gap-one-pagers/latest.json`
- Authoring template in `evals/gap-one-pagers/TEMPLATE.md`

## How to use the skills (end-to-end)

### 1) Run competitive gap analysis

Use `observability-gap-analysis` first.

Example prompts:

- "Use observability-gap-analysis on current setup and persist findings."
- "Run observability-gap-analysis for OpenInference vs Braintrust/LangSmith setup friction."

Expected outputs:

- `evals/gap-runs/<timestamp>.json`
- `evals/gap-runs/latest.json` (updated pointer)
- `evals/COMPETITIVE-ANALYSIS-TEMPLATE.md` sections `## 8` and `## 9` (updated ledger/history)

### 2) Generate one-pagers from persisted gaps

Use `observability-gap-one-pagers` after step 1.

Example prompts:

- "Use observability-gap-one-pagers for all current non-rejected gaps."
- "Use observability-gap-one-pagers for AX-001, AX-005, and OI-002 only."

Expected outputs:

- `evals/gap-one-pagers/<gap_id>.md` (one file per gap)
- `evals/gap-one-pagers/index.md` (updated index table)
- `evals/gap-one-pagers/latest.json` (updated pointer + generated gap IDs)

### 3) Typical operating loop

1. Re-run `observability-gap-analysis` after new integration/eval work.
2. Re-run `observability-gap-one-pagers` to refresh product-ready briefs.
3. Use the one-pagers as implementation specs and roadmap inputs.

### Host note

These skills are mirrored for multiple agent hosts:

- Copilot: `.github/skills/...`
- Claude-compatible: `.claude/skills/...`
- Generic agent hosts: `.agents/skills/...`

If your host does not auto-discover repository skills, open the relevant `SKILL.md` and follow it manually.
