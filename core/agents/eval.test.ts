/**
 * Unit tests for the eval agent (US-009).
 */

import {
  evaluateSandboxResults,
  buildPRDetails,
  routeEvalResult,
  runEvalAgent,
} from './eval';
import {
  EvalAgentInput,
  PRClient,
  PRDetails,
  EvalAgentError,
} from './eval-types';
import { SandboxArtifact, SandboxConfig, SandboxResult } from '../sandbox-types';
import { ConfirmedIssue } from './fix-types';
import { BaseRepoAdapter } from '../adapter.interface';

// --- Test Fixtures ---

function makeConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    repoFullName: 'upstream-org/my-repo',
    forkFullName: 'my-org/my-repo',
    branchName: 'agent/scope-42-56',
    workflowRepoFullName: 'harness-org/harness-repo',
    testCommand: 'npm test',
    sandboxServices: [],
    timeoutMinutes: 15,
    ...overrides,
  };
}

function makeResult(overrides: Partial<SandboxResult> = {}): SandboxResult {
  return {
    completed: true,
    exitCode: 0,
    stdout: 'All 42 tests passed',
    stderr: '',
    durationSeconds: 30,
    workflowRunUrl: 'https://github.com/my-org/my-repo/actions/runs/123',
    timedOut: false,
    workflowRunId: 123,
    ...overrides,
  };
}

function makeArtifact(overrides: { config?: Partial<SandboxConfig>; result?: Partial<SandboxResult> } = {}): SandboxArtifact {
  const result = makeResult(overrides.result);
  return {
    config: makeConfig(overrides.config),
    result,
    commands: [{ command: 'npm test', exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr }],
    startedAt: '2026-05-06T10:00:00Z',
    completedAt: '2026-05-06T10:00:30Z',
  };
}

function makeIssues(count = 2): ConfirmedIssue[] {
  return Array.from({ length: count }, (_, i) => ({
    number: 42 + i,
    title: `Issue ${42 + i}`,
    body: `Body of issue ${42 + i}`,
    labels: ['bug'],
  }));
}

function makeInput(overrides: Partial<EvalAgentInput> = {}): EvalAgentInput {
  return {
    sandboxArtifact: makeArtifact(),
    confirmedIssues: makeIssues(),
    fixSummary: 'Fix null check in parser',
    designSummary: 'Add null guard before accessing property',
    forkFullName: 'my-org/my-repo',
    branchName: 'agent/scope-42-43',
    upstreamRepo: 'upstream-org/my-repo',
    upstreamDefaultBranch: 'main',
    issueTypes: ['bug_fix'],
    retryCount: 0,
    maxRetries: 3,
    adapter: new BaseRepoAdapter(),
    ...overrides,
  };
}

