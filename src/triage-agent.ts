/**
 * Triage agent for the OSS Autonomous Fix Loop.
 *
 * Classifies issues (bug_fix / new_feature / docs), identifies affected modules,
 * emits confidence scores, and routes to the appropriate downstream agent.
 */

import {
  TriageInput,
  TriageResult,
  TriageRouting,
  TriageClassifier,
  IssueCommenter,
  IssueType,
} from './triage-types';

/** Confidence threshold below which a clarification comment is posted. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Default LLM-based classifier implementation.
 * Uses heuristics and keyword matching as a deterministic fallback
 * when no LLM provider is configured.
 */
export class HeuristicClassifier implements TriageClassifier {
  async classify(input: TriageInput): Promise<TriageResult> {
    const text = `${input.title} ${input.body ?? ''}`.toLowerCase();
    const labels = input.labels.map((l) => l.toLowerCase());

    const issueType = this.classifyType(text, labels, input.moduleTaxonomy);
    const affectedModule = this.identifyModule(text, input.repoTree);
    const confidence = this.computeConfidence(text, labels, issueType, affectedModule, input);
    const summary = this.generateSummary(input.title, issueType, affectedModule);

    return { issueType, affectedModule, confidence, summary };
  }

  private classifyType(
    text: string,
    labels: string[],
    taxonomy: IssueType[]
  ): IssueType {
    // Label-based classification takes priority
    if (labels.some((l) => l.includes('doc') || l.includes('documentation') || l.includes('typo'))) {
      if (taxonomy.includes('docs')) return 'docs';
    }
    if (labels.some((l) => l.includes('bug') || l.includes('fix') || l.includes('defect'))) {
      if (taxonomy.includes('bug_fix')) return 'bug_fix';
    }
    if (labels.some((l) => l.includes('feature') || l.includes('enhancement') || l.includes('request'))) {
      if (taxonomy.includes('new_feature')) return 'new_feature';
    }

    // Keyword-based classification
    const docsKeywords = [
      'readme', 'documentation', 'typo', 'spelling', 'docs',
      'javadoc', 'docstring', 'comment', 'changelog',
    ];
    const bugKeywords = [
      'bug', 'error', 'fix', 'crash', 'broken', 'failing',
      'regression', 'not working', 'unexpected', 'traceback',
      'exception', 'stack trace', 'segfault', 'panic',
    ];
    const featureKeywords = [
      'feature', 'add support', 'new api', 'implement',
      'enhancement', 'proposal', 'rfc', 'request',
    ];

    const docsScore = docsKeywords.filter((k) => text.includes(k)).length;
    const bugScore = bugKeywords.filter((k) => text.includes(k)).length;
    const featureScore = featureKeywords.filter((k) => text.includes(k)).length;

    if (docsScore > bugScore && docsScore > featureScore && taxonomy.includes('docs')) {
      return 'docs';
    }
    if (bugScore >= featureScore && taxonomy.includes('bug_fix')) {
      return 'bug_fix';
    }
    if (taxonomy.includes('new_feature')) {
      return 'new_feature';
    }
    // Fallback to first available type
    return taxonomy[0] ?? 'bug_fix';
  }

