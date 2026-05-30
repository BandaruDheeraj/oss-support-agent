/**
 * Repro Prober — replaces the LLM-authored Planner. Runs the same shape of
 * loop the legacy Executor used (read + sandbox + write-test + note), but its
 * terminal contract is to emit a `ReproRecipe` via `record_evidence`. The
 * recipe carries:
 *
 *  - the literal testSource that produced two consecutive failing run_repro
 *    calls with the sentinel in stderr/stdout,
 *  - the pip_install steps the Prober actually had to perform,
 *  - the credentials it detected as required,
 *  - the heavy-framework verbatim-incompatibility flag,
 *  - a provenance block including the last observed run_repro stats.
 *
 * The deterministic Executor then transcribes the recipe — no LLM judgment
 * at execution time. Critic consumes `provenance.observedProbe` to decide
 * whether `expectedFailureSignature` is a hard gate (observed=true) or a
 * soft signal (observed=false).
 */

import { runAgentLoop, type AgentLoopResult } from '../agent-loop';
import { makeReproProberRegistry } from '../tools';
import type {
  DossierStore,
  DossierSnapshot,
  Precondition,
  ReproRecipe,
} from '../analyst/dossier';
import type {
  IssueHandle,
  RepoHandle,
  SandboxHandle,
  WorkspaceReader,
  WorkspaceWriter,
} from '../tools/handles';
import {
  renderEditableInstallsBlock,
  renderIssueSnippetsBlock,
  detectHeavyFrameworkSignal,
  type IssueCodeSnippet,
} from './repro-hints';
import {
  deriveVerifiedState,
  summariseVerifiedState,
  renderVerifiedState,
} from './verified-state';

/**
 * Render dossier preconditions for the Prober's user prompt. Copied
 * verbatim from the legacy Executor; the Prober has the same enforcement
 * obligation (every precondition must show up in the candidate test source
 * via at least one satisfactionMode's markers).
 */
function renderPreconditionsBlockForProber(preconditions: Precondition[]): string | null {
  if (preconditions.length === 0) return null;
  const lines: string[] = ['PRECONDITIONS THE TEST MUST ENFORCE:'];
  for (const pc of preconditions) {
    lines.push(`- [${pc.id}] (${pc.kind}) ${pc.condition}`);
    if (pc.appliesTo) {
      lines.push(
        `    target: ${pc.appliesTo.file}${pc.appliesTo.symbol ? ` :: ${pc.appliesTo.symbol}` : ''}`,
      );
    }
    if (pc.satisfactionModes && pc.satisfactionModes.length > 0) {
      lines.push(
        `    satisfaction modes (choose one and ensure its markers appear in the test):`,
      );
      for (const mode of pc.satisfactionModes) {
        lines.push(
          `      • ${mode.description}${
            mode.markers.length > 0
              ? ` — markers: ${mode.markers.map((m) => `\`${m}\``).join(', ')}`
              : ''
          }`,
        );
      }
    }
    if (pc.threats && pc.threats.length > 0) {
      lines.push(`    threats to neutralize: ${pc.threats.join('; ')}`);
    }
  }
  return lines.join('\n');
}

