/**
 * Issue sweep and scope confirmation (US-013).
 *
 * After design approval:
 * - PM agent searches all open issues against the agreed design
 * - Produces high_confidence and maybe_in_scope groups with one-sentence reasons
 * - Sends scope confirmation email per PRD section 5.3 format
 * - Parses freeform prose replies (e.g. 'include 142 and 156 but drop 201') and 'all'
 * - Confirmed list is passed to the orchestrator for fork creation
 * - SWEEP_PENDING state persists across restarts
 */

import {
  SweepInput,
  SweepResult,
  SweepIssue,
  ScopeConfirmationConfig,
  ScopeConfirmationResult,
  IssueSweeper,
  SweepStateStore,
  SweepError,
} from './issue-sweep-types';

import {
  EmailThread,
  GmailClient,
} from './gmail-types';

import {
  sendAndTrack,
  buildEmailMessage,
  sendEmail,
  GmailWatcher,
} from './gmail-mcp';

/**
 * Default heuristic issue sweeper.
 * Categorizes open issues by relevance to the agreed design.
 */
export class HeuristicIssueSweeper implements IssueSweeper {
  sweepIssues(input: SweepInput): SweepResult {
    const { agreedDesign, affectedModule, openIssues, primaryIssueNumber } = input;
    const designLower = agreedDesign.toLowerCase();
    const moduleLower = affectedModule.toLowerCase();
    const moduleSegments = affectedModule.split('/').filter(Boolean);

    const highConfidence: SweepIssue[] = [];
    const maybeInScope: SweepIssue[] = [];

    for (const issue of openIssues) {
      // Skip the primary issue (it's always in scope)
      if (issue.number === primaryIssueNumber) {
        highConfidence.push({
          ...issue,
          reason: 'Primary issue that triggered this run.',
        });
        continue;
      }

      const score = scoreIssueRelevance(issue, designLower, moduleLower, moduleSegments);

      if (score >= HIGH_CONFIDENCE_THRESHOLD) {
        highConfidence.push(issue);
      } else if (score >= MAYBE_IN_SCOPE_THRESHOLD) {
        maybeInScope.push(issue);
      }
      // Below threshold: not included
    }

    return { highConfidence, maybeInScope };
  }
}

/** Threshold for high confidence (design directly closes) */
const HIGH_CONFIDENCE_THRESHOLD = 0.7;
/** Threshold for maybe in scope (partial overlap) */
const MAYBE_IN_SCOPE_THRESHOLD = 0.4;

/**
 * Score an issue's relevance to the agreed design.
 * Returns 0-1 float.
 */
function scoreIssueRelevance(
  issue: SweepIssue,
  designLower: string,
  moduleLower: string,
  moduleSegments: string[]
): number {
  let score = 0;
  const titleLower = issue.title.toLowerCase();
  const reasonLower = issue.reason.toLowerCase();

  // Title words appear in the design summary
  const titleWords = titleLower.split(/\s+/).filter((w) => w.length > 3);
  const titleMatchCount = titleWords.filter((w) => designLower.includes(w)).length;
  if (titleWords.length > 0) {
    score += (titleMatchCount / titleWords.length) * 0.4;
  }

  // Issue references the same module
  if (reasonLower.includes(moduleLower) || titleLower.includes(moduleLower)) {
    score += 0.3;
  } else {
    // Partial module match (any segment)
    const hasSegmentMatch = moduleSegments.some(
      (seg) => seg.length > 3 && (titleLower.includes(seg) || reasonLower.includes(seg))
    );
    if (hasSegmentMatch) {
      score += 0.15;
    }
  }

  // Shared labels with the design context
  const designMentionsLabel = issue.labels.some((l) => designLower.includes(l.toLowerCase()));
  if (designMentionsLabel) {
    score += 0.15;
  }

  // Keywords suggesting relevance
  const relevanceKeywords = ['related', 'same', 'also', 'similar', 'duplicate', 'affects'];
  if (relevanceKeywords.some((kw) => reasonLower.includes(kw))) {
    score += 0.15;
  }

  return Math.min(score, 1.0);
}

/**
 * Format the scope confirmation email per PRD section 5.3.
 */
