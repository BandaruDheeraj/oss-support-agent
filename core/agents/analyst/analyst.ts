/**
 * Analyst agent: read-only loop that culminates in a `record_evidence`
 * call to produce a new EvidenceDossier snapshot.
 */

import { generateText } from 'ai';
import { DossierStore, type DossierSnapshot } from './dossier';
import { classifyAgentLoopError, runAgentLoop } from '../agent-loop';
import { makeAnalystRegistry } from '../tools';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';
import type { SemanticSuspectSeed } from './semantic-search';
import { getModelRoutes, MissingLlmApiKeyError, type ModelRoute } from '../../llm/v2/client';
import { getAISDKTelemetrySettings } from '../../observability';

export interface RunAnalystArgs {
  issue: IssueHandle;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
  attemptId: string;
  dossier: DossierStore;
  /** Optional carryforward from a prior attempt. */
  carryforwardSummary?: string;
  /** Optional semantic retrieval seed computed pre-Analyst. */
  semanticSuspectSeed?: SemanticSuspectSeed | null;
  /** Optional test infrastructure fingerprint for the affected package. */
  testInfraProfile?: import('../repro-loop-v2/test-infra-fingerprint').TestInfraProfile | null;
  /**
   * Related open issues fetched before the analyst runs.
   * When present, the analyst classifies the bug as isolated vs cluster
   * and emits a patternAssessment on record_evidence.
   */
  relatedIssues?: Array<{ number: number; title: string; reason: string }>;
}

export interface AnalystResult {
  snapshot: DossierSnapshot | null;
  terminated: 'done' | 'abandon' | 'max_turns' | 'finished' | 'error' | 'api_unavailable';
  reason?: string;
  apiUnavailable?: AnalystApiUnavailable;
  toolCalls: number;
  transcriptSummary: string;
}

export interface AnalystApiUnavailable {
  stage: 'analyst_preflight';
  reason: string;
  routeId: string | null;
  modelId: string | null;
}

const DEFAULT_ANALYST_PREFLIGHT_TIMEOUT_MS = 8_000;

