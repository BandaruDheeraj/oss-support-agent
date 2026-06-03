# Harness Redesign: Integration-First Bug Fix Flow

**Date:** 2026-06-03  
**Based on:** Manual walk-through of Arize-ai/openinference#3198 (session.id overwrite by ClaudeAgentSDKInstrumentor)

---

## How This Doc Was Written

This redesign comes directly from manually reproducing and fixing issue #3198 end-to-end, then asking: "if I had done a complete upfront read of the test infrastructure before writing a single line, which of the 5 failure cycles would I have avoided?"

The honest answer: all 5. Every failure was discoverable from files that were already in the repo. None required running code to discover.

---

## What The Walk-Through Taught Us

### The five failure cycles and their root causes

We took 5 dispatch-fail-fix cycles to get the repro test to collect. Each cycle was a ~2-minute GHA sandbox round-trip. Each failure was caused by something discoverable from a static file read:

| Cycle | Error | Root cause | Discoverable from |
|---|---|---|---|
| 1 | `ModuleNotFoundError: claude_agent_sdk` | Needed `[instruments]` extra, not just `[test]` | `pyproject.toml` → `[project.optional-dependencies]` |
| 2 | `AttributeError: _on_ending` | `SpanProcessor` must inherit from the OTel base class | Any existing `SpanProcessor` subclass in the repo or OTel docs |
| 3 | `NameError: trace_sdk` | `trace_sdk` comes from conftest.py scope, not test_instrumentor.py module scope | Module-level imports in test_instrumentor.py |
| 4 | `pytest.fail: cassette not found` | Cassette file must be named exactly after the test function | `conftest.py` lines 109-110 |
| 5 | `if/print` exits 0 | Test detected the bug but didn't assert, so sandbox saw success | Conceptual: tests must exit non-zero to signal failure |

All 5 were present in the repo before the first sandbox was dispatched. The harness read none of them.

### What we did upfront vs. what we found reactively

**Upfront (correct):**
- Read `conftest.py` → understood `ReplayTransport`, `cassette_transport` fixture, cassette naming convention
- Read the issue description → understood Langfuse behavior needs to be stubbed, not installed
- Found an existing cassette to copy rather than recording a new one

**Reactively (should have been upfront):**
- `pyproject.toml` → discovered `[instruments]` extra after `ModuleNotFoundError`
- Module-level imports of `test_instrumentor.py` → discovered `trace_sdk` scope after `NameError`
- OTel `SpanProcessor` base class → discovered after `AttributeError: _on_ending`
- The `assert`-or-exit principle → discovered after test produced exit 0 on bug present

If the three reactive items had been read upfront, 4 of the 5 cycles wouldn't have happened.

### The two key conceptual distinctions

**1. Install what the instrumentation patches, not what uses it**

The instrumentation is a parasite — you need the host. Install `claude-agent-sdk` because the instrumentor patches its methods and needs something to patch. Don't install Langfuse because it's the third-party consumer; it's not what's being instrumented.

**2. Simulate the third-party's interface contract, not the third-party itself**

Langfuse's relevant behavior is: "a `SpanProcessor` that reads `session.id` from OTel baggage in `on_start` and writes it to the span." That's 4 lines of Python. Langfuse itself is 50,000 lines, requires credentials, and needs a running backend. The bug lives at the interface between the instrumentation and the OTel lifecycle. You only need to exercise that interface, not the consumer that sits on top of it.

---

## Redesigned Architecture

### Current flow (broken)

```
Webhook
  → Semantic Search (finds suspect files)
  → Analyst (writes test blindly, with no knowledge of test infrastructure)
  → Builder (runs test, often fails due to infra mismatch)
  → Fix Agent
  → PR
```

The analyst writes a test without knowing what the repo's test infrastructure looks like. Every mismatch — wrong install extras, wrong base class, wrong import scope, wrong cassette name — requires a full GHA sandbox round-trip to discover. Each cycle is 2-5 minutes.

### Redesigned flow

