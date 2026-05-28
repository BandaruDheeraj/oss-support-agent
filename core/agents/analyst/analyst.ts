/**
 * Analyst agent: read-only loop that culminates in a `record_evidence`
 * call to produce a new EvidenceDossier snapshot.
 */

import { DossierStore, type DossierSnapshot } from './dossier';
import { runAgentLoop } from '../agent-loop';
import { makeAnalystRegistry } from '../tools';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';

export interface RunAnalystArgs {
  issue: IssueHandle;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
  attemptId: string;
  dossier: DossierStore;
  /** Optional carryforward from a prior attempt. */
  carryforwardSummary?: string;
}

export interface AnalystResult {
  snapshot: DossierSnapshot | null;
  terminated: 'done' | 'abandon' | 'max_turns' | 'finished' | 'error';
  reason?: string;
  toolCalls: number;
  transcriptSummary: string;
}

const SYSTEM_PROMPT = `You are the Analyst agent for an OSS bug-fixing pipeline. Your job is to investigate an upstream issue, read the relevant code, and produce a structured EvidenceDossier — but you DO NOT propose fixes and you DO NOT write code.

You are read-only. You can call: read_file, grep, list_dir, read_diff, git_blame, git_log, read_test, find_symbol, find_callers, web_fetch, gh_issue, gh_pr, note, record_evidence, abandon.

Procedure:
1. Call gh_issue and gh_pr to anchor yourself.
2. Read the issue body carefully. Note any version info, stack traces, repro snippets.
3. Locate the affected symbols in the repo using grep/find_symbol/find_callers.
4. Open the relevant files with read_file. Open recent commits with git_log/git_blame if behaviour changed.
5. Form a list of suspect symbols, open questions, and confidence level.
6. Identify PRECONDITIONS — see "Preconditions" section below.
7. Terminate by calling record_evidence with a complete summary. record_evidence is the ONLY way to commit your findings.

CRITICAL: You MUST end the session with either record_evidence or abandon. Returning a plain-text summary without calling record_evidence wastes the entire investigation — your findings are discarded. Always finalize via tool call.

Do not call write_test, apply_patch, run_repro, or any sandbox tool — they are not registered for you.
Do not include the issue body verbatim in evidence.detail; quote only the relevant excerpts.
Confidence rules: 'high' requires a specific file:line cause hypothesis; 'medium' requires at least one suspect symbol; 'low' otherwise.

Preconditions:
For each suspect symbol, identify the world-state required for the bug to manifest. Preconditions can be NEGATIVE ("no tracer provider configured", "env var FOO unset", "client created without retry middleware"). Many real bugs only fire in specific environmental conditions; downstream agents will use these to write a repro test that ACTUALLY triggers the bug.

Each precondition needs:
  - condition: one-sentence description of the required state
  - kind: one of global_state, config_absence, env_var, input_shape, timing, concurrency, version_pin
  - appliesTo: {file, symbol?} pointing at the suspect surface
  - evidenceRefs: ids of dossier evidence items that support the precondition
  - satisfactionModes: ways a test can enforce it. Each mode has a description and \`markers\` — short substrings that should appear in test source when the mode is in force (e.g. for direct injection: ["NonRecordingSpan(", "INVALID_SPAN_CONTEXT"]). List MULTIPLE modes when both global-reset and direct-injection paths exist — downstream agents prefer the simpler one.
  - threats: test-infrastructure items that might VIOLATE the precondition. SEE "Test-infra scan" below.

Test-infra scan (best-effort — this is what catches issues like NonRecordingSpan-masked-by-autouse-fixture):
For each suspect source path, MAP it to its likely test mirror and look for relevant fixtures. Example:
  src/openinference/instrumentation/smolagents/_wrappers.py
  → tests/openinference/instrumentation/smolagents/conftest.py
Walk \`tests/\` DOWNWARD from the package root toward the matching test directory using list_dir / read_file. Also check setup.cfg, pytest.ini, pyproject.toml [tool.pytest.ini_options] when easily reachable. Look for:
  - autouse fixtures (\`@pytest.fixture(autouse=True)\`)
  - fixtures that call \`set_tracer_provider\`, \`instrument(\`, \`monkeypatch.setenv\`, \`set_global_handler\`, or similar
  - fixtures named after suspect concepts (e.g. \`tracer_provider\`, \`event_loop\`, \`mock_openai\`)
Each fixture that installs the state a precondition requires to be ABSENT becomes a \`threats\` entry. Walking ABOVE the source path won't find these — test infra mirrors source path under \`tests/\`.

IMPORTANT: This scan is BEST-EFFORT. If you cannot find a tests/ directory, or no conftest.py exists at the expected path, that is FINE — record_evidence with whatever preconditions you have (or none at all) and move on. NEVER call abandon just because the test-infra scan came up empty. "No relevant test files found" is the COMMON case, not an error condition; it just means there are no test-infra threats to enumerate.

Empty preconditions: [] is acceptable for issues with no environmental subtlety. Do NOT fabricate baseline preconditions — that wastes downstream prompt context.

CANDIDATE REPRO (optional, high-leverage):
When your confidence is medium or high AND the failure mode fits one of two templates, you SHOULD include a \`candidateRepro\` field on record_evidence. A downstream deterministic Builder will use it to author the failing test WITHOUT another LLM round-trip — this dramatically reduces failed repros caused by Prober drift.

Two supported failureMode templates:
1. \`unexpected_exception\` — the exercise call raises an exception when it shouldn't (or a different exception type than expected). Specify \`expectedExceptionType\` either as the FQN of the exception that the buggy code raises (e.g. "AttributeError"), or "None" if the bug is that no exception is raised.
2. \`wrong_return\` — the exercise call returns the wrong value. Specify \`expectedReturnRepr\` as a Python repr the actual return must equal (e.g. "True", "42", "'ok'").

Required fields on candidateRepro:
- failureMode: "unexpected_exception" | "wrong_return"
- candidateTestPath: absolute path under tests/ — let the Builder pick one if you're unsure (e.g. "tests/repro/test_issue_<N>.py")
- sentinelString: a short distinctive string the test will print on the failure path (e.g. "REPRO_46_SENTINEL_NONRECORDINGSPAN")
- exerciseImports: list of \`{module, names?: string[]}\` — minimal imports to make the exercise call work
- setupCode: optional Python preamble (kept short — assignments only)
- exerciseCall: ONE Python expression that triggers the bug (must reference at least one suspectSymbol you also recorded)
- expectedExceptionType OR expectedReturnRepr (depending on failureMode)
- pipInstalls: list of \`{package, editable?: boolean}\` — third-party deps the test needs (do NOT include the repo's own package if it's already editable-installed)
- preconditionsSatisfied: list of precondition IDs you've verified hold

DO NOT include candidateRepro when:
- Confidence is low
- The bug is intermittent, race-conditional, or requires real network/credentials
- You can't pin down a single exercise call

When in doubt, omit candidateRepro — the Prober will handle it.

FINAL REMINDER: regardless of how much you investigated or how confident you are, you MUST end this session by calling record_evidence (with whatever you have). Use abandon ONLY when the issue itself is contradictory or empty — NEVER as a way out of an incomplete investigation. Plain-text summaries without a terminal tool call are discarded.`;

