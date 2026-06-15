/**
 * PM agent design scoring for the OSS Autonomous Fix Loop.
 * Phase 1: Scores design complexity and auto-routes based on the score.
 *
 * Heuristics from PRD section 4.2:
 * - New or changed public API
 * - >= 3 related open issues
 * - Intentional but contested behaviour
 * - Change spans > 2 modules
 * - Title/body contains 'rethink', 'redesign', 'breaking', 'architecture'
 */

import {
  PMScoringInput,
  PMScoringResult,
  DesignSignal,
} from './pm-types';

/** Keywords that signal a design review is needed */
const DESIGN_KEYWORDS = ['rethink', 'redesign', 'breaking', 'architecture'];

/** Minimum related issues to trigger the "many related issues" heuristic */
const RELATED_ISSUES_THRESHOLD = 3;

/** Keywords indicating contested/intentional behaviour */
const CONTESTED_KEYWORDS = [
  'intentional',
  'by design',
  'wontfix',
  'controversial',
  'contested',
  'debatable',
  'opinionated',
  'trade-off',
  'tradeoff',
];

/** Keywords indicating public API changes */
const PUBLIC_API_KEYWORDS = [
  'public api',
  'exported',
  'breaking change',
  'api surface',
  'public interface',
  'external api',
  'sdk',
  'client library',
  'endpoint',
];

/**
 * Checks if the issue title/body contains design keywords.
 */
function checkDesignKeywords(title: string, body: string | null): DesignSignal {
  const text = `${title} ${body ?? ''}`.toLowerCase();
  const found = DESIGN_KEYWORDS.filter((kw) => text.includes(kw));
  return {
    rule: 'design_keywords',
    triggered: found.length > 0,
    detail:
      found.length > 0
        ? `Found design keywords: ${found.join(', ')}`
        : 'No design keywords found in title/body',
  };
}

/**
 * Checks if there are >= 3 related open issues for the same module/error/API.
 */
function checkRelatedIssuesCount(
  relatedIssues: PMScoringInput['relatedIssues']
): DesignSignal {
  const count = relatedIssues.length;
  return {
    rule: 'related_issues_count',
    triggered: count >= RELATED_ISSUES_THRESHOLD,
    detail:
      count >= RELATED_ISSUES_THRESHOLD
        ? `${count} related open issues found (threshold: ${RELATED_ISSUES_THRESHOLD})`
        : `Only ${count} related open issues (threshold: ${RELATED_ISSUES_THRESHOLD})`,
  };
}

/**
 * Checks if the change involves a new or changed public API.
 */
function checkPublicAPIChange(
  title: string,
  body: string | null,
  recentPRs: PMScoringInput['recentPRs']
): DesignSignal {
  const text = `${title} ${body ?? ''}`.toLowerCase();
  const hasAPIKeywords = PUBLIC_API_KEYWORDS.some((kw) => text.includes(kw));

  // Also check if recent PRs indicate API surface changes
  const apiPRs = recentPRs.filter(
    (pr) =>
      pr.title.toLowerCase().includes('api') ||
      pr.title.toLowerCase().includes('public') ||
      pr.title.toLowerCase().includes('export') ||
      pr.files_changed.some(
        (f) =>
          f.includes('index.') ||
          f.includes('api.') ||
          f.includes('types.') ||
          f.includes('.d.ts')
      )
  );

  const triggered = hasAPIKeywords || apiPRs.length > 0;
  return {
    rule: 'public_api_change',
    triggered,
    detail: triggered
      ? hasAPIKeywords
        ? `Issue mentions public API changes`
        : `${apiPRs.length} recent PRs touched API surface files`
      : 'No public API change indicators detected',
  };
}

/**
 * Checks if the change is intentional but contested behaviour.
 */
function checkContestedBehaviour(
  title: string,
  body: string | null,
  relatedIssues: PMScoringInput['relatedIssues']
): DesignSignal {
  const text = `${title} ${body ?? ''}`.toLowerCase();
  const hasContestedKeywords = CONTESTED_KEYWORDS.some((kw) =>
    text.includes(kw)
  );

  // Check if related issues have contested labels
  const contestedLabels = ['wontfix', 'by-design', 'controversial', 'needs-discussion'];
  const contestedIssues = relatedIssues.filter((issue) =>
    issue.labels.some((l) =>
      contestedLabels.some((cl) => l.toLowerCase().includes(cl))
    )
  );

  const triggered = hasContestedKeywords || contestedIssues.length > 0;
  return {
    rule: 'contested_behaviour',
    triggered,
    detail: triggered
      ? hasContestedKeywords
        ? `Issue text suggests intentional/contested behaviour`
        : `${contestedIssues.length} related issues have contested/wontfix labels`
      : 'No contested behaviour indicators detected',
  };
}

/**
 * Checks if the change spans more than 2 modules.
 */
function checkMultiModuleSpan(
  affectedModule: string,
  recentPRs: PMScoringInput['recentPRs'],
  body: string | null
): DesignSignal {
  // Identify distinct top-level modules from recent PRs and issue body
  const modules = new Set<string>();
  modules.add(getTopLevelModule(affectedModule));

  // Check recent PRs for cross-module changes
  for (const pr of recentPRs) {
    for (const file of pr.files_changed) {
      modules.add(getTopLevelModule(file));
    }
  }

  // Check if the body mentions other modules
  if (body) {
    const pathPattern = /(?:src|lib|packages?)\/([a-zA-Z0-9_-]+)/g;
    let match;
    while ((match = pathPattern.exec(body)) !== null) {
      modules.add(match[1]);
    }
  }

  const moduleCount = modules.size;
  const triggered = moduleCount > 2;
  return {
    rule: 'multi_module_span',
    triggered,
    detail: triggered
      ? `Change spans ${moduleCount} modules: ${Array.from(modules).slice(0, 5).join(', ')}`
      : `Change affects ${moduleCount} module(s)`,
  };
}

/**
 * Extracts the top-level module name from a file path.
 */
function getTopLevelModule(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);

  // Skip common prefixes
  const prefixes = ['src', 'lib', 'packages', 'pkg'];
  let startIdx = 0;
  if (parts.length > 1 && prefixes.includes(parts[0])) {
    startIdx = 1;
  }

  return parts[startIdx] ?? parts[0] ?? '/';
}

/**
 * Scores design complexity based on PRD section 4.2 heuristics.
 */
export function scoreDesign(input: PMScoringInput): PMScoringResult {
  const signals: DesignSignal[] = [
    checkDesignKeywords(input.title, input.body),
    checkRelatedIssuesCount(input.relatedIssues),
    checkPublicAPIChange(input.title, input.body, input.recentPRs),
    checkContestedBehaviour(input.title, input.body, input.relatedIssues),
    checkMultiModuleSpan(input.affectedModule, input.recentPRs, input.body),
  ];

  const triggeredSignals = signals.filter((s) => s.triggered);
  const designNeeded = triggeredSignals.length > 0;

  const reasoning = designNeeded
    ? `Design review needed: ${triggeredSignals.map((s) => s.detail).join('; ')}`
    : `No design review needed: all heuristic checks passed without triggering`;

  return { designNeeded, reasoning, signals };
}

