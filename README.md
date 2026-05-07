# oss-support-agent

Repo-agnostic OSS autonomous fix loop harness.

## OpenRouter (US-100)

This harness supports a shared LLM client via OpenRouter (OpenAI-compatible `chat/completions`).

### Required

- `OPENROUTER_API_KEY`: OpenRouter API key. If unset, LLM-backed agents fall back to deterministic heuristics where available.

### Model selection

- `OPENROUTER_MODEL_DEFAULT`: default model when an agent-specific model is not set.
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
