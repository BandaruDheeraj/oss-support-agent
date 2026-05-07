/**
 * Retry loop with eval context injection (US-017).
 *
 * Feeds eval retry_context back into the fix or build agent on failure
 * so the agent can correct its own mistakes up to max_retries.
 * After max_retries exceeded: emails the user, labels the upstream issue
 * agent-failed, preserves the fork branch, and transitions to FAILED.
 */

import {
  RetryAttempt,
  RetryHistory,
  RetryLoopConfig,
  RetryDispatchInput,
  RetryLoopResult,
  FailureReport,
  IssueLabeler,
  FailureNotifier,
  RetryStateStore,
  RetryLoopError,
  AGENT_FAILED_LABEL,
  FAILURE_EMAIL_SUBJECT_PREFIX,
} from './retry-loop-types';

/**
 * Build combined retry context from all previous attempts.
 * Provides a structured summary of what has been tried and failed.
 */
export function buildCombinedRetryContext(attempts: RetryAttempt[]): string {
  if (attempts.length === 0) {
    return '';
  }

  const lines: string[] = [
    `## Previous Retry Attempts (${attempts.length} total)`,
    '',
  ];

  for (const attempt of attempts) {
    lines.push(`### Attempt ${attempt.attemptNumber} (${attempt.agentType} agent, ${attempt.timestamp})`);
    lines.push('');
    lines.push(attempt.retryContext);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Record a new retry attempt and update history.
 */
export function recordRetryAttempt(
  history: RetryHistory,
  retryContext: string,
  agentType: 'fix' | 'build'
): RetryHistory {
  const newAttempt: RetryAttempt = {
    attemptNumber: history.attempts.length + 1,
    retryContext,
    timestamp: new Date().toISOString(),
    agentType,
  };

  return {
    ...history,
    attempts: [...history.attempts, newAttempt],
  };
}

/**
 * Create an empty retry history for a new run.
 */
export function createRetryHistory(runId: string, maxRetries: number): RetryHistory {
  return {
    runId,
    maxRetries,
    attempts: [],
  };
}

/**
 * Determine whether to retry or fail based on current attempt count.
 * Returns a RetryLoopResult with either a retry dispatch or failure report.
 */
export function evaluateRetryDecision(
  history: RetryHistory,
  latestRetryContext: string,
  config: RetryLoopConfig
): RetryLoopResult {
  const currentAttemptCount = history.attempts.length;

  if (currentAttemptCount < config.maxRetries) {
    // Still have retries remaining
    const combinedContext = buildCombinedRetryContext(history.attempts);
    const dispatch: RetryDispatchInput = {
      retryCount: currentAttemptCount + 1,
      combinedRetryContext: combinedContext,
      latestRetryContext,
      agentType: config.agentType,
    };

    return { action: 'retry', dispatch };
  }

  // Max retries exceeded
  const failureReport: FailureReport = {
    runId: config.runId,
    upstreamRepo: config.upstreamRepo,
    primaryIssueNumber: config.primaryIssueNumber,
    retryHistory: history.attempts,
    forkBranch: config.branchName,
    forkFullName: config.forkFullName,
    summary: buildFailureSummary(history, config),
  };

  return { action: 'max_retries_exceeded', failureReport };
}

/**
 * Build a human-readable failure summary for the email notification.
 */
export function buildFailureSummary(history: RetryHistory, config: RetryLoopConfig): string {
  const issueNumbers = config.confirmedIssues.map((i) => `#${i.number}`).join(', ');
  return (
    `Fix attempt for ${config.upstreamRepo} issues ${issueNumbers} failed after ` +
    `${history.maxRetries} retry attempts using the ${config.agentType} agent. ` +
    `The fork branch "${config.branchName}" on ${config.forkFullName} has been preserved for inspection.`
  );
}

/**
 * Format the failure notification email body.
 * Contains the full retry context from all attempts.
 */
export function formatFailureEmail(report: FailureReport): string {
  const lines: string[] = [
    `# Agent Fix Failed — ${report.upstreamRepo}#${report.primaryIssueNumber}`,
    '',
    report.summary,
    '',
    '## Fork Branch (preserved)',
    '',
    `Repository: ${report.forkFullName}`,
    `Branch: ${report.forkBranch}`,
    '',
    '## Retry History',
    '',
  ];

  for (const attempt of report.retryHistory) {
    lines.push(`### Attempt ${attempt.attemptNumber} (${attempt.agentType} agent)`);
    lines.push(`Timestamp: ${attempt.timestamp}`);
    lines.push('');
    lines.push('```');
    lines.push(attempt.retryContext);
    lines.push('```');
    lines.push('');
  }

  lines.push('---');
  lines.push('This is an automated notification from the OSS Autonomous Fix Loop.');

  return lines.join('\n');
}

/**
 * Format the failure notification email subject.
 */
export function formatFailureSubject(upstreamRepo: string, issueNumber: number): string {
  return `${FAILURE_EMAIL_SUBJECT_PREFIX} ${upstreamRepo}#${issueNumber}`;
}

/**
 * Handle the max_retries_exceeded case:
 * 1. Email the user with full retry context from all attempts
 * 2. Label the upstream issue agent-failed
 * 3. Preserve the fork branch (no-op — we simply don't delete it)
 *
 * Both email and labeling are best-effort (non-fatal if they fail individually).
 */
export async function handleMaxRetriesExceeded(
  report: FailureReport,
  config: RetryLoopConfig,
  notifier: FailureNotifier,
  labeler: IssueLabeler
): Promise<{ emailSent: boolean; labelApplied: boolean }> {
  let emailSent = false;
  let labelApplied = false;

  // Step 1: Email the user with full retry context
  try {
    const subject = formatFailureSubject(config.upstreamRepo, config.primaryIssueNumber);
    const body = formatFailureEmail(report);
    await notifier.sendEmail(config.pmEmail, subject, body, config.replyToAddress);
    emailSent = true;
  } catch (error) {
    // Email is best-effort; log but don't throw
  }

  // Step 2: Label the upstream issue agent-failed
  try {
    await labeler.addLabel(
      config.upstreamRepo,
      config.primaryIssueNumber,
      AGENT_FAILED_LABEL
    );
    labelApplied = true;
  } catch (error) {
    // Labeling is best-effort; log but don't throw
  }

  // Step 3: Fork branch is preserved (no-op — we don't delete it)

  return { emailSent, labelApplied };
}

/**
 * Run the full retry loop decision pipeline:
 * 1. Load or create retry history
 * 2. Record the new failed attempt
 * 3. Persist updated history
 * 4. Evaluate whether to retry or fail
 * 5. On max_retries_exceeded, handle notifications and labeling
 * 6. Clean up state on terminal decision
 */
export async function runRetryLoop(
  retryContext: string,
  config: RetryLoopConfig,
  stateStore: RetryStateStore,
  notifier: FailureNotifier,
  labeler: IssueLabeler
): Promise<RetryLoopResult> {
  // Step 1: Load or create retry history
  let history = await stateStore.loadRetryHistory(config.runId);
  if (!history) {
    history = createRetryHistory(config.runId, config.maxRetries);
  }

  // Step 2: Record the new failed attempt
  history = recordRetryAttempt(history, retryContext, config.agentType);

  // Step 3: Persist updated history
  await stateStore.saveRetryHistory(history);

  // Step 4: Evaluate retry decision
  const decision = evaluateRetryDecision(history, retryContext, config);

  // Step 5: On max_retries_exceeded, handle notifications
  if (decision.action === 'max_retries_exceeded') {
    await handleMaxRetriesExceeded(decision.failureReport, config, notifier, labeler);

    // Step 6: Clean up persisted state (terminal)
    await stateStore.deleteRetryHistory(config.runId);
  }

  return decision;
}

/**
 * Append retry context to the fix agent input.
 * Returns a modified design summary that includes retry context.
 */
export function injectRetryContextForFixAgent(
  originalDesignSummary: string,
  dispatch: RetryDispatchInput
): string {
  const parts: string[] = [originalDesignSummary];

  if (dispatch.combinedRetryContext) {
    parts.push('');
    parts.push(dispatch.combinedRetryContext);
  }

  parts.push('');
  parts.push('## Latest Failure (address this in your fix)');
  parts.push('');
  parts.push(dispatch.latestRetryContext);

  return parts.join('\n');
}

/**
 * Append retry context to the build agent input.
 * Returns a modified design summary that includes retry context.
 */
export function injectRetryContextForBuildAgent(
  originalDesignSummary: string,
  dispatch: RetryDispatchInput
): string {
  // Same injection mechanism as fix agent
  return injectRetryContextForFixAgent(originalDesignSummary, dispatch);
}

/**
 * Resume retry loop from persisted state after a restart.
 * Returns the retry history if one exists for the run, or null.
 */
export async function resumeRetryLoop(
  runId: string,
  stateStore: RetryStateStore
): Promise<RetryHistory | null> {
  return stateStore.loadRetryHistory(runId);
}
