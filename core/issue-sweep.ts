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
  SweepAnalysis,
  ScopeConfirmationConfig,
  ScopeConfirmationResult,
  IssueSweeper,
  SweepStateStore,
  SweepError,
} from './issue-sweep-types';

import type { LLMMessage } from './llm/types';

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
          analysis: {
            score: 1,
            scoreSignals: [
              'This is the issue that started this whole run, so it is always included.',
            ],
          },
        });
        continue;
      }

      const { score, signals } = scoreIssueRelevance(issue, designLower, moduleLower, moduleSegments);
      const scored: SweepIssue = { ...issue, analysis: { score, scoreSignals: signals } };

      if (score >= HIGH_CONFIDENCE_THRESHOLD) {
        highConfidence.push(scored);
      } else if (score >= MAYBE_IN_SCOPE_THRESHOLD) {
        maybeInScope.push(scored);
      }
      // Below threshold: not included
    }

    return { highConfidence, maybeInScope };
  }
}

/** Threshold for high confidence (design directly closes) */
const HIGH_CONFIDENCE_THRESHOLD = 0.7;
/** Threshold for maybe in scope (partial overlap) */
const MAYBE_IN_SCOPE_THRESHOLD = 0.3;

/**
 * Score an issue's relevance to the agreed design.
 * Returns a 0-1 score plus a plain-language sentence for every signal checked
 * (both the ones that added points and the ones that did not), so the scope
 * email can show the complete reasoning.
 */
function scoreIssueRelevance(
  issue: SweepIssue,
  designLower: string,
  moduleLower: string,
  moduleSegments: string[]
): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];
  const titleLower = issue.title.toLowerCase();
  const reasonLower = issue.reason.toLowerCase();

  // Title words appear in the design summary
  const titleWords = titleLower.split(/\s+/).filter((w) => w.length > 3);
  const matchedWords = titleWords.filter((w) => designLower.includes(w));
  if (titleWords.length > 0) {
    const pts = (matchedWords.length / titleWords.length) * 0.4;
    score += pts;
    if (matchedWords.length > 0) {
      signals.push(
        `${matchedWords.length} of the ${titleWords.length} significant words in this issue's title ` +
          `also appear in the agreed fix plan (${matchedWords.slice(0, 6).map((w) => `"${w}"`).join(', ')}): ` +
          `+${Math.round(pts * 100)} points (out of a possible 40).`
      );
    } else {
      signals.push(
        `None of the ${titleWords.length} significant words in this issue's title appear in the agreed fix plan: +0 points.`
      );
    }
  }

  // Issue references the same module. A trivial module name like "." would
  // match almost any title, so only exact-match on meaningful names.
  const moduleIsMeaningful = moduleLower.length > 1;
  if (moduleIsMeaningful && (reasonLower.includes(moduleLower) || titleLower.includes(moduleLower))) {
    score += 0.3;
    signals.push(`This issue mentions the exact part of the code being fixed ("${moduleLower}"): +30 points.`);
  } else {
    // Partial module match (any segment)
    const matchedSegment = moduleSegments.find(
      (seg) => seg.length > 3 && (titleLower.includes(seg.toLowerCase()) || reasonLower.includes(seg.toLowerCase()))
    );
    if (matchedSegment) {
      score += 0.15;
      signals.push(`This issue mentions part of the code area being fixed ("${matchedSegment}"): +15 points.`);
    } else if (moduleIsMeaningful) {
      signals.push(`This issue does not mention the part of the code being fixed ("${moduleLower}"): +0 points.`);
    } else {
      signals.push('The fix plan does not name a specific code area, so no points could be given for that check.');
    }
  }

  // Shared labels with the design context
  const matchedLabel = issue.labels.find((l) => designLower.includes(l.toLowerCase()));
  if (matchedLabel) {
    score += 0.15;
    signals.push(`This issue has the label "${matchedLabel}", which the fix plan also mentions: +15 points.`);
  } else if (issue.labels.length > 0) {
    signals.push(
      `None of this issue's labels (${issue.labels.join(', ')}) appear in the fix plan: +0 points.`
    );
  } else {
    signals.push('This issue has no labels, so no points could be given for matching labels.');
  }

  // Keywords suggesting relevance
  const relevanceKeywords = ['related', 'same', 'also', 'similar', 'duplicate', 'affects'];
  const matchedKeyword = relevanceKeywords.find((kw) => reasonLower.includes(kw));
  if (matchedKeyword) {
    score += 0.15;
    signals.push(`This issue's notes contain the word "${matchedKeyword}", which hints it is connected: +15 points.`);
  }

  return { score: Math.min(score, 1.0), signals };
}

