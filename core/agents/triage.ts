/**
 * Triage agent for the OSS Autonomous Fix Loop.
 *
 * Classifies issues (bug_fix / new_feature / docs), identifies affected modules,
 * emits confidence scores, and routes to the appropriate downstream agent.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { Issue, RepoAdapter } from '../adapter.interface';
import { AdapterContractError } from '../adapter-loader';
import {
  TriageInput,
  TriageResult,
  TriageRouting,
  TriageTypeClassifier,
  IssueCommenter,
  IssueType,
} from './triage-types';

/** Confidence threshold below which a clarification comment is posted. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Core issue-type classifier. Module routing is intentionally adapter-owned. */
export class DefaultIssueTypeClassifier implements TriageTypeClassifier {
  async classifyIssueType(input: TriageInput): Promise<IssueType> {
    return classifyIssueType(input);
  }
}

/** Classifies only the issue type (bug/feature/docs), never the module path. */
export function classifyIssueType(input: TriageInput): IssueType {
  const text = `${input.title} ${input.body ?? ''}`.toLowerCase();
  const labels = input.labels.map((l) => l.toLowerCase());
  const taxonomy = input.moduleTaxonomy ?? ['bug_fix', 'new_feature', 'docs'];

  if (labels.some((l) => l.includes('doc') || l.includes('documentation') || l.includes('typo'))) {
    if (taxonomy.includes('docs')) return 'docs';
  }
  if (labels.some((l) => l.includes('bug') || l.includes('fix') || l.includes('defect'))) {
    if (taxonomy.includes('bug_fix')) return 'bug_fix';
  }
  if (labels.some((l) => l.includes('feature') || l.includes('enhancement') || l.includes('request'))) {
    if (taxonomy.includes('new_feature')) return 'new_feature';
  }

  const docsKeywords = ['readme', 'documentation', 'typo', 'spelling', 'docs', 'javadoc', 'docstring', 'comment', 'changelog'];
  const bugKeywords = ['bug', 'error', 'fix', 'crash', 'broken', 'failing', 'regression', 'not working', 'unexpected', 'traceback', 'exception', 'stack trace', 'segfault', 'panic'];
  const featureKeywords = ['feature', 'add support', 'new api', 'implement', 'enhancement', 'proposal', 'rfc', 'request'];

  const docsScore = docsKeywords.filter((k) => text.includes(k)).length;
  const bugScore = bugKeywords.filter((k) => text.includes(k)).length;
  const featureScore = featureKeywords.filter((k) => text.includes(k)).length;

  if (docsScore > bugScore && docsScore > featureScore && taxonomy.includes('docs')) return 'docs';
  if (bugScore >= featureScore && taxonomy.includes('bug_fix')) return 'bug_fix';
  if (taxonomy.includes('new_feature')) return 'new_feature';
  return taxonomy[0] ?? 'bug_fix';
}

/** Validates adapter module routing before downstream agents use it. */
export function validateClassifiedModulePath(
  modulePath: string,
  repoRoot: string,
  repoFullName = 'unknown/unknown',
  adapterPath = 'adapter.classifyModule'
): string {
  const normalized = modulePath.replace(/\\/g, '/').replace(/\/+$/g, '');
  const candidate = normalized === '' ? '.' : normalized;

  if (path.isAbsolute(candidate) || candidate.startsWith('/') || candidate.split('/').includes('..')) {
    throwInvalidModule(candidate, repoFullName, adapterPath, 'Path must be relative and cannot contain ".."');
  }

  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throwInvalidModule(candidate, repoFullName, adapterPath, 'Path resolves outside the repository root');
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throwInvalidModule(candidate, repoFullName, adapterPath, 'Path does not exist in the cloned fork');
  }
  if (!stat.isDirectory()) {
    throwInvalidModule(candidate, repoFullName, adapterPath, 'Path must resolve to a directory');
  }

  return candidate;
}

function throwInvalidModule(modulePath: string, repoFullName: string, adapterPath: string, reason: string): never {
  throw new AdapterContractError({
    message: `Invalid classifyModule return value "${modulePath}": ${reason}`,
    code: 'invalid_classify_module',
    repoFullName,
    adapterPath,
  });
}

