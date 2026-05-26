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

  const result = await runAgentLoop({
    agent: 'ANALYST',
    registry,
    system: SYSTEM_PROMPT,
    user: userPrompt,
    attemptId: args.attemptId,
    issueNumber: args.issue.number,
  });

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
    });
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