const SYSTEM_PROMPT = `You are the Analyst agent for an OSS bug-fixing pipeline. Your job is to investigate an upstream issue, read the relevant code, and produce a structured EvidenceDossier — but you DO NOT propose fixes and you DO NOT write code.

You are read-only. You can call: read_file, grep, grep_with_context, list_dir, read_diff, git_blame, git_log, read_test, find_symbol, find_callers, read_symbol_context, web_fetch, gh_issue, gh_pr, read_issue_repo_context, note, record_evidence, abandon.

Procedure:
1. Call read_issue_repo_context (or gh_issue + gh_pr) to anchor yourself.
2. Read the issue body carefully. Note any version info, stack traces, repro snippets.
2b. If a semantic suspect seed is provided in the user prompt, treat it as your PRIMARY suspect-file/suspect-symbol source of truth.
2c. When semantic suspect files are present, stay scoped to those files for code reads. Do NOT spend tool budget on broad repository exploration (list_dir/grep/find_symbol/find_callers/read_symbol_context) unless the seed is empty.
3. Locate the affected symbols in the repo using read_symbol_context (or grep/find_symbol/find_callers) only when no semantic seed is available.
4. Open the relevant files with read_file. Open recent commits with git_log/git_blame if behaviour changed.
5. Form a list of suspect files + suspect symbols, open questions, and confidence level.
6. Identify PRECONDITIONS — see "Preconditions" section below.
7. Build a structured ORACLE SPEC with suspect_path_assertions + precondition_assertions.
8. Terminate by calling record_evidence with a complete summary. record_evidence is the ONLY way to commit your findings.

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

Suspect files (REQUIRED when known):
When you can identify likely source files, include a \`suspectFiles\` array on \`record_evidence\` with repo-relative paths. Keep this aligned with \`suspectSymbols[*].file\`.

Oracle spec (REQUIRED on record_evidence):
Provide \`oracleSpec\` with EXACTLY these two fields:
  - \`suspect_path_assertions\`: array of objects describing what MUST appear in failing output. Use:
      { kind: "symbol" | "stack_frame" | "span_attribute", needle: "<substring>", file?: "<repo path>" }
    Use \`needle\` as a concrete substring to match (symbol name, frame text, or span attribute key/value token).
  - \`precondition_assertions\`: array of objects describing what MUST be present in test source. Use:
      { condition: "<precondition sentence>", markers: ["<substring>", "..."] }
    markers should come from your satisfactionModes and be easy to grep in test code.

Downstream stages are deterministic and consume this struct directly. Keep it concise, machine-checkable, and tied to your evidence.

LOW-CONFIDENCE semantic seed handling:
When \`semanticConfidence.low_confidence\` is true, you MUST explicitly state in your dossier summary that semantic suspects are low-confidence. You MUST carry that uncertainty into \`oracleSpec\`: only include suspect_path_assertions you can justify from direct file reads / concrete evidence, and avoid claiming suspect-path evidence you cannot verify.

REPRO TARGETS (optional, low-cost):
Independent of candidateRepro, you SHOULD include a \`reproTargets\` field on record_evidence when you've identified the structural setup the repro needs:

- \`reproTargets.editableInstall\`: array of repo-relative directory paths the Repro Executor should \`pip install -e <dir>\` BEFORE running the candidate test. Each entry MUST be a directory containing pyproject.toml / setup.py / setup.cfg (the in-repo package whose imports the test needs). This replaces a fragile BFS heuristic downstream. Example: ["python/openinference-instrumentation-smolagents", "python/openinference-instrumentation"]. Omit when the bug is in a single-package repo with no nested packages.
- \`reproTargets.runtimeForbidden\`: array of import names (lowercase) that must NOT be installed in the runtime sandbox — frameworks known to either explode the dep tree or require network/credentials. Examples: "smolagents", "langchain", "llama_index", "autogen", "crewai". Populate this when the issue body, snippet, or suspect path involves one of these frameworks AND the bug can be reproduced by exercising the wrapped primitive directly.

reproTargets is independent of confidence — even a low-confidence dossier benefits from naming the right package dir. Omit reproTargets entirely (or set both fields to []) when you cannot identify either.

FINAL REMINDER: regardless of how much you investigated or how confident you are, you MUST end this session by calling record_evidence (with whatever you have). Use abandon ONLY when the issue itself is contradictory or empty — NEVER as a way out of an incomplete investigation. Plain-text summaries without a terminal tool call are discarded.

Pattern assessment (when related issues are provided):
When a "RELATED OPEN ISSUES" section appears in your user prompt, you MUST include patternAssessment in record_evidence:
- kind: 'cluster' if ≥1 related issue shares the same suspect file or root-cause pattern; else 'isolated'
- clusterSize: total issues in the cluster including this one
- relatedIssueNumbers: issue numbers of the related issues that are in the cluster
- structuralNote: 1-2 sentences on what single structural change would fix the whole cluster (or "" if isolated)
Also mention the pattern in your summary: "This is one of N issues stemming from <pattern>." or "This appears to be an isolated bug."
Omit patternAssessment when no related issues section is present.`;

function resolveAnalystPreflightTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OSA_ANALYST_PREFLIGHT_TIMEOUT_MS;
  if (!raw) return DEFAULT_ANALYST_PREFLIGHT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ANALYST_PREFLIGHT_TIMEOUT_MS;
  return Math.floor(parsed);
}

function classifyAnalystProbeError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    const lower = err.message.toLowerCase();
    if (err.name === 'AbortError' || lower.includes('aborted')) {
      return `[timeout] Analyst API preflight timed out after ${timeoutMs}ms`;
    }
    return classifyAgentLoopError(err.message);
  }
  return classifyAgentLoopError(String(err));
}

