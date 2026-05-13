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
6. Terminate by calling record_evidence with a complete summary. record_evidence is the ONLY way to commit your findings.

Do not call write_test, apply_patch, run_repro, or any sandbox tool — they are not registered for you.
Do not include the issue body verbatim in evidence.detail; quote only the relevant excerpts.
Confidence rules: 'high' requires a specific file:line cause hypothesis; 'medium' requires at least one suspect symbol; 'low' otherwise.`;

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

  return {
    snapshot: args.dossier.latest(),
    terminated: result.terminated,
    reason: result.reason,
    toolCalls: result.toolCalls,
    transcriptSummary: result.transcriptSummary,
  };
}