export function formatScopeEmail(sweepResult: SweepResult): string {
  const sections: string[] = [];

  sections.push('## Scope Confirmation\n');
  sections.push(
    'The following issues have been identified as related to the approved design. ' +
    'Please confirm which issues should be included in the fix scope.\n'
  );

  sections.push('**High confidence (design directly closes):**');
  if (sweepResult.highConfidence.length > 0) {
    for (const issue of sweepResult.highConfidence) {
      sections.push(`- #${issue.number}: ${issue.title} — ${issue.reason}`);
    }
  } else {
    sections.push('- (none)');
  }
  sections.push('');

  sections.push('**Maybe in scope (partial overlap):**');
  if (sweepResult.maybeInScope.length > 0) {
    for (const issue of sweepResult.maybeInScope) {
      sections.push(`- #${issue.number}: ${issue.title} — ${issue.reason}`);
    }
  } else {
    sections.push('- (none)');
  }
  sections.push('');

  sections.push('---');
  sections.push(
    'Please reply with the final issue numbers to include (e.g., "include 142 and 156 but drop 201") ' +
    'or reply "all" to include everything listed above.'
  );

  return sections.join('\n');
}

/**
 * Parse a freeform prose reply to extract confirmed issue numbers.
 * Handles:
 * - "all" → all issues from sweep
 * - "include 142 and 156 but drop 201" → explicit include/exclude
 * - Plain numbers: "142, 156, 203"
 * - "include 142 and 156" → only those
 * - "drop 201" from the full set
 */
export function parseScopeReply(
  replyBody: string,
  sweepResult: SweepResult
): number[] {
  const bodyLower = replyBody.toLowerCase().trim();
  const allIssueNumbers = [
    ...sweepResult.highConfidence.map((i) => i.number),
    ...sweepResult.maybeInScope.map((i) => i.number),
  ];

  // Handle "all" keyword
  if (bodyLower === 'all' || bodyLower.startsWith('all ') || bodyLower.includes('include all')) {
    return [...allIssueNumbers];
  }

  // Extract all numbers from the reply
  const numberMatches = replyBody.match(/\d+/g);
  if (!numberMatches) {
    // No numbers found — default to high confidence only
    return [...sweepResult.highConfidence.map((i) => i.number)];
  }

  const mentionedNumbers = numberMatches.map(Number);

  // Check for explicit exclude patterns
  const hasDropPattern = /\b(drop|remove|exclude|not|without|skip|except)\b/i.test(replyBody);
  const hasIncludePattern = /\b(include|add|keep|yes|with)\b/i.test(replyBody);

  if (hasDropPattern && hasIncludePattern) {
    // Mixed: parse includes and excludes separately
    return parseMixedReply(replyBody, allIssueNumbers);
  }

  if (hasDropPattern && !hasIncludePattern) {
    // Drop mode: start with all, remove mentioned numbers
    return allIssueNumbers.filter((n) => !mentionedNumbers.includes(n));
  }

  // Include mode: only include mentioned numbers that are in the sweep
  const validNumbers = mentionedNumbers.filter((n) => allIssueNumbers.includes(n));
  return validNumbers.length > 0 ? validNumbers : [...sweepResult.highConfidence.map((i) => i.number)];
}

/**
 * Parse a reply with both include and exclude patterns.
 * E.g. "include 142 and 156 but drop 201"
 */
