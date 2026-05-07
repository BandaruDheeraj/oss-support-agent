/**
 * Unit tests for the triage agent.
 *
 * Covers each issue_type classification, low-confidence path,
 * skip_pm_gate path, routing decisions, and clarification comments.
 */

import {
  TriageInput,
  TriageResult,
  TriageClassifier,
  IssueCommenter,
  IssueType,
} from './triage-types';
import {
  HeuristicClassifier,
  triageIssue,
  runTriage,
  buildClarificationComment,
  LOW_CONFIDENCE_THRESHOLD,
} from './triage';

// --- Test Fixtures ---

const baseInput: TriageInput = {
  title: 'Fix null pointer in UserService',
  body: 'The UserService crashes with a null pointer exception when the user has no email configured. Stack trace attached showing the error in src/services/user.ts line 42.',
  labels: ['bug'],
  author: 'testuser',
  moduleTaxonomy: ['bug_fix', 'new_feature', 'docs'],
  repoTree: ['src/', 'src/services/', 'src/utils/', 'docs/', 'tests/', 'README.md'],
  hasSkipPmGate: false,
};

const docsInput: TriageInput = {
  ...baseInput,
  title: 'Fix typo in README installation instructions',
  body: 'The README.md has a typo in the installation section. "npm instal" should be "npm install".',
  labels: ['documentation'],
};

const featureInput: TriageInput = {
  ...baseInput,
  title: 'Add support for GraphQL subscriptions',
  body: 'We need to implement GraphQL subscription support in the API module. This would allow real-time updates for connected clients.',
  labels: ['enhancement'],
};

const vagueInput: TriageInput = {
  ...baseInput,
  title: 'Something is wrong',
  body: '',
  labels: [],
};

const skipPmGateInput: TriageInput = {
  ...baseInput,
  hasSkipPmGate: true,
};

const conflictingInput: TriageInput = {
  ...baseInput,
  title: 'Add feature to fix the documentation bug',
  body: 'Need to add a new feature and also fix the documentation error. This is an enhancement that also fixes a bug in docs.',
  labels: [],
};

// --- Mock Classifier ---

class MockClassifier implements TriageClassifier {
  public result: TriageResult;

  constructor(result: TriageResult) {
    this.result = result;
  }

  async classify(_input: TriageInput): Promise<TriageResult> {
    return this.result;
  }
}

// --- Mock Commenter ---

class MockCommenter implements IssueCommenter {
  public comments: Array<{ repo: string; issueNumber: number; comment: string }> = [];

  async postComment(repo: string, issueNumber: number, comment: string): Promise<void> {
    this.comments.push({ repo, issueNumber, comment });
  }
}

// --- Tests ---

