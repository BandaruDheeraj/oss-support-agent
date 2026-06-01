import type { ActionsClient, WorkflowRun } from '../../sandbox-types';
import { buildSemanticSuspectSeed } from './semantic-search';

function mockWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 101,
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/BandaruDheeraj/oss-support-agent/actions/runs/101',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function createActionsClient(overrides: Partial<ActionsClient> = {}): ActionsClient {
  return {
    triggerWorkflowDispatch: jest.fn().mockResolvedValue(undefined),
    getWorkflowRun: jest.fn().mockResolvedValue(mockWorkflowRun()),
    waitForWorkflowRun: jest
      .fn()
      .mockResolvedValue({ completed: true, conclusion: 'success', timedOut: false }),
    getWorkflowRunLogs: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    uploadArtifact: jest.fn().mockResolvedValue('https://github.com/example/actions/runs/101'),
    downloadWorkflowRunArtifact: jest.fn().mockResolvedValue(
      JSON.stringify({
        model: 'BAAI/bge-small-en-v1.5',
        cacheHit: false,
        cacheKey: 'seed',
        indexedFileCount: 23,
        instrumentationDirs: ['python/openinference-instrumentation'],
        top_score: 0.91,
        results: [
          {
            file: 'python/openinference-instrumentation/openinference/instrumentation/demo.py',
            score: 0.91,
            primaryClass: 'DemoClass',
            primaryFunction: 'demo_function',
          },
        ],
      })
    ),
    ...overrides,
  };
}

function createSandboxSessionMock(overrides: Record<string, unknown> = {}): any {
  return {
    verifyAndPushBranch: jest
      .fn()
      .mockResolvedValue({ ok: true, phase: 'branch', sha: 'abc123' }),
    verifyWorkflowReachability: jest.fn().mockResolvedValue({ ok: true, phase: 'workflow' }),
    dispatchWorkflow: jest.fn().mockResolvedValue({
      ok: true,
      runId: 101,
      conclusion: 'success',
      stepOutcomes: [],
      rawLogs: '',
      exitCode: 0,
    }),
    ...overrides,
  };
}

function buildGhaConfig(
  actionsClient: ActionsClient,
  sandboxSession: any,
  branchName: string = 'agent/scope-52'
) {
  return {
    actionsClient,
    sandboxSession,
    repoFullName: 'BandaruDheeraj/openinference',
    forkFullName: 'BandaruDheeraj/openinference',
    forkCloneUrl: 'https://github.com/BandaruDheeraj/openinference.git',
    branchName,
    workflowRepoFullName: 'BandaruDheeraj/oss-support-agent',
    workflowDispatchRef: 'main',
    timeoutMinutes: 15,
  };
}