const SYSTEM = `You are the Repro Prober for an OSS bug pipeline. Your job is to (1) construct a failing test at a candidate path, (2) prove it fails reproducibly in the sandbox, and (3) commit the recipe via record_evidence so the deterministic Executor can transcribe it later. The sandbox is STATEFUL — pip_install, python_module_check and run_python persist across calls within this run. Use that.

Procedure (follow in order; do not skip):

1. PICK a candidate test path under one of the configured test roots. Pick a filename that conveys the bug (e.g. tests/test_repro_<short-desc>.py). Remember this path; you will write to it and record it on the recipe.

2. PROBE imports. For each suspect symbol in the dossier and each import in the issue snippets:
   - python_module_check("X") — fast importability check, no execution.
   - run_python("from X import Y") — confirms the actual import statement works.
   If an import fails: pip_install with \`-e <candidate-dir>\` from "Candidate editable-install dirs" when the failing module looks like an in-repo package, or use read_symbol_context / grep_with_context (or grep / find_symbol) to locate the correct import path. Repeat until you have a verified import block.

3. PROBE the exercise. Use run_python to actually call the suspect symbols with hand-constructed inputs. Confirm the call executes (whether or not it raises). If it raises the expected failure signature, you already have a working repro skeleton — copy it into the test.

ESCAPE HATCH (NON-NEGOTIABLE — read this before grepping a 6th time): the moment ANY of these is true, your VERY NEXT tool call MUST be write_test:
   - run_python has errored 2+ times trying to construct the exercise call, OR
   - you have made 8+ combined grep/grep_with_context/find_symbol/find_callers/read_symbol_context calls and the verified-state ledger shows importable >= 1, OR
   - you have spent a turn doing nothing but read-tier research after a probe phase that already established at least one working import.
Rationale: pytest stderr from run_repro will pinpoint a wrong call signature in ONE iteration. Continuing to grep cannot. write_test is NOT a one-shot commitment — revise_test corrects course as many times as your sandbox budget allows, and a failing-for-the-wrong-reason test is strictly more information than another grep result. Big-bang authoring is not the failure mode here; analysis-paralysis is.

4. COMMIT the test source. ONE write_test call. The test contains: your verified imports, your verified exercise call, and a final assertion that fails with YOUR chosen sentinel string. PICK a unique 12+ character sentinel (e.g. \`REPRO_NONRECORDINGSPAN_CRASH_a3f9\`) and embed it as a LITERAL string in the failure message. Example:
   \`\`\`python
   SENTINEL = "REPRO_NONRECORDINGSPAN_CRASH_a3f9"
   try:
       suspect_call(bad_input)
   except SomeError as exc:
       assert False, SENTINEL + ": " + str(exc)
   else:
       raise AssertionError(SENTINEL + ": expected SomeError but call succeeded")
   \`\`\`
   Do NOT write the literal text \`<sentinel>\` — that is a placeholder in these instructions, not the value to embed. You must invent a unique string and use IT.

5. VERIFY twice. run_repro twice. After EACH run, classify the result by these rules:
   - exit != 0 AND your chosen sentinel string appears in stdout/stderr → POSITIVE (the test triggered the bug). Count it.
   - exit != 0 AND no sentinel → the test failed for the wrong reason (collection error, unrelated exception). revise_test to fix the exercise.
   - exit == 0 → the test PASSED; the exercise did not trigger the bug. revise_test with a stronger exercise.

   COMPLETION TRIGGER (NON-NEGOTIABLE): as soon as you have 2 POSITIVE observations since your latest test write, your VERY NEXT tool call MUST be record_evidence. Do not probe more. Do not read more files. Do not call abandon. The registry's abandon gate will reject abandon when a positive signal exists.

6. RECORD the recipe. Call record_evidence with a complete \`reproRecipe\` object. The Critic and deterministic Executor will consume this exact object. Required fields:
   - candidateTestPath: the path you wrote to in step 4.
   - testSource: the LITERAL contents you wrote (must be ≤ 4096 chars; trim or extract a focused subset if your draft is larger — the deterministic Executor re-applies this verbatim).
   - sentinelString: the exact sentinel you embedded in the test's failure message.
   - expectedFailureSignature: a short stable substring of the failing run's stderr/stdout (e.g. exception class name + key suffix). If you observed it in step 5, set provenance.observedProbe.signatureObserved=true.
   - pipInstalls: every pip_install you ran that the deterministic Executor must repeat — each as { package: "<spec>", editable: <true|false> }.
   - requiresCredentials: env-var names whose absence in the sandbox would make the test silently skip or PASS for the wrong reason.
   - verbatimSnippetIncompatible: true if you had to pivot from the issue's verbatim snippet because of heavy-framework or environmental issues (the user prompt will state when this is forced).
   - approach: 1–3 sentences explaining how the test exercises the bug.
   - provenance.exerciseImports: the import statements you verified work in step 2 (e.g. ["from opentelemetry.trace import NonRecordingSpan"]).
   - provenance.preconditionsSatisfied: ids of dossier preconditions enforced by the test source.
   - provenance.observedProbe: populated from your most recent run_repro: { sentinelObserved, signatureObserved, exitCode, durationMs, stderrTail, stdoutTail }. stderrTail/stdoutTail capped to 2048 chars each — supply just the relevant tail.
   - provenance.proberAttempts: how many write_test+revise_test cycles you ran (an integer).
   - provenance.recordedAt: ISO timestamp.

7. END the loop with done after record_evidence returns recipe_recorded=true. Summary should name the suspect symbol the test exercised; changedFiles=[<candidateTestPath>]. The registry blocks done if a recipe was never recorded.

Hard rules:

- Do NOT call write_test before step 4. Big-bang authoring burns budget on incorrect imports before any sandbox feedback. Probe first. The registry will block write_test until at least one import probe has succeeded — the error message will show you the verified-state ledger.
- revise_test is allowed only after at least one run_repro call has produced output you can react to.
- Embed the sentinelString in your test's failure message so the Executor and Critic can verify reproducibility across runs.
- Before calling record_evidence you MUST have two consecutive run_repro results with non-zero exit AND the sentinel in stderr/stdout.
- Do NOT call done in the same model turn as record_evidence — wait for the result on the next turn so you can confirm recipe_recorded=true before terminating.
- You may not modify source files (apply_patch is not registered for you).
- Each turn make ONE stateful tool call (sandbox/write-test/meta). Reads may be batched.

Verbatim-snippet faithfulness:
- If the user prompt includes "Verbatim code snippets from the issue body", your first write_test SHOULD preserve those snippets' imports and call sequence as faithfully as the probe-verified state allows.
- You may revise toward a direct-call path AFTER observing run_repro fail for ENVIRONMENTAL reasons (missing credentials, unreachable model API, install-fatigue on a heavy framework). When you make that pivot, set reproRecipe.verbatimSnippetIncompatible=true.
- If the user prompt says "[FORCED] heavy-framework signal: verbatim path is incompatible", you may skip the verbatim-first attempt entirely and go straight to a direct-call exercise of the underlying primitive. Still set verbatimSnippetIncompatible=true on the recipe.

Preconditions enforcement:
- The user prompt's "PRECONDITIONS THE TEST MUST ENFORCE" block lists conditions the failing test must guarantee. Treat them as test contracts. The Critic will reject any test that does not enforce them.
- For preconditions with kind: config_absence and non-empty threats, your test MUST either (a) reset the threatened global before exercising the suspect symbol (e.g. via monkeypatch.setattr on the framework's internal globals), OR (b) bypass the global entirely by importing the suspect symbol and calling it directly with hand-constructed inputs. Either way, the chosen satisfactionMode's markers SHOULD appear in your test source — then list the precondition id in provenance.preconditionsSatisfied.

Abandon discipline:
- abandon is reserved for ENVIRONMENTAL dead-ends — never for "running out of budget" (the registry tracks turns; you have plenty as long as you make focused progress) and never when you already have a positive run_repro observation since your last write.
- Only call abandon after you have (a) authored at least one test, (b) run_repro at least twice, (c) exhausted read_symbol_context/grep_with_context (or grep/find_symbol/read_file) for any blocking symbol, AND (d) the abandon gate confirms zero positive observations since your last write. "Symbol not found in repo" alone is NEVER a sufficient reason — third-party symbols (opentelemetry's NonRecordingSpan, pytest's MonkeyPatch, etc.) live in their package, not in this repo, so try importing them directly first.
- The abandon gate will REJECT your abandon call if the verified-state ledger shows ≥1 POSITIVE run_repro observation (exit != 0 + sentinel) since your last test write. If you see that rejection, your next step is record_evidence (after one more run_repro if you only have 1 positive observation), not abandon.
- Install-fatigue: if pip_install fails 2+ times for the same heavy framework (smolagents, langchain, llama-index, autogen, crewai), treat that as environmental incompatibility. Stop installing — pivot to a direct-call path that imports the suspect symbol straight from its underlying package (e.g. opentelemetry.trace), then run_repro on the revised test before considering abandon.`;

