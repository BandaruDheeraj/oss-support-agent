/**
 * Repro Executor — tool-using loop that constructs and verifies a failing
 * test. Terminates via `done` only after observing:
 *   - run_repro exited != 0,
 *   - two consecutive prior run_repro calls produced the same stderr (sentinel match),
 *   - AST preflight passed on the candidate test (Python only, best-effort).
 */

import type { ReproPlan } from './planner';
import { runAgentLoop, type AgentLoopResult } from '../agent-loop';
import { makeReproExecutorRegistry } from '../tools';
import type { DossierStore, DossierSnapshot, Precondition } from '../analyst/dossier';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';
import {
  renderEditableInstallsBlock,
  renderIssueSnippetsBlock,
  type IssueCodeSnippet,
} from './repro-hints';

/**
 * Render dossier preconditions for the Executor's user prompt. This is the
 * "test contract" the executor must enforce: every listed precondition has
 * to be satisfied by the candidate test for the Critic to approve.
 *
 * The block also surfaces the Planner's verbatimSnippetIncompatible flag
 * so the executor knows whether the verbatim-first invariant
 * (commit 1ae5948) still applies.
 */
function renderPreconditionsBlockForExecutor(
  preconditions: Precondition[],
  verbatimIncompatible: boolean
): string | null {
  const lines: string[] = [];
  if (preconditions.length > 0) {
    lines.push(`PRECONDITIONS THE TEST MUST ENFORCE:`);
    for (const pc of preconditions) {
      lines.push(`- [${pc.id}] (${pc.kind}) ${pc.condition}`);
      if (pc.appliesTo) {
        lines.push(`    target: ${pc.appliesTo.file}${pc.appliesTo.symbol ? ` :: ${pc.appliesTo.symbol}` : ''}`);
      }
      if (pc.satisfactionModes && pc.satisfactionModes.length > 0) {
        lines.push(`    satisfaction modes (choose one and ensure its markers appear in the test):`);
        for (const mode of pc.satisfactionModes) {
          lines.push(`      • ${mode.description}${mode.markers.length > 0 ? ` — markers: ${mode.markers.map((m) => `\`${m}\``).join(', ')}` : ''}`);
        }
      }
      if (pc.threats && pc.threats.length > 0) {
        lines.push(`    threats to neutralize: ${pc.threats.join('; ')}`);
      }
    }
    lines.push('');
  }
  if (verbatimIncompatible) {
    lines.push(
      `VERBATIM SNIPPET INCOMPATIBLE = TRUE. The Planner determined a heavy 3rd-party framework (smolagents / langchain / llama-index / autogen / crewai / haystack / guidance / dspy) is in play and the verbatim reproduction path cannot run in this sandbox (no network, no creds, transitive-dep storm). Constraints:\n` +
        `  • DO NOT pip_install the heavy framework runtime itself (e.g. \`pip install smolagents\`). It will fail repeatedly and burn budget — the install-fatigue abandon gate will then terminate the run.\n` +
        `  • You MAY (and usually should) pip_install -e the in-repo instrumentation package surfaced in "EditableInstall candidates" — that gives you the suspect wrapper module without pulling the heavy runtime.\n` +
        `  • Your FIRST write_test must be a DIRECT-CALL test: import the suspect symbol straight from its underlying package (e.g. \`from opentelemetry.trace import NonRecordingSpan, INVALID_SPAN_CONTEXT\`) and the suspect wrapper from the editable-installed in-repo package, then construct the inputs by hand. Do NOT write a test that imports or instantiates the heavy framework.\n` +
        `  • Any precondition satisfactionMode markers above SHOULD appear in your test source.`
    );
  } else {
    lines.push(
      `Verbatim snippet incompatible = false. If a verbatim snippet is provided, your FIRST write_test must mirror it. Switch to a direct-call path only AFTER an observed run_repro fails for environmental (not behavioural) reasons.`
    );
  }
  return lines.length > 0 ? lines.join('\n') : null;
}


export interface RunReproExecutorArgs {
  attemptId: string;
  plan: ReproPlan;
  dossier: DossierStore;
  dossierSnapshot: DossierSnapshot;
  issue: IssueHandle;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
  /** Repo-relative dirs the executor can `pip install -e` to satisfy in-repo imports. */
  editableInstallCandidates?: string[];
  /** Verbatim fenced code blocks lifted from the issue body. */
  issueSnippets?: IssueCodeSnippet[];
}

