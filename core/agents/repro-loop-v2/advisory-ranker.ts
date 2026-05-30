import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '../../llm/v2/client';
import { withAgentSpan } from '../../observability/spans';
import type { ReproRecipe } from '../analyst/dossier';
import type { IssueHandle } from '../tools/handles';
import type { DeterministicReproOracleResult } from './deterministic-oracle';

const AdvisoryReproRankSchema = z.object({
  selectedCandidateId: z.string().min(1),
  reason: z.string().min(5),
});

type AdvisoryReproRank = z.infer<typeof AdvisoryReproRankSchema>;

export interface ReproRankCandidate {
  candidateId: string;
  source: 'builder' | 'prober';
  sampleIndex: number;
  recipe: ReproRecipe;
  oracle: DeterministicReproOracleResult;
}

export interface ReproAdvisoryRankResult {
  selectedCandidateId: string;
  reason: string;
  transcript: string;
}

function fallbackRank(candidates: ReproRankCandidate[], reason: string): ReproAdvisoryRankResult {
  return {
    selectedCandidateId: candidates[0]!.candidateId,
    reason,
    transcript: reason,
  };
}

function renderCandidateBullet(candidate: ReproRankCandidate): string {
  const installs =
    candidate.recipe.pipInstalls.length > 0
      ? candidate.recipe.pipInstalls
          .map((step) => (step.editable ? `-e ${step.package}` : step.package))
          .join(' | ')
      : '(none)';
  const approach = candidate.recipe.approach ?? '(unspecified)';
  return [
    `- ${candidate.candidateId} (${candidate.source} #${candidate.sampleIndex})`,
    `  test: ${candidate.recipe.candidateTestPath}`,
    `  approach: ${approach}`,
    `  pip_install: ${installs}`,
    `  suspect_assertions: ${candidate.oracle.suspectPathAssertionResult.passed}`,
    `  precondition_assertions: ${candidate.oracle.preconditionAssertionResult.passed}`,
  ].join('\n');
}

export async function rankValidReproCandidates(args: {
  attemptId: string;
  issue: IssueHandle;
  candidates: ReproRankCandidate[];
}): Promise<ReproAdvisoryRankResult> {
  const candidates = args.candidates;
  if (candidates.length === 0) {
    throw new Error('rankValidReproCandidates requires at least one candidate');
  }
  if (candidates.length === 1) {
    return fallbackRank(candidates, 'single valid candidate');
  }

  const model = getModel('REPRO_CRITIC');
  const modelId = (model as { modelId?: string }).modelId ?? 'unknown';
  const candidateList = candidates.map((candidate) => renderCandidateBullet(candidate)).join('\n');
  const allowedIds = candidates.map((candidate) => candidate.candidateId).join(', ');
  const prompt =
    `Issue #${args.issue.number}: ${args.issue.title}\n\n` +
    `Choose the cleanest already-valid repro candidate. You MUST choose exactly one id from this allow-list:\n` +
    `${allowedIds}\n\n` +
    `Candidates:\n${candidateList}\n\n` +
    `Ranking policy:\n` +
    `1) Prefer the narrowest test that still reproduces the issue.\n` +
    `2) Prefer fewer and lighter pip_install requirements.\n` +
    `3) Prefer clear, deterministic setup over fragile scaffolding.\n` +
    `Do not reject all candidates and do not request revisions. Pick one candidate id.`;

  try {
    const decision = await withAgentSpan(
      'REPRO_CRITIC',
      {
        attempt_id: args.attemptId,
        issue_number: args.issue.number,
        'repro.ranker.candidate_count': candidates.length,
        'llm.model_name': modelId,
      },
      async () =>
        generateObject({
          model,
          schema: AdvisoryReproRankSchema,
          prompt,
          experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
        })
    );
    const verdict: AdvisoryReproRank = decision.object;
    const selected = candidates.find((candidate) => candidate.candidateId === verdict.selectedCandidateId);
    if (!selected) {
      return fallbackRank(
        candidates,
        `ranker returned unknown candidate id "${verdict.selectedCandidateId}", defaulting to first valid candidate`
      );
    }
    return {
      selectedCandidateId: selected.candidateId,
      reason: verdict.reason,
      transcript: `selected=${selected.candidateId}; reason=${verdict.reason}`,
    };
  } catch (error) {
    return fallbackRank(candidates, `ranker unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