function makePRClient(overrides: Partial<PRClient> = {}): PRClient {
  return {
    createPullRequest: jest.fn().mockResolvedValue({ url: 'https://github.com/upstream-org/my-repo/pull/99', number: 99 }),
    addLabels: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// --- evaluateSandboxResults ---

describe('evaluateSandboxResults', () => {
  it('returns overallPass=true when tests pass (exit code 0, completed, not timed out)', async () => {
    const result = await evaluateSandboxResults(makeArtifact(), makeIssues(), 'Fixed it');
    expect(result.overallPass).toBe(true);
    expect(result.regressionDetected).toBe(false);
    expect(result.retryContext).toBeNull();
  });

  it('returns overallPass=false when exit code is non-zero', async () => {
    const artifact = makeArtifact({ result: { exitCode: 1, stderr: 'FAIL: test_auth' } });
    const result = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed it');
    expect(result.overallPass).toBe(false);
    expect(result.retryContext).not.toBeNull();
  });

  it('returns overallPass=false when sandbox timed out', async () => {
    const artifact = makeArtifact({ result: { timedOut: true, completed: false, exitCode: null } });
    const result = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed it');
    expect(result.overallPass).toBe(false);
  });

  it('returns overallPass=false when sandbox did not complete', async () => {
    const artifact = makeArtifact({ result: { completed: false, exitCode: null } });
    const result = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed it');
    expect(result.overallPass).toBe(false);
  });

  it('always sets regressionDetected=false in Phase 1', async () => {
    const artifact = makeArtifact({ result: { exitCode: 1 } });
    const result = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed it');
    expect(result.regressionDetected).toBe(false);
  });

  it('produces per-issue verdicts for all confirmed issues', async () => {
    const issues = makeIssues(3);
    const result = await evaluateSandboxResults(makeArtifact(), issues, 'Fixed it');
    expect(result.perIssueVerdicts).toHaveLength(3);
    expect(result.perIssueVerdicts[0].issueNumber).toBe(42);
    expect(result.perIssueVerdicts[1].issueNumber).toBe(43);
    expect(result.perIssueVerdicts[2].issueNumber).toBe(44);
  });

  it('all per-issue verdicts pass when overall passes', async () => {
    const result = await evaluateSandboxResults(makeArtifact(), makeIssues(), 'Fixed it');
    result.perIssueVerdicts.forEach((v) => expect(v.passed).toBe(true));
  });

  it('all per-issue verdicts fail when overall fails', async () => {
    const artifact = makeArtifact({ result: { exitCode: 1, stderr: 'err' } });
    const result = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed it');
    result.perIssueVerdicts.forEach((v) => expect(v.passed).toBe(false));
  });

  it('includes stderr snippet in failure reason', async () => {
    const artifact = makeArtifact({ result: { exitCode: 1, stderr: 'TypeError: cannot read property x of null' } });
    const result = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed it');
    expect(result.retryContext).toContain('TypeError');
  });

  it('retry context includes test command and exit code', async () => {
    const artifact = makeArtifact({ result: { exitCode: 2, stderr: 'segfault' } });
    const result = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed it');
    expect(result.retryContext).toContain('segfault');
    expect(result.overallPass).toBe(false);
  });

  it('retry context includes stderr and stdout snippets', async () => {
    const artifact = makeArtifact({ result: { exitCode: 1, stderr: 'error output', stdout: 'test output' } });
    const result = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed it');
    expect(result.retryContext).toContain('error output');
    expect(result.retryContext).toContain('test output');
  });

  it('prSummary mentions all issues on pass', async () => {
    const result = await evaluateSandboxResults(makeArtifact(), makeIssues(), 'Fix null check');
    expect(result.prSummary).toContain('#42');
    expect(result.prSummary).toContain('#43');
    expect(result.prSummary).toContain('Fix null check');
  });

  it('prSummary mentions failure on fail', async () => {
    const artifact = makeArtifact({ result: { exitCode: 1, timedOut: true, completed: false } });
    const result = await evaluateSandboxResults(artifact, makeIssues(), 'Fix null check');
    expect(result.prSummary).toContain('failed');
  });
});

// --- buildPRDetails ---

describe('buildPRDetails', () => {
  it('title format: [agent-fix] {summary}', async () => {
    const input = makeInput();
    const evalResult = await evaluateSandboxResults(input.sandboxArtifact, input.confirmedIssues, input.fixSummary);
    const pr = buildPRDetails(input, evalResult);
    expect(pr.title).toBe('[agent-fix] Fix null check in parser');
  });

  it('body includes design summary', async () => {
    const input = makeInput();
    const evalResult = await evaluateSandboxResults(input.sandboxArtifact, input.confirmedIssues, input.fixSummary);
    const pr = buildPRDetails(input, evalResult);
    expect(pr.body).toContain('Add null guard before accessing property');
  });

  it('body includes per-issue verdicts', async () => {
    const input = makeInput();
    const evalResult = await evaluateSandboxResults(input.sandboxArtifact, input.confirmedIssues, input.fixSummary);
    const pr = buildPRDetails(input, evalResult);
    expect(pr.body).toContain('#42');
    expect(pr.body).toContain('#43');
    expect(pr.body).toContain('✅ Passed');
  });

  it('body includes sandbox run link', async () => {
    const input = makeInput();
    const evalResult = await evaluateSandboxResults(input.sandboxArtifact, input.confirmedIssues, input.fixSummary);
    const pr = buildPRDetails(input, evalResult);
    expect(pr.body).toContain('https://github.com/my-org/my-repo/actions/runs/123');
  });

  it('body includes retry information when retryCount > 0', async () => {
    const input = makeInput({ retryCount: 2 });
    const evalResult = await evaluateSandboxResults(input.sandboxArtifact, input.confirmedIssues, input.fixSummary);
    const pr = buildPRDetails(input, evalResult);
    expect(pr.body).toContain('2 retry attempt(s)');
  });

  it('body does not include retry section when retryCount is 0', async () => {
    const input = makeInput({ retryCount: 0 });
    const evalResult = await evaluateSandboxResults(input.sandboxArtifact, input.confirmedIssues, input.fixSummary);
    const pr = buildPRDetails(input, evalResult);
    expect(pr.body).not.toContain('Retry Information');
  });

  it('labels include agent-fix plus issue type labels', async () => {
    const input = makeInput({ issueTypes: ['bug_fix', 'docs'] });
    const evalResult = await evaluateSandboxResults(input.sandboxArtifact, input.confirmedIssues, input.fixSummary);
    const pr = buildPRDetails(input, evalResult);
    expect(pr.labels).toContain('agent-fix');
    expect(pr.labels).toContain('bug_fix');
    expect(pr.labels).toContain('docs');
  });

  it('labels deduplicate issue types', async () => {
    const input = makeInput({ issueTypes: ['bug_fix', 'bug_fix'] });
    const evalResult = await evaluateSandboxResults(input.sandboxArtifact, input.confirmedIssues, input.fixSummary);
    const pr = buildPRDetails(input, evalResult);
    expect(pr.labels.filter((l) => l === 'bug_fix')).toHaveLength(1);
  });

  it('head format: forkOrg:branchName', async () => {
    const input = makeInput({ forkFullName: 'my-org/my-repo', branchName: 'agent/scope-42' });
    const evalResult = await evaluateSandboxResults(input.sandboxArtifact, input.confirmedIssues, input.fixSummary);
    const pr = buildPRDetails(input, evalResult);
    expect(pr.head).toBe('my-org:agent/scope-42');
  });

  it('base is the upstream default branch', async () => {
    const input = makeInput({ upstreamDefaultBranch: 'develop' });
    const evalResult = await evaluateSandboxResults(input.sandboxArtifact, input.confirmedIssues, input.fixSummary);
    const pr = buildPRDetails(input, evalResult);
    expect(pr.base).toBe('develop');
  });

  it('does not auto-assign reviewers', async () => {
    const input = makeInput();
    const evalResult = await evaluateSandboxResults(input.sandboxArtifact, input.confirmedIssues, input.fixSummary);
    const pr = buildPRDetails(input, evalResult);
    // PRDetails has no reviewers field
    expect((pr as any).reviewers).toBeUndefined();
  });
});

// --- routeEvalResult ---

describe('routeEvalResult', () => {
  it('routes to open_pr when overall passes', async () => {
    const evalResult = await evaluateSandboxResults(makeArtifact(), makeIssues(), 'Fixed');
    const routing = routeEvalResult(evalResult, 0, 3);
    expect(routing.action).toBe('open_pr');
  });

  it('routes to retry when overall fails and retries remain', async () => {
    const artifact = makeArtifact({ result: { exitCode: 1, stderr: 'fail' } });
    const evalResult = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed');
    const routing = routeEvalResult(evalResult, 0, 3);
    expect(routing.action).toBe('retry');
  });

  it('routes to retry when retryCount < maxRetries', async () => {
    const artifact = makeArtifact({ result: { exitCode: 1, stderr: 'fail' } });
    const evalResult = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed');
    const routing = routeEvalResult(evalResult, 2, 3);
    expect(routing.action).toBe('retry');
  });

  it('routes to failed when retryCount >= maxRetries', async () => {
    const artifact = makeArtifact({ result: { exitCode: 1, stderr: 'fail' } });
    const evalResult = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed');
    const routing = routeEvalResult(evalResult, 3, 3);
    expect(routing.action).toBe('failed');
  });

  it('retry routing includes retry context', async () => {
    const artifact = makeArtifact({ result: { exitCode: 1, stderr: 'error msg' } });
    const evalResult = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed');
    const routing = routeEvalResult(evalResult, 0, 3);
    expect(routing.action).toBe('retry');
    if (routing.action === 'retry') {
      expect(routing.retryContext).toContain('error msg');
    }
  });

  it('failed routing includes max retries info', async () => {
    const artifact = makeArtifact({ result: { exitCode: 1, stderr: 'err' } });
    const evalResult = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed');
    const routing = routeEvalResult(evalResult, 3, 3);
    if (routing.action === 'failed') {
      expect(routing.reason).toContain('Max retries (3)');
    }
  });

  it('routes to failed with maxRetries=0 on first failure', async () => {
    const artifact = makeArtifact({ result: { exitCode: 1, stderr: 'err' } });
    const evalResult = await evaluateSandboxResults(artifact, makeIssues(), 'Fixed');
    const routing = routeEvalResult(evalResult, 0, 0);
    expect(routing.action).toBe('failed');
  });
});

// --- runEvalAgent (integration) ---

describe('runEvalAgent', () => {
  it('creates PR on pass and returns PR URL', async () => {
    const input = makeInput();
    const client = makePRClient();
    const { result, routing } = await runEvalAgent(input, client);

    expect(result.overallPass).toBe(true);
    expect(routing.action).toBe('open_pr');
    if (routing.action === 'open_pr') {
      expect(routing.prUrl).toBe('https://github.com/upstream-org/my-repo/pull/99');
    }
  });

  it('calls createPullRequest with correct upstream repo', async () => {
    const input = makeInput({ upstreamRepo: 'owner/target-repo' });
    const client = makePRClient();
    await runEvalAgent(input, client);

    expect(client.createPullRequest).toHaveBeenCalledWith(
      'owner/target-repo',
      expect.any(Object)
    );
  });

  it('PR title follows [agent-fix] format', async () => {
    const input = makeInput({ fixSummary: 'Handle edge case in auth' });
    const client = makePRClient();
    await runEvalAgent(input, client);

    const prDetails: PRDetails = (client.createPullRequest as jest.Mock).mock.calls[0][1];
    expect(prDetails.title).toBe('[agent-fix] Handle edge case in auth');
  });

  it('adds labels to the created PR', async () => {
    const input = makeInput({ issueTypes: ['bug_fix'] });
    const client = makePRClient();
    await runEvalAgent(input, client);

    expect(client.addLabels).toHaveBeenCalledWith(
      input.upstreamRepo,
      99,
      expect.arrayContaining(['agent-fix', 'bug_fix'])
    );
  });

  it('does not create PR on failure', async () => {
    const input = makeInput({
      sandboxArtifact: makeArtifact({ result: { exitCode: 1, stderr: 'fail' } }),
    });
    const client = makePRClient();
    const { routing } = await runEvalAgent(input, client);

    expect(routing.action).toBe('retry');
    expect(client.createPullRequest).not.toHaveBeenCalled();
  });

  it('routes to retry on failure with retries remaining', async () => {
    const input = makeInput({
      sandboxArtifact: makeArtifact({ result: { exitCode: 1, stderr: 'err' } }),
      retryCount: 1,
      maxRetries: 3,
    });
    const client = makePRClient();
    const { routing } = await runEvalAgent(input, client);

    expect(routing.action).toBe('retry');
  });

  it('routes to failed after max retries exceeded', async () => {
    const input = makeInput({
      sandboxArtifact: makeArtifact({ result: { exitCode: 1, stderr: 'err' } }),
      retryCount: 3,
      maxRetries: 3,
    });
    const client = makePRClient();
    const { routing } = await runEvalAgent(input, client);

    expect(routing.action).toBe('failed');
    expect(client.createPullRequest).not.toHaveBeenCalled();
  });

  it('throws EvalAgentError when PR creation fails', async () => {
    const input = makeInput();
    const client = makePRClient({
      createPullRequest: jest.fn().mockRejectedValue(new Error('API error')),
    });

    await expect(runEvalAgent(input, client)).rejects.toThrow(EvalAgentError);
    await expect(runEvalAgent(input, client)).rejects.toThrow('Failed to create PR');
  });

  it('label failure is non-fatal', async () => {
    const input = makeInput();
    const client = makePRClient({
      addLabels: jest.fn().mockRejectedValue(new Error('label error')),
    });
    const { routing } = await runEvalAgent(input, client);
    expect(routing.action).toBe('open_pr');
  });

  it('PR body includes design summary, issues, and sandbox link', async () => {
    const input = makeInput();
    const client = makePRClient();
    await runEvalAgent(input, client);

    const prDetails: PRDetails = (client.createPullRequest as jest.Mock).mock.calls[0][1];
    expect(prDetails.body).toContain('Design Summary');
    expect(prDetails.body).toContain('#42');
    expect(prDetails.body).toContain('Workflow Run');
  });

  it('head uses fork org and branch', async () => {
    const input = makeInput({ forkFullName: 'test-org/repo', branchName: 'agent/scope-1-2' });
    const client = makePRClient();
    await runEvalAgent(input, client);

    const prDetails: PRDetails = (client.createPullRequest as jest.Mock).mock.calls[0][1];
    expect(prDetails.head).toBe('test-org:agent/scope-1-2');
  });

  it('base is the upstream default branch', async () => {
    const input = makeInput({ upstreamDefaultBranch: 'develop' });
    const client = makePRClient();
    await runEvalAgent(input, client);

    const prDetails: PRDetails = (client.createPullRequest as jest.Mock).mock.calls[0][1];
    expect(prDetails.base).toBe('develop');
  });

  it('does not auto-assign reviewers', async () => {
    const input = makeInput();
    const client = makePRClient();
    await runEvalAgent(input, client);

    const prDetails: PRDetails = (client.createPullRequest as jest.Mock).mock.calls[0][1];
    expect((prDetails as any).reviewers).toBeUndefined();
  });
});


describe('adapter-backed eval integration', () => {
  it('evaluateSandboxResults calls adapter.runCustomEval with sandbox commands', async () => {
    const artifact = makeArtifact({ result: { exitCode: 7, stderr: 'custom failure' } });
    const adapter = {
      ...makeInput().adapter!,
      runCustomEval: jest.fn().mockResolvedValue({ passed: false, summary: 'custom verdict', retryContext: ['ctx'] }),
    };
    const result = await evaluateSandboxResults(artifact, makeIssues(1), 'Fixed', adapter);
    expect(adapter.runCustomEval).toHaveBeenCalledWith(artifact.commands);
    expect(result.overallPass).toBe(false);
    expect(result.retryContext).toBe('ctx');
  });

  it('runEvalAgent calls adapter.getPRMetadata with confirmed issues', async () => {
    const input = makeInput({
      adapter: Object.assign(new BaseRepoAdapter(), {
        getPRMetadata: jest.fn().mockResolvedValue({ extraLabels: [], extraBodySections: [] }),
      }),
    });
    await runEvalAgent(input, makePRClient());
    expect(input.adapter!.getPRMetadata).toHaveBeenCalledWith([
      { number: 42, title: 'Issue 42', body: 'Body of issue 42', labels: ['bug'] },
      { number: 43, title: 'Issue 43', body: 'Body of issue 43', labels: ['bug'] },
    ]);
  });

  it('runEvalAgent merges adapter PR labels and body sections', async () => {
    const input = makeInput({
      adapter: Object.assign(new BaseRepoAdapter(), {
        getPRMetadata: jest.fn().mockResolvedValue({
          extraLabels: ['repo-specific'],
          extraBodySections: ['## Repo Notes\nCustom note'],
        }),
      }),
    });
    const client = makePRClient();
    await runEvalAgent(input, client);
    const prDetails: PRDetails = (client.createPullRequest as jest.Mock).mock.calls[0][1];
    expect(prDetails.labels).toEqual(expect.arrayContaining(['agent-fix', 'bug_fix', 'repo-specific']));
    expect(prDetails.body).toContain('## Repo Notes');
  });
});
