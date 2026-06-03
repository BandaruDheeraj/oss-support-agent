# Harness Redesign: Integration-First Bug Fix Flow

**Date:** 2026-06-03  
**Based on:** Manual walk-through of Arize-ai/openinference#3198 (session.id overwrite by ClaudeAgentSDKInstrumentor)

---

## What We Learned From The Walk-Through

We took 5 dispatch-fail-fix cycles to get the repro test to collect, each revealing a piece of domain knowledge the harness has no way to acquire today:

| Failure | What it required | Where to find it |
|---|---|---|
| `ModuleNotFoundError: claude_agent_sdk` | Install `[instruments]` extra, not just `[test]` | `pyproject.toml` `[project.optional-dependencies]` |
| `AttributeError: _on_ending` | `SpanProcessor` must inherit from `opentelemetry.sdk.trace.SpanProcessor` | OTel SDK / existing tests |
| `NameError: trace_sdk` | `trace_sdk` is from conftest.py, not test_instrumentor.py | Read module-level imports in existing test |
| `pytest.fail: cassette not found` | Cassette must be named exactly after the test function | conftest.py lines 109-110 |
| Third-party simulation | Langfuse = 10-line SpanProcessor stub, not a pip install | Understanding the issue description |

None of these were in the issue body. All were discoverable from reading the existing test infrastructure for 10 minutes.

**The two key distinctions the walk-through clarified:**

1. You install the library the instrumentation *patches* (claude-agent-sdk), not the third-party that *uses* the instrumentation (Langfuse). The instrumentation is a parasite — you need the host.

2. You simulate the third-party's *interface contract* (SpanProcessor.on_start writes session.id) not the third-party itself. The relevant behavior is 4 lines of Python.

---

## Redesigned Architecture

### Current flow (broken)

```
Webhook → Semantic Search → Analyst (writes testSource blindly) → Builder → Fix → PR
```

The analyst writes a test without knowing what test infrastructure the repo uses. Every mismatch (wrong base class, wrong import scope, wrong cassette name) requires a full sandbox round-trip to discover.

### Redesigned flow

```
Webhook → Semantic Search → [Test Infra Fingerprint] → Analyst → Repro Verification → Fix → Fix Verification → PR
```

The new step — **Test Infra Fingerprint** — runs before the analyst. It reads the repo's test infrastructure and produces a profile the analyst uses to generate a conformant test on the first try.

---

## The Five Phases

### Phase 0: Test Infra Fingerprinting (NEW)

**What it does:** Reads the target repo's test infrastructure before the analyst writes anything.

**Inputs:** repo, affected package path  
**Reads:**
- `tests/conftest.py` — available fixtures, cassette transport pattern, naming convention
- One representative existing integration test — import patterns, base classes, setup/teardown
- `pyproject.toml` `[project.optional-dependencies]` — which extras to install
- `tests/cassettes/` or `tests/recordings/` — what cassettes exist and can be reused

**Outputs a "test infra profile":**
```json
{
  "cassette_convention": "test function name → tests/cassettes/<test_module>/<test_name>.yaml",
  "cassette_transport_fixture": "cassette_transport",
  "available_fixtures": ["in_memory_span_exporter", "tracer_provider", "instrument", "cassette_transport"],
  "module_level_imports": ["from opentelemetry.sdk.trace import TracerProvider", "..."],
  "test_extras": ["instruments", "test"],
  "additional_packages": ["pytest-asyncio", "pyyaml"],
  "existing_cassettes": ["test_client_real_agent_span", "test_query_real_agent_span"],
  "async_test_decorator": "@pytest.mark.asyncio"
}
```

This runs as a read-only GHA job or direct API read — no sandbox needed, just file reads.

---

### Phase 1: Semantic Search (unchanged)

GHA workflow semantically indexes the repo and produces suspect files/symbols from the issue text.

---

### Phase 2: Analyst (updated)

Receives: issue body, suspect files/symbols, **test infra profile**.

**New analyst tasks:**

**a. Read the suspect code** (same as today)  
Understand what the bug is and where it lives.

**b. Read one relevant existing test** (new)  
Specifically for pattern matching — how does an existing test exercise similar code? What does a cassette-based test look like here?

**c. Identify what to install and what to stub**

- *Install*: the library the instrumentation patches (claude-agent-sdk). Use the test infra profile to know which extras. Never install third-party consumers.
- *Stub*: the third-party's interface contract. From the issue description, extract: "what does the third party do that the bug interacts with?" Write that as an inline stub (a SpanProcessor, a mock HTTP client, a fake callback — whatever the interface is).

**d. Identify a reusable cassette or recording**

From `existing_cassettes` in the profile, find one that exercises the relevant code path. The cassette becomes the "real API" for the repro.