```
Webhook
  → Semantic Search (finds suspect files)
  → Test Infra Fingerprint (reads conftest.py, pyproject.toml, existing tests — no sandbox)
  → Analyst (writes test from profile, first-try conformant)
  → Repro Verification (sandbox: test must fail + show expected output)
  → Fix Agent (patches code)
  → Fix Verification (same sandbox: test must now pass)
  → PR (test + cassette + fix, permanent regression test)
```

The new **Test Infra Fingerprint** phase runs before the analyst, costs nothing (file reads only, no LLM, no sandbox), and eliminates the entire category of "test doesn't collect" failures.

---

## The Six Phases In Detail

### Phase 0: Test Infra Fingerprinting (NEW — no sandbox, no LLM)

**Purpose:** Give the analyst everything it needs to write a conformant test on the first try.

**Inputs:** repo URL, affected package directory path

**Reads these files:**
1. `tests/conftest.py` — fixtures available, cassette/recording pattern, naming conventions, base classes used
2. One representative existing integration test (the closest existing test to the bug area) — module-level imports, async patterns, setup/teardown structure
3. `pyproject.toml` `[project.optional-dependencies]` — which extras install the SDK under test vs. test deps
4. `tests/cassettes/` or `tests/recordings/` directory listing — which recordings can be reused

**Produces a structured "test infra profile":**
```json
{
  "cassette_naming_convention": "tests/cassettes/{test_module_name}/{test_function_name}.yaml",
  "cassette_transport_fixture": "cassette_transport",
  "available_fixtures": [
    "in_memory_span_exporter",
    "tracer_provider",
    "instrument",
    "cassette_transport",
    "api_key"
  ],
  "module_level_imports_in_test_file": [
    "from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter",
    "from openinference.instrumentation.claude_agent_sdk import ClaudeAgentSDKInstrumentor"
  ],
  "sdk_base_classes": {
    "SpanProcessor": "opentelemetry.sdk.trace.SpanProcessor"
  },
  "install_extras": {
    "sdk_under_test": "instruments",
    "test_runner": "test"
  },
  "additional_packages": ["pytest-asyncio", "pyyaml"],
  "existing_cassettes": [
    "test_client_real_agent_span",
    "test_query_real_agent_span",
    "test_query_tool_spans_from_messages"
  ],
  "async_test_marker": "@pytest.mark.asyncio"
}
```

**This profile eliminates 3 of 5 failure cycles before the first sandbox fires:**
- `[instruments]` extra → no `ModuleNotFoundError`
- `SpanProcessor` base class → no `AttributeError: _on_ending`
- Module-level imports → no `NameError: trace_sdk`

---

### Phase 1: Semantic Search (unchanged)

GHA workflow semantically indexes the repo against the issue text. Produces suspect files and symbols. The test infra fingerprint runs in parallel — both are pure reads with no dependencies on each other.

---

### Phase 2: Analyst (significantly updated)

**Receives:** issue body, suspect files/symbols, test infra profile

**Does these things in order:**

**a. Understand the bug** (same as today)  
Read the suspect source file. Identify what's wrong and where.

**b. Read one existing test** (new)  
Find the test closest to the bug area. Read it to understand: what does a conformant test look like here? The test infra profile tells you *what* exists; this step tells you *how* it's used.

**c. Identify what to install vs. what to stub**

*Install:* the library the instrumentation patches, plus the editable instrumentation source. Use `install_extras` from the profile to get the right extras. Example for #3198: install `claude-agent-sdk` (via `[instruments]`) because the instrumentor patches its methods.

*Stub:* any third-party mentioned in the issue that *uses* the instrumentation. Extract from the issue description: "what is the third party doing that creates the conflict?" Write a minimal inline stub for that one interface. Example for #3198: Langfuse writes `session.id` from baggage in `SpanProcessor.on_start` — stub that as a 10-line class, don't install Langfuse.

**d. Find a reusable cassette** (new)  
From `existing_cassettes` in the profile, find one that exercises the relevant code path. The cassette is the "live API interaction" — you don't need real credentials if a recording exists. Name the new cassette after the test function, as required by the naming convention in the profile. Copy the content from the closest matching existing cassette.

**e. Produce `reproFiles`** (replaces `candidateRepro.testSource`)

A set of files that all go onto the branch together:

