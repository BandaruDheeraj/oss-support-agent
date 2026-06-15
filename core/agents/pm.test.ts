/**
 * Unit tests for PM agent design scoring (US-005).
 * Covers each scoring heuristic from PRD section 4.2.
 */

import { scoreDesign } from './pm';
import { PMScoringInput } from './pm-types';

/** Helper to create a minimal valid input */
function makeInput(overrides: Partial<PMScoringInput> = {}): PMScoringInput {
  return {
    issueType: 'bug_fix',
    affectedModule: 'src/auth',
    summary: 'Bug fix in src/auth: Login fails on expired tokens',
    title: 'Login fails on expired tokens',
    body: 'When a token expires, the login flow throws an unhandled error.',
    labels: ['bug'],
    relatedIssues: [],
    recentPRs: [],
    designDocs: [],
    ...overrides,
  };
}

describe('PM Agent Design Scoring', () => {
  describe('Design Keywords Heuristic', () => {
    it('triggers when title contains "redesign"', () => {
      const input = makeInput({ title: 'Redesign the auth module' });
      const result = scoreDesign(input);
      expect(result.designNeeded).toBe(true);
      const signal = result.signals.find((s) => s.rule === 'design_keywords');
      expect(signal?.triggered).toBe(true);
      expect(signal?.detail).toContain('redesign');
    });

    it('triggers when title contains "breaking"', () => {
      const input = makeInput({ title: 'Breaking change to the API' });
      const result = scoreDesign(input);
      expect(result.designNeeded).toBe(true);
      const signal = result.signals.find((s) => s.rule === 'design_keywords');
      expect(signal?.triggered).toBe(true);
      expect(signal?.detail).toContain('breaking');
    });

    it('triggers when body contains "architecture"', () => {
      const input = makeInput({
        body: 'We need to rethink the architecture of this module',
      });
      const result = scoreDesign(input);
      expect(result.designNeeded).toBe(true);
      const signal = result.signals.find((s) => s.rule === 'design_keywords');
      expect(signal?.triggered).toBe(true);
    });

    it('triggers when body contains "rethink"', () => {
      const input = makeInput({
        body: 'We should rethink this approach entirely',
      });
      const result = scoreDesign(input);
      expect(result.designNeeded).toBe(true);
      const signal = result.signals.find((s) => s.rule === 'design_keywords');
      expect(signal?.triggered).toBe(true);
      expect(signal?.detail).toContain('rethink');
    });

    it('does not trigger on normal issue text', () => {
      const input = makeInput({
        title: 'Fix null pointer in auth handler',
        body: 'The handler crashes when user is null.',
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'design_keywords');
      expect(signal?.triggered).toBe(false);
    });

    it('is case-insensitive', () => {
      const input = makeInput({ title: 'BREAKING CHANGE to Auth' });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'design_keywords');
      expect(signal?.triggered).toBe(true);
    });
  });

  describe('Related Issues Count Heuristic', () => {
    it('triggers when >= 3 related issues exist', () => {
      const input = makeInput({
        relatedIssues: [
          { number: 1, title: 'Issue 1', labels: [], reason: 'same module' },
          { number: 2, title: 'Issue 2', labels: [], reason: 'same error' },
          { number: 3, title: 'Issue 3', labels: [], reason: 'same API' },
        ],
      });
      const result = scoreDesign(input);
      expect(result.designNeeded).toBe(true);
      const signal = result.signals.find((s) => s.rule === 'related_issues_count');
      expect(signal?.triggered).toBe(true);
      expect(signal?.detail).toContain('3');
    });

    it('triggers when > 3 related issues exist', () => {
      const input = makeInput({
        relatedIssues: [
          { number: 1, title: 'Issue 1', labels: [], reason: 'same module' },
          { number: 2, title: 'Issue 2', labels: [], reason: 'same error' },
          { number: 3, title: 'Issue 3', labels: [], reason: 'same API' },
          { number: 4, title: 'Issue 4', labels: [], reason: 'duplicate' },
        ],
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'related_issues_count');
      expect(signal?.triggered).toBe(true);
    });

    it('does not trigger when < 3 related issues', () => {
      const input = makeInput({
        relatedIssues: [
          { number: 1, title: 'Issue 1', labels: [], reason: 'same module' },
          { number: 2, title: 'Issue 2', labels: [], reason: 'same error' },
        ],
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'related_issues_count');
      expect(signal?.triggered).toBe(false);
    });

    it('does not trigger with zero related issues', () => {
      const input = makeInput({ relatedIssues: [] });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'related_issues_count');
      expect(signal?.triggered).toBe(false);
    });
  });

  describe('Public API Change Heuristic', () => {
    it('triggers when issue mentions "public api"', () => {
      const input = makeInput({
        title: 'Change the public api for user service',
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'public_api_change');
      expect(signal?.triggered).toBe(true);
    });

    it('triggers when issue mentions "breaking change"', () => {
      const input = makeInput({
        body: 'This introduces a breaking change to the SDK',
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'public_api_change');
      expect(signal?.triggered).toBe(true);
    });

    it('triggers when recent PRs touched API surface files', () => {
      const input = makeInput({
        title: 'Fix token validation',
        body: 'Tokens are not validated correctly.',
        recentPRs: [
          {
            number: 100,
            title: 'Update types',
            files_changed: ['src/auth/types.ts', 'src/auth/index.ts'],
            merged_at: '2026-05-01',
          },
        ],
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'public_api_change');
      expect(signal?.triggered).toBe(true);
    });

    it('does not trigger on internal-only changes', () => {
      const input = makeInput({
        title: 'Fix internal cache invalidation',
        body: 'The internal cache is not cleared properly.',
        recentPRs: [
          {
            number: 101,
            title: 'Fix cache bug',
            files_changed: ['src/auth/cache.ts'],
            merged_at: '2026-05-01',
          },
        ],
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'public_api_change');
      expect(signal?.triggered).toBe(false);
    });
  });

  describe('Contested Behaviour Heuristic', () => {
    it('triggers when body mentions "intentional" behaviour', () => {
      const input = makeInput({
        body: 'This behaviour is intentional but confusing to users',
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'contested_behaviour');
      expect(signal?.triggered).toBe(true);
    });

    it('triggers when body mentions "by design"', () => {
      const input = makeInput({
        body: 'The current behaviour is by design but needs reconsideration',
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'contested_behaviour');
      expect(signal?.triggered).toBe(true);
    });

    it('triggers when related issues have wontfix labels', () => {
      const input = makeInput({
        relatedIssues: [
          {
            number: 50,
            title: 'Same issue reported before',
            labels: ['wontfix'],
            reason: 'same error pattern',
          },
        ],
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'contested_behaviour');
      expect(signal?.triggered).toBe(true);
    });

    it('triggers when related issues have "needs-discussion" label', () => {
      const input = makeInput({
        relatedIssues: [
          {
            number: 60,
            title: 'Debate about this feature',
            labels: ['needs-discussion'],
            reason: 'same module',
          },
        ],
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'contested_behaviour');
      expect(signal?.triggered).toBe(true);
    });

    it('does not trigger on straightforward issues', () => {
      const input = makeInput({
        title: 'Fix null check',
        body: 'Missing null check causes crash',
        relatedIssues: [
          {
            number: 70,
            title: 'Similar crash',
            labels: ['bug'],
            reason: 'same error',
          },
        ],
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'contested_behaviour');
      expect(signal?.triggered).toBe(false);
    });
  });

  describe('Multi-Module Span Heuristic', () => {
    it('triggers when recent PRs span > 2 modules', () => {
      const input = makeInput({
        affectedModule: 'src/auth',
        recentPRs: [
          {
            number: 200,
            title: 'Cross-cutting change',
            files_changed: [
              'src/auth/handler.ts',
              'src/billing/invoice.ts',
              'src/notifications/email.ts',
            ],
            merged_at: '2026-05-01',
          },
        ],
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'multi_module_span');
      expect(signal?.triggered).toBe(true);
    });

    it('triggers when body references multiple modules', () => {
      const input = makeInput({
        affectedModule: 'src/auth',
        body: 'This affects src/billing and src/notifications as well as src/api',
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'multi_module_span');
      expect(signal?.triggered).toBe(true);
    });

    it('does not trigger for single-module changes', () => {
      const input = makeInput({
        affectedModule: 'src/auth',
        recentPRs: [
          {
            number: 201,
            title: 'Auth fix',
            files_changed: ['src/auth/handler.ts', 'src/auth/utils.ts'],
            merged_at: '2026-05-01',
          },
        ],
        body: 'Only the auth module is affected.',
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'multi_module_span');
      expect(signal?.triggered).toBe(false);
    });

    it('does not trigger for exactly 2 modules', () => {
      const input = makeInput({
        affectedModule: 'src/auth',
        recentPRs: [
          {
            number: 202,
            title: 'Auth + utils fix',
            files_changed: ['src/auth/handler.ts', 'src/utils/helper.ts'],
            merged_at: '2026-05-01',
          },
        ],
      });
      const result = scoreDesign(input);
      const signal = result.signals.find((s) => s.rule === 'multi_module_span');
      expect(signal?.triggered).toBe(false);
    });
  });

  describe('scoreDesign integration', () => {
    it('returns designNeeded=false when no heuristics trigger', () => {
      const input = makeInput({
        title: 'Fix null pointer in auth handler',
        body: 'The handler crashes when user is null.',
        relatedIssues: [],
        recentPRs: [],
      });
      const result = scoreDesign(input);
      expect(result.designNeeded).toBe(false);
      expect(result.signals).toHaveLength(5);
      expect(result.signals.every((s) => !s.triggered)).toBe(true);
    });

    it('returns designNeeded=true when any single heuristic triggers', () => {
      const input = makeInput({ title: 'Redesign auth flow' });
      const result = scoreDesign(input);
      expect(result.designNeeded).toBe(true);
    });

    it('returns designNeeded=true when multiple heuristics trigger', () => {
      const input = makeInput({
        title: 'Redesign the public API',
        body: 'This is a breaking change that spans multiple modules. See src/billing and src/notifications and src/api for details.',
        relatedIssues: [
          { number: 1, title: 'Related', labels: ['wontfix'], reason: 'same' },
          { number: 2, title: 'Related', labels: [], reason: 'same' },
          { number: 3, title: 'Related', labels: [], reason: 'same' },
        ],
      });
      const result = scoreDesign(input);
      expect(result.designNeeded).toBe(true);
      const triggeredCount = result.signals.filter((s) => s.triggered).length;
      expect(triggeredCount).toBeGreaterThan(1);
    });

    it('includes reasoning summary', () => {
      const input = makeInput({ title: 'Redesign auth' });
      const result = scoreDesign(input);
      expect(result.reasoning).toContain('Design review needed');
    });

    it('reasoning explains why no design is needed', () => {
      const input = makeInput({
        title: 'Fix typo in error message',
        body: 'Simple typo fix.',
      });
      const result = scoreDesign(input);
      expect(result.reasoning).toContain('No design review needed');
    });
  });


});
