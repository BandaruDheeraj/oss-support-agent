/**
 * Eval agent for the OSS Autonomous Fix Loop (US-009).
 *
 * Produces a pass/fail verdict from sandbox outputs and,
 * on pass, opens a PR from the fork to upstream.
 * On fail, routes to retry (up to max_retries) or FAILED.
 */

import {
  EvalAgentInput,
  EvalAgentResult,
  EvalRouting,
  PRDetails,
  PRClient,
  IssueVerdict,
  EvalAgentError,
} from './eval-types';
import { SandboxArtifact } from '../sandbox-types';
import { ConfirmedIssue } from './fix-types';
import { BaseRepoAdapter, type EvalResult, type PRMetadata, type RepoAdapter } from '../adapter.interface';

/**
 * Evaluate sandbox results and produce a pass/fail verdict.
 * In Phase 1, regression_detected is always false.
 */
export async function evaluateSandboxResults(
  sandboxArtifact: SandboxArtifact,
  confirmedIssues: ConfirmedIssue[],
  fixSummary: string,
  adapter: RepoAdapter = new BaseRepoAdapter()
): Promise<EvalAgentResult> {
  const adapterEval = await adapter.runCustomEval(sandboxArtifact.commands);
  return buildEvalAgentResult(adapterEval, confirmedIssues, fixSummary);
}

function buildEvalAgentResult(
  adapterEval: EvalResult,
  confirmedIssues: ConfirmedIssue[],
  fixSummary: string
): EvalAgentResult {
  const perIssueVerdicts: IssueVerdict[] = confirmedIssues.map((issue) => ({
    issueNumber: issue.number,
    passed: adapterEval.passed,
    reason: adapterEval.passed
      ? `Tests passed for fix addressing issue #${issue.number}`
      : adapterEval.summary,
  }));

  return {
    overallPass: adapterEval.passed,
    perIssueVerdicts,
    regressionDetected: false,
    retryContext: adapterEval.passed ? null : adapterEval.retryContext.join('\n'),
    prSummary: adapterEval.passed
      ? `All tests passed. Fix addresses: ${confirmedIssues.map((i) => `#${i.number}`).join(', ')}. ${fixSummary}`
      : `Tests failed. ${adapterEval.summary}`,
  };
}

/**
 * Build PR details from eval result and input context.
 */
export function buildPRDetails(
  input: EvalAgentInput,
  evalResult: EvalAgentResult,
  metadata: PRMetadata = { extraLabels: [], extraBodySections: [] }
): PRDetails {
  const title = `[agent-fix] ${input.fixSummary}`;

  const bodyParts: string[] = [
    '## Design Summary',
    '',
    input.designSummary,
    '',
    '## Issues Addressed',
    '',
    ...evalResult.perIssueVerdicts.map((v) =>
      `- #${v.issueNumber}: ${v.passed ? '✅ Passed' : '❌ Failed'} — ${v.reason}`
    ),
    '',
    '## Sandbox Run',
    '',
    `- **Result**: ${evalResult.overallPass ? 'All tests passed ✅' : 'Tests failed ❌'}`,
    `- **Duration**: ${input.sandboxArtifact.result.durationSeconds}s`,
    `- **Logs**: [Workflow Run](${input.sandboxArtifact.result.workflowRunUrl})`,
    '',
  ];

  if (input.retryCount > 0) {
    bodyParts.push(`## Retry Information`, '', `This fix succeeded after ${input.retryCount} retry attempt(s).`, '');
  }

  bodyParts.push(...metadata.extraBodySections.flatMap((section) => [section, '']));

  // Labels: agent-fix plus one per issue type plus adapter-provided labels
  const labels = ['agent-fix', ...new Set([...input.issueTypes, ...metadata.extraLabels])];

  // Head: fork_org:branch_name format for cross-fork PRs
  const [forkOrg] = input.forkFullName.split('/');
  const head = `${forkOrg}:${input.branchName}`;

  return {
    title,
    body: bodyParts.join('\n'),
    labels,
    head,
    base: input.upstreamDefaultBranch,
  };
}

/**
 * Route the eval result: open PR, retry, or fail.
 */
export function routeEvalResult(
  evalResult: EvalAgentResult,
  retryCount: number,
  maxRetries: number
): EvalRouting {
  if (evalResult.overallPass) {
    // Will be resolved to 'open_pr' with URL after PR creation
    return { action: 'open_pr', prUrl: '' };
  }

  if (retryCount < maxRetries) {
    return {
      action: 'retry',
      retryContext: evalResult.retryContext || 'No retry context available',
    };
  }

  return {
    action: 'failed',
    reason: `Max retries (${maxRetries}) exceeded. Last failure: ${evalResult.retryContext || 'unknown'}`,
  };
}

/**
 * Run the full eval agent pipeline:
 * 1. Evaluate sandbox results
 * 2. Route based on pass/fail and retry count
 * 3. On pass, open a PR from fork to upstream
 */
export async function runEvalAgent(
  input: EvalAgentInput,
  prClient: PRClient
): Promise<{ result: EvalAgentResult; routing: EvalRouting }> {
  // Step 1: Evaluate sandbox results
  const adapter = input.adapter ?? new BaseRepoAdapter();
  const evalResult = await evaluateSandboxResults(
    input.sandboxArtifact,
    input.confirmedIssues,
    input.fixSummary,
    adapter
  );

  // Step 2: Route based on result
  const routing = routeEvalResult(evalResult, input.retryCount, input.maxRetries);

  // Step 3: On pass, open PR
  if (routing.action === 'open_pr') {
    try {
      const metadata = await adapter.getPRMetadata(
        input.confirmedIssues.map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? '',
          labels: issue.labels,
        }))
      );
      const prDetails = buildPRDetails(input, evalResult, metadata);
      const { url } = await prClient.createPullRequest(input.upstreamRepo, prDetails);

      // Add labels (non-fatal if this fails)
      try {
        const prNumber = parseInt(url.split('/').pop() || '0', 10);
        if (prNumber > 0) {
          await prClient.addLabels(input.upstreamRepo, prNumber, prDetails.labels);
        }
      } catch {
        // Label addition is non-fatal
      }

      routing.prUrl = url;
    } catch (error) {
      throw new EvalAgentError(
        `Failed to create PR: ${error instanceof Error ? error.message : String(error)}`,
        'pr_creation'
      );
    }
  }

  return { result: evalResult, routing };
}
