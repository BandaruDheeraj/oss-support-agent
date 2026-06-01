import JSZip from 'jszip';

import { GitHubActionsClient } from './github-actions';

describe('GitHubActionsClient.downloadWorkflowRunArtifact', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('extracts text content from the downloaded artifact zip', async () => {
    const zip = new JSZip();
    zip.file(
      'target/semantic-output.json',
      JSON.stringify({
        model: 'BAAI/bge-small-en-v1.5',
        results: [],
      })
    );
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            artifacts: [{ id: 222, name: 'semantic-output' }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(zipBuffer, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GitHubActionsClient('token');
    const content = await client.downloadWorkflowRunArtifact(
      'BandaruDheeraj/oss-support-agent',
      123,
      'semantic-output'
    );

    expect(content).toContain('"model":"BAAI/bge-small-en-v1.5"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out stalled requests', async () => {
    const fetchMock = jest.fn().mockImplementation((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const rejectAbort = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal.aborted) {
          rejectAbort();
          return;
        }
        signal.addEventListener('abort', rejectAbort, { once: true });
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GitHubActionsClient('token', { requestTimeoutMs: 10 });
    await expect(client.branchRefExists('BandaruDheeraj/oss-support-agent', 'main')).rejects.toThrow(
      'GitHub request timed out after 10ms'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
