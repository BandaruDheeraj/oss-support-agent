---
name: observability-gap-one-pagers
description: Generate one-page briefs for each AX/OI gap using persisted gap artifacts. Each brief must clearly capture competitor behavior, current behavior, the gap, and a fix plan.
license: MIT
---

Use this skill when asked to create or refresh one-pagers for gaps identified by `observability-gap-analysis`.

## Objective

Convert persisted gap records into decision-ready one-pagers that make four things explicit:

1. What competitors do and why that is easier
2. What this project currently does
3. The precise gap
4. How to fix it (owner-specific) and how success is measured

## Mandatory inputs

Always read these first:

1. `evals/gap-runs/latest.json`
2. The referenced run artifact in `evals/gap-runs/<timestamp>.json` (or user-provided artifact path)
3. `evals/COMPETITIVE-ANALYSIS-TEMPLATE.md` (Section 8 ledger)
4. Existing page (if present): `evals/gap-one-pagers/<gap_id>.md`

## Mandatory persisted outputs

Every run must update all of these:

1. One-pager files: `evals/gap-one-pagers/<gap_id>.md`
2. Index file: `evals/gap-one-pagers/index.md`
3. Pointer file: `evals/gap-one-pagers/latest.json`

If the user does not provide gap IDs, generate one-pagers for all non-`rejected` gaps in the selected run artifact.

## Gap ownership and scope rules

- Keep each one-pager owner-specific:
  - `arize-ax` or
  - `openinference`
- Do not merge AX and OpenInference fixes into one page.
- If a finding mixes both, split into two pages with linked references.

## Citation standard (required)

- Every factual statement must be backed by at least one citation.
- Code/doc citations use: `path:start-end`
- Runtime citations use: `evals/gap-runs/<timestamp>.json` plus field path(s)
- Do not publish a one-pager with missing citations.

## One-pager structure (required headings)

Use this exact structure for each `evals/gap-one-pagers/<gap_id>.md`:

1. `# <gap_id> - <short title>`
2. `## 1) Snapshot`
3. `## 2) What competitors do (why easier)`
4. `## 3) What we do today in oss-support-agent`
5. `## 4) Gap statement`
6. `## 5) Proposed fix`
7. `## 6) Delivery plan`
8. `## 7) Success metrics`
9. `## 8) Evidence and citations`
10. `## 9) Change log`

## Required content per section

### 1) Snapshot

Include:

- `gap_id`
- `owner`
- `status`
- `priority`
- `job`
- `competitor_platform`
- `last_run_artifact`
- `last_updated`

### 2) What competitors do (why easier)

- Exact competitor mechanism (API/workflow/UX)
- Why it reduces setup or debugging friction

### 3) What we do today in oss-support-agent

- Current implementation behavior in this repo
- Affected components/workflows

### 4) Gap statement

- One concise problem statement:
  - "Because <current behavior>, users cannot <desired outcome> as easily as <competitor mechanism>."

### 5) Proposed fix

- Concrete platform/spec/SDK change
- Owner-specific scope boundary (`arize-ax` or `openinference`)
- Out-of-scope notes (to avoid accidental scope creep)

### 6) Delivery plan

- 3-6 implementation steps
- Dependencies and risks
- Suggested release slice (MVP vs follow-up)

### 7) Success metrics

Use a small table:
`Metric | Baseline | Target | How measured`

### 8) Evidence and citations

- Bulleted citations tied to claims made above
- Must include at least:
  - one competitor-ease citation
  - one current-behavior citation
  - one fix rationale citation

### 9) Change log

Append entries:
- `<ISO timestamp> - created from <artifact path>`
- `<ISO timestamp> - updated (<what changed>)`

## Index and pointer update rules

### `evals/gap-one-pagers/index.md`

Maintain a table with columns:
`Gap ID | Owner | Status | Priority | Competitor | One-pager | Last artifact | Last updated`

### `evals/gap-one-pagers/latest.json`

Keep this shape:

```json
{
  "latest_run_artifact": "evals/gap-runs/<timestamp>.json",
  "generated_at": "<ISO timestamp>",
  "gap_ids": ["AX-001", "OI-002"]
}
```

## Definition of done

Complete only when:

- One-pager files exist for every targeted gap ID
- Every page includes competitor behavior, current behavior, explicit gap, and fix plan
- Every page has citations and a change log entry
- `index.md` and `latest.json` are updated and consistent with generated pages