function parseMixedReply(replyBody: string, allIssueNumbers: number[]): number[] {
  const dropPatterns = /(?:drop|remove|exclude|not|without|skip|except)\s+(?:#?(\d+)(?:\s*(?:,|and)\s*#?(\d+))*)/gi;
  const excludeNumbers: number[] = [];

  let match: RegExpExecArray | null;
  // Find numbers after drop keywords
  const dropSection = replyBody.replace(
    /\b(drop|remove|exclude|not|without|skip|except)\b/gi,
    '|||DROP|||'
  );
  const includeSection = replyBody.replace(
    /\b(include|add|keep|yes|with)\b/gi,
    '|||INCLUDE|||'
  );

  // Split by markers and extract numbers from drop sections
  const parts = dropSection.split('|||DROP|||');
  for (let i = 1; i < parts.length; i++) {
    // Get numbers immediately after the drop keyword (before next keyword)
    const segment = parts[i].split(/\b(include|add|keep|but)\b/i)[0];
    const nums = segment.match(/\d+/g);
    if (nums) {
      excludeNumbers.push(...nums.map(Number));
    }
  }

  // Find explicitly included numbers
  const includeParts = includeSection.split('|||INCLUDE|||');
  const includeNumbers: number[] = [];
  for (let i = 1; i < includeParts.length; i++) {
    const segment = includeParts[i].split(/\b(drop|remove|exclude|but|not)\b/i)[0];
    const nums = segment.match(/\d+/g);
    if (nums) {
      includeNumbers.push(...nums.map(Number));
    }
  }

  if (includeNumbers.length > 0) {
    // If explicit includes found, use those minus excludes
    return includeNumbers
      .filter((n) => !excludeNumbers.includes(n))
      .filter((n) => allIssueNumbers.includes(n));
  }

  // Otherwise, start with all and remove excludes
  return allIssueNumbers.filter((n) => !excludeNumbers.includes(n));
}

/**
 * Send the scope confirmation email after design approval.
 */
export async function sendScopeConfirmation(
  client: GmailClient,
  watcher: GmailWatcher,
  config: ScopeConfirmationConfig,
  sweepResult: SweepResult,
  stateStore: SweepStateStore,
  existingThreadId?: string
): Promise<ScopeConfirmationResult> {
  const emailBody = formatScopeEmail(sweepResult);

  const thread = await sendAndTrack(client, watcher, {
    runId: config.runId,
    to: config.pmEmail,
    repo: config.repo,
    issueNumber: config.issueNumber,
    issueTitle: config.issueTitle,
    body: emailBody,
    replyTo: config.replyToAddress,
    existingThreadId,
  });

  // Persist state for restart-resume
  stateStore.saveSweepState(config.runId, thread, sweepResult);

  return {
    action: 'scope_email_sent',
    thread,
    sweepResult,
  };
}

/**
 * Process a scope confirmation reply.
 * Parses the reply to extract confirmed issue numbers.
 */
export function processScopeReply(
  replyBody: string,
  sweepResult: SweepResult,
  stateStore: SweepStateStore,
  runId: string,
  watcher: GmailWatcher,
  threadId: string
): ScopeConfirmationResult {
  const confirmedIssueNumbers = parseScopeReply(replyBody, sweepResult);

  // Clean up persisted state
  stateStore.deleteSweepState(runId);

  // Unregister from watcher
  watcher.unregisterThread(threadId);

  return {
    action: 'scope_confirmed',
    confirmedIssueNumbers,
  };
}

/**
 * Resume a SWEEP_PENDING state after a restart.
 * Loads persisted state and re-registers the thread with the watcher.
 */
export function resumeSweepLoop(
  watcher: GmailWatcher,
  stateStore: SweepStateStore,
  runId: string
): { thread: EmailThread; sweepResult: SweepResult } | null {
  const state = stateStore.loadSweepState(runId);
  if (!state) return null;

  // Re-register with the watcher so it picks up new replies
  watcher.registerThread(state.thread);

  return state;
}

/**
 * Full sweep pipeline: sweep issues → send email → wait for reply → parse → confirm.
 * This is the top-level function called by the orchestrator after approval.
 */
export async function runIssueSweep(
  client: GmailClient,
  watcher: GmailWatcher,
  config: ScopeConfirmationConfig,
  sweepInput: SweepInput,
  sweeper: IssueSweeper,
  stateStore: SweepStateStore,
  existingThreadId?: string
): Promise<ScopeConfirmationResult> {
  // Step 1: Sweep open issues against agreed design
  const sweepResult = sweeper.sweepIssues(sweepInput);

  // Step 2: Send scope confirmation email
  return sendScopeConfirmation(
    client,
    watcher,
    config,
    sweepResult,
    stateStore,
    existingThreadId
  );
}

/**
 * Create a reply handler for scope confirmation replies.
 * Called when the Gmail watcher detects a reply to a scope confirmation thread.
 */
export function createSweepReplyHandler(
  stateStore: SweepStateStore,
  watcher: GmailWatcher,
  onScopeConfirmed: (runId: string, confirmedIssueNumbers: number[]) => Promise<void>
): (runId: string, reply: import('./gmail-types').GmailReply, thread: EmailThread) => Promise<void> {
  return async (runId, reply, thread) => {
    const state = stateStore.loadSweepState(runId);
    if (!state) {
      throw new SweepError(
        `No sweep state found for run ${runId}`,
        'reply_handler',
        runId
      );
    }

    const result = processScopeReply(
      reply.body,
      state.sweepResult,
      stateStore,
      runId,
      watcher,
      thread.threadId
    );

    if (result.action === 'scope_confirmed') {
      await onScopeConfirmed(runId, result.confirmedIssueNumbers);
    }
  };
}