async function probeAnalystApiAvailability(
  modelOverride: string
): Promise<{ ok: true } | { ok: false; unavailable: AnalystApiUnavailable }> {
  let routes: ModelRoute[];
  try {
    routes = getModelRoutes('ANALYST', modelOverride);
  } catch (err) {
    const reason =
      err instanceof MissingLlmApiKeyError
        ? `[no-api-keys] ${err.message}`
        : classifyAnalystProbeError(err, resolveAnalystPreflightTimeoutMs());
    return {
      ok: false,
      unavailable: {
        stage: 'analyst_preflight',
        reason,
        routeId: null,
        modelId: modelOverride,
      },
    };
  }

  const timeoutMs = resolveAnalystPreflightTimeoutMs();
  let lastFailure: AnalystApiUnavailable | null = null;
  for (const route of routes) {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const aiTelemetry = getAISDKTelemetrySettings({
        functionId: 'analyst.preflight.generateText',
        metadata: {
          'agent.name': 'ANALYST',
          'llm.route': route.routeId,
          'llm.model_name': route.modelId,
        },
        recordInputs: true,
        recordOutputs: true,
      });
      await generateText({
        model: route.model,
        system: 'Analyst API preflight probe. Reply with "ok".',
        messages: [{ role: 'user', content: 'ok' }],
        maxTokens: 4,
        temperature: 0,
        abortSignal: abortController.signal,
        ...(aiTelemetry ? { experimental_telemetry: aiTelemetry } : {}),
      });
      return { ok: true };
    } catch (err) {
      lastFailure = {
        stage: 'analyst_preflight',
        reason: classifyAnalystProbeError(err, timeoutMs),
        routeId: route.routeId,
        modelId: route.modelId,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  return {
    ok: false,
    unavailable:
      lastFailure ?? {
        stage: 'analyst_preflight',
        reason: '[provider-unavailable] Analyst API preflight failed with no route-level error detail',
        routeId: null,
        modelId: modelOverride,
      },
  };
}

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
        semanticSuspectSeed: args.semanticSuspectSeed ?? null,
      },
    },
  });

  const carry = args.carryforwardSummary
    ? `\n\nPrior-attempt carry-forward (treat as new evidence inputs, not as the original issue):\n${args.carryforwardSummary}`
    : '';

  const semanticSeed = args.semanticSuspectSeed
    ? `\n\nSemantic retrieval seed (PRIMARY suspect triage input):\n` +
      `${JSON.stringify(
        {
          model: args.semanticSuspectSeed.model,
          cacheHit: args.semanticSuspectSeed.cacheHit,
          indexedFileCount: args.semanticSuspectSeed.indexedFileCount,
          suspectFiles: args.semanticSuspectSeed.suspectFiles,
          suspectSymbols: args.semanticSuspectSeed.suspectSymbols,
          semanticConfidence: args.semanticSuspectSeed.semanticConfidence,
        },
        null,
        2
      )}\n` +
      `You MUST treat these suspectFiles/suspectSymbols as the primary starting point, stay scoped to those suspectFiles for code reads, and carry them into record_evidence unless direct file reads disprove them. ` +
      `If semanticConfidence.low_confidence is true, explicitly state that uncertainty in your dossier summary and avoid unverified suspect_path assertions.`
    : '';

  const testInfraSection = args.testInfraProfile
    ? `\n\n=== TEST INFRASTRUCTURE PROFILE ===\n${JSON.stringify(args.testInfraProfile, null, 2)}`
    : '';

  const relatedIssuesSection = args.relatedIssues && args.relatedIssues.length > 0
    ? `\n\n=== RELATED OPEN ISSUES (for pattern assessment) ===\n` +
      `The following ${args.relatedIssues.length} open issue(s) may share the same root cause. ` +
      `Compare their affected areas with your suspect list.\n\n` +
      args.relatedIssues.map((i) => `- #${i.number}: ${i.title} (reason: ${i.reason})`).join('\n') +
      `\n\nYou MUST include patternAssessment in record_evidence. ` +
      `Set kind='cluster' if ≥1 related issue shares the same suspect file or root-cause pattern. Otherwise kind='isolated'.`
    : '';

  const userPrompt = `Issue #${args.issue.number}: ${args.issue.title}\n\n${args.issue.body}\n\nRepo: ${args.repo.fullName} (affected module: ${args.repo.affectedModule}, language: ${args.repo.language})${carry}${semanticSeed}${testInfraSection}${relatedIssuesSection}\n\nInvestigate and produce an EvidenceDossier via record_evidence.`;

  // Pin Analyst to a strong tool-calling model unless explicitly overridden.
  // We bypass OPENROUTER_MODEL_DEFAULT here because some defaults (e.g.
  // smaller/cheaper models) silently stop emitting tool calls and exit with
  // a plain-text summary, which is then discarded — leading to repeated
  // `terminated=finished` failures with no dossier.
  const analystModel = process.env.OPENROUTER_MODEL_ANALYST || 'anthropic/claude-sonnet-4.5';

  const preflight = await probeAnalystApiAvailability(analystModel);
  if (!preflight.ok) {
    const unavailable = preflight.unavailable;
    // eslint-disable-next-line no-console
    console.log(
      `[v2-analyst] attempt=${args.attemptId} phase=preflight terminated=api_unavailable` +
        ` stage=${unavailable.stage}` +
        (unavailable.routeId ? ` route=${unavailable.routeId}` : '') +
        (unavailable.modelId ? ` model=${unavailable.modelId}` : '') +
        ` reason=${JSON.stringify(unavailable.reason).slice(0, 320)}`
    );
    return {
      snapshot: args.dossier.latest(),
      terminated: 'api_unavailable',
      reason: unavailable.reason,
      apiUnavailable: unavailable,
      toolCalls: 0,
      transcriptSummary: '(analyst api preflight failed)',
    };
  }

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
  // retry with an explicit reminder before declaring analyst_failed. We also
  // recover once from a terminal record_evidence JSON-parse failure because
  // this is usually model formatting noise (extra trailing tokens), not a
  // true investigation dead-end.
  const recoverableJsonParseFailure = isRecoverableRecordEvidenceJsonParseFailure(result);
  if (
    !args.dossier.latest() &&
    (result.terminated === 'finished' ||
      result.terminated === 'max_turns' ||
      recoverableJsonParseFailure)
  ) {
    const forcePrompt = recoverableJsonParseFailure
      ? `${userPrompt}\n\n[ORCHESTRATOR REMINDER] Your previous terminal tool call failed JSON parsing:\n` +
        `${result.reason ?? '(unknown parse failure)'}\n\n` +
        `Re-emit ONE valid JSON object for record_evidence. No XML envelope tokens, no prose before/after the JSON, no trailing text. ` +
        `Keep it minimal, but include candidateRepro.testSource (a full pytest test string) when suspect symbols are present.\n\n` +
        `Use this exact minimal shape if needed:\n` +
        `record_evidence({\n` +
        `  "summary": "<one-paragraph summary of what you found>",\n` +
        `  "confidence": "low",\n` +
        `  "evidence": [],\n` +
        `  "suspectSymbols": [],\n` +
        `  "preconditions": [],\n` +
        `  "openQuestions": []\n` +
        `})\n\n` +
        `If semantic suspect files/symbols were provided, include reproFiles with testEntryPoint and reproFiles array in this retry; it is required for repro execution.\n\n` +
        `Do NOT call abandon — just emit a valid record_evidence tool call with what you have.`
      : `${userPrompt}\n\n[ORCHESTRATOR REMINDER] Your previous attempt ended with a plain-text reply (no tool call). Plain-text replies are DISCARDED. You MUST call record_evidence NOW. Use this minimal template if you are stuck — fill in summary and confidence from what you have already investigated, and set every array to [] if you don't have specific entries:\n\n` +
        `record_evidence({\n` +
        `  summary: "<one-paragraph summary of what you found — even if incomplete, write what you have>",\n` +
        `  confidence: "low",\n` +
        `  evidence: [],\n` +
        `  suspectSymbols: [],\n` +
        `  preconditions: [],\n` +
        `  openQuestions: []\n` +
        `})\n\n` +
        `If semantic suspect files/symbols were provided, include reproFiles with testEntryPoint and reproFiles array in this retry; it is required for repro execution.\n\n` +
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

function isRecoverableRecordEvidenceJsonParseFailure(result: Pick<AnalystResult, 'terminated' | 'reason'>): boolean {
  if (result.terminated !== 'error' || !result.reason) return false;
  const reason = result.reason.toLowerCase();
  return reason.includes('record_evidence') && reason.includes('json parsing failed');
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
