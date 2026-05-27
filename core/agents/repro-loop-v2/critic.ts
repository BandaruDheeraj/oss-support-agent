/**
 * Repro Critic — mandatory second-opinion loop. Re-runs the candidate test
 * independently and checks structural guards before emitting a verdict.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '../../llm/v2/client';
import { withAgentSpan } from '../../observability/spans';
import { makeReproCriticRegistry } from '../tools';
import { runAgentLoop } from '../agent-loop';
import type { ReproPlan } from './planner';
import type { DossierStore, DossierSnapshot, Precondition } from '../analyst/dossier';
import type { IssueHandle, RepoHandle, SandboxHandle, WorkspaceReader, WorkspaceWriter } from '../tools/handles';

export const ReproVerdictSchema = z.object({
  verdict: z.enum(['approve', 'reject', 'revise']),
  reason: z.string().min(5),
  reproducedReliably: z.boolean(),
  sentinelMatched: z.boolean(),
  suggestedRevision: z.string().optional(),
});
export type ReproVerdict = z.infer<typeof ReproVerdictSchema>;

const INVESTIGATE_SYSTEM = `You are the Repro Critic. Verify that the candidate test reliably reproduces the upstream issue. Re-run it twice independently via run_repro, read its source via read_file, and check the dossier. Use only read + sandbox + note tools.

Pay particular attention to dossier preconditions: for each one, verify which (if any) satisfactionMode is in force in the candidate test by checking for the mode's markers. Also verify the failure stderr references at least one suspect symbol from the dossier — otherwise the test may be failing for the wrong reason.`;

const JUDGE_SYSTEM = `You are the Repro Critic judge. Given the investigation transcript, decide whether to approve, reject, or revise the repro test. Return JSON matching the schema.

approve: only if (a) you ran run_repro at least twice yourself, (b) both runs exited non-zero, (c) stderr contained the sentinel both times, (d) every dossier precondition is enforced by at least one satisfactionMode (markers visible in test source), AND (e) stderr references at least one suspect symbol — the failure must come from the suspect code path, not an unrelated import/setup error.
reject: the test does not reproduce, or it always passes, or it errors before exercising suspect code, or it ignores a dossier precondition.
revise: the test almost reproduces but needs a small change (suggest one).`;

export interface RunReproCriticArgs {
  attemptId: string;
  plan: ReproPlan;
  dossier: DossierStore;
  dossierSnapshot: DossierSnapshot;
  issue: IssueHandle;
  repo: RepoHandle;
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
}

/**
 * Per-precondition structural enforcement result. Computed by scanning
 * the candidate test source for any of a precondition's satisfactionMode
 * markers. Passed into the judge prompt so the LLM has a redundant
 * signal beyond the investigation transcript summary.
 */
export interface PreconditionEnforcement {
  id: string;
  condition: string;
  kind: Precondition['kind'];
  enforcedMode: string | null;
  matchedMarkers: string[];
}

export function evaluatePreconditionEnforcement(
  candidateTestSource: string,
  preconditions: Precondition[]
): PreconditionEnforcement[] {
  return preconditions.map((pc) => {
    let enforcedMode: string | null = null;
    let matchedMarkers: string[] = [];
    for (const mode of pc.satisfactionModes ?? []) {
      const hits = mode.markers.filter((m) => m.length > 0 && candidateTestSource.includes(m));
      if (hits.length > 0) {
        enforcedMode = mode.description;
        matchedMarkers = hits;
        break;
      }
    }
    return { id: pc.id, condition: pc.condition, kind: pc.kind, enforcedMode, matchedMarkers };
  });
}

/**
 * Returns true if at least one suspect symbol's name appears in the
 * combined stderr/stdout of any run_repro entry. A test can satisfy
 * sentinel + nonzero exit while still failing for an unrelated setup
 * error; this guards against that false-positive.
 */
export function failureExercisesSuspectPath(
  reproRuns: Array<{ result: unknown }>,
  suspectSymbols: Array<{ symbol: string }>
): boolean {
  if (suspectSymbols.length === 0) return true; // nothing to check against
  const allOutput = reproRuns
    .map((r) => `${(r.result as any)?.stderr ?? ''}\n${(r.result as any)?.stdout ?? ''}`)
    .join('\n');
  return suspectSymbols.some((s) => s.symbol.length > 0 && allOutput.includes(s.symbol));
}

