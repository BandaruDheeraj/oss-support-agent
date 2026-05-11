/**
 * PM agent email conversation loop (US-012).
 * Multi-turn email design conversation until approval keyword is received.
 *
 * - Initial design brief sent within 5 minutes of design_needed=true
 * - Brief contains 6 fields: issue summary, affected module, related open issues,
 *   recent PR context, 2-3 proposed approaches with tradeoffs, open questions
 * - On each reply, PM agent re-reads full thread history and responds within 60s
 * - Never restates resolved decisions — only surfaces what is still unresolved
 * - Loop exits when reply contains an approval keyword
 * - EMAIL_PENDING state persists across restarts
 */

import {
  DesignBriefInput,
  DesignBrief,
  ApproachOption,
  FollowUpInput,
  FollowUpResult,
  PMEmailLoopConfig,
  PMEmailLoopResult,
  DesignBriefGenerator,
  FollowUpGenerator,
  EmailStateStore,
  PMEmailLoopError,
} from './pm-email-types';

import {
  EmailThread,
  ConversationEntry,
  GmailClient,
} from './gmail-types';

import {
  sendAndTrack,
  detectApproval,
  GmailWatcher,
  appendAgentMessageToThread,
  sendEmail,
  buildEmailMessage,
} from './gmail-mcp';

/**
 * Default heuristic design brief generator.
 * Builds a structured brief from the provided context.
 */
export class HeuristicBriefGenerator implements DesignBriefGenerator {
  generateBrief(input: DesignBriefInput): DesignBrief {
    const relatedOpenIssues = input.relatedIssues.length > 0
      ? input.relatedIssues
          .map((i) => `#${i.number}: ${i.title} (${i.reason})`)
          .join('\n')
      : 'No related open issues found.';

    const recentPRContext = input.recentPRs.length > 0
      ? input.recentPRs
          .slice(0, 5)
          .map((pr) => `PR #${pr.number}: ${pr.title} (${pr.files_changed.length} files, merged ${pr.merged_at})`)
          .join('\n')
      : 'No recent PRs found touching this module.';

    const proposedApproaches = generateApproaches(input);
    const openQuestions = generateOpenQuestions(input);

    return {
      issueSummary: input.issueSummary,
      affectedModule: input.affectedModule,
      relatedOpenIssues,
      recentPRContext,
      proposedApproaches,
      openQuestions,
    };
  }
}

/**
 * Generate 2-3 proposed approaches based on the scoring signals.
 */
function generateApproaches(input: DesignBriefInput): ApproachOption[] {
  const approaches: ApproachOption[] = [];
  const signals = input.scoringResult.signals.filter((s) => s.triggered);

  // Always propose a minimal fix approach
  approaches.push({
    name: 'Minimal targeted fix',
    description: `Address the core issue in ${input.affectedModule} with the smallest possible change.`,
    pros: ['Low risk of regression', 'Fast to implement', 'Easy to review'],
    cons: ['May not address root cause', 'Related issues may persist'],
  });

  // If multi-module or API changes, propose a broader refactor
  const hasAPISignal = signals.some((s) => s.rule === 'public_api_change');
  const hasMultiModule = signals.some((s) => s.rule === 'multi_module_span');

  if (hasAPISignal || hasMultiModule) {
    approaches.push({
      name: 'Coordinated refactor',
      description: `Refactor the affected API surface across related modules to address the root cause.`,
      pros: ['Addresses root cause', 'Fixes related issues', 'Cleaner API'],
      cons: ['Higher risk of regression', 'Larger review surface', 'More time to implement'],
    });
  }

  // If many related issues, propose a comprehensive design
  if (input.relatedIssues.length >= 3) {
    approaches.push({
      name: 'Comprehensive design pass',
      description: `Design a holistic solution that addresses all ${input.relatedIssues.length} related issues together.`,
      pros: ['Addresses all related issues at once', 'Avoids incremental patches', 'Better long-term architecture'],
      cons: ['Largest scope and risk', 'Requires most review effort', 'May delay fix for primary issue'],
    });
  }

  // If only one approach so far (minimal), add an incremental approach
  if (approaches.length < 2) {
    approaches.push({
      name: 'Incremental improvement',
      description: `Fix the immediate issue and add infrastructure to make future fixes easier.`,
      pros: ['Fixes the issue now', 'Improves maintainability', 'Moderate scope'],
      cons: ['Partial solution', 'Some tech debt remains'],
    });
  }

  return approaches.slice(0, 3);
}