describe('buildSemanticSuspectSeed', () => {
  it('dispatches semantic workflow and maps suspect files/symbols from artifact output', async () => {
    const actionsClient = createActionsClient();
    const sandboxSession = createSandboxSessionMock();
    const result = await buildSemanticSuspectSeed({
      workspaceDir: '/tmp/workspace',
      issueTitle: 'Agent crashes when tracing tool calls',
      issueBody: 'Regression appears in instrumentation path.',
      affectedModule: 'python/openinference-instrumentation',
      ghaConfig: buildGhaConfig(actionsClient, sandboxSession),
    });

    expect(result).toEqual(
      expect.objectContaining({
        suspectFiles: ['python/openinference-instrumentation/openinference/instrumentation/demo.py'],
        semanticConfidence: {
          top_score: 0.91,
          low_confidence: false,
          diagnostics: expect.stringContaining('meets threshold 0.600'),
        },
      })
    );
    expect(result?.suspectSymbols).toEqual([
      expect.objectContaining({ symbol: 'DemoClass' }),
      expect.objectContaining({ symbol: 'demo_function' }),
    ]);

    expect(sandboxSession.verifyAndPushBranch).toHaveBeenCalledTimes(1);
    expect(sandboxSession.verifyWorkflowReachability).toHaveBeenCalledWith(
      'semantic-search.yml'
    );
    expect(sandboxSession.dispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'semantic-search.yml',
        timeoutMins: 15,
        inputs: expect.objectContaining({
          repo_full_name: 'BandaruDheeraj/openinference',
          branch_name: 'agent/scope-52',
          issue_title: 'Agent crashes when tracing tool calls',
          issue_body: 'Regression appears in instrumentation path.',
        }),
      })
    );
    expect(actionsClient.downloadWorkflowRunArtifact).toHaveBeenCalledWith(
      'BandaruDheeraj/oss-support-agent',
      101,
      'semantic-output'
    );
  });

  it('returns null when gha config is unavailable', async () => {
    const result = await buildSemanticSuspectSeed({
      workspaceDir: '/tmp/workspace',
      issueTitle: 'No-op',
      issueBody: '',
    });
    expect(result).toBeNull();
  });

  it('parses pretty JSON wrapped by noisy workflow output', async () => {
    const sandboxSession = createSandboxSessionMock();
    const actionsClient = createActionsClient({
      downloadWorkflowRunArtifact: jest.fn().mockResolvedValue(
        [
          '[semantic-search] script_exit=1 raw_bytes=321 stderr_bytes=45',
          '{',
          '  "model": "BAAI/bge-small-en-v1.5",',
          '  "cacheHit": false,',
          '  "cacheKey": "seed",',
          '  "indexedFileCount": 7,',
          '  "instrumentationDirs": ["python/openinference-instrumentation"],',
          '  "top_score": 0.82,',
          '  "results": [',
          '    {',
          '      "file": "python/openinference-instrumentation/openinference/instrumentation/demo.py",',
          '      "score": 0.82,',
          '      "primaryClass": "DemoClass",',
          '      "primaryFunction": "demo_function"',
          '    }',
          '  ]',
          '}',
          '[semantic-search] done',
        ].join('\n')
      ),
    });

    const result = await buildSemanticSuspectSeed({
      workspaceDir: '/tmp/workspace',
      issueTitle: 'Wrapped JSON payload',
      issueBody: 'Body',
      ghaConfig: buildGhaConfig(actionsClient, sandboxSession, 'agent/scope-53'),
    });

    expect(result).toEqual(
      expect.objectContaining({
        suspectFiles: ['python/openinference-instrumentation/openinference/instrumentation/demo.py'],
        semanticConfidence: {
          top_score: 0.82,
          low_confidence: false,
          diagnostics: expect.stringContaining('meets threshold 0.600'),
        },
      })
    );
  });

  it('marks semantic seed as low-confidence when top_score is below threshold', async () => {
    const sandboxSession = createSandboxSessionMock();
    const actionsClient = createActionsClient({
      downloadWorkflowRunArtifact: jest.fn().mockResolvedValue(
        JSON.stringify({
          model: 'BAAI/bge-small-en-v1.5',
          cacheHit: false,
          cacheKey: 'seed-low',
          indexedFileCount: 4,
          instrumentationDirs: ['python/openinference-instrumentation'],
          top_score: 0.41,
          results: [
            {
              file: 'python/openinference-instrumentation/openinference/instrumentation/demo.py',
              score: 0.41,
              primaryClass: 'DemoClass',
              primaryFunction: 'demo_function',
            },
          ],
        })
      ),
    });

    const result = await buildSemanticSuspectSeed({
      workspaceDir: '/tmp/workspace',
      issueTitle: 'Low confidence seed',
      issueBody: 'Body',
      ghaConfig: buildGhaConfig(actionsClient, sandboxSession, 'agent/scope-53'),
    });

    expect(result?.semanticConfidence).toEqual({
      top_score: 0.41,
      low_confidence: true,
      diagnostics: expect.stringContaining('below threshold 0.600'),
    });
  });

  it('returns null when semantic workflow artifact has no suspect results', async () => {
    const sandboxSession = createSandboxSessionMock();
    const actionsClient = createActionsClient({
      downloadWorkflowRunArtifact: jest.fn().mockResolvedValue(
        JSON.stringify({
          model: 'BAAI/bge-small-en-v1.5',
          cacheHit: false,
          cacheKey: 'workflow-fallback',
          indexedFileCount: 0,
          instrumentationDirs: [],
          results: [],
          diagnostics: {
            reason: 'non_json_output',
            scriptExitCode: 1,
          },
        })
      ),
    });

    const result = await buildSemanticSuspectSeed({
      workspaceDir: '/tmp/workspace',
      issueTitle: 'No semantic output',
      issueBody: 'Body',
      ghaConfig: buildGhaConfig(actionsClient, sandboxSession, 'agent/scope-54'),
    });

    expect(result).toBeNull();
  });
});