export interface RunReproProberArgs {
  attemptId: string;
  dossier: DossierStore;
  /**
   * Read-only snapshot the Prober consults — preconditions, suspect symbols,
   * open questions. The Prober's record_evidence call writes a new snapshot
   * downstream of this one carrying the recipe.
   */
  dossierSnapshot: DossierSnapshot;
  issue: IssueHandle;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
  /** Repo-relative dirs the Prober can `pip install -e` to satisfy in-repo imports. */
  editableInstallCandidates?: string[];
  /** Verbatim fenced code blocks lifted from the issue body. */
  issueSnippets?: IssueCodeSnippet[];
  /** Issue body prose; used by the heavy-framework heuristic. */
  issueBody?: string;
}

export interface ReproProberResult extends AgentLoopResult {
  /** The dossier snapshot carrying the recipe, when record_evidence succeeded. */
  recipeSnapshot: DossierSnapshot | null;
  /** Normalized recipe lifted off `recipeSnapshot.body.reproRecipe`, when present. */
  recipe: ReproRecipe | null;
  /** True when the heavy-framework heuristic fired on the inputs. */
  verbatimIncompatibleHint: boolean;
  /** Raw transcript entries — orchestrator uses them for credentials detection + diagnostics. */
  transcript: Array<{ tool: string; result: unknown; ok: boolean }>;
  ranReproCount: number;
  lastReproExitCode: number | null;
  /** Compact one-line ledger summary (e.g. "installs_ok=4 ... run_repro_positive_since_write=0"). */
  verifiedSummary: string;
}