describe('HeuristicClassifier', () => {
  const classifier = new HeuristicClassifier();

  describe('issue type classification', () => {
    it('classifies bug_fix issues from labels', async () => {
      const result = await classifier.classify(baseInput);
      expect(result.issueType).toBe('bug_fix');
    });

    it('classifies docs issues from labels', async () => {
      const result = await classifier.classify(docsInput);
      expect(result.issueType).toBe('docs');
    });

    it('classifies new_feature issues from labels', async () => {
      const result = await classifier.classify(featureInput);
      expect(result.issueType).toBe('new_feature');
    });

    it('classifies bug_fix from keywords when no labels present', async () => {
      const input: TriageInput = {
        ...baseInput,
        labels: [],
        title: 'Error in authentication module causes crash',
        body: 'Getting a traceback when logging in. The error is a regression from last release.',
      };
      const result = await classifier.classify(input);
      expect(result.issueType).toBe('bug_fix');
    });

    it('classifies docs from keywords when no labels present', async () => {
      const input: TriageInput = {
        ...baseInput,
        labels: [],
        title: 'Update readme with new installation steps',
        body: 'The documentation is outdated. Need to update docs for the new CLI.',
      };
      const result = await classifier.classify(input);
      expect(result.issueType).toBe('docs');
    });

    it('classifies new_feature from keywords when no labels present', async () => {
      const input: TriageInput = {
        ...baseInput,
        labels: [],
        title: 'Proposal: Add support for OAuth2 PKCE flow',
        body: 'RFC for implementing a new API endpoint for PKCE-based authentication.',
      };
      const result = await classifier.classify(input);
      expect(result.issueType).toBe('new_feature');
    });

    it('falls back to first taxonomy type when ambiguous', async () => {
      const input: TriageInput = {
        ...baseInput,
        labels: [],
        title: 'Hello world',
        body: null,
        moduleTaxonomy: ['new_feature', 'docs'],
      };
      const result = await classifier.classify(input);
      expect(['new_feature', 'docs']).toContain(result.issueType);
    });
  });

  describe('affected module identification', () => {
    it('identifies module from path mentions in issue text', async () => {
      const result = await classifier.classify(baseInput);
      // Issue mentions src/services/user.ts, should match src/services/
      expect(result.affectedModule).toContain('src/services');
    });

    it('identifies docs module for documentation issues', async () => {
      const input: TriageInput = {
        ...docsInput,
        repoTree: ['src/', 'src/services/', 'docs/', 'docs/api/', 'README.md'],
      };
      const result = await classifier.classify(input);
      // README is mentioned in the issue
      expect(result.affectedModule).toBe('README.md');
    });

    it('returns first directory when no module match found', async () => {
      const input: TriageInput = {
        ...baseInput,
        title: 'Generic issue title',
        body: 'No file paths mentioned here at all.',
        labels: ['bug'],
        repoTree: ['lib/', 'lib/core/', 'lib/utils/'],
      };
      const result = await classifier.classify(input);
      expect(result.affectedModule).toBeTruthy();
    });
  });

  describe('confidence scoring', () => {
    it('gives high confidence to well-labeled issues with detailed body', async () => {
      const result = await classifier.classify(baseInput);
      expect(result.confidence).toBeGreaterThanOrEqual(LOW_CONFIDENCE_THRESHOLD);
    });

    it('gives low confidence to vague issues without labels', async () => {
      const result = await classifier.classify(vagueInput);
      expect(result.confidence).toBeLessThan(LOW_CONFIDENCE_THRESHOLD);
    });

    it('reduces confidence when multiple type signals conflict', async () => {
      const result = await classifier.classify(conflictingInput);
      // Conflicting signals should reduce confidence
      const clearResult = await classifier.classify(baseInput);
      expect(result.confidence).toBeLessThanOrEqual(clearResult.confidence);
    });

    it('confidence is always between 0 and 1', async () => {
      const inputs = [baseInput, docsInput, featureInput, vagueInput, conflictingInput];
      for (const input of inputs) {
        const result = await classifier.classify(input);
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('summary generation', () => {
    it('includes issue type in summary', async () => {
      const result = await classifier.classify(baseInput);
      expect(result.summary).toContain('Bug fix');
    });

    it('includes affected module in summary', async () => {
      const result = await classifier.classify(baseInput);
      expect(result.summary).toContain(result.affectedModule);
    });

    it('includes issue title in summary', async () => {
      const result = await classifier.classify(baseInput);
      expect(result.summary).toContain(baseInput.title);
    });
  });
});

describe('triageIssue', () => {
  describe('routing for bug_fix', () => {
    it('routes bug_fix to PM agent', async () => {
      const classifier = new MockClassifier({
        issueType: 'bug_fix',
        affectedModule: 'src/services/',
        confidence: 0.85,
        summary: 'Bug fix in src/services/: Fix null pointer',
      });
      const routing = await triageIssue(baseInput, classifier);
      expect(routing.action).toBe('route_pm');
      expect(routing.result.issueType).toBe('bug_fix');
    });
  });

  describe('routing for new_feature', () => {
    it('routes new_feature to PM agent', async () => {
      const classifier = new MockClassifier({
        issueType: 'new_feature',
        affectedModule: 'src/api/',
        confidence: 0.9,
        summary: 'New feature in src/api/: Add GraphQL support',
      });
      const routing = await triageIssue(featureInput, classifier);
      expect(routing.action).toBe('route_pm');
      expect(routing.result.issueType).toBe('new_feature');
    });
  });

  describe('routing for docs (fast path)', () => {
    it('routes docs directly to docs agent (skips PM)', async () => {
      const classifier = new MockClassifier({
        issueType: 'docs',
        affectedModule: 'README.md',
        confidence: 0.95,
        summary: 'Documentation update in README.md: Fix typo',
      });
      const routing = await triageIssue(docsInput, classifier);
      expect(routing.action).toBe('route_docs');
      expect(routing.result.issueType).toBe('docs');
    });
  });

  describe('low-confidence path', () => {
    it('returns clarify action when confidence is below threshold', async () => {
      const classifier = new MockClassifier({
        issueType: 'bug_fix',
        affectedModule: '/',
        confidence: 0.4,
        summary: 'Bug fix in /: Something is wrong',
      });
      const routing = await triageIssue(vagueInput, classifier);
      expect(routing.action).toBe('clarify');
      if (routing.action === 'clarify') {
        expect(routing.comment).toContain('not fully confident');
        expect(routing.comment).toContain('bug_fix');
        expect(routing.comment).toContain('40%');
      }
    });

    it('returns clarify when confidence is exactly at threshold boundary', async () => {
      const classifier = new MockClassifier({
        issueType: 'bug_fix',
        affectedModule: 'src/',
        confidence: 0.59,
        summary: 'Bug fix in src/: borderline issue',
      });
      const routing = await triageIssue(baseInput, classifier);
      expect(routing.action).toBe('clarify');
    });

    it('routes normally when confidence is exactly at threshold', async () => {
      const classifier = new MockClassifier({
        issueType: 'bug_fix',
        affectedModule: 'src/',
        confidence: 0.6,
        summary: 'Bug fix in src/: threshold issue',
      });
      const routing = await triageIssue(baseInput, classifier);
      expect(routing.action).toBe('route_pm');
    });
  });

  describe('skip_pm_gate path', () => {
    it('routes directly to fork when skip_pm_gate is set', async () => {
      const classifier = new MockClassifier({
        issueType: 'bug_fix',
        affectedModule: 'src/services/',
        confidence: 0.85,
        summary: 'Bug fix in src/services/: Fix null pointer',
      });
      const routing = await triageIssue(skipPmGateInput, classifier);
      expect(routing.action).toBe('route_fork');
    });

    it('skip_pm_gate routes to fork even for docs issues', async () => {
      const input: TriageInput = { ...docsInput, hasSkipPmGate: true };
      const classifier = new MockClassifier({
        issueType: 'docs',
        affectedModule: 'README.md',
        confidence: 0.9,
        summary: 'Docs update in README.md',
      });
      const routing = await triageIssue(input, classifier);
      expect(routing.action).toBe('route_fork');
    });

    it('skip_pm_gate does NOT override low confidence (clarify first)', async () => {
      const input: TriageInput = { ...vagueInput, hasSkipPmGate: true };
      const classifier = new MockClassifier({
        issueType: 'bug_fix',
        affectedModule: '/',
        confidence: 0.3,
        summary: 'Bug fix in /: vague',
      });
      const routing = await triageIssue(input, classifier);
      expect(routing.action).toBe('clarify');
    });
  });
});

describe('runTriage', () => {
  it('posts a clarification comment on low confidence', async () => {
    const classifier = new MockClassifier({
      issueType: 'bug_fix',
      affectedModule: '/',
      confidence: 0.3,
      summary: 'Bug fix in /: vague issue',
    });
    const commenter = new MockCommenter();

    const routing = await runTriage(
      'owner/repo',
      42,
      vagueInput,
      classifier,
      commenter
    );

    expect(routing.action).toBe('clarify');
    expect(commenter.comments).toHaveLength(1);
    expect(commenter.comments[0].repo).toBe('owner/repo');
    expect(commenter.comments[0].issueNumber).toBe(42);
    expect(commenter.comments[0].comment).toContain('not fully confident');
  });

  it('does NOT post a comment when confidence is sufficient', async () => {
    const classifier = new MockClassifier({
      issueType: 'bug_fix',
      affectedModule: 'src/',
      confidence: 0.85,
      summary: 'Bug fix in src/: Fix crash',
    });
    const commenter = new MockCommenter();

    await runTriage('owner/repo', 42, baseInput, classifier, commenter);

    expect(commenter.comments).toHaveLength(0);
  });

  it('returns routing result even when posting a comment', async () => {
    const classifier = new MockClassifier({
      issueType: 'new_feature',
      affectedModule: 'src/api/',
      confidence: 0.4,
      summary: 'New feature in src/api/: unclear',
    });
    const commenter = new MockCommenter();

    const routing = await runTriage('owner/repo', 7, featureInput, classifier, commenter);

    expect(routing.action).toBe('clarify');
    expect(routing.result.issueType).toBe('new_feature');
    expect(routing.result.confidence).toBe(0.4);
  });
});

describe('buildClarificationComment', () => {
  it('includes the classified type', () => {
    const result: TriageResult = {
      issueType: 'bug_fix',
      affectedModule: 'src/auth/',
      confidence: 0.45,
      summary: 'Bug fix in src/auth/',
    };
    const comment = buildClarificationComment(result);
    expect(comment).toContain('bug_fix');
  });

  it('includes the affected module', () => {
    const result: TriageResult = {
      issueType: 'docs',
      affectedModule: 'docs/api/',
      confidence: 0.5,
      summary: 'Docs update',
    };
    const comment = buildClarificationComment(result);
    expect(comment).toContain('docs/api/');
  });

  it('includes the confidence percentage', () => {
    const result: TriageResult = {
      issueType: 'new_feature',
      affectedModule: 'src/',
      confidence: 0.55,
      summary: 'Feature',
    };
    const comment = buildClarificationComment(result);
    expect(comment).toContain('55%');
  });

  it('asks for clarification questions', () => {
    const result: TriageResult = {
      issueType: 'bug_fix',
      affectedModule: '/',
      confidence: 0.3,
      summary: 'Vague',
    };
    const comment = buildClarificationComment(result);
    expect(comment).toContain('bug fix, new feature, or documentation');
    expect(comment).toContain('module or file');
  });
});

describe('timing', () => {
  it('triage completes in under 90 seconds (heuristic classifier)', async () => {
    const classifier = new HeuristicClassifier();
    const start = Date.now();
    await triageIssue(baseInput, classifier);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(90_000);
  });
});
