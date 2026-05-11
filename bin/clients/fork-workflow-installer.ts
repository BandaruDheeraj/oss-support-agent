/**
 * Installs the regression-test.yml workflow into a target fork's default branch
 * so that GitHub Actions `workflow_dispatch` can reach it.
 *
 * GitHub only honors `workflow_dispatch` for workflow files present on the
 * default branch of the repo. The fix branch inherits the file as an ancestor
 * commit, which will surface in the eventual upstream PR diff — that is by
 * design and documented in the PR body when `sandbox_runner === 'gha'`.
 *
 * Idempotent: if the file already exists with matching content on the default
 * branch, this is a no-op.
 */

const GITHUB_API = 'https://api.github.com';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'oss-support-agent',
  };
}

async function ghFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = {
    ...authHeaders(token),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  return fetch(url, { ...init, headers });
}

export const REGRESSION_WORKFLOW_PATH = '.github/workflows/regression-test.yml';

export const REGRESSION_WORKFLOW_CONTENT = `name: regression-test

# Auto-installed by oss-support-agent to support the regression-guard agent.
# Safe to delete if you do not use the agent's GHA sandbox runner.

on:
  workflow_dispatch:
    inputs:
      test_command:
        description: Test command to run on the checked-out branch
        required: true
        type: string
      branch:
        description: Branch to test (set automatically by the agent)
        required: true
        type: string
      timeout_minutes:
        description: Per-job timeout in minutes
        required: false
        type: string
        default: "15"
      sandbox_services:
        description: Comma-separated list of services the test command needs
        required: false
        type: string
        default: ""
      network_policy:
        description: Network policy hint ("none" or "allow:<services>")
        required: false
        type: string
        default: "none"

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout target branch
        uses: actions/checkout@v4
        with:
          ref: \${{ inputs.branch }}

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Run test command
        shell: bash
        run: |
          set +e
          echo "::group::Running test command"
          echo "Command: \${{ inputs.test_command }}"
          echo "::endgroup::"
          bash -c "\${{ inputs.test_command }}"
          exit_code=$?
          echo "Test exit code: $exit_code"
          exit $exit_code
`;

/**
 * Ensure the regression workflow file is present on the fork's default branch.
 * Returns true if a commit was created, false if the file already matched.
 */
export async function ensureRegressionWorkflowOnFork(
  token: string,
  forkFullName: string,
  log: (msg: string) => void = () => undefined
): Promise<boolean> {
  // 1. Get the default branch name
  const repoRes = await ghFetch(token, `${GITHUB_API}/repos/${forkFullName}`);
  if (!repoRes.ok) {
    throw new Error(`GitHub get repo failed (${repoRes.status}): ${await repoRes.text()}`);
  }
  const repoData: any = await repoRes.json();
  const defaultBranch: string = repoData.default_branch;

  // 2. Check if the file already exists with matching content
  const contentUrl = `${GITHUB_API}/repos/${forkFullName}/contents/${REGRESSION_WORKFLOW_PATH}?ref=${encodeURIComponent(defaultBranch)}`;
  const contentRes = await ghFetch(token, contentUrl);
  let existingSha: string | null = null;
  if (contentRes.ok) {
    const contentData: any = await contentRes.json();
    if (typeof contentData.content === 'string') {
      const decoded = Buffer.from(contentData.content, 'base64').toString('utf-8');
      if (decoded.trim() === REGRESSION_WORKFLOW_CONTENT.trim()) {
        log(`[gha-setup] regression workflow already up to date on ${forkFullName}@${defaultBranch}`);
        return false;
      }
      existingSha = contentData.sha;
    }
  } else if (contentRes.status !== 404) {
    throw new Error(`GitHub get contents failed (${contentRes.status}): ${await contentRes.text()}`);
  }

  // 3. Create or update the file
  const putUrl = `${GITHUB_API}/repos/${forkFullName}/contents/${REGRESSION_WORKFLOW_PATH}`;
  const body: Record<string, unknown> = {
    message: 'chore(agent): install regression-test workflow for oss-support-agent\n\nAuto-installed by oss-support-agent. Safe to delete if you do not use the GHA sandbox runner.',
    content: Buffer.from(REGRESSION_WORKFLOW_CONTENT, 'utf-8').toString('base64'),
    branch: defaultBranch,
  };
  if (existingSha) body.sha = existingSha;
  const putRes = await ghFetch(token, putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!putRes.ok) {
    throw new Error(`GitHub put contents failed (${putRes.status}): ${await putRes.text()}`);
  }
  log(`[gha-setup] installed regression-test workflow on ${forkFullName}@${defaultBranch}`);
  return true;
}
