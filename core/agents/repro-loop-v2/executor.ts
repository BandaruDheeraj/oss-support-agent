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
import type { DossierStore, DossierSnapshot } from '../analyst/dossier';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';

export interface RunReproExecutorArgs {
  attemptId: string;
  plan: ReproPlan;
  dossier: DossierStore;
  dossierSnapshot: DossierSnapshot;
  issue: IssueHandle;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
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

  const userPrompt = `Plan approach: ${args.plan.approach}\nCandidate test path: ${args.plan.candidateTestPath}\nSentinel string: "${args.plan.sentinelString}"\nExpected failure signature: ${args.plan.expectedFailureSignature}\nSteps:\n${args.plan.steps.map((s) => `- [${s.stepId}] ${s.intent} (hint: ${s.toolHint})`).join('\n')}\n\nIssue #${args.issue.number}: ${args.issue.title}\n\nConstruct the failing test and prove it fails twice with matching output, then call done with summary and changedFiles=["${args.plan.candidateTestPath}"].`;

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