const TOOL_CALLS_EMPTY_TERMINATION = /finishReason=tool-calls;\s*finalText=\(empty\)/i;
const MAX_TOOL_CALLS_EMPTY_RECOVERY_PASSES = 2;

/**
 * The AI SDK can occasionally return `finishReason=tool-calls` with empty
 * final text even though no terminal tool call was observed. Treat that as a
 * transport/step-boundary artifact and continue the same registry state.
 */
export function shouldRecoverFromToolCallsEmptyTermination(loop: AgentLoopResult): boolean {
  return loop.terminated === 'finished' && TOOL_CALLS_EMPTY_TERMINATION.test(loop.reason ?? '');
}

export async function runReproProber(args: RunReproProberArgs): Promise<ReproProberResult> {
  const snapshotIdBeforeProber = args.dossierSnapshot.snapshotId;
  const registry = makeReproProberRegistry({
    ctx: {
      agentName: 'REPRO_PROBER',
      attemptId: args.attemptId,
      issueNumber: args.issue.number,
      dossierSnapshotId: snapshotIdBeforeProber,
      handles: {
        workspace: args.workspace,
        sandbox: args.sandbox,
        issue: args.issue,
        repo: args.repo,
        dossier: args.dossier,
      },
    },
  });

  const preconditions = args.dossierSnapshot.body.preconditions ?? [];
  const suspectSymbols = args.dossierSnapshot.body.suspectSymbols ?? [];

  const verbatimIncompatibleHint =
    (args.dossierSnapshot.body.reproTargets?.runtimeForbidden ?? []).length > 0 ||
    detectHeavyFrameworkSignal({
      snippets: args.issueSnippets,
      issueBody: args.issueBody,
      suspectSymbols,
    });

  const snippetBlock = renderIssueSnippetsBlock(args.issueSnippets ?? []);
  const editableBlock = renderEditableInstallsBlock(args.editableInstallCandidates ?? []);
  const preconditionsBlock = renderPreconditionsBlockForProber(preconditions);
  const suspectsBlock =
    suspectSymbols.length > 0
      ? `Dossier suspect symbols (probe these first):\n${suspectSymbols
          .map((s) => `- ${s.symbol} in ${s.file}`)
          .join('\n')}`
      : null;
  const forcedHintBlock = verbatimIncompatibleHint
    ? `[FORCED] heavy-framework signal: verbatim path is incompatible. Pivot to a direct-call exercise of the underlying primitive. Set reproRecipe.verbatimSnippetIncompatible=true.`
    : null;

  const hintsParts = [forcedHintBlock, suspectsBlock, snippetBlock, editableBlock, preconditionsBlock].filter(
    (s): s is string => Boolean(s),
  );
  const hintsSection = hintsParts.length > 0 ? `\n\n${hintsParts.join('\n\n')}` : '';

  const openQs = (args.dossierSnapshot.body.openQuestions ?? []).slice(0, 5);
  const openQsBlock =
    openQs.length > 0
      ? `\n\nOpen questions from the Analyst (treat as hints, not requirements):\n${openQs.map((q) => `- ${q}`).join('\n')}`
      : '';

  const userPrompt = `Issue #${args.issue.number}: ${args.issue.title}\n\nDossier summary: ${args.dossierSnapshot.body.summary}\nConfidence: ${args.dossierSnapshot.body.confidence}${hintsSection}${openQsBlock}\n\nProcedure: probe imports + exercise (steps 2-3), write_test (step 4), run_repro twice (step 5), record_evidence with reproRecipe (step 6), done (step 7). The registry blocks done until record_evidence has been called with recipe_recorded=true.`;

  const runLoop = (user: string) =>
    runAgentLoop({
      agent: 'REPRO_PROBER',
      registry,
      system: SYSTEM,
      user,
      attemptId: args.attemptId,
      issueNumber: args.issue.number,
      dossierSnapshotId: snapshotIdBeforeProber,
    });

  const loop = await runLoop(userPrompt);

  // If the model emitted plain text instead of calling done/abandon, retry
  // once with an explicit reminder. The registry preserves state.
  let finalLoop = loop;
  if (loop.terminated === 'finished' && registry.isTerminated() === null) {
    const reproCalls = registry.getTranscript().filter((e) => e.tool === 'run_repro').length;
    const wroteTest = registry
      .getTranscript()
      .some((e) => (e.tool === 'write_test' || e.tool === 'revise_test') && e.ok);
    const recipeRecorded = registry
      .getTranscript()
      .some((e) => e.tool === 'record_evidence' && e.ok && (e.result as any)?.recipe_recorded === true);
    const remind = `${userPrompt}\n\n[ORCHESTRATOR REMINDER] Your previous turn ended without calling done or abandon. State: wrote_test=${wroteTest}, run_repro_count=${reproCalls}, recipe_recorded=${recipeRecorded}. You MUST end the session with a tool call. If recipe_recorded=false, you also need to call record_evidence with a complete reproRecipe before done — the registry will reject done until that is recorded. Plain-text replies are discarded.`;
    finalLoop = await runLoop(remind);
  }

  for (let pass = 0; pass < MAX_TOOL_CALLS_EMPTY_RECOVERY_PASSES; pass++) {
    if (registry.isTerminated() !== null || !shouldRecoverFromToolCallsEmptyTermination(finalLoop)) {
      break;
    }
    const reproCalls = registry.getTranscript().filter((e) => e.tool === 'run_repro').length;
    const wroteTest = registry
      .getTranscript()
      .some((e) => (e.tool === 'write_test' || e.tool === 'revise_test') && e.ok);
    const recipeRecorded = registry
      .getTranscript()
      .some((e) => e.tool === 'record_evidence' && e.ok && (e.result as any)?.recipe_recorded === true);
    const recoverPrompt =
      `${userPrompt}\n\n` +
      `[ORCHESTRATOR RECOVERY] The previous attempt ended with "${finalLoop.reason ?? 'unknown'}" ` +
      `and no terminal tool call was observed. Continue from the current registry state. ` +
      `State: wrote_test=${wroteTest}, run_repro_count=${reproCalls}, recipe_recorded=${recipeRecorded}. ` +
      `Your NEXT response must be a tool call (no plain text). ` +
      `If recipe_recorded=true, call done. Otherwise continue the procedure and record_evidence before done.`;
    finalLoop = await runLoop(recoverPrompt);
  }

  const transcript = registry.getTranscript();
  const reproCalls = transcript.filter((e) => e.tool === 'run_repro');
  const last = reproCalls[reproCalls.length - 1];
  const lastExit =
    typeof (last?.result as any)?.exitCode === 'number' ? (last!.result as any).exitCode : null;
  const lastStderrTail =
    typeof (last?.result as any)?.stderr === 'string'
      ? String((last!.result as any).stderr).slice(-400).replace(/\s+/g, ' ').trim()
      : '';
  const lastStdoutTail =
    typeof (last?.result as any)?.stdout === 'string'
      ? String((last!.result as any).stdout).slice(-200).replace(/\s+/g, ' ').trim()
      : '';
  const toolCounts: Record<string, number> = {};
  for (const e of transcript) toolCounts[e.tool] = (toolCounts[e.tool] ?? 0) + 1;
  const toolsSummary = Object.entries(toolCounts)
    .map(([k, v]) => `${k}(${v})`)
    .join(' ');
  const verifiedState = deriveVerifiedState(transcript);
  const verifiedSummary = summariseVerifiedState(verifiedState);

  // Lift the recipe off the dossier. The Prober's record_evidence call
  // returned a snapshot_id in its result; we re-read that exact snapshot
  // rather than relying on dossier.latest() which can be clobbered if the
  // Prober records evidence again afterwards (e.g. without a recipe on the
  // second call). Search from the end for the most recent successful
  // record_evidence with recipe_recorded=true.
  let recipeSnapshot: DossierSnapshot | null = null;
  let recipe: ReproRecipe | null = null;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.tool !== 'record_evidence' || !e.ok) continue;
    const res = e.result as { snapshot_id?: string; recipe_recorded?: boolean } | null;
    if (!res || res.recipe_recorded !== true || typeof res.snapshot_id !== 'string') continue;
    const snap = args.dossier.get(res.snapshot_id);
    if (
      snap &&
      snap.snapshotId !== snapshotIdBeforeProber &&
      snap.body.attemptId === args.attemptId &&
      snap.body.reproRecipe
    ) {
      recipeSnapshot = snap;
      recipe = snap.body.reproRecipe;
      break;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[v2-prober] attempt=${args.attemptId} terminated=${finalLoop.terminated} turns=${finalLoop.turns}` +
      ` toolCalls=${transcript.length} runReproCount=${reproCalls.length} lastExit=${lastExit}` +
      ` recipeRecorded=${recipe !== null}` +
      ` verbatimIncompatibleHint=${verbatimIncompatibleHint}` +
      ` editableInstalls=${(args.editableInstallCandidates ?? []).join('|') || '(none)'}` +
      ` tools=${toolsSummary || '(none)'}` +
      ` verifiedState=[${verifiedSummary}]` +
      (finalLoop.reason ? ` reason=${JSON.stringify(finalLoop.reason).slice(0, 240)}` : '') +
      (lastStdoutTail ? ` lastStdoutTail=${JSON.stringify(lastStdoutTail)}` : '') +
      (lastStderrTail ? ` lastStderrTail=${JSON.stringify(lastStderrTail)}` : ''),
  );
  // eslint-disable-next-line no-console
  console.log(`[v2-prober-ledger] attempt=${args.attemptId}\n${renderVerifiedState(verifiedState)}`);

  return {
    ...finalLoop,
    recipeSnapshot,
    recipe,
    verbatimIncompatibleHint,
    transcript: transcript.map((e) => ({ tool: e.tool, result: e.result, ok: e.ok })),
    ranReproCount: reproCalls.length,
    lastReproExitCode: lastExit,
    verifiedSummary,
  };
}