export interface ReproExecutorResult extends AgentLoopResult {
  candidateTestPath: string;
  sentinelString: string;
  ranReproCount: number;
  lastReproExitCode: number | null;
  /** Raw transcript entries from the executor's tool registry — used by the orchestrator for credential detection. */
  transcript: Array<{ tool: string; result: unknown; ok: boolean }>;
}

const SYSTEM = `You are the Repro Executor for an OSS bug pipeline. Use tools to construct a failing test at the candidateTestPath in the plan and prove it fails reproducibly.

Rules:
- Use write_test / revise_test to author the test. Path must be the candidateTestPath unless you have a strong reason.
- Embed the sentinelString in your test's failure message (assertion message or print) so we can verify reproducibility.
- Call run_repro repeatedly. The test must FAIL (exit != 0). If it passes you have not reproduced the issue — investigate more, then revise_test.
- Before calling done you MUST have two consecutive run_repro results with non-zero exit AND containing the same sentinel-related text in stderr.
- Do NOT call done in the same model turn as write_test/revise_test/run_repro. Observe the result in the next turn, then emit done.
- You may not modify source files (apply_patch is not registered for you).
- Each turn make ONE stateful tool call (sandbox/write-test/meta). Reads may be batched.

Setup hints — verbatim-first invariant:
- If the user prompt lists "Verbatim code snippets from the issue body" AND the plan's verbatimSnippetIncompatible flag is FALSE (the default), your FIRST write_test call MUST encode the first preferred snippet almost verbatim — only wrap it with the sentinel assertion / output capture. Do NOT paraphrase before you have at least one observed run_repro result; subtle rewrites are how repros silently stop reproducing. This invariant comes from commit 1ae5948 and is non-negotiable when the flag is false.
- ONLY after observing run_repro on the verbatim test AND finding it fails for ENVIRONMENTAL reasons (missing credentials, unreachable model API, unavailable live service — NOT a behavioural mismatch) may you revise to a direct-call test that satisfies the SAME preconditions via one of the satisfactionModes listed in the dossier preconditions block.
- If the plan's verbatimSnippetIncompatible flag is TRUE, the Planner has determined the verbatim snippet cannot satisfy a named precondition (typically because it requires credentials/services the sandbox lacks). In that case you MAY skip the verbatim step and proceed directly to a satisfactionMode path — but your test MUST enforce every precondition's chosen mode and the markers from that mode SHOULD appear in your test source.

Preconditions enforcement:
- The user prompt's "PRECONDITIONS THE TEST MUST ENFORCE" block lists conditions the failing test must guarantee. Treat them as test contracts.
- When a precondition has kind: config_absence with non-empty threats, your test MUST either (a) reset the threatened global before exercising the suspect symbol (e.g. via monkeypatch.setattr on the framework's internal globals), OR (b) bypass the global entirely by importing the suspect symbol and calling it directly with hand-constructed inputs matching the satisfaction-mode markers.
- Do NOT initialize the very component the precondition requires to be absent. If the dossier flags "no OTel tracer provider configured" as a threat, do not call set_tracer_provider in the test, even via an import that triggers SDK initialization.

Module-install hints:
- If a run_repro fails with ModuleNotFoundError (or ImportError) on an in-repo import, do NOT try to "fix" the test — the package isn't editable-installed yet. Use pip_install with \`-e <candidate-dir>\` (one of the candidates listed in the user prompt under "Candidate editable-install dirs") matching the failing import's package, then re-run run_repro.
- pip_install accepts arbitrary requirement specs including \`-e <path>\` for editable installs.
- Install-fatigue escape hatch: if pip_install fails 2+ times for the SAME third-party heavy framework (e.g. smolagents, langchain, llama-index, autogen, crewai) imported by a verbatim snippet, treat that as an ENVIRONMENTAL failure equivalent to the missing-credentials case. Stop trying to install. Instead, revise_test to a direct-call satisfactionMode path that imports the suspect symbol straight from its underlying package (e.g. opentelemetry.trace) and constructs the inputs by hand. The verbatim-first invariant is satisfied — you DID try verbatim, it failed environmentally, fallback is justified.

Symbol discovery:
- Third-party symbols (classes/functions from pip / npm / cargo dependencies — e.g. opentelemetry's NonRecordingSpan, pytest's MonkeyPatch) do NOT live in this repo. Import them directly by package path. Do NOT try to locate their source via find_symbol/read_file.
- When the dossier mentions an in-repo symbol only by name (e.g. "called inside _StepWrapper"), use grep or find_symbol to locate it — it's almost always in the same file or directory as related cited symbols.
- Only call abandon after you have (a) authored at least one test, (b) run_repro at least twice, and (c) exhausted grep/find_symbol/read_file for any blocking symbol. "Symbol not found in repo" alone is NEVER a sufficient reason to abandon — try importing it from its package first.`;