```json
{
  "reproFiles": [
    {
      "path": "tests/test_instrumentor.py",
      "append": true,
      "content": "# test function appended to existing file\n..."
    },
    {
      "path": "tests/cassettes/test_instrumentor/test_session_id_not_overwritten.yaml",
      "content": "# cassette content copied from test_client_real_agent_span.yaml"
    }
  ],
  "testEntryPoint": "tests/test_instrumentor.py::test_session_id_not_overwritten",
  "installSpec": {
    "editableInstall": [
      "python/openinference-semantic-conventions",
      "python/openinference-instrumentation",
      "python/instrumentation/openinference-instrumentation-claude-agent-sdk[instruments,test]"
    ],
    "additionalPackages": ["pytest", "pytest-asyncio", "pyyaml"]
  },
  "expectedFailureOutput": "session.id was overwritten",
  "fixHypothesis": {
    "file": "src/openinference/instrumentation/claude_agent_sdk/_wrappers.py",
    "description": "Check OTel baggage before writing SESSION_ID in _extract_init_attributes and _extract_usage_and_cost_attributes"
  }
}
```

**Constraints enforced by the Builder (not hoped for):**
- Test MUST contain `assert` or `raise` — if/print exits 0 even when bug is present (learned from cycle 5)
- Any stub of an SDK interface MUST inherit from the base class in `sdk_base_classes` — duck-typing fails (learned from cycle 2)
- Cassette MUST be named per `cassette_naming_convention` — conftest will `pytest.fail` otherwise (learned from cycle 4)
- Installable packages MUST use extras from `install_extras` — bare installs miss transitive deps (learned from cycle 1)

---

### Phase 3: Repro Verification (updated)

**Step 3a — Write all reproFiles atomically**  
Builder writes every file in `reproFiles` to the branch before running anything. The test and its cassette land together. No sandbox run before all files are in place.

**Step 3b — Install from dynamic `installSpec`**  
Not hardcoded smolagents. Derived from the analyst's `installSpec` which came from pyproject.toml.

**Step 3c — Dispatch sandbox, check exit code**  
Test should exit non-zero. If it passes: the bug is not reproduced (either already fixed or repro is wrong). Abort and surface the result.

**Step 3d — Validate failure output contains `expectedFailureOutput`**  
This distinguishes "test found the bug" from "test crashed on an import error." If the expected substring is absent, the failure is incidental — don't accept it as a repro.

**Step 3e — Commit all files on success**  
Test + cassette committed to branch. This is now a permanent regression test.

---

### Phase 4: Fix Application (mostly unchanged)

Fix agent reads the dossier and `fixHypothesis`. Applies the code change. The test already exists on the branch — the fix agent doesn't need to touch it.

---

### Phase 5: Fix Verification (updated)

Dispatch the same sandbox with the same `installSpec` and `testEntryPoint`. Now it must exit zero AND the expected failure string must NOT appear (because the test passes).

If it passes: PR is ready.

---

### Phase 6: PR (updated)

The PR contains three things — and reviewers see all three together:
1. **Repro test** — a permanent regression test that fails when the bug is present
2. **Cassette** — the recorded API interaction that triggers the bug
3. **Fix** — the code change

CI runs the test on every future PR. Any regression is caught automatically.

---

## What The Two-Sandbox Loop Looks Like In Practice

For issue #3198:

```
Sandbox run 1 (pre-fix code, repro test):
  exit: 1
  output: "session.id was overwritten by Claude's internal UUID.
           Expected: 'dedf7759-...', Got: '63cfe7fe-...'"
  → bug confirmed ✓

Sandbox run 2 (post-fix code, same repro test):
  exit: 0
  output: "1 passed, 6 warnings in 0.13s"
  → fix verified ✓
```

Both runs use the same GHA sandbox, same install commands, same test. The only difference is what code is on the branch.

---

## Schema Changes

### Old `candidateRepro`
```typescript
// Single file, hardcoded install, no expected output
{
  testSource: string,
  candidateTestPath: string,
  pipInstalls: { package: string; editable?: boolean }[],
  sentinel?: string,
}
```

