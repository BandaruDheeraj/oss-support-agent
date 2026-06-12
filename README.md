# oss-support-agent

An autonomous bug-fix pipeline for open-source repos. Point it at a GitHub repo, label a bug issue, and it will reproduce the bug, write a fix, verify it, and open a draft PR — without a human writing a line of code.

## What it solves

Triaging and fixing bugs in open-source projects is slow. Maintainers get the same classes of bugs repeatedly, most fixes are mechanical, and there are never enough reviewers. This agent runs the full fix workflow autonomously:

1. **Reads the issue** and decides if it's a fixable bug (skips feature requests and design questions).
2. **Finds the right code** via semantic search across the repo.
3. **Writes a deterministic repro test** and confirms it actually fails before doing anything else.
4. **Patches the source**, commits to a branch on a fork, and runs the repro test again to confirm green.
5. **Opens a draft PR** with the fix, the repro test, and a summary of what changed and why.

If it gets stuck (can't reproduce, hits its retry budget, needs credentials), it emails the PM instead of silently failing.

## Architecture

The pipeline is a sequence of bounded tool-using agent loops, each with a specific job:

```
GitHub issue labeled
        │
        ▼
   Triage agent ──── not a bug? → ignore
        │
        ▼
  Fork + branch
        │
        ▼
  Semantic search (GHA) → suspect files + symbols
        │
        ▼
   Analyst agent → Evidence Dossier (read-only, versioned)
        │
        ▼
   Repro loop ──────────────────────────────────────────────
   │  Planner   → candidate test file + install spec       │
   │  Executor  → writes test, pip installs, runs sandbox  │
   │  Critic    → independent re-run to confirm failure    │
   └────────────────────────────────────────────────────────
        │  repro confirmed failing
        ▼
   Fix loop (up to max_retries) ───────────────────────────
   │  Investigator → reads dossier, proposes hypotheses    │
   │  Planner      → ordered steps with risk ratings       │
   │  Executor     → patches code, commits, runs sandbox   │
   │  Critic       → verifies repro is green               │
   └────────────────────────────────────────────────────────
        │  fix verified
        ▼
   Draft PR opened upstream
```

**Key design decisions:**

- **Sandbox isolation** — all test runs happen in ephemeral GitHub Actions jobs that clone the fork branch fresh. The agent never runs arbitrary code on the host.
- **Evidence Dossier** — the Analyst writes a structured, append-only snapshot before any mutation happens. Every hypothesis the Executor makes must cite evidence from the Dossier; the Critic rejects uncited changes.
- **Deterministic repro first** — the pipeline won't attempt a fix until it has a test that reliably fails 2/2 runs. This prevents the agent from "fixing" bugs it can't actually reproduce.
- **HITL email loop** — when human judgment is needed (credentials required, PM design gate, fix ready for review), typed emails go out with signed reply tokens. No Slack bots, no dashboards required.

### Code layout

```
core/          Repo-agnostic pipeline code (orchestrator, agents, sandbox runner)
  agents/      Individual agent loops (analyst, repro, fix, email, HITL)
  observability/ Pluggable tracing backends (Arize AX, LangSmith, Braintrust)
  llm/         LLM client with retry, fallback, and token tracking
configs/       Per-repo configuration (one subdirectory per repo)
  <org>/<repo>/
    manifest.yaml   Trigger label, fork org, retry limits, sandbox settings
    adapter.ts      Test command, docker services, repo-specific hooks
bin/           Server entrypoint + CLI utilities
```

`core/` never imports from `configs/`. `configs/` imports only from `core/adapter.interface.ts`.

## Getting started

### Prerequisites

- **Node.js 20+**
- A **GitHub bot account** (a dedicated machine user, not your personal account) that will own the forks.
- A **classic PAT** on that account with `repo` and `workflow` scopes.
- An **LLM API key**: Anthropic direct (`ANTHROPIC_API_KEY`) or OpenRouter (`OPENROUTER_API_KEY`).
- A **fork of this repo** under the bot account (e.g. `my-bot/oss-support-agent`) — the GHA sandbox workflows live here.

### Step 1 — Clone and install

```bash
git clone https://github.com/your-org/oss-support-agent.git
cd oss-support-agent
npm ci
cp .env.example .env   # then fill in the required values below
```

### Step 2 — Set environment variables

The minimum set to get a run working:

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | PAT from above (`ghp_...`) |
| `WEBHOOK_SECRET` | Any random string — must match what you put in the GitHub webhook |
| `DEFAULT_FORK_ORG` | The bot account or org that owns forks (e.g. `my-bot`) |
| `ANTHROPIC_API_KEY` | Claude API key — or use `OPENROUTER_API_KEY` instead |
| `HARNESS_REPO_FULL_NAME` | Your fork of this repo, e.g. `my-bot/oss-support-agent` |
| `REPRO_AGENT_MODE` | Set to `loop` to enable the full repro agent |
| `FIX_AGENT_MODE` | Set to `loop` to enable the full fix agent |

See `.env.example` for the full list including observability, email (Resend), and eval options.

### Step 3 — Configure the target repo

Create `configs/<org>/<repo>/manifest.yaml`:

```yaml
repo: "myorg/myrepo"
trigger_label: "agent-fix"        # adding this label fires the pipeline
skip_pm_gate_label: "trivial-fix" # also add this to skip the PM approval step
fork_org: "my-bot"
branch_prefix: "agent/scope-"
pm_email: "you@example.com"       # gets fix-ready and halt emails
max_retries: 3
sandbox_timeout_mins: 15
sandbox_runner: gha
sandbox_workflow_repo: "my-bot/oss-support-agent"
sandbox_workflow_ref: "main"
```

Then create `configs/<org>/<repo>/adapter.ts`. Copy `configs/BandaruDheeraj/openinference/adapter.ts` as a template — it exports `getTestCommands()` (the pytest command to run) and `getSandboxServices()` (any Docker services the tests need).

Create the required labels on the target repo:

```bash
gh label create "agent-fix"    --repo myorg/myrepo --color 0075ca
gh label create "trivial-fix"  --repo myorg/myrepo --color e4e669
gh label create "agent-failed" --repo myorg/myrepo --color d93f0b
gh label create "needs-design" --repo myorg/myrepo --color ededed
```

### Step 4 — Confirm the sandbox workflows are present

The bot account's fork of this repo needs the GHA workflows:

```bash
gh workflow list --repo my-bot/oss-support-agent
# should show: sandbox, semantic-search
```

If they're missing, copy `.github/workflows/sandbox.yml` and `.github/workflows/semantic-search.yml` from this repo into your fork and push.

### Step 5 — Start the server and expose a webhook

**Local dev:**

```bash
# Terminal 1
npm run start:dev

# Terminal 2 — forward GitHub webhooks to localhost
npx smee-client --url https://smee.io/YOUR_CHANNEL --target http://localhost:3000/webhook
```

**Production (Render):** deploy with `render.yaml` — the service URL becomes the webhook endpoint directly.

Configure the webhook on `myorg/myrepo → Settings → Webhooks → Add webhook`:
- **Payload URL**: your server URL or smee channel
- **Content type**: `application/json`
- **Secret**: same as `WEBHOOK_SECRET`
- **Events**: Issues only

### Step 6 — Trigger a run

Find a bug issue on `myorg/myrepo` and add both `trivial-fix` and `agent-fix` labels. The webhook fires, the server picks it up, and the pipeline starts.

Watch the logs for progress. Terminal signals:
- `[v2-done]` — PR opened successfully
- `[v2-halt]` — hit max retries; check your `pm_email` inbox for a summary and the agent branch for whatever was committed

## Observability

Set `OBSERVABILITY_BACKEND` to route traces to your preferred backend:

| Value | Backend | Required vars |
|---|---|---|
| `none` (default) | No-op | — |
| `arize` | Arize AX (OTLP/HTTP) | `ARIZE_API_KEY`, `ARIZE_SPACE_ID`, `ARIZE_PROJECT_NAME` |
| `langsmith` | LangSmith | `LANGSMITH_API_KEY` |
| `braintrust` | Braintrust | `BRAINTRUST_API_KEY` |
| `all` | All three | All of the above |

Every pipeline run emits one parent span per stage (`pipeline.repro`, `pipeline.fix`) and one child span per LLM call. Spans carry OpenInference semantic conventions and include token counts, latency, and pass/fail eval signals.

Run `npm run trace-smoke` to confirm spans are reaching your backend before running a live issue.

## Operations

```bash
# List pending human-decision emails (HITL inbox)
npm run osa-admin -- inbox pending

# Force-resolve a stuck inbox entry
npm run osa-admin -- inbox set-action <id> approve

# Expire old inbox entries past their TTL
npm run osa-admin -- inbox expire-sweep

# Smoke-test tracing against configured backends
npm run trace-smoke
```

## Known limitations

- **Python only** — the repro and fix loops are wired for Python/pytest. JavaScript/Go support requires a new sandbox adapter.
- **No mid-step resume** — if the server restarts mid-pipeline, the run won't continue from where it left off (duplicate triggers are blocked, but the in-flight work is lost).
- **Single instance** — run state is file-backed under `STATE_ROOT`; multiple replicas would need a shared database.
- **No build/docs agents yet** — new feature scaffolding and documentation generation aren't implemented.
