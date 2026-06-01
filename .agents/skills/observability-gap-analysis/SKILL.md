---
name: observability-gap-analysis
description: Compare Arize AX + OpenInference against Braintrust and LangSmith across evals, debugging, monitoring, and SDK DX. Produce evidence-backed, prioritized gap backlogs.
license: MIT
---

Use this skill when asked to compare Arize/Phoenix/OpenInference with Braintrust/LangSmith, identify concrete product gaps, and propose actionable build items.

## Objective

Produce a decision-ready gap analysis with two separate backlogs and persist findings to repo artifacts on every run.

1. **Arize AX platform backlog** (product, workflow, UX, APIs)
2. **OpenInference backlog** (spec + SDK ergonomics + portability)

Do not merge these into one list.

## Mandatory persistence on every run

Every run must update all of these:

1. Canonical ledger doc: `evals/COMPETITIVE-ANALYSIS-TEMPLATE.md`
2. Per-run artifact: `evals/gap-runs/<timestamp>.json`
3. Latest pointer: `evals/gap-runs/latest.json`

If a target file does not exist, create it.

## Ownership classification (required)

- Every fix proposal must be labeled as exactly one owner:
  - `arize-ax`
  - `openinference`
- If a finding touches both, split it into two linked gap records (one per owner).

## Competitor-ease attribution (required)

For every gap, include:

- `competitor_platform`: `braintrust` or `langsmith` (or both in separate records)
- `competitor_mechanism`: exact capability/workflow/API that made competitor setup easier
- `why_competitor_easier`: concise explanation of why this reduced friction

## Ground rules

- Keep prompts, datasets, issue sets, pass/fail criteria, and workload shape identical across platforms.
- Treat unmeasured claims as unknown. Do not guess.
- Tie every gap to evidence from this repo and/or measured runs.
- Prefer measurable friction over subjective preference.

## Citation standard

- Code or docs evidence must use file citations in `path:start-end` form.
- Runtime evidence must reference a run artifact path and the metric field(s).
- Do not include a gap without at least one citation.

## Repo surfaces to inspect first

- `core/observability/arize.ts`
- `core/observability/braintrust.ts`
- `core/observability/langsmith.ts`
- `core/observability/tracer.ts`
- `core/observability/adapter-health.ts`
- `evals/platforms/arize.ts`
- `evals/platforms/braintrust.ts`
- `evals/platforms/langsmith.ts`
- `evals/run-eval.ts`
- `.env.example` (observability/eval env requirements)
- `README.md` (Observability + comparison harness sections)

## Benchmark workflow

1. **Define test jobs-to-be-done**
   - First-time setup and first successful trace/eval
   - Running repeatable evals and comparing variants
   - Debugging a single failed run quickly
   - Monitoring aggregate quality/reliability over time
   - CI regression gating for ship/no-ship decisions

2. **Run parity experiments**
   - Use the same workload once per backend (`arize`, `braintrust`, `langsmith`).
   - Use existing harness commands where possible:
     - `npm run trace-smoke`
     - `npm run eval:observability`
     - `npm run eval:observability:triage`

3. **Capture friction metrics**
   - Time-to-first-success (minutes)
   - Number of required steps
   - Number of retries/errors
   - Context switches (tool/dashboard/docs hops)
   - Manual instrumentation code burden
   - CI wiring complexity

4. **Audit OpenInference vs vendor SDKs**
   - Semantic coverage for critical fields (input/output, tool calls, token usage, latency, outcome labels)
   - Ergonomics (boilerplate, wrappers/helpers, defaults)
   - Interoperability/portability across vendors
   - Failure handling and offline/retry behavior
   - Extensibility for agent/eval-specific metadata

5. **Convert findings into persisted gap records**
   - Use this exact structure:
     - `gap_id`: stable id (`AX-###` or `OI-###`)
     - `owner`: `arize-ax` or `openinference`
     - `status`: `new` | `in-progress` | `shipped` | `validated` | `rejected`
     - `priority`: `P0` | `P1` | `P2`
     - `job`: <user job>
     - `observed_friction`: <what slowed/broke>
     - `competitor_platform`: `braintrust` or `langsmith`
     - `competitor_mechanism`: <what competitor does>
     - `why_competitor_easier`: <why setup is easier there>
     - `current_behavior_in_oss_support_agent`: <how it works now in this repo>
     - `root_cause`: <platform/spec cause>
     - `proposed_fix`: <specific change>
     - `success_metric`: <metric delta>
     - `evidence`: <file citations and/or run metric references>
     - `integration_context`: <specific components/workflows in oss-support-agent>
     - `created_at`: ISO timestamp
     - `updated_at`: ISO timestamp

## Canonical doc update rules

In `evals/COMPETITIVE-ANALYSIS-TEMPLATE.md`:

1. Maintain `## 8. Persistent setup gap ledger (skill-maintained)` as the canonical, run-over-run backlog.
2. Maintain `## 9. Gap run history (skill-maintained)` with one row per run artifact.
3. Upsert ledger rows by `gap_id` (do not create duplicate IDs).
4. Always include owner (`arize-ax` or `openinference`) and competitor mechanism fields.

## Required output format

Return four sections in this order.

### 1) Competitive scorecard

Create a table with columns:
`Job | Arize today | Braintrust/LangSmith benchmark | Evidence | Gap severity (1-5)`

### 2) Prioritized backlog (Arize AX)

Create a table with columns:
`Item | User problem | Proposed platform change | Impact | Effort | Priority | Success metric`

### 3) Prioritized backlog (OpenInference)

Create a table with columns:
`Item | SDK/spec gap | Proposed OI change | Compatibility risk | Impact | Effort | Priority | Success metric`

### 4) Persistence updates

List:
- Canonical doc sections updated
- Run artifact path written
- Number of new/updated/validated gap IDs

## Prioritization rubric

- **Impact**: effect on adoption, speed, or quality of decision-making
- **Effort**: implementation complexity/risk
- **Priority**:
  - `P0`: blocks core eval/debug workflow
  - `P1`: major friction but workaround exists
  - `P2`: incremental DX improvement

## Definition of done

The analysis is complete only when:

- At least one measured artifact exists per job-to-be-done.
- `evals/COMPETITIVE-ANALYSIS-TEMPLATE.md` is updated with current run findings.
- A per-run artifact exists in `evals/gap-runs/`.
- `evals/gap-runs/latest.json` points to the newest artifact.
- Each backlog item is testable with a clear success metric.
- Every gap includes competitor mechanism details and citation(s).
- AX and OpenInference actions are clearly separated.
