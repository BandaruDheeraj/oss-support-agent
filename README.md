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
