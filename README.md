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
| `OPENROUTER_API_KEY` | (recommended) OpenRouter key for real LLM-backed triage + fix. Without this, triage falls back to heuristic and the fix agent will fail (no heuristic fix generator). |

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