/**
 * Generate open questions based on the design signals.
 */
function generateOpenQuestions(input: DesignBriefInput): string[] {
  const questions: string[] = [];
  const signals = input.scoringResult.signals.filter((s) => s.triggered);

  for (const signal of signals) {
    switch (signal.rule) {
      case 'design_keywords':
        questions.push('What specific architectural changes are acceptable for this fix?');
        break;
      case 'related_issues_count':
        questions.push(`Should all ${input.relatedIssues.length} related issues be addressed together, or just the primary issue?`);
        break;
      case 'public_api_change':
        questions.push('Is a breaking API change acceptable, or must backward compatibility be maintained?');
        break;
      case 'contested_behaviour':
        questions.push('What is the intended behaviour? Should we align with the existing design intent or change direction?');
        break;
      case 'multi_module_span':
        questions.push('Should the fix be contained to the primary module, or are cross-module changes acceptable?');
        break;
    }
  }

  // Always include a scope question
  if (questions.length === 0) {
    questions.push('What is the acceptable scope for this change?');
  }

  return questions;
}

/**
 * Format a DesignBrief into a human-readable email body.
 */
export function formatDesignBriefEmail(brief: DesignBrief): string {
  const sections: string[] = [];

  sections.push('## Design Brief\n');

  sections.push(`**Issue Summary:** ${brief.issueSummary}\n`);
  sections.push(`**Affected Module:** ${brief.affectedModule}\n`);

  sections.push(`**Related Open Issues:**\n${brief.relatedOpenIssues}\n`);
  sections.push(`**Recent PR Context:**\n${brief.recentPRContext}\n`);

  sections.push('**Proposed Approaches:**\n');
  for (let i = 0; i < brief.proposedApproaches.length; i++) {
    const approach = brief.proposedApproaches[i];
    sections.push(`${i + 1}. **${approach.name}**: ${approach.description}`);
    sections.push(`   Pros: ${approach.pros.join(', ')}`);
    sections.push(`   Cons: ${approach.cons.join(', ')}\n`);
  }

  sections.push('**Open Questions:**');
  for (const q of brief.openQuestions) {
    sections.push(`- ${q}`);
  }

  sections.push('\n---\nPlease reply with your preference or questions. To approve and proceed, reply with an approval keyword.');

  return sections.join('\n');
}

/**
 * Default heuristic follow-up generator.
 * Analyzes conversation history and surfaces only unresolved items.
 */
export class HeuristicFollowUpGenerator implements FollowUpGenerator {
  generateFollowUp(input: FollowUpInput): FollowUpResult {
    const { conversationHistory, latestReply, resolvedDecisions, unresolvedQuestions } = input;

    // Analyze the latest reply to extract decisions
    const newDecisions = extractDecisions(latestReply);
    const updatedResolved = [...resolvedDecisions, ...newDecisions];

    // Filter out questions that have been resolved
    const stillUnresolved = unresolvedQuestions.filter(
      (q) => !isQuestionResolved(q, updatedResolved, latestReply)
    );

    // Generate a response that only addresses unresolved items
    const responseBody = buildFollowUpResponse(
      stillUnresolved,
      newDecisions,
      latestReply,
      conversationHistory
    );

    return {
      responseBody,
      resolvedDecisions: updatedResolved,
      unresolvedQuestions: stillUnresolved,
    };
  }
}

/**
 * Extract decisions from a user's reply.
 */
export function extractDecisions(reply: string): string[] {
  const decisions: string[] = [];
  const lines = reply.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Look for decision indicators
    if (
      trimmed.toLowerCase().startsWith('decision:') ||
      trimmed.toLowerCase().startsWith('let\'s go with') ||
      trimmed.toLowerCase().startsWith('i prefer') ||
      trimmed.toLowerCase().startsWith('go with') ||
      trimmed.toLowerCase().startsWith('use option') ||
      trimmed.toLowerCase().startsWith('option ') ||
      trimmed.match(/^(yes|no|agreed|confirmed|approve)\b/i)
    ) {
      decisions.push(trimmed);
    }
  }

  // If no explicit decision lines, check for approach selection
  const approachMatch = reply.match(/(?:option|approach|choice)\s*(\d+)/i);
  if (approachMatch && decisions.length === 0) {
    decisions.push(`Selected approach ${approachMatch[1]}`);
  }

  return decisions;
}

