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
});

