/** Unit tests for adapter-backed triage. */

import { BaseRepoAdapter, Issue } from '../adapter.interface';
import { AdapterContractError } from '../adapter-loader';
import {
  DefaultIssueTypeClassifier,
  classifyIssueType,
  triageIssue,
  runTriage,
  buildClarificationComment,
  validateClassifiedModulePath,
  LOW_CONFIDENCE_THRESHOLD,
} from './triage';
import { IssueCommenter, TriageInput, TriageResult } from './triage-types';

const repoRoot = process.cwd();

const baseInput: TriageInput = {
  number: 42,
  title: 'Fix null pointer in UserService',
  body: 'The UserService crashes with a null pointer exception when the user has no email configured.',
  labels: ['bug'],
  author: 'testuser',
  moduleTaxonomy: ['bug_fix', 'new_feature', 'docs'],
  repoTree: ['core/', 'docs/'],
  hasSkipPmGate: false,
  clonedRepoRoot: repoRoot,
};

class FakeAdapter extends BaseRepoAdapter {
  public issues: Issue[] = [];

  constructor(private readonly modulePath = 'core') {
    super();
  }

  async classifyModule(issue: Issue): Promise<string> {
    this.issues.push(issue);
    return this.modulePath;
  }
}

class MockCommenter implements IssueCommenter {
  public comments: Array<{ repo: string; issueNumber: number; comment: string }> = [];

  async postComment(repo: string, issueNumber: number, comment: string): Promise<void> {
    this.comments.push({ repo, issueNumber, comment });
  }
}

describe('classifyIssueType', () => {
  it('classifies bug_fix issues from labels', () => {
    expect(classifyIssueType(baseInput)).toBe('bug_fix');
  });

  it('classifies docs issues from labels', () => {
    expect(classifyIssueType({ ...baseInput, labels: ['documentation'] })).toBe('docs');
  });

  it('classifies new_feature issues from labels', () => {
    expect(classifyIssueType({ ...baseInput, labels: ['enhancement'] })).toBe('new_feature');
  });

  it('classifies bug_fix from keywords when no labels exist', () => {
    expect(classifyIssueType({ ...baseInput, labels: [], title: 'Crash on login', body: 'traceback regression' })).toBe('bug_fix');
  });

  it('classifies docs from keywords when no labels exist', () => {
    expect(classifyIssueType({ ...baseInput, labels: [], title: 'Update README', body: 'documentation typo' })).toBe('docs');
  });

  it('classifies new_feature from keywords when no labels exist', () => {
    expect(classifyIssueType({ ...baseInput, labels: [], title: 'Proposal add support', body: 'implement new API' })).toBe('new_feature');
  });

  it('falls back to the first taxonomy value', () => {
    expect(classifyIssueType({ ...baseInput, labels: [], title: 'Hello', body: null, moduleTaxonomy: ['docs'] })).toBe('docs');
  });

  it('DefaultIssueTypeClassifier delegates to classifyIssueType', async () => {
    await expect(new DefaultIssueTypeClassifier().classifyIssueType(baseInput)).resolves.toBe('bug_fix');
  });
});

describe('validateClassifiedModulePath', () => {
  it('accepts an existing relative directory', () => {
    expect(validateClassifiedModulePath('core', repoRoot)).toBe('core');
  });

  it('accepts the repository root dot path', () => {
    expect(validateClassifiedModulePath('.', repoRoot)).toBe('.');
  });

  it('rejects leading slash paths', () => {
    expect(() => validateClassifiedModulePath('/core', repoRoot)).toThrow(AdapterContractError);
  });

  it('rejects parent traversal', () => {
    expect(() => validateClassifiedModulePath('../core', repoRoot)).toThrow(AdapterContractError);
  });

  it('rejects non-existent directories', () => {
    expect(() => validateClassifiedModulePath('does-not-exist', repoRoot)).toThrow(AdapterContractError);
  });

  it('rejects files because downstream agents require a directory', () => {
    expect(() => validateClassifiedModulePath('package.json', repoRoot)).toThrow(AdapterContractError);
  });
});