/**
 * Check if a question has been resolved by recent decisions or the reply.
 */
function isQuestionResolved(
  question: string,
  resolvedDecisions: string[],
  latestReply: string
): boolean {
  const qLower = question.toLowerCase();
  const replyLower = latestReply.toLowerCase();

  // Check if the reply directly addresses key terms in the question
  const keyTerms = extractKeyTerms(qLower);
  const addressesQuestion = keyTerms.some((term) => replyLower.includes(term));

  // Check if any decision resolves this question
  const decisionResolves = resolvedDecisions.some((d) => {
    const dLower = d.toLowerCase();
    return keyTerms.some((term) => dLower.includes(term));
  });

  return addressesQuestion || decisionResolves;
}

/**
 * Extract key terms from a question for matching.
 */
function extractKeyTerms(question: string): string[] {
  const stopWords = new Set(['what', 'is', 'the', 'a', 'an', 'or', 'and', 'should', 'be', 'are', 'for', 'this', 'that', 'to', 'of']);
  return question
    .replace(/[?.,!]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));
}

/**
 * Build a follow-up response that only surfaces unresolved items.
 * Never restates resolved decisions.
 */
function buildFollowUpResponse(
  unresolvedQuestions: string[],
  newDecisions: string[],
  latestReply: string,
  history: ConversationEntry[]
): string {
  const sections: string[] = [];

  // Acknowledge new decisions briefly
  if (newDecisions.length > 0) {
    sections.push('Understood. Noted your decisions.\n');
  } else {
    sections.push('Thank you for your reply.\n');
  }

  // Only surface unresolved items
  if (unresolvedQuestions.length > 0) {
    sections.push('**Still unresolved:**');
    for (const q of unresolvedQuestions) {
      sections.push(`- ${q}`);
    }
    sections.push('');
  } else {
    sections.push('All design questions have been addressed. If you are satisfied with the direction, please reply with an approval keyword to proceed.\n');
  }

  sections.push('---\nReply with your thoughts or an approval keyword to proceed.');

  return sections.join('\n');
}

/**
 * Send the initial design brief email.
 * Must be sent within 5 minutes of design_needed=true.
 */
export async function sendDesignBrief(
  client: GmailClient,
  watcher: GmailWatcher,
  config: PMEmailLoopConfig,
  briefInput: DesignBriefInput,
  briefGenerator: DesignBriefGenerator,
  stateStore: EmailStateStore
): Promise<PMEmailLoopResult> {
  const brief = briefGenerator.generateBrief(briefInput);
  const emailBody = formatDesignBriefEmail(brief);

  const thread = await sendAndTrack(client, watcher, {
    runId: config.runId,
    to: config.pmEmail,
    repo: config.repo,
    issueNumber: config.issueNumber,
    issueTitle: config.issueTitle,
    body: emailBody,
    replyTo: config.replyToAddress,
  });

  // Persist state for restart-resume
  stateStore.saveThreadState(
    config.runId,
    thread,
    [],
    brief.openQuestions
  );

  return {
    action: 'email_sent',
    thread,
    briefSentAt: new Date().toISOString(),
  };
}

/**
 * Process a user reply in the email conversation loop.
 * Re-reads full thread history and responds within 60 seconds.
 * Never restates resolved decisions.
 * Exits loop on approval keyword detection.
 */
