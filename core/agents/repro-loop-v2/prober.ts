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
   If an import fails: pip_install with \`-e <candidate-dir>\` from "Candidate editable-install dirs" when the failing module looks like an in-repo package, or grep / find_symbol to locate the correct import path. Repeat until you have a verified import block.

3. PROBE the exercise. Use run_python to actually call the suspect symbols with hand-constructed inputs. Confirm the call executes (whether or not it raises). If it raises the expected failure signature, you already have a working repro skeleton — copy it into the test.

4. COMMIT the test source. ONE write_test call. The test contains: your verified imports, your verified exercise call, and \`assert False, "<sentinel>"\` (or equivalent) at the end so run_repro reports a failure containing the sentinel.

5. VERIFY twice. run_repro twice. Require exit != 0 AND the sentinel in stderr/stdout AND (ideally) the dossier's expectedFailureSignature in stderr/stdout. If the test PASSED (exit == 0), the exercise didn't trigger the bug — return to step 3, probe more, then revise_test.

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
- Only call abandon after you have (a) authored at least one test, (b) run_repro at least twice, and (c) exhausted grep/find_symbol/read_file for any blocking symbol. "Symbol not found in repo" alone is NEVER a sufficient reason — third-party symbols (opentelemetry's NonRecordingSpan, pytest's MonkeyPatch, etc.) live in their package, not in this repo, so try importing them directly first.
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

  const verbatimIncompatibleHint = detectHeavyFrameworkSignal({
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

  const loop = await runAgentLoop({
    agent: 'REPRO_PROBER',
    registry,
    system: SYSTEM,
    user: userPrompt,
    attemptId: args.attemptId,
    issueNumber: args.issue.number,
    dossierSnapshotId: snapshotIdBeforeProber,
  });

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
    finalLoop = await runAgentLoop({
      agent: 'REPRO_PROBER',
      registry,
      system: SYSTEM,
      user: remind,
      attemptId: args.attemptId,
      issueNumber: args.issue.number,
      dossierSnapshotId: snapshotIdBeforeProber,
    });
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
  };
}