export async function runReproExecutor(args: RunReproExecutorArgs): Promise<ReproExecutorResult> {
  const registry = makeReproExecutorRegistry({
    ctx: {
      agentName: 'REPRO_EXECUTOR',
      attemptId: args.attemptId,
      issueNumber: args.issue.number,
      dossierSnapshotId: args.dossierSnapshot.snapshotId,
      handles: {
        workspace: args.workspace,
        sandbox: args.sandbox,
        issue: args.issue,
        repo: args.repo,
        dossier: args.dossier,
      },
    },
  });

  const snippetBlock = renderIssueSnippetsBlock(args.issueSnippets ?? []);
  const editableBlock = renderEditableInstallsBlock(args.editableInstallCandidates ?? []);
  const preconditionsBlock = renderPreconditionsBlockForExecutor(
    args.dossierSnapshot.body.preconditions ?? [],
    args.plan.verbatimSnippetIncompatible
  );
  const hintsParts = [snippetBlock, editableBlock, preconditionsBlock].filter((s): s is string => Boolean(s));
  const hintsSection = hintsParts.length > 0 ? `\n\n${hintsParts.join('\n\n')}` : '';

  const userPrompt = `Plan approach: ${args.plan.approach}\nCandidate test path: ${args.plan.candidateTestPath}\nSentinel string: "${args.plan.sentinelString}"\nExpected failure signature: ${args.plan.expectedFailureSignature}\nVerbatim snippet incompatible: ${args.plan.verbatimSnippetIncompatible ? 'true (Planner determined snippet cannot satisfy a precondition — direct-call path permitted)' : 'false (verbatim-first invariant in force — first write_test must mirror the snippet)'}\nSteps:\n${args.plan.steps
    .map((s) => {
      const addr = s.preconditionsAddressed && s.preconditionsAddressed.length > 0
        ? ` [addresses: ${s.preconditionsAddressed.join(', ')}]`
        : '';
      return `- [${s.stepId}] ${s.intent} (hint: ${s.toolHint})${addr}`;
    })
    .join('\n')}\n\nIssue #${args.issue.number}: ${args.issue.title}${hintsSection}\n\nConstruct the failing test and prove it fails twice with matching output, then call done with summary and changedFiles=["${args.plan.candidateTestPath}"].`;

  const loop = await runAgentLoop({
    agent: 'REPRO_EXECUTOR',
    registry,
    system: SYSTEM,
    user: userPrompt,
    attemptId: args.attemptId,
    issueNumber: args.issue.number,
    dossierSnapshotId: args.dossierSnapshot.snapshotId,
  });

  // If the model emitted plain text instead of calling done/abandon, retry
  // once with an explicit reminder. The registry preserves state (turn counts,
  // budgets, terminated flag) so the gate still applies.
  let finalLoop = loop;
  if (loop.terminated === 'finished' && registry.isTerminated() === null) {
    const reproCalls = registry.getTranscript().filter((e) => e.tool === 'run_repro').length;
    const wroteTest = registry.getTranscript().some((e) => (e.tool === 'write_test' || e.tool === 'revise_test') && e.ok);
    const remind = `${userPrompt}\n\n[ORCHESTRATOR REMINDER] Your previous turn ended without calling done or abandon. State: wrote_test=${wroteTest}, run_repro_count=${reproCalls}. You MUST end the session with a tool call: done (after observing two consecutive failing run_repro results with the sentinel) or abandon (only if gate passes). Plain-text replies are discarded.`;
    finalLoop = await runAgentLoop({
      agent: 'REPRO_EXECUTOR',
      registry,
      system: SYSTEM,
      user: remind,
      attemptId: args.attemptId,
      issueNumber: args.issue.number,
      dossierSnapshotId: args.dossierSnapshot.snapshotId,
    });
  }

  const transcript = registry.getTranscript();
  const reproCalls = transcript.filter((e) => e.tool === 'run_repro');
  const last = reproCalls[reproCalls.length - 1];
  const lastExit = typeof (last?.result as any)?.exitCode === 'number' ? (last!.result as any).exitCode : null;

  // Diagnostic: surface the most recent run_repro stderr/stdout tail so
  // when the model halts with terminated=finished or max_turns we have
  // a clue what the test was actually doing on its last attempt.
  const lastStderrTail = typeof (last?.result as any)?.stderr === 'string'
    ? String((last!.result as any).stderr).slice(-400).replace(/\s+/g, ' ').trim()
    : '';
  const lastStdoutTail = typeof (last?.result as any)?.stdout === 'string'
    ? String((last!.result as any).stdout).slice(-200).replace(/\s+/g, ' ').trim()
    : '';
  const toolCounts: Record<string, number> = {};
  for (const e of transcript) toolCounts[e.tool] = (toolCounts[e.tool] ?? 0) + 1;
  const toolsSummary = Object.entries(toolCounts)
    .map(([k, v]) => `${k}(${v})`)
    .join(' ');
  // eslint-disable-next-line no-console
  console.log(
    `[v2-executor] attempt=${args.attemptId} terminated=${finalLoop.terminated} turns=${finalLoop.turns}` +
      ` toolCalls=${transcript.length} runReproCount=${reproCalls.length} lastExit=${lastExit}` +
      ` verbatimIncompatible=${args.plan.verbatimSnippetIncompatible}` +
      ` editableInstalls=${(args.editableInstallCandidates ?? []).join('|') || '(none)'}` +
      ` tools=${toolsSummary || '(none)'}` +
      (finalLoop.reason ? ` reason=${JSON.stringify(finalLoop.reason).slice(0, 240)}` : '') +
      (lastStdoutTail ? ` lastStdoutTail=${JSON.stringify(lastStdoutTail)}` : '') +
      (lastStderrTail ? ` lastStderrTail=${JSON.stringify(lastStderrTail)}` : '')
  );

  return {
    ...finalLoop,
    candidateTestPath: args.plan.candidateTestPath,
    sentinelString: args.plan.sentinelString,
    ranReproCount: reproCalls.length,
    lastReproExitCode: lastExit,
    transcript: transcript.map((e) => ({ tool: e.tool, result: e.result, ok: e.ok })),
  };
}

