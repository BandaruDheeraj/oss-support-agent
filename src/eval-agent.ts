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
} from './eval-agent-types';
import { SandboxArtifact } from './sandbox-types';
import { ConfirmedIssue } from './fix-agent-types';

/**
 * Evaluate sandbox results and produce a pass/fail verdict.
 * In Phase 1, regression_detected is always false.
 */
export function evaluateSandboxResults(
  sandboxArtifact: SandboxArtifact,
  confirmedIssues: ConfirmedIssue[],
  fixSummary: string
): EvalAgentResult {
  const { result } = sandboxArtifact;

  // Overall pass: sandbox completed with exit code 0
  const overallPass = result.completed && result.exitCode === 0 && !result.timedOut;

  // Per-issue verdicts: in Phase 1, all issues share the same verdict
  const perIssueVerdicts: IssueVerdict[] = confirmedIssues.map((issue) => ({
    issueNumber: issue.number,
    passed: overallPass,
    reason: overallPass
      ? `Tests passed for fix addressing issue #${issue.number}`
      : buildFailureReason(result.exitCode, result.timedOut, result.stderr),
  }));

  // Retry context: structured summary of what failed (for retry loop)
  const retryContext = overallPass
    ? null
    : buildRetryContext(sandboxArtifact);

  // PR summary
  const prSummary = overallPass
    ? `All tests passed. Fix addresses: ${confirmedIssues.map((i) => `#${i.number}`).join(', ')}. ${fixSummary}`
    : `Tests failed. ${buildFailureReason(result.exitCode, result.timedOut, result.stderr)}`;

  return {
    overallPass,
    perIssueVerdicts,
    regressionDetected: false, // Phase 1: always false
    retryContext,
    prSummary,
  };
}

/**
 * Build a failure reason string from sandbox results.
 */
function buildFailureReason(
  exitCode: number | null,
  timedOut: boolean,
  stderr: string
): string {
  if (timedOut) {
    return 'Sandbox run timed out before completion';
  }
  if (exitCode === null) {
    return 'Sandbox run did not complete (no exit code)';
  }
  const stderrSnippet = stderr.trim().length > 0
    ? `: ${stderr.trim().slice(0, 200)}`
    : '';
  return `Tests failed with exit code ${exitCode}${stderrSnippet}`;
}

/**
 * Build structured retry context from sandbox results.
 */
function buildRetryContext(artifact: SandboxArtifact): string {
  const { result, config } = artifact;
  const lines: string[] = [
    `Test command: ${config.testCommand}`,
    `Exit code: ${result.exitCode ?? 'N/A'}`,
    `Timed out: ${result.timedOut}`,
    `Duration: ${result.durationSeconds}s`,
  ];
  if (result.stderr.trim()) {
    lines.push(`Stderr (first 500 chars): ${result.stderr.trim().slice(0, 500)}`);
  }
  if (result.stdout.trim()) {
    lines.push(`Stdout (last 500 chars): ${result.stdout.trim().slice(-500)}`);
  }
  return lines.join('\n');
}

/**
 * Build PR details from eval result and input context.
 */
export function buildPRDetails(
  input: EvalAgentInput,
  evalResult: EvalAgentResult
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

  // Labels: agent-fix plus one per issue type
  const labels = ['agent-fix', ...new Set(input.issueTypes)];

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
  const evalResult = evaluateSandboxResults(
    input.sandboxArtifact,
    input.confirmedIssues,
    input.fixSummary
  );

  // Step 2: Route based on result
  const routing = routeEvalResult(evalResult, input.retryCount, input.maxRetries);

  // Step 3: On pass, open PR
  if (routing.action === 'open_pr') {
    try {
      const prDetails = buildPRDetails(input, evalResult);
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