### New `reproFiles`
```typescript
// Multiple files, dynamic install, validated failure output
{
  reproFiles: {
    path: string,
    content: string,
    append?: boolean,   // append to existing file vs. create new
  }[],
  testEntryPoint: string,
  installSpec: {
    editableInstall: string[],       // repo-relative dirs with pyproject.toml
    additionalPackages: string[],    // non-editable packages (pytest-asyncio, etc.)
  },
  expectedFailureOutput: string,     // must appear in stderr/stdout when bug is present
  fixHypothesis: {
    file: string,
    description: string,
  },
}
```

---

## Comparison: What Changed And Why

| Aspect | Old | New | Why |
|---|---|---|---|
| Test written | Blindly, no context | From test infra profile | Eliminates 3/5 failure cycles |
| Install spec | Hardcoded (smolagents) | Dynamic from pyproject.toml | Wrong for every repo except smolagents |
| Files written | One (testSource) | Many (test + cassette + helpers) | Cassette is required to run the test |
| Third-party | Install it | Stub its interface | Don't need 50k lines to test 4 lines |
| Failure validation | Exit code only | Exit code + expected output substring | Distinguishes real repro from import error |
| Base class | Hoped for | Enforced from profile | duck-typing crashes OTel SDK |
| Cassette naming | Not addressed | Enforced from profile | conftest.py fails if name is wrong |
| `assert`/`raise` | Post-hoc guard | Enforced + explained | if/print exits 0, pipeline is blind |
| Commits | Every iteration pushed | Squashed to 1-2 clean commits | OSS repos expect clean history |
| PR gating | Opens immediately | Email review first, then open | Maintainer signs off before upstream sees it |
| CI failures | Not tracked | Watched and surfaced | Maintainer knows what needs fixing |

---

## Three Additional Requirements (Post Walk-Through)

### Requirement 1: Human Review Email Before Upstream PR

The harness MUST NOT open a PR on the upstream repo without the maintainer reviewing the repro and fix first. This is both an OSS courtesy (don't spam upstream with unreviewed work) and a quality gate (the maintainer can catch errors before they're public).

**Flow:**

1. Fix verification passes (test exits 0 on fixed code) → harness sends review email
2. Email contains:
   - Link to the branch in the fork
   - The repro test source (inline, readable)
   - The fix diff (inline, readable)
   - Sandbox run output showing: test fails before fix, passes after
   - One-click approve / reject links (same HITL mechanism as PM email loop)
3. Maintainer replies "approved" or clicks the approve link
4. Only then: harness opens the PR on the upstream repo

**Email format:**
```
Subject: [agent-fix] Arize-ai/openinference#3198 — ready for upstream PR

Bug: session.id overwritten by Claude internal UUID (#3198)
Branch: BandaruDheeraj:fix/claude-agent-sdk-session-id-overwrite

REPRO TEST (confirms bug before fix):
─────────────────────────────────────
[test source]

Exit code: 1
Output: "session.id was overwritten by Claude's internal UUID.
         Expected: dedf7759-... Got: 63cfe7fe-..."

FIX (two lines in _wrappers.py):
─────────────────────────────────
[diff]

EXIT CODE AFTER FIX: 0 — test passes

Reply "approved" to open the upstream PR, or "rejected: <reason>" to abort.
```

**Implementation:** Use the existing Resend + HITL inbox mechanism. The harness already has `runIntrospection` and PM email flows — this is the same pattern applied to the pre-PR gate.

---

### Requirement 2: Watch PR For Failing CI Checks

After the upstream PR is opened, the harness polls the PR's status checks and emails the maintainer when checks fail, with enough detail to fix them.

**What to watch:**

- Parse `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` every 5 minutes
- When all checks are `completed`:
  - If all pass: send success notification, pipeline done
  - If any fail: triage each failure and send fix-guidance email

**Failure triage:**

| Check type | What it means | What to include in email |
|---|---|---|
| Lint / format (`ruff`, `flake8`) | Code style violation | Show the diff ruff would produce |
| Type check (`mypy`, `pyright`) | Type error | Show the exact error line |
| Tests | Regression in unrelated tests | Show which test failed and the output |
| CLA Assistant | CLA not signed | Direct link + sign instructions |
| Security (`zizmor`) | Workflow security issue | Show the flagged line and suggested fix |