export async function processReply(
  client: GmailClient,
  watcher: GmailWatcher,
  config: PMEmailLoopConfig,
  thread: EmailThread,
  replyBody: string,
  resolvedDecisions: string[],
  unresolvedQuestions: string[],
  briefInput: DesignBriefInput,
  followUpGenerator: FollowUpGenerator,
  stateStore: EmailStateStore
): Promise<PMEmailLoopResult> {
  // Check for approval keyword first
  const approval = detectApproval(replyBody, config.approvalKeywords);
  if (approval.approved) {
    // Extract the agreed design from the conversation
    const agreedDesign = summarizeAgreedDesign(thread.conversationHistory, resolvedDecisions);

    // Clean up persisted state
    stateStore.deleteThreadState(config.runId);

    // Unregister the thread from the watcher
    watcher.unregisterThread(thread.threadId);

    return {
      action: 'approved',
      thread,
      approvalResult: approval,
      agreedDesign,
    };
  }

  // Generate follow-up response (re-reads full history, only surfaces unresolved)
  const followUpInput: FollowUpInput = {
    conversationHistory: thread.conversationHistory,
    latestReply: replyBody,
    designBriefInput: briefInput,
    resolvedDecisions,
    unresolvedQuestions,
  };

  const followUp = await followUpGenerator.generateFollowUp(followUpInput);

  // Send the follow-up response
  const message = buildEmailMessage({
    to: config.pmEmail,
    repo: config.repo,
    issueNumber: config.issueNumber,
    issueTitle: config.issueTitle,
    body: followUp.responseBody,
    replyTo: config.replyToAddress,
    threadId: thread.threadId,
  });

  const sendResult = await sendEmail(client, message);
  const timestamp = new Date().toISOString();

  // Update the thread with the agent's response
  const updatedThread = appendAgentMessageToThread(
    thread,
    followUp.responseBody,
    sendResult.messageId,
    timestamp
  );

  // Update the watcher's copy
  watcher.registerThread(updatedThread);

  // Persist updated state for restart-resume
  stateStore.saveThreadState(
    config.runId,
    updatedThread,
    followUp.resolvedDecisions,
    followUp.unresolvedQuestions
  );

  return {
    action: 'reply_processed',
    thread: updatedThread,
    approved: false,
  };
}

/**
 * Resume an EMAIL_PENDING conversation after a restart.
 * Loads persisted state and re-registers the thread with the watcher.
 */
export function resumeEmailLoop(
  watcher: GmailWatcher,
  stateStore: EmailStateStore,
  runId: string
): { thread: EmailThread; resolvedDecisions: string[]; unresolvedQuestions: string[] } | null {
  const state = stateStore.loadThreadState(runId);
  if (!state) return null;

  // Re-register with the watcher so it picks up new replies
  watcher.registerThread(state.thread);

  return state;
}

/**
 * Summarize the agreed design from the full conversation history.
 */
export function summarizeAgreedDesign(
  history: ConversationEntry[],
  resolvedDecisions: string[]
): string {
  const sections: string[] = [];

  sections.push('## Agreed Design Summary\n');

  if (resolvedDecisions.length > 0) {
    sections.push('**Decisions made:**');
    for (const decision of resolvedDecisions) {
      sections.push(`- ${decision}`);
    }
    sections.push('');
  }

  // Extract the original brief from the first agent message
  const firstAgentMessage = history.find((e) => e.role === 'agent');
  if (firstAgentMessage) {
    // Extract the issue summary from the brief
    const summaryMatch = firstAgentMessage.body.match(/\*\*Issue Summary:\*\*\s*(.+)/);
    if (summaryMatch) {
      sections.push(`**Issue:** ${summaryMatch[1]}`);
    }
  }

  // Include the number of conversation turns
  const userMessages = history.filter((e) => e.role === 'user');
  sections.push(`\n**Conversation turns:** ${userMessages.length}`);

  return sections.join('\n');
}

/**
 * Full PM email loop handler for the reply callback from GmailWatcher.
 * This is the ReplyHandler.onReply implementation that wakes the PM agent.
 */
export function createPMReplyHandler(
  client: GmailClient,
  watcher: GmailWatcher,
  configMap: Map<string, PMEmailLoopConfig>,
  briefInputMap: Map<string, DesignBriefInput>,
  followUpGenerator: FollowUpGenerator,
  stateStore: EmailStateStore,
  onApproval: (runId: string, agreedDesign: string) => Promise<void>,
  onReplyProcessed: (runId: string) => Promise<void>
): (runId: string, reply: import('./gmail-types').GmailReply, thread: EmailThread) => Promise<void> {
  return async (runId, reply, thread) => {
    const config = configMap.get(runId);
    const briefInput = briefInputMap.get(runId);
    if (!config || !briefInput) {
      throw new PMEmailLoopError(
        `No config found for run ${runId}`,
        'reply_handler',
        runId
      );
    }

    // Load current state
    const state = stateStore.loadThreadState(runId);
    const resolvedDecisions = state?.resolvedDecisions ?? [];
    const unresolvedQuestions = state?.unresolvedQuestions ?? [];

    const result = await processReply(
      client,
      watcher,
      config,
      thread,
      reply.body,
      resolvedDecisions,
      unresolvedQuestions,
      briefInput,
      followUpGenerator,
      stateStore
    );

    if (result.action === 'approved') {
      await onApproval(runId, result.agreedDesign);
    } else {
      await onReplyProcessed(runId);
    }
  };
}