/**
 * Best-effort AST preflight for Python repro candidates. Rejects tests that
 * trivially fail (assert False, sys.exit, raise without try, etc.) without
 * actually exercising the codebase.
 */
export function reproAstPreflight(language: RepoHandle['language'], src: string, suspectFiles: string[], suspectSymbols: string[]): { ok: boolean; reason?: string } {
  if (language !== 'python') return { ok: true };
  const stripped = src
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
    .replace(/#[^\n]*\n/g, '\n');

  const trivial =
    /\bassert\s+False\b/.test(stripped) ||
    /\bsys\.exit\s*\(/.test(stripped) ||
    /^\s*raise\b/m.test(stripped.replace(/^\s*try:[\s\S]*?except[\s\S]*?raise\b/g, '')) ||
    /^\s*print\(['"][^'"]*sentinel[^'"]*['"]\)\s*;?\s*assert\s+False/i.test(stripped);
  if (trivial) {
    return { ok: false, reason: 'test trivially fails without exercising suspect code paths' };
  }

  const exercises =
    suspectFiles.some((f) => stripped.includes(f.replace(/[\\/]/g, '.').replace(/\.py$/, ''))) ||
    suspectSymbols.some((s) => new RegExp(`\\b${s}\\b`).test(stripped));
  if (!exercises) {
    return { ok: false, reason: 'test does not reference any suspect file or symbol from the dossier' };
  }
  return { ok: true };
}