/**
 * Minimal LLM surface needed by the sweep explainer. ChatClient satisfies this.
 */
export interface SweepExplainerLLM {
  chatJson<T>(
    messages: LLMMessage[],
    schema: unknown,
    options?: { agent?: string; temperature?: number }
  ): Promise<{ data: T }>;
}

interface SweepExplanation {
  number: number;
  plainSummary: string;
  whyRelated: string[];
  whyNotRelated: string[];
}

const SWEEP_EXPLANATION_SCHEMA = {
  type: 'object',
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'plainSummary', 'whyRelated', 'whyNotRelated'],
        properties: {
          number: { type: 'number' },
          plainSummary: { type: 'string' },
          whyRelated: { type: 'array', items: { type: 'string' } },
          whyNotRelated: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

/**
 * Use the LLM to write a plain-language summary and explicit for/against
 * reasoning for every issue in the sweep result, so the scope email gives the
 * reader everything they need to decide. Mutates the issues' `analysis` in
 * place. Best-effort: on LLM failure the email falls back to heuristic-only.
 */
export async function enrichSweepWithExplanations(
  llm: SweepExplainerLLM,
  sweepResult: SweepResult,
  agreedDesign: string,
  log?: (msg: string) => void
): Promise<void> {
  const allIssues = [...sweepResult.highConfidence, ...sweepResult.maybeInScope];
  if (allIssues.length === 0) return;

  const issueBlocks = allIssues
    .map((i) => {
      const body = (i.body ?? '').trim();
      return [
        `Issue #${i.number}: ${i.title}`,
        `Labels: ${i.labels.join(', ') || '(none)'}`,
        `Automatic scoring notes: ${i.analysis?.scoreSignals.join(' ') ?? '(none)'}`,
        `Issue description:\n${body || '(no description provided)'}`,
      ].join('\n');
    })
    .join('\n\n---\n\n');

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content:
        'You explain GitHub issues to a non-technical project owner deciding which issues to bundle ' +
        'into one fix. Write at a middle-school reading level: short sentences, no unexplained jargon. ' +
        'If you must use a technical term, explain it in parentheses the first time. Be honest and ' +
        'complete — list every reason an issue might be related to the planned fix AND every reason it ' +
        'might not be. Never invent details that are not in the issue text.',
    },
    {
      role: 'user',
      content:
        `Here is the fix plan that was agreed on:\n\n${agreedDesign}\n\n` +
        `Here are the candidate issues:\n\n${issueBlocks}\n\n` +
        'For EACH issue, return:\n' +
        '- plainSummary: 2-4 sentences explaining what the person who filed the issue is reporting, ' +
        'simple enough for a middle schooler.\n' +
        '- whyRelated: every reason this issue might be caused by the same problem the fix plan addresses.\n' +
        '- whyNotRelated: every reason this issue might be a different problem that the fix plan would NOT solve.\n',
    },
  ];

  try {
    const { data } = await llm.chatJson<{ issues: SweepExplanation[] }>(
      messages,
      SWEEP_EXPLANATION_SCHEMA,
      { agent: 'PM', temperature: 0 }
    );
    const byNumber = new Map(data.issues.map((e) => [e.number, e]));
    for (const issue of allIssues) {
      const exp = byNumber.get(issue.number);
      if (!exp || !issue.analysis) continue;
      issue.analysis.plainSummary = exp.plainSummary;
      issue.analysis.whyRelated = exp.whyRelated;
      issue.analysis.whyNotRelated = exp.whyNotRelated;
    }
  } catch (err) {
    log?.(`[sweep] LLM explanation failed (${(err as Error).message}); using heuristic-only email`);
  }
}

