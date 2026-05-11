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
export const USABILITY_WORKFLOW_PATH = '.github/workflows/usability-test.yml';

/**
 * Generic helper: ensure a workflow file is present on a specific branch of the
 * fork with the given content. Idempotent — no-op if the file already matches.
 * Returns true if a commit was created.
 */
async function ensureWorkflowOnBranch(
  token: string,
  forkFullName: string,
  workflowPath: string,
  workflowContent: string,
  branch: string,
  commitMessage: string,
  label: string,
  log: (msg: string) => void
): Promise<boolean> {
  const contentUrl = `${GITHUB_API}/repos/${forkFullName}/contents/${workflowPath}?ref=${encodeURIComponent(branch)}`;
  const contentRes = await ghFetch(token, contentUrl);
  let existingSha: string | null = null;
  if (contentRes.ok) {
    const contentData: any = await contentRes.json();
    if (typeof contentData.content === 'string') {
      const decoded = Buffer.from(contentData.content, 'base64').toString('utf-8');
      if (decoded.trim() === workflowContent.trim()) {
        log(`[gha-setup] ${label} workflow already up to date on ${forkFullName}@${branch}`);
        return false;
      }
      existingSha = contentData.sha;
    }
  } else if (contentRes.status !== 404) {
    throw new Error(`GitHub get contents failed (${contentRes.status}): ${await contentRes.text()}`);
  }

  const putUrl = `${GITHUB_API}/repos/${forkFullName}/contents/${workflowPath}`;
  const body: Record<string, unknown> = {
    message: commitMessage,
    content: Buffer.from(workflowContent, 'utf-8').toString('base64'),
    branch,
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
  log(`[gha-setup] installed ${label} workflow on ${forkFullName}@${branch}`);
  return true;
}

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

export const USABILITY_WORKFLOW_CONTENT = `name: usability-test

# Auto-installed by oss-support-agent to support the usability agent (US-015).
# Safe to delete if you do not use the agent's GHA sandbox runner.
#
# Each job below maps to a single UsabilityCheck category. The agent reads each
# job's conclusion to derive pass/fail for that category, so renaming jobs will
# break the mapping.

on:
  workflow_dispatch:
    inputs:
      branch:
        description: Branch to exercise (set automatically by the agent)
        required: true
        type: string
      install_command:
        description: Command to install the package from a fresh checkout
        required: true
        type: string
      affected_module:
        description: Affected module path (relative to repo root)
        required: true
        type: string
      entry_points:
        description: JSON-encoded array of entry-point hints
        required: false
        type: string
        default: "[]"
      timeout:
        description: Per-job timeout in minutes
        required: false
        type: string
        default: "15"
      network_policy:
        description: Network policy hint ("none" or "allow:<services>")
        required: false
        type: string
        default: "none"
      sandbox_services:
        description: Comma-separated list of services the exercise needs
        required: false
        type: string
        default: ""

jobs:
  installation:
    name: installation
    runs-on: ubuntu-latest
    timeout-minutes: 15
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

      - name: Run install command
        shell: bash
        run: |
          set -e
          echo "::group::install"
          echo "Command: \${{ inputs.install_command }}"
          bash -c "\${{ inputs.install_command }}"
          echo "::endgroup::"

  import_paths:
    name: import_paths
    needs: installation
    runs-on: ubuntu-latest
    timeout-minutes: 10
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

      - name: Reinstall
        shell: bash
        run: bash -c "\${{ inputs.install_command }}"

      - name: Smoke-import every entry point
        shell: bash
        env:
          AFFECTED_MODULE: \${{ inputs.affected_module }}
          ENTRY_POINTS_JSON: \${{ inputs.entry_points }}
        run: |
          set -e
          python3 - <<'PY'
          import json, os, subprocess, sys
          raw = os.environ.get("ENTRY_POINTS_JSON", "[]") or "[]"
          try:
              entries = json.loads(raw)
          except Exception as e:
              print(f"entry_points is not valid JSON: {e}", file=sys.stderr)
              sys.exit(1)
          if not entries:
              # Fall back to a module path heuristic.
              affected = os.environ.get("AFFECTED_MODULE", "").strip()
              if affected and affected != ".":
                  entries = [affected]
          if not entries:
              print("no entry points to exercise; treating as pass")
              sys.exit(0)
          failures = []
          for ep in entries:
              ep = str(ep).strip()
              if not ep:
                  continue
              print(f"::group::entry-point {ep}")
              candidates = []
              # JS entry-point candidate
              candidates.append(("node", ["-e", f"try{{require('{ep}');console.log('ok')}}catch(e){{process.exit(1)}}"]))
              # Python module candidate (dotted)
              py_mod = ep.replace("/", ".").replace("\\\\", ".")
              candidates.append(("python3", ["-c", f"import {py_mod}"]))
              ok = False
              last_err = ""
              for cmd, args in candidates:
                  try:
                      r = subprocess.run([cmd] + args, capture_output=True, text=True, timeout=60)
                      if r.returncode == 0:
                          ok = True
                          break
                      last_err = (r.stderr or r.stdout or "").strip()[:300]
                  except FileNotFoundError:
                      continue
              print("::endgroup::")
              if not ok:
                  failures.append(f"{ep}: {last_err}")
          if failures:
              print("Import failures:")
              for f in failures:
                  print(f"  - {f}")
              sys.exit(1)
          PY

  error_messages:
    name: error_messages
    needs: installation
    runs-on: ubuntu-latest
    timeout-minutes: 10
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

      - name: Reinstall
        shell: bash
        run: bash -c "\${{ inputs.install_command }}"

      - name: Check that thrown errors include a message
        shell: bash
        env:
          AFFECTED_MODULE: \${{ inputs.affected_module }}
        run: |
          # Heuristic: scan affected module sources for empty Error()/raise Exception() patterns.
          set -e
          shopt -s globstar nullglob || true
          mod="\${AFFECTED_MODULE}"
          if [ -z "$mod" ] || [ "$mod" = "." ]; then
            # Whole-repo scope: grepping the entire tree for empty-error patterns
            # produces false positives from unrelated upstream code. The signal is
            # only meaningful when we have a specific module to scope to.
            echo "no specific module scope; skipping (whole-repo grep is too noisy)"
            exit 0
          fi
          target="$mod"
          if [ ! -e "$target" ]; then
            echo "module path '$target' not found; skipping"
            exit 0
          fi
          # Look for obvious empty-error anti-patterns.
          if grep -rEn "throw new Error\\(\\s*\\)|raise [A-Za-z_]+Error\\(\\s*\\)|raise Exception\\(\\s*\\)" "$target" 2>/dev/null; then
            echo "Found empty error constructors above. Errors should include a descriptive message."
            exit 1
          fi
          echo "no empty error constructors found"

  documentation_examples:
    name: documentation_examples
    needs: installation
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout target branch
        uses: actions/checkout@v4
        with:
          ref: \${{ inputs.branch }}

      - name: Check README mentions the affected module
        shell: bash
        env:
          AFFECTED_MODULE: \${{ inputs.affected_module }}
        run: |
          set -e
          mod="\${AFFECTED_MODULE}"
          if [ -z "$mod" ] || [ "$mod" = "." ]; then
            echo "no specific module; skipping"
            exit 0
          fi
          base="$(basename "$mod")"
          for readme in README.md README.rst README.txt readme.md; do
            if [ -f "$readme" ] && grep -qi "$base" "$readme"; then
              echo "README mentions $base"
              exit 0
            fi
          done
          echo "::warning::README does not mention $base; consider adding documentation."
          # warning, not fail
          exit 0
`;

/**
 * Ensure the regression workflow file is present on the fork's default branch.
 * Returns true if a commit was created, false if the file already matched.
 */
export async function ensureRegressionWorkflowOnFork(
  token: string,
  forkFullName: string,
  log: (msg: string) => void = () => undefined
): Promise<{ committed: boolean; defaultBranch: string }> {
  const repoRes = await ghFetch(token, `${GITHUB_API}/repos/${forkFullName}`);
  if (!repoRes.ok) {
    throw new Error(`GitHub get repo failed (${repoRes.status}): ${await repoRes.text()}`);
  }
  const repoData: any = await repoRes.json();
  const defaultBranch: string = repoData.default_branch;
  const committed = await ensureWorkflowOnBranch(
    token,
    forkFullName,
    REGRESSION_WORKFLOW_PATH,
    REGRESSION_WORKFLOW_CONTENT,
    defaultBranch,
    'chore(agent): install regression-test workflow for oss-support-agent\n\nAuto-installed by oss-support-agent. Safe to delete if you do not use the GHA sandbox runner.',
    'regression-test',
    log
  );
  return { committed, defaultBranch };
}

/**
 * Ensure the regression workflow file is present on a specific (non-default)
 * branch of the fork. Used so that workflow_dispatch can be targeted at the
 * agent branch (so head_branch of the resulting run matches the branch we want
 * to look up).
 */
export async function ensureRegressionWorkflowOnBranch(
  token: string,
  forkFullName: string,
  branch: string,
  log: (msg: string) => void = () => undefined
): Promise<boolean> {
  return ensureWorkflowOnBranch(
    token,
    forkFullName,
    REGRESSION_WORKFLOW_PATH,
    REGRESSION_WORKFLOW_CONTENT,
    branch,
    'chore(agent): install regression-test workflow for oss-support-agent\n\nAuto-installed by oss-support-agent. Safe to delete if you do not use the GHA sandbox runner.',
    'regression-test',
    log
  );
}

/**
 * Ensure the usability workflow file is present on the fork's default branch.
 * Returns { committed: true } if a commit was created, false if the file already matched.
 */
export async function ensureUsabilityWorkflowOnFork(
  token: string,
  forkFullName: string,
  log: (msg: string) => void = () => undefined
): Promise<{ committed: boolean; defaultBranch: string }> {
  const repoRes = await ghFetch(token, `${GITHUB_API}/repos/${forkFullName}`);
  if (!repoRes.ok) {
    throw new Error(`GitHub get repo failed (${repoRes.status}): ${await repoRes.text()}`);
  }
  const repoData: any = await repoRes.json();
  const defaultBranch: string = repoData.default_branch;
  const committed = await ensureWorkflowOnBranch(
    token,
    forkFullName,
    USABILITY_WORKFLOW_PATH,
    USABILITY_WORKFLOW_CONTENT,
    defaultBranch,
    'chore(agent): install usability-test workflow for oss-support-agent\n\nAuto-installed by oss-support-agent. Safe to delete if you do not use the GHA sandbox runner.',
    'usability-test',
    log
  );
  return { committed, defaultBranch };
}

/**
 * Ensure the usability workflow file is present on a specific (non-default)
 * branch of the fork. Used so that workflow_dispatch can be targeted at the
 * agent branch (so head_branch of the resulting run matches the branch we want
 * to look up).
 */
export async function ensureUsabilityWorkflowOnBranch(
  token: string,
  forkFullName: string,
  branch: string,
  log: (msg: string) => void = () => undefined
): Promise<boolean> {
  return ensureWorkflowOnBranch(
    token,
    forkFullName,
    USABILITY_WORKFLOW_PATH,
    USABILITY_WORKFLOW_CONTENT,
    branch,
    'chore(agent): install usability-test workflow for oss-support-agent\n\nAuto-installed by oss-support-agent. Safe to delete if you do not use the GHA sandbox runner.',
    'usability-test',
    log
  );
}