**e. Produce `reproFiles`** (replaces `testSource`)

```json
{
  "reproFiles": [
    {
      "path": "tests/test_instrumentor.py",
      "content": "...(appended test function with inline stub + assert)..."
    },
    {
      "path": "tests/cassettes/test_instrumentor/test_session_id_not_overwritten_by_claude_internal_uuid.yaml",
      "content": "...(copied from existing cassette)..."
    }
  ],
  "testEntryPoint": "tests/test_instrumentor.py::test_session_id_not_overwritten_by_claude_internal_uuid",
  "installSpec": {
    "editableInstall": ["python/openinference-semantic-conventions", "python/openinference-instrumentation", "python/instrumentation/openinference-instrumentation-claude-agent-sdk[instruments,test]"],
    "additionalPackages": ["pytest", "pytest-asyncio", "pyyaml"]
  },
  "expectedFailureOutput": "session.id was overwritten",
  "fixHypothesis": {
    "file": "src/openinference/instrumentation/claude_agent_sdk/_wrappers.py",
    "description": "Check OTel baggage before writing SESSION_ID in _extract_init_attributes and _extract_usage_and_cost_attributes"
  }
}
```

**Critical constraints the analyst must follow (enforced by Builder):**
- Test MUST use `assert` or `raise` — `if/print` exits 0 even when bug is present
- Test MUST use a base class (not duck-typed) for any SDK interface (SpanProcessor, Transport, etc.)
- Cassette file MUST be named after the test function per the naming convention in the profile

---

### Phase 3: Repro Verification (updated)

**Step 3a: Write all reproFiles to branch**  
Builder writes the test AND the cassette AND any other fixtures atomically before running anything.

**Step 3b: Install using dynamic installSpec**  
Not hardcoded smolagents. Uses the analyst's `installSpec` derived from pyproject.toml.

**Step 3c: Run test — must exit non-zero**  
Sandbox dispatched. Test should fail. If it passes: either bug not present or repro is wrong.

**Step 3d: Validate failure output**  
Check that `expectedFailureOutput` appears in stdout/stderr. This prevents false positives from unrelated failures (wrong import, syntax error, etc.).

**Step 3e: Commit on success**  
Both test files committed to branch. This is now a permanent regression test.

---

### Phase 4: Fix Application (mostly unchanged)

Fix agent reads the dossier and `fixHypothesis`. Applies the code change. The test already exists on the branch.

---

### Phase 5: Fix Verification (updated)

Dispatch the same sandbox again — same install, same test entry point. Now it must exit zero.

If it passes: PR is ready. The PR contains three things:
1. The repro test (permanent regression test)
2. The cassette (replay of the triggering API interaction)  
3. The fix (code change)

Any future regression is caught by CI running the same test.

---

## Schema Changes

### Old `candidateRepro`
```typescript
{
  testSource: string,          // one test file
  candidateTestPath: string,
  pipInstalls: [{package, editable}],
}
```

### New `reproFiles`
```typescript
{
  reproFiles: {path: string, content: string}[],  // test + cassette + helpers
  testEntryPoint: string,
  installSpec: {
    editableInstall: string[],     // from pyproject.toml, relative paths
    additionalPackages: string[],  // pytest-asyncio, pyyaml, etc.
  },
  expectedFailureOutput: string,   // substring that must appear in failure output
  fixHypothesis: {
    file: string,
    description: string,
  },
}
```

---

## What Stays The Same

- GHA sandbox execution model (dispatch → artifact → exit code)
- Two-run verification loop (fail before fix, pass after fix)
- Branch-based workflow (write files → run → commit → PR)
- The analyst as the intelligence layer
- The Builder as the execution layer
- The oracle validating failure output

## What Changes Fundamentally

| Today | Redesign |
|---|---|
| Analyst writes test blind | Analyst writes test from test infra profile |
| One file (`testSource`) | Multiple files (`reproFiles`) |
| Hardcoded smolagents install | Dynamic `installSpec` from pyproject.toml |
| Third-party = hope LLM figures it out | Third-party = explicit stub derived from issue |
| `assert` guard is post-hoc | Naming/base class/assert enforced by Builder from profile |
| Oracle checks exit code | Oracle checks exit code + failure substring |

---

## What This Still Won't Handle

- Bugs requiring **live credentials** (no cassette exists, can't stub auth)
- Bugs that only manifest under **concurrency or load**
- Bugs in **proprietary code** the sandbox can't clone
- Bugs where the **fix requires architecture changes** spanning many files

These remain human-only. The goal is to handle the majority class: single-library instrumentation bugs where a cassette exists or can be copied, the third-party can be stubbed, and the fix is localized.