  private identifyModule(text: string, repoTree: string[]): string {
    // Try to match repo tree paths mentioned in the issue text
    const normalizedText = text.replace(/\\/g, '/');

    // Score each tree path by how well it matches mentions in the text
    let bestMatch = '';
    let bestScore = 0;

    for (const path of repoTree) {
      const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
      let score = 0;

      // Check if the full path or parts are mentioned
      if (normalizedText.includes(path.replace(/\\/g, '/'))) {
        score = parts.length * 3;
      } else {
        for (const part of parts) {
          if (part.length > 2 && normalizedText.includes(part.toLowerCase())) {
            score += 1;
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = path;
      }
    }

    // If no match found, return the root or first directory
    if (!bestMatch) {
      const dirs = repoTree.filter((p) => !p.includes('.') || p.includes('/'));
      return dirs[0] ?? '/';
    }

    return bestMatch;
  }

  private computeConfidence(
    text: string,
    labels: string[],
    issueType: IssueType,
    affectedModule: string,
    input: TriageInput
  ): number {
    let confidence = 0.5;

    // Labels boost confidence significantly
    const hasRelevantLabel = labels.some(
      (l) =>
        l.includes('bug') ||
        l.includes('doc') ||
        l.includes('feature') ||
        l.includes('enhancement')
    );
    if (hasRelevantLabel) confidence += 0.2;

    // Body presence boosts confidence
    if (input.body && input.body.length > 50) confidence += 0.1;

    // Module identification boosts confidence
    if (affectedModule !== '/' && affectedModule !== '') confidence += 0.1;

    // Very short/vague issues reduce confidence
    if (!input.body || input.body.length < 20) confidence -= 0.2;
    if (input.title.split(' ').length < 3) confidence -= 0.1;

    // Multiple type signals conflicting reduce confidence
    const bugSignals = ['bug', 'fix', 'error', 'crash'].filter((k) => text.includes(k)).length;
    const featureSignals = ['feature', 'add', 'new', 'implement'].filter((k) => text.includes(k)).length;
    const docsSignals = ['doc', 'readme', 'typo'].filter((k) => text.includes(k)).length;

    const maxSignal = Math.max(bugSignals, featureSignals, docsSignals);
    const secondMax = [bugSignals, featureSignals, docsSignals]
      .sort((a, b) => b - a)[1];
    if (maxSignal > 0 && secondMax > 0 && maxSignal - secondMax <= 1) {
      confidence -= 0.15;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  private generateSummary(
    title: string,
    issueType: IssueType,
    affectedModule: string
  ): string {
    const typeLabel =
      issueType === 'bug_fix'
        ? 'Bug fix'
        : issueType === 'new_feature'
        ? 'New feature'
        : 'Documentation update';
    return `${typeLabel} in ${affectedModule}: ${title}`;
  }
}

/**
 * Generates a clarification comment for low-confidence triage results.
 */
export function buildClarificationComment(result: TriageResult): string {
  return (
    `🤖 **Triage Bot**: I'm not fully confident in my classification of this issue.\n\n` +
    `**Current classification:**\n` +
    `- Type: \`${result.issueType}\`\n` +
    `- Affected module: \`${result.affectedModule}\`\n` +
    `- Confidence: ${(result.confidence * 100).toFixed(0)}%\n\n` +
    `Could you help clarify:\n` +
    `1. Is this a bug fix, new feature, or documentation issue?\n` +
    `2. Which module or file is primarily affected?\n\n` +
    `This will help me route the issue to the right agent. ` +
    `Please reply or update labels to clarify.`
  );
}

/**
 * Core triage function: classifies an issue and determines routing.
 *
 * @param input - Triage input with issue details and repo context
 * @param classifier - LLM/heuristic classifier implementation
 * @returns Routing decision with triage result
 */
export async function triageIssue(
  input: TriageInput,
  classifier: TriageClassifier
): Promise<TriageRouting> {
  const result = await classifier.classify(input);

  // Low confidence: post clarification comment and halt
  if (result.confidence < LOW_CONFIDENCE_THRESHOLD) {
    const comment = buildClarificationComment(result);
    return { action: 'clarify', result, comment };
  }

  // skip_pm_gate: route directly to fork creation regardless of type
  if (input.hasSkipPmGate) {
    return { action: 'route_fork', result };
  }

  // Route based on issue type
  switch (result.issueType) {
    case 'docs':
      return { action: 'route_docs', result };
    case 'bug_fix':
    case 'new_feature':
      return { action: 'route_pm', result };
    default:
      return { action: 'route_pm', result };
  }
}

/**
 * Full triage pipeline: classifies, routes, and performs side effects
 * (posting comments on low confidence).
 *
 * @param repo - Repository full name (owner/repo)
 * @param issueNumber - Issue number
 * @param input - Triage input
 * @param classifier - LLM/heuristic classifier
 * @param commenter - GitHub issue commenter
 * @returns Routing decision
 */
export async function runTriage(
  repo: string,
  issueNumber: number,
  input: TriageInput,
  classifier: TriageClassifier,
  commenter: IssueCommenter
): Promise<TriageRouting> {
  const routing = await triageIssue(input, classifier);

  // Post clarification comment on low confidence
  if (routing.action === 'clarify') {
    await commenter.postComment(repo, issueNumber, routing.comment);
  }

  return routing;
}
