/**
 * CI Check Watcher
 *
 * Watches a PR's CI checks after opening, auto-fixes lint failures using the
 * exact pinned tool version from CI, and amends the commit instead of creating
 * new ones.
 *
 * Key learnings from PR #3199:
 * - ruff 0.9.2 (CI) vs 0.15.15 (local) have different I001 import ordering rules
 * - Must install pinned version in a throwaway venv: python3 -m venv /tmp/venv && pip install ruff==X.Y.Z
 * - Must amend existing commit (git commit --amend --no-edit), never add new commits
 * - Must verify with pinned version before pushing (run --no-fix and check output)
 */

import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execCb);

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CIWatchResult {
  allPassed: boolean;
  autoFixed: string[];
  requiresHuman: Array<{ name: string; reason: string; logSnippet: string }>;
}

export interface CIWatcherArgs {
  prNumber: number;
  owner: string;
  repo: string;
  /** Absolute path to the local git checkout for this branch */
  branchDir: string;
  githubToken: string;
  /** Maximum total wait time in ms before giving up (default 3 600 000 = 1 h) */
  maxWaitMs?: number;
  /** How long to sleep between polls in ms (default 300 000 = 5 min) */
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

interface CheckRun {
  id: number;
  name: string;
  status: string; // 'queued' | 'in_progress' | 'completed'
  conclusion: string | null; // 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required'
  details_url: string;
  // Non-standard: populated lazily when we fetch log URLs
  logUrl?: string;
}

async function ghGet(path: string, token: string): Promise<unknown> {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub GET ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function getPrHeadSha(owner: string, repo: string, prNumber: number, token: string): Promise<string> {
  const data = (await ghGet(`/repos/${owner}/${repo}/pulls/${prNumber}`, token)) as {
    head: { sha: string };
  };
  return data.head.sha;
}

async function getCheckRuns(owner: string, repo: string, sha: string, token: string): Promise<CheckRun[]> {
  // GitHub paginates at 100; for most PRs one page is enough.
  const data = (await ghGet(
    `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
    token,
  )) as { check_runs: CheckRun[] };
  return data.check_runs;
}

/**
 * Download the raw log for a check-run job.  The API returns a redirect; we
 * follow it transparently because fetch follows redirects by default.
 */
async function getCheckRunLog(owner: string, repo: string, checkRunId: number, token: string): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${checkRunId}/logs`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch log for check-run ${checkRunId}: ${res.status}`);
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------

/**
 * Parse the pinned version of `tool` from a CI job log string.
 *
 * Examples of lines we look for:
 *   pip install ruff==0.9.2
 *   ruff==0.9.2
 *   Using ruff 0.9.2
 *   flake8==3.9.0
 *   Run ruff@0.9.2
 */
export function parsePinnedVersion(jobLog: string, tool: string): string | null {
  // Pattern 1: tool==X.Y.Z  (pip install style)
  const pinPattern = new RegExp(`${tool}==([\\d]+\\.[\\d]+(?:\\.[\\d]+)?)`, 'i');
  const pin = pinPattern.exec(jobLog);
  if (pin) return pin[1];

  // Pattern 2: tool@X.Y.Z  (pipx / uvx style)
  const atPattern = new RegExp(`${tool}@([\\d]+\\.[\\d]+(?:\\.[\\d]+)?)`, 'i');
  const at = atPattern.exec(jobLog);
  if (at) return at[1];

  // Pattern 3: "Using ruff X.Y.Z" or "ruff X.Y.Z" as a standalone phrase
  const phrasePattern = new RegExp(`(?:using\\s+)?${tool}\\s+([\\d]+\\.[\\d]+(?:\\.[\\d]+)?)`, 'i');
  const phrase = phrasePattern.exec(jobLog);
  if (phrase) return phrase[1];

  return null;
}

// ---------------------------------------------------------------------------
// Auto-fix helpers
// ---------------------------------------------------------------------------

const LINT_TOOLS = ['ruff', 'flake8'] as const;
type LintTool = (typeof LINT_TOOLS)[number];

function detectLintTool(checkName: string): LintTool | null {
  const lower = checkName.toLowerCase();
  if (lower.includes('ruff')) return 'ruff';
  if (lower.includes('flake8')) return 'flake8';
  return null;
}

/**
 * Returns true if the check is one we know how to auto-fix (lint only).
 */
function isAutoFixable(checkName: string): boolean {
  return detectLintTool(checkName) !== null;
}

/**
 * Reason string for checks we cannot auto-fix.
 */
function humanReason(checkName: string): string {
  const lower = checkName.toLowerCase();
  if (lower.includes('cla')) return 'CLA signature required — must be signed manually';
  if (lower.includes('security')) return 'Security scan failure requires human review';
  if (lower.includes('test') || lower.includes('pytest') || lower.includes('jest')) {
    return 'Test failure requires human investigation';
  }
  if (lower.includes('type') || lower.includes('mypy')) {
    return 'Type-check failure requires human investigation';
  }
  return 'Unknown check failure requires human investigation';
}

// ---------------------------------------------------------------------------
// Core auto-fix flow
// ---------------------------------------------------------------------------

async function autoFixLint(
  tool: LintTool,
  pinnedVersion: string,
  branchDir: string,
  log: (msg: string) => void,
): Promise<void> {
  const venvPath = `/tmp/ci-fix-venv-${tool}-${pinnedVersion}`;

  log(`[ci-check-watcher] Creating venv at ${venvPath} and installing ${tool}==${pinnedVersion}`);
  await exec(`python3 -m venv ${venvPath} && ${venvPath}/bin/pip install --quiet ${tool}==${pinnedVersion}`);

  const toolBin = `${venvPath}/bin/${tool}`;

  if (tool === 'ruff') {
    log(`[ci-check-watcher] Running ruff --fix in ${branchDir}`);
    // ruff check --fix applies fixable violations; ruff format handles formatting
    await exec(`${toolBin} check --fix .`, { cwd: branchDir }).catch(() => {
      // ruff exits non-zero when there are unfixable violations; ignore that here
    });
    await exec(`${toolBin} format .`, { cwd: branchDir }).catch(() => {});

    // Verify: run --no-fix and fail if there are still violations
    log(`[ci-check-watcher] Verifying with ${tool}==${pinnedVersion} --no-fix`);
    const { stdout: verifyOut, stderr: verifyErr } = await exec(`${toolBin} check --no-fix .`, { cwd: branchDir }).catch(
      (e: { stdout: string; stderr: string }) => e,
    );
    const verifyOutput = (verifyOut ?? '') + (verifyErr ?? '');
    if (verifyOutput.includes('Found') && !verifyOutput.includes('Found 0')) {
      throw new Error(`Unfixable ruff violations remain:\n${verifyOutput.slice(0, 2000)}`);
    }
  } else if (tool === 'flake8') {
    // flake8 itself does not have a --fix flag; delegate to autopep8 or isort
    // We do a best-effort pass with autopep8 if available, then re-verify.
    log(`[ci-check-watcher] Running autopep8 for flake8 fix in ${branchDir}`);
    await exec(`${venvPath}/bin/pip install --quiet autopep8`);
    await exec(`${venvPath}/bin/autopep8 --in-place --recursive .`, { cwd: branchDir }).catch(() => {});

    log(`[ci-check-watcher] Verifying with flake8==${pinnedVersion}`);
    const { stdout: verifyOut, stderr: verifyErr } = await exec(`${toolBin} .`, { cwd: branchDir }).catch(
      (e: { stdout: string; stderr: string }) => e,
    );
    const verifyOutput = (verifyOut ?? '') + (verifyErr ?? '');
    if (verifyOutput.trim().length > 0) {
      throw new Error(`Unfixable flake8 violations remain:\n${verifyOutput.slice(0, 2000)}`);
    }
  }
}

async function commitAmendAndPush(branchDir: string, log: (msg: string) => void): Promise<void> {
  log(`[ci-check-watcher] Staging changes and amending commit in ${branchDir}`);
  await exec('git add -u', { cwd: branchDir });

  // Only amend if there are staged changes
  const { stdout: diffOut } = await exec('git diff --cached --stat', { cwd: branchDir });
  if (!diffOut.trim()) {
    log(`[ci-check-watcher] No staged changes after fix — skipping amend`);
    return;
  }

  await exec('git commit --amend --no-edit', { cwd: branchDir });
  log(`[ci-check-watcher] Force-pushing amended commit`);
  await exec('git push --force-with-lease', { cwd: branchDir });
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export async function watchAndFixPrChecks(args: CIWatcherArgs): Promise<CIWatchResult> {
  const {
    prNumber,
    owner,
    repo,
    branchDir,
    githubToken,
    maxWaitMs = 3_600_000,
    pollIntervalMs = 300_000,
    log = (msg: string) => console.log(msg),
  } = args;

  const deadline = Date.now() + maxWaitMs;
  const autoFixed: string[] = [];
  const requiresHuman: CIWatchResult['requiresHuman'] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() > deadline) {
      log(`[ci-check-watcher] Reached maxWaitMs (${maxWaitMs} ms) without all checks passing`);
      return { allPassed: false, autoFixed, requiresHuman };
    }

    // 1. Resolve the current head SHA (may change after we push amendments)
    const sha = await getPrHeadSha(owner, repo, prNumber, githubToken);
    log(`[ci-check-watcher] PR #${prNumber} head SHA: ${sha}`);

    // 2. Fetch check-runs
    let checks: CheckRun[];
    try {
      checks = await getCheckRuns(owner, repo, sha, githubToken);
    } catch (err) {
      log(`[ci-check-watcher] Error fetching check-runs: ${err}`);
      await sleep(pollIntervalMs);
      continue;
    }

    if (checks.length === 0) {
      log(`[ci-check-watcher] No check-runs found yet — waiting`);
      await sleep(pollIntervalMs);
      continue;
    }

    // 3. If any checks are still pending, wait
    const pending = checks.filter((c) => c.status !== 'completed');
    if (pending.length > 0) {
      log(`[ci-check-watcher] ${pending.length} check(s) still pending — waiting ${pollIntervalMs} ms`);
      await sleep(pollIntervalMs);
      continue;
    }

    // 4. All checks completed
    const failed = checks.filter(
      (c) => c.conclusion !== 'success' && c.conclusion !== 'neutral' && c.conclusion !== 'skipped',
    );

    if (failed.length === 0) {
      log(`[ci-check-watcher] All checks passed`);
      return { allPassed: true, autoFixed, requiresHuman };
    }

    log(`[ci-check-watcher] ${failed.length} failing check(s): ${failed.map((c) => c.name).join(', ')}`);

    // 5. Triage failing checks
    let madeAFix = false;

    for (const check of failed) {
      if (isAutoFixable(check.name)) {
        const tool = detectLintTool(check.name)!;
        log(`[ci-check-watcher] Attempting auto-fix for lint check: ${check.name} (tool=${tool})`);

        // Download log to find pinned version
        let jobLog = '';
        try {
          jobLog = await getCheckRunLog(owner, repo, check.id, githubToken);
        } catch (err) {
          log(`[ci-check-watcher] Could not download log for ${check.name}: ${err}`);
        }

        const pinnedVersion = parsePinnedVersion(jobLog, tool);
        if (!pinnedVersion) {
          log(`[ci-check-watcher] Could not parse pinned version of ${tool} from log — escalating`);
          requiresHuman.push({
            name: check.name,
            reason: `Could not determine pinned ${tool} version from CI log`,
            logSnippet: jobLog.slice(0, 1000),
          });
          continue;
        }

        log(`[ci-check-watcher] Pinned version: ${tool}==${pinnedVersion}`);

        try {
          await autoFixLint(tool, pinnedVersion, branchDir, log);
          await commitAmendAndPush(branchDir, log);
          autoFixed.push(check.name);
          madeAFix = true;
        } catch (err) {
          log(`[ci-check-watcher] Auto-fix failed for ${check.name}: ${err}`);
          const errMsg = err instanceof Error ? err.message : String(err);
          requiresHuman.push({
            name: check.name,
            reason: `Auto-fix attempt failed: ${errMsg.slice(0, 500)}`,
            logSnippet: jobLog.slice(0, 1000),
          });
        }
      } else {
        // CLA, security scan, test failures — cannot auto-fix
        let logSnippet = '';
        try {
          const jobLog = await getCheckRunLog(owner, repo, check.id, githubToken);
          logSnippet = jobLog.slice(-2000); // last 2 KB is usually the relevant failure
        } catch {
          // ignore log fetch errors for human-escalation items
        }

        requiresHuman.push({
          name: check.name,
          reason: humanReason(check.name),
          logSnippet,
        });
      }
    }

    if (madeAFix) {
      // Give GitHub time to register the push and queue new check-runs
      log(`[ci-check-watcher] Fix applied — waiting ${pollIntervalMs} ms before re-polling`);
      await sleep(pollIntervalMs);
    } else {
      // Nothing more we can do; return what we have
      return { allPassed: false, autoFixed, requiresHuman };
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