**Fixes the harness can apply automatically:**
- `ruff format` violations — run ruff, commit, push
- Import ordering — run `ruff check --fix`, commit, push
- After auto-fix: re-watch for remaining failures

**Fixes that require the maintainer:**
- CLA — human must sign
- Test regressions in unrelated code — may need manual investigation
- Security findings — requires human judgment

**Implementation:** New `watchPrChecks` pipeline phase. Uses the existing GH Actions client. Emails go through the same Resend transport.

---

### Requirement 3: OSS-Standard Commit Practices

The harness must follow the same commit hygiene expected by upstream OSS maintainers. PRs with noisy iterative commits ("fix lint", "fix lint 2", "actually fix lint") are harder to review and may be rejected on style grounds.

**Rules:**

**1. Squash all work to 1-2 commits before pushing the branch**

The branch that gets pushed to the fork (and PRed upstream) has exactly:
- `test(pkg): <test description>` — the regression test and cassette
- `fix(pkg): <fix description>` — the source code change

If the fix and test are small, one combined commit is fine. No "fix: ruff" commits, no "wip" commits, no iterative history.

**2. Commit messages follow Conventional Commits**

```
fix(claude-agent-sdk): don't overwrite session.id when propagated via OTel baggage

<body: what and why, not how>

Fixes: #<upstream issue number>
```

- Type: `fix` for bugs, `test` for test-only changes, `chore` for tooling
- Scope: the affected package name (matches pyproject.toml `name` field)
- Body: explain the problem and why this approach, not a line-by-line walkthrough
- Footer: `Fixes: #<n>` linking to the upstream issue (not the fork issue)

**3. Never push the branch mid-process**

The branch is not pushed until the fix is verified. All sandbox work happens on the harness's local git state. Only two pushes ever happen:
- Push 1: branch with test + fix (after fix verification passes)
- Push 2: any CI fixes required after the PR is open (auto-applied by harness)

Each push is a force-push if it replaces prior state, with `--force-with-lease` for safety.

**4. The PR description is written once, correctly**

The PR body is generated after fix verification and contains:
- One-line summary of the bug
- Root cause (2-3 sentences)
- The fix approach and why alternatives were rejected
- Test plan: what the regression test does and why no API key is needed
- Link to the upstream issue

No iterative PR description edits. The harness writes it once based on the dossier, fix hypothesis, and sandbox output.

---

## Updated Full Flow

```
Webhook
  → Semantic Search
  → Test Infra Fingerprint (reads conftest.py, pyproject.toml, existing tests)
  → Analyst (produces reproFiles + fixHypothesis from profile)
  → Repro Verification (sandbox: test fails + expected output present)
  → Fix Application (patches code)
  → Fix Verification (same sandbox: test now passes)
  → [SQUASH] All sandbox work squashed to 1-2 clean commits on branch
  → [EMAIL REVIEW] Send repro + fix to maintainer for approval
  → [WAIT] Hold until maintainer approves
  → PR Opened on upstream (1 commit, conventional message, full description)
  → [WATCH] Poll PR checks every 5 minutes
    → If lint/format fails: auto-fix + push + continue watching
    → If CLA/security/tests fail: email maintainer with details
    → If all pass: send success notification, done
```

---

## What Still Requires A Human

- **Live credentials** — bug only manifests with real API keys, no cassette exists
- **Concurrency / timing bugs** — not reproducible in a single sequential run
- **Architecture-level fixes** — fix spans many files
- **Proprietary dependencies** — library can't be cloned or pip-installed
- **First-ever cassette recording** — truly new test patterns need a real API key
- **CLA signing** — must be done by a human GitHub account
- **Security findings** — requires human judgment, not auto-fixed
- **Upstream maintainer review** — harness only opens the PR; merging is always human

The goal is to handle the majority class: single-library instrumentation bugs where a cassette exists, the third-party can be stubbed, the fix is localized, and the PR can be reviewed and merged by the upstream maintainer without back-and-forth.