export async function runAnalyst(args: RunAnalystArgs): Promise<AnalystResult> {
  const registry = makeAnalystRegistry({
    ctx: {
      agentName: 'ANALYST',
      attemptId: args.attemptId,
      issueNumber: args.issue.number,
      handles: {
        workspace: args.workspace,
        sandbox: args.sandbox,
        issue: args.issue,
        repo: args.repo,
        dossier: args.dossier,
      },
    },
  });

  const carry = args.carryforwardSummary
    ? `\n\nPrior-attempt carry-forward (treat as new evidence inputs, not as the original issue):\n${args.carryforwardSummary}`
    : '';

  const userPrompt = `Issue #${args.issue.number}: ${args.issue.title}\n\n${args.issue.body}\n\nRepo: ${args.repo.fullName} (affected module: ${args.repo.affectedModule}, language: ${args.repo.language})${carry}\n\nInvestigate and produce an EvidenceDossier via record_evidence.`;

  // Pin Analyst to a strong tool-calling model unless explicitly overridden.
  // We bypass OPENROUTER_MODEL_DEFAULT here because some defaults (e.g.
  // smaller/cheaper models) silently stop emitting tool calls and exit with
  // a plain-text summary, which is then discarded — leading to repeated
  // `terminated=finished` failures with no dossier.
  const analystModel = process.env.OPENROUTER_MODEL_ANALYST || 'anthropic/claude-sonnet-4.5';

  const result = await runAgentLoop({
    agent: 'ANALYST',
    registry,
    system: SYSTEM_PROMPT,
    user: userPrompt,
    attemptId: args.attemptId,
    issueNumber: args.issue.number,
    modelOverride: analystModel,
  });

  logAnalystAttempt('initial', args.attemptId, analystModel, result, !!args.dossier.latest());

  // Some models stop emitting tool calls before recording the dossier (they
  // narrate findings in plain text and exit). Give them exactly one forced
  // retry with an explicit reminder before declaring analyst_failed.
  if (!args.dossier.latest() && (result.terminated === 'finished' || result.terminated === 'max_turns')) {
    const forcePrompt =
      `${userPrompt}\n\n[ORCHESTRATOR REMINDER] Your previous attempt ended with a plain-text reply (no tool call). Plain-text replies are DISCARDED. You MUST call record_evidence NOW. Use this minimal template if you are stuck — fill in summary and confidence from what you have already investigated, and set every array to [] if you don't have specific entries:\n\n` +
      `record_evidence({\n` +
      `  summary: "<one-paragraph summary of what you found — even if incomplete, write what you have>",\n` +
      `  confidence: "low",\n` +
      `  evidence: [],\n` +
      `  suspectSymbols: [],\n` +
      `  preconditions: [],\n` +
      `  openQuestions: []\n` +
      `})\n\n` +
      `Do NOT call abandon — abandon is reserved for contradictory or empty issues, not incomplete investigations. Just call record_evidence with whatever you have.`;
    const retry = await runAgentLoop({
      agent: 'ANALYST',
      registry,
      system: SYSTEM_PROMPT,
      user: forcePrompt,
      attemptId: args.attemptId,
      issueNumber: args.issue.number,
      modelOverride: analystModel,
    });
    logAnalystAttempt('retry', args.attemptId, analystModel, retry, !!args.dossier.latest());
    return {
      snapshot: args.dossier.latest(),
      terminated: retry.terminated,
      reason: retry.reason,
      toolCalls: result.toolCalls + retry.toolCalls,
      transcriptSummary: retry.transcriptSummary,
    };
  }

  return {
    snapshot: args.dossier.latest(),
    terminated: result.terminated,
    reason: result.reason,
    toolCalls: result.toolCalls,
    transcriptSummary: result.transcriptSummary,
  };
}

/**
 * Diagnostic logger for the Analyst stage. Emits a single line per attempt
 * (initial + optional retry) so we can see WHY the Analyst halts when it
 * fails to record a dossier — model id, turns, tool-call counts, terminated
 * kind/reason, transcript summary, and a preview of any final plaintext.
 */
function logAnalystAttempt(
  phase: 'initial' | 'retry',
  attemptId: string,
  model: string,
  result: { terminated: string; reason?: string; turns: number; toolCalls: number; transcriptSummary: string; text: string },
  dossierRecorded: boolean
): void {
  const textPreview = (result.text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  // eslint-disable-next-line no-console
  console.log(
    `[v2-analyst] attempt=${attemptId} phase=${phase} model=${model} terminated=${result.terminated}` +
      ` turns=${result.turns} toolCalls=${result.toolCalls} dossierRecorded=${dossierRecorded}` +
      (result.reason ? ` reason=${JSON.stringify(result.reason).slice(0, 240)}` : '') +
      ` tools=${result.transcriptSummary}` +
      (textPreview ? ` textPreview=${JSON.stringify(textPreview)}` : '')
  );
}