/**
 * Returns true if AT LEAST TWO passing run_repro entries contain the
 * expected failure signature in their combined stderr+stdout. Vacuously
 * true if the plan didn't specify a signature (legacy plans).
 *
 * Sentinel proves the test failed; this proves it failed for the right
 * reason. Mirrors the semantics of the sentinel "two hits" reliability
 * check rather than requiring EVERY run — the Critic may do diagnostic
 * runs that legitimately don't yet contain the signature.
 *
 * See Commit C of the iterative-build executor plan.
 */
export function expectedSignatureMatched(
  reproRuns: Array<{ result: unknown }>,
  expectedSignature: string
): boolean {
  const sig = expectedSignature.trim();
  if (sig.length === 0) return true;
  let hits = 0;
  for (const r of reproRuns) {
    const out = `${(r.result as any)?.stderr ?? ''}\n${(r.result as any)?.stdout ?? ''}`;
    if (out.includes(sig)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

export async function runReproCritic(args: RunReproCriticArgs): Promise<{ verdict: ReproVerdict; transcriptSummary: string }> {
  const registry = makeReproCriticRegistry({
    ctx: {
      agentName: 'REPRO_CRITIC',
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

  const preconditions = args.dossierSnapshot.body.preconditions ?? [];
  const suspectSymbols = args.dossierSnapshot.body.suspectSymbols ?? [];

  // Surface preconditions to the investigation loop so the Critic knows
  // what contracts to verify on the candidate test source.
  const preconditionsForPrompt =
    preconditions.length > 0
      ? `\n\nDossier preconditions (verify each is enforced by the candidate test):\n${preconditions
          .map(
            (pc) =>
              `- [${pc.id}] (${pc.kind}) ${pc.condition}${
                pc.satisfactionModes.length > 0
                  ? `\n    modes: ${pc.satisfactionModes
                      .map((m) => `${m.description}${m.markers.length > 0 ? ` [markers: ${m.markers.join(', ')}]` : ''}`)
                      .join(' | ')}`
                  : ''
              }`
          )
          .join('\n')}`
      : '';
  const suspectsForPrompt =
    suspectSymbols.length > 0
      ? `\n\nSuspect symbols (failure stderr should reference at least one):\n${suspectSymbols
          .map((s) => `- ${s.symbol} in ${s.file}`)
          .join('\n')}`
      : '';

  const userPrompt = `Repro candidate at: ${args.plan.candidateTestPath}\nSentinel: "${args.plan.sentinelString}"\nExpected failure signature: ${args.plan.expectedFailureSignature}${preconditionsForPrompt}${suspectsForPrompt}\n\nInvestigate: read the candidate test, run run_repro twice, then summarise your findings with note() calls. After that I will ask you for a verdict.`;

  const investigation = await runAgentLoop({
    agent: 'REPRO_CRITIC',
    registry,
    system: INVESTIGATE_SYSTEM,
    user: userPrompt,
    attemptId: args.attemptId,
    issueNumber: args.issue.number,
    dossierSnapshotId: args.dossierSnapshot.snapshotId,
  });

  // Structural pre-check: we need >=2 run_repro calls with exit != 0
  const transcript = registry.getTranscript();
  const reproRuns = transcript.filter((e) => e.tool === 'run_repro' && e.ok);
  const reliable = reproRuns.length >= 2 && reproRuns.every((r) => (r.result as any)?.exitCode !== 0);
  const sentinelHits = reproRuns.filter((r) => {
    const out = `${(r.result as any)?.stderr ?? ''}\n${(r.result as any)?.stdout ?? ''}`;
    return out.includes(args.plan.sentinelString);
  });
  const sentinelOk = sentinelHits.length >= 2;

  // New: precondition enforcement check. Read the candidate test source
  // and OR-scan each precondition's satisfactionMode markers. Pass the
  // results directly into the judge prompt so the LLM doesn't have to
  // recover them from the investigation summary string.
  const candidateSource = (await args.workspace.readFile(args.plan.candidateTestPath)) ?? '';
  const enforcement = evaluatePreconditionEnforcement(candidateSource, preconditions);
  const unenforcedPreconditions = enforcement.filter((e) => e.enforcedMode === null);
  // A precondition has at least one satisfactionMode AND none matched → real gap.
  // If a precondition has zero satisfactionModes (Analyst declined to
  // enumerate), we don't count it as a structural failure here — the LLM
  // judge still sees it in the prompt and decides.
  const realUnenforced = unenforcedPreconditions.filter((e) => {
    const pc = preconditions.find((p) => p.id === e.id);
    return pc && pc.satisfactionModes.length > 0;
  });

  // New: failure must exercise suspect code path.
  const suspectPathHit = failureExercisesSuspectPath(reproRuns, suspectSymbols);

  // Commit C: expectedFailureSignature must appear in BOTH passing
  // run_repro outputs. Sentinel proves the test failed; signature proves it
  // failed for the right reason. Vacuously true if the plan didn't specify
  // a signature, so legacy plans don't regress.
  const expectedSig = (args.plan.expectedFailureSignature ?? '').trim();
  const expectedSigOk = expectedSignatureMatched(reproRuns, expectedSig);

  const verdict = await withAgentSpan(
    'REPRO_CRITIC',
    { attempt_id: args.attemptId, issue_number: args.issue.number, dossier_snapshot_id: args.dossierSnapshot.snapshotId, 'critic.phase': 'judge' },
    async () => {
      const enforcementBlock =
        enforcement.length > 0
          ? `\n\nPer-precondition enforcement (computed structurally from candidate test source):\n${enforcement
              .map(
                (e) =>
                  `- [${e.id}] (${e.kind}) ${e.condition} → ${
                    e.enforcedMode
                      ? `ENFORCED via "${e.enforcedMode}" (markers matched: ${e.matchedMarkers.join(', ')})`
                      : 'NOT ENFORCED (no satisfactionMode markers found in test source)'
                  }`
              )
              .join('\n')}`
          : '';
      const candidateSourceBlock = candidateSource
        ? `\n\nCandidate test source (first 2000 chars):\n\`\`\`\n${candidateSource.slice(0, 2000)}\n\`\`\``
        : '';
      const suspectBlock =
        suspectSymbols.length > 0
          ? `\nFailure path check: stderr references suspect symbol = ${suspectPathHit}`
          : '';
      const signatureBlock =
        expectedSig.length > 0
          ? `\nExpected-signature check: both run_repro outputs contain "${expectedSig}" = ${expectedSigOk}`
          : '';
      const judged = await generateObject({
        model: getModel('REPRO_CRITIC'),
        schema: ReproVerdictSchema,
        system: JUDGE_SYSTEM,
        prompt: `Repro run summaries:\n${reproRuns
          .map(
            (r) =>
              `- exit=${(r.result as any)?.exitCode}, stderr_head="${String((r.result as any)?.stderr ?? '').slice(0, 200)}"`
          )
          .join('\n')}\n\nInvestigation tool summary: ${investigation.transcriptSummary}\n\nPlan expected signature: ${args.plan.expectedFailureSignature}\nSentinel: ${args.plan.sentinelString}\n\nStructural pre-check: reliable=${reliable}, sentinelMatchedTwice=${sentinelOk}${suspectBlock}${signatureBlock}${enforcementBlock}${candidateSourceBlock}`,
        experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
      });
      return judged.object;
    }
  );

  // Hard override: judge cannot approve if any structural check fails.
  // (1) classic: reliable + sentinel
  // (2) new: at least one suspect symbol mentioned in stderr (unless none declared)
  // (3) new: every precondition with declared satisfactionModes is enforced
  // (4) Commit C: expectedFailureSignature must appear in both passing runs
  if (verdict.verdict === 'approve') {
    const failures: string[] = [];
    if (!reliable) failures.push('not reliably failing');
    if (!sentinelOk) failures.push('sentinel missing');
    if (!suspectPathHit) failures.push('failure did not exercise suspect code path');
    if (!expectedSigOk)
      failures.push(`expectedFailureSignature "${expectedSig}" missing from one or both run_repro outputs`);
    if (realUnenforced.length > 0)
      failures.push(`preconditions unenforced: ${realUnenforced.map((e) => e.id).join(', ')}`);
    if (failures.length > 0) {
      return {
        verdict: {
          verdict: 'reject',
          reason: `Critic override: structural checks failed (${failures.join('; ')}).`,
          reproducedReliably: reliable,
          sentinelMatched: sentinelOk,
        },
        transcriptSummary: investigation.transcriptSummary,
      };
    }
  }

  return {
    verdict: { ...verdict, reproducedReliably: reliable, sentinelMatched: sentinelOk },
    transcriptSummary: investigation.transcriptSummary,
  };
}