function buildAdapterIssue(input: TriageInput, issueNumber: number): Issue {
  return {
    number: input.number ?? issueNumber,
    title: input.title,
    body: input.body ?? '',
    labels: [...input.labels],
    url: input.url,
  };
}

function computeConfidence(input: TriageInput, affectedModule: string): number {
  const text = `${input.title} ${input.body ?? ''}`.toLowerCase();
  const labels = input.labels.map((l) => l.toLowerCase());
  let confidence = 0.5;

  const hasRelevantLabel = labels.some((l) => l.includes('bug') || l.includes('doc') || l.includes('feature') || l.includes('enhancement'));
  if (hasRelevantLabel) confidence += 0.2;
  if (input.body && input.body.length > 50) confidence += 0.1;
  if (affectedModule !== '.' && affectedModule !== '') confidence += 0.1;
  if (!input.body || input.body.length < 20) confidence -= 0.2;
  if (input.title.split(' ').length < 3) confidence -= 0.1;

  const bugSignals = ['bug', 'fix', 'error', 'crash'].filter((k) => text.includes(k)).length;
  const featureSignals = ['feature', 'add', 'new', 'implement'].filter((k) => text.includes(k)).length;
  const docsSignals = ['doc', 'readme', 'typo'].filter((k) => text.includes(k)).length;
  const maxSignal = Math.max(bugSignals, featureSignals, docsSignals);
  const secondMax = [bugSignals, featureSignals, docsSignals].sort((a, b) => b - a)[1];
  if (maxSignal > 0 && secondMax > 0 && maxSignal - secondMax <= 1) confidence -= 0.15;

  return Math.max(0, Math.min(1, confidence));
}

function generateSummary(title: string, issueType: IssueType, affectedModule: string): string {
  const typeLabel = issueType === 'bug_fix' ? 'Bug fix' : issueType === 'new_feature' ? 'New feature' : 'Documentation update';
  return `${typeLabel} in ${affectedModule}: ${title}`;
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

export interface TriageOptions {
  issueNumber?: number;
  clonedRepoRoot?: string;
  repoFullName?: string;
  adapterPath?: string;
  typeClassifier?: TriageTypeClassifier;
}

/** Core triage function: classifies issue type, asks adapter for module, and routes. */
export async function triageIssue(
  input: TriageInput,
  adapter: RepoAdapter,
  options: TriageOptions = {}
): Promise<TriageRouting> {
  const issueNumber = options.issueNumber ?? input.number ?? 0;
  const repoRoot = options.clonedRepoRoot ?? input.clonedRepoRoot ?? process.cwd();
  const typeClassifier = options.typeClassifier ?? new DefaultIssueTypeClassifier();

  const issueType = await typeClassifier.classifyIssueType(input);
  const rawModule = await adapter.classifyModule(buildAdapterIssue(input, issueNumber));
  const affectedModule = validateClassifiedModulePath(
    rawModule,
    repoRoot,
    options.repoFullName,
    options.adapterPath
  );
  const confidence = computeConfidence(input, affectedModule);
  const result: TriageResult = {
    issueType,
    affectedModule,
    confidence,
    summary: generateSummary(input.title, issueType, affectedModule),
  };

  if (result.confidence < LOW_CONFIDENCE_THRESHOLD) {
    const comment = buildClarificationComment(result);
    return { action: 'clarify', result, comment };
  }

  if (input.hasSkipPmGate) {
    return { action: 'route_fork', result };
  }

  switch (result.issueType) {
    case 'docs':
      return { action: 'route_docs', result };
    case 'bug_fix':
    case 'new_feature':
    default:
      return { action: 'route_pm', result };
  }
}

/** Full triage pipeline including low-confidence comment side effects. */
export async function runTriage(
  repo: string,
  issueNumber: number,
  input: TriageInput,
  adapter: RepoAdapter,
  commenter: IssueCommenter,
  options: Omit<TriageOptions, 'issueNumber' | 'repoFullName'> = {}
): Promise<TriageRouting> {
  const routing = await triageIssue(input, adapter, {
    ...options,
    issueNumber,
    repoFullName: repo,
  });

  if (routing.action === 'clarify') {
    await commenter.postComment(repo, issueNumber, routing.comment);
  }

  return routing;
}