describe('triageIssue', () => {
  it('calls adapter.classifyModule with documented issue fields', async () => {
    const adapter = new FakeAdapter('core');
    await triageIssue(baseInput, adapter);
    expect(adapter.issues).toEqual([{ number: 42, title: baseInput.title, body: baseInput.body, labels: baseInput.labels, url: undefined }]);
  });

  it('uses the adapter module as affectedModule', async () => {
    const routing = await triageIssue(baseInput, new FakeAdapter('core/agents'));
    expect(routing.result.affectedModule).toBe('core/agents');
  });

  it('routes bug_fix to PM', async () => {
    const routing = await triageIssue(baseInput, new FakeAdapter('core'));
    expect(routing.action).toBe('route_pm');
  });

  it('routes new_feature to PM', async () => {
    const routing = await triageIssue({ ...baseInput, labels: ['enhancement'] }, new FakeAdapter('core'));
    expect(routing.action).toBe('route_pm');
    expect(routing.result.issueType).toBe('new_feature');
  });

  it('routes docs directly to docs agent', async () => {
    const routing = await triageIssue({ ...baseInput, labels: ['docs'], title: 'Fix docs' }, new FakeAdapter('core'));
    expect(routing.action).toBe('route_docs');
  });

  it('routes directly to fork when skip_pm_gate is set', async () => {
    const routing = await triageIssue({ ...baseInput, hasSkipPmGate: true }, new FakeAdapter('core'));
    expect(routing.action).toBe('route_fork');
  });

  it('returns clarify for low-confidence issues before skip_pm_gate routing', async () => {
    const routing = await triageIssue({ ...baseInput, title: 'Bad', body: '', labels: [], hasSkipPmGate: true }, new FakeAdapter('.'));
    expect(routing.action).toBe('clarify');
  });

  it('throws AdapterContractError for invalid adapter module paths', async () => {
    await expect(triageIssue(baseInput, new FakeAdapter('../bad'))).rejects.toThrow(AdapterContractError);
  });

  it('uses issueNumber option when input number is absent', async () => {
    const adapter = new FakeAdapter('core');
    await triageIssue({ ...baseInput, number: undefined }, adapter, { issueNumber: 99 });
    expect(adapter.issues[0].number).toBe(99);
  });
});

describe('runTriage', () => {
  it('posts a clarification comment on low confidence', async () => {
    const commenter = new MockCommenter();
    const routing = await runTriage('owner/repo', 7, { ...baseInput, title: 'Bad', body: '', labels: [] }, new FakeAdapter('.'), commenter);
    expect(routing.action).toBe('clarify');
    expect(commenter.comments).toHaveLength(1);
    expect(commenter.comments[0].issueNumber).toBe(7);
  });

  it('does not post a comment when confidence is sufficient', async () => {
    const commenter = new MockCommenter();
    await runTriage('owner/repo', 42, baseInput, new FakeAdapter('core'), commenter);
    expect(commenter.comments).toHaveLength(0);
  });
});

describe('buildClarificationComment', () => {
  const result: TriageResult = { issueType: 'bug_fix', affectedModule: 'core', confidence: 0.45, summary: 'Bug fix in core' };

  it('includes the classified type', () => {
    expect(buildClarificationComment(result)).toContain('bug_fix');
  });

  it('includes the affected module', () => {
    expect(buildClarificationComment(result)).toContain('core');
  });

  it('includes the confidence percentage', () => {
    expect(buildClarificationComment(result)).toContain('45%');
  });

  it('asks for clarification questions', () => {
    expect(buildClarificationComment(result)).toContain('module or file');
  });
});

describe('timing', () => {
  it('triage completes in under 90 seconds', async () => {
    const start = Date.now();
    await triageIssue(baseInput, new FakeAdapter('core'));
    expect(Date.now() - start).toBeLessThan(90_000);
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.6);
  });
});