/** Render one issue as a fully-explained section of the scope email. */
function formatIssueSection(issue: SweepIssue): string[] {
  const lines: string[] = [];
  const a = issue.analysis;
  const scoreSuffix = a ? ` — relevance score: ${Math.round(a.score * 100)}/100` : '';
  lines.push(`### Issue #${issue.number}: ${issue.title}${scoreSuffix}`);
  if (issue.labels.length > 0) {
    lines.push(`Labels: ${issue.labels.join(', ')}`);
  }
  lines.push('');

  const summary = a?.plainSummary ?? (issue.body ? excerpt(issue.body) : issue.reason);
  if (summary) {
    lines.push('**What this issue is about (in plain words):**');
    lines.push(summary);
    lines.push('');
  }

  if (a?.whyRelated?.length) {
    lines.push('**Why it MIGHT be related to our fix:**');
    for (const r of a.whyRelated) lines.push(`- ${r}`);
    lines.push('');
  }
  if (a?.whyNotRelated?.length) {
    lines.push('**Why it might NOT be related:**');
    for (const r of a.whyNotRelated) lines.push(`- ${r}`);
    lines.push('');
  }
  if (a?.scoreSignals.length) {
    lines.push('**How the automatic scorer added up the points:**');
    for (const s of a.scoreSignals) lines.push(`- ${s}`);
    lines.push('');
  }
  return lines;
}

/** First ~350 characters of an issue body, whitespace-collapsed. */
function excerpt(body: string, max = 350): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * Format the scope confirmation email per PRD section 5.3, with the complete
 * per-issue reasoning (plain-language summary, for/against arguments, and the
 * heuristic score breakdown).
 */
export function formatScopeEmail(sweepResult: SweepResult): string {
  const sections: string[] = [];

  sections.push('## Scope Confirmation — which issues should we fix together?\n');
  sections.push(
    'Before starting the fix, we scanned every open issue in the repo to see if any of them ' +
      'look like they are caused by the same underlying problem. Fixing them together saves a ' +
      'separate round of work later — but bundling an unrelated issue would make the change ' +
      'bigger and riskier. Your job here is just to pick which issue numbers to include.\n'
  );

  sections.push('**How the scoring works (in plain words):**');
  sections.push(
    '- Each issue gets points for overlapping with the agreed fix plan: words its title shares ' +
      'with the plan (up to 40 points), mentioning the same part of the code (up to 30), ' +
      'sharing a label the plan mentions (15), and wording that hints at a connection (15).'
  );
  sections.push('- 70+ points → listed as "very likely related". 30–69 points → "maybe related".');
  sections.push(
    '- The score is a rough hint, not a verdict — read the reasoning under each issue before deciding.\n'
  );

  sections.push('## Issues we think are VERY LIKELY related\n');
  if (sweepResult.highConfidence.length > 0) {
    for (const issue of sweepResult.highConfidence) {
      sections.push(...formatIssueSection(issue));
    }
  } else {
    sections.push('(none)\n');
  }

  sections.push('## Issues that are MAYBE related\n');
  if (sweepResult.maybeInScope.length > 0) {
    for (const issue of sweepResult.maybeInScope) {
      sections.push(...formatIssueSection(issue));
    }
  } else {
    sections.push('(none)\n');
  }

  sections.push('---');
  sections.push('**How to reply:**');
  sections.push('- Reply "all" to include every issue listed above.');
  sections.push('- Reply with the numbers to include, e.g. "include 142 and 156 but drop 201".');
  sections.push(
    '- If you only want the primary issue, reply with just its number or "only the primary issue".'
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
