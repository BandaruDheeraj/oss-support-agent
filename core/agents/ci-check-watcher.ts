/**
 * CI Check Watcher
 *
 * Polls a PR's check-runs after the PR is opened and auto-fixes lint failures
 * (ruff / format checks) by installing the pinned tool version, running the
 * fix in the local clone, and amending + force-pushing the branch.
 *
 * For checks that cannot be auto-fixed (CLA, zizmor, mypy, tests) the check
 * name is surfaced in the `manualActionNeeded` list so the caller can handle
 * it appropriately.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

const execFileAsync = promisify(execFile);

const GITHUB_API = 'https://api.github.com';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CheckRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

export interface CIWatchResult {
  allPassed: boolean;
  failedChecks: string[];
  autoFixedChecks: string[];
  manualActionNeeded: string[];
}

export interface CIWatchArgs {
  prNumber: number;
  repoFullName: string;    // upstream repo e.g. "Arize-ai/openinference"
  branchName: string;
  localRepoPath: string;   // path to the local clone
  token: string;
  pollIntervalMs?: number; // default 5 * 60 * 1000
  maxWaitMs?: number;      // default 60 * 60 * 1000
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'oss-support-agent',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Minimal request helper that mirrors the private `request()` pattern used in
 * github-actions.ts — it attaches auth headers and throws on non-OK responses.
 */
async function request(
  token: string,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    ...authHeaders(token),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  const res = await fetch(url, { ...init, headers });
  return res;
}

/**
 * Fetch all check-runs for the HEAD commit of a PR.
 */
async function listCheckRuns(
  token: string,
  repoFullName: string,
  prNumber: number
): Promise<CheckRunSummary[]> {
  // First resolve the HEAD SHA of the PR.
  const prUrl = `${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`;
  const prRes = await request(token, prUrl);
  if (!prRes.ok) {
    throw new Error(
      `Failed to fetch PR #${prNumber} from ${repoFullName} (${prRes.status}): ${await prRes.text()}`
    );
  }
  const prData: any = await prRes.json();
  const headSha: string = prData.head?.sha;
  if (!headSha) {
    throw new Error(`PR #${prNumber} has no head SHA`);
  }

  // Retrieve check-runs for that SHA (paginate if necessary).
  const checks: CheckRunSummary[] = [];
  let page = 1;
  while (true) {
    const url = `${GITHUB_API}/repos/${repoFullName}/commits/${headSha}/check-runs?per_page=100&page=${page}`;
    const res = await request(token, url);
    if (!res.ok) {
      throw new Error(
        `Failed to list check-runs for ${repoFullName}@${headSha} (${res.status}): ${await res.text()}`
      );
    }
    const data: any = await res.json();
    const runs: any[] = data.check_runs ?? [];
    for (const run of runs) {
      checks.push({
        name: String(run.name ?? ''),
        status: String(run.status ?? ''),
        conclusion: run.conclusion != null ? String(run.conclusion) : null,
        detailsUrl: run.details_url != null ? String(run.details_url) : null,
      });
    }
    if (runs.length < 100) break;
    page++;
  }
  return checks;
}

/**
 * Download the log text for a specific check-run job.
 * GitHub's check-run logs redirect to a short-lived URL; we follow redirects.
 */
async function downloadCheckRunLog(
  token: string,
  repoFullName: string,
  checkRunId: number
): Promise<string> {
  const url = `${GITHUB_API}/repos/${repoFullName}/actions/jobs/${checkRunId}/logs`;
  const res = await request(token, url, { redirect: 'follow' });
  if (!res.ok) {
    // Logs may not be available for all check-run types; return empty string
    // so callers degrade gracefully.
    return '';
  }
  return res.text();
}

/**
 * Return the check-run id (job id) for a given check-run name on a PR's HEAD.
 * Returns null when it cannot be resolved.
 */
async function resolveCheckRunId(
  token: string,
  repoFullName: string,
  prNumber: number,
  checkName: string
): Promise<number | null> {
  const prUrl = `${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`;
  const prRes = await request(token, prUrl);
  if (!prRes.ok) return null;
  const prData: any = await prRes.json();
  const headSha: string = prData.head?.sha;
  if (!headSha) return null;

  const url = `${GITHUB_API}/repos/${repoFullName}/commits/${headSha}/check-runs?per_page=100`;
  const res = await request(token, url);
  if (!res.ok) return null;
  const data: any = await res.json();
  const runs: any[] = data.check_runs ?? [];
  const match = runs.find((r) => String(r.name ?? '') === checkName);
  return match ? (match.id as number) : null;
}

/**
 * Determine whether a check name looks like a lint / format check that we
 * should attempt to auto-fix with ruff.
 */
function isLintCheck(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('ruff') || lower.includes('lint') || lower.includes('format');
}

/**
 * Determine whether a check name requires manual action (cannot be auto-fixed).
 */
function isManualOnlyCheck(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes('cla') ||
    lower.includes('zizmor') ||
    lower.includes('mypy') ||
    lower.includes('test')
  );
}

// ---------------------------------------------------------------------------
// Exported utility functions
// ---------------------------------------------------------------------------

/**
 * Parse pinned tool version from a CI job log.
 * e.g. "ruff==0.9.2" in the pip list output → {tool: "ruff", version: "0.9.2"}
 */
export function parsePinnedToolVersion(jobLog: string, toolName: string): string | null {
  const regex = new RegExp(`${toolName}==(\\S+)`, 'i');
  const match = jobLog.match(regex);
  return match ? match[1] : null;
}

/**
 * Install a tool in a temp venv and return the path to the binary.
 * If the venv already exists with that tool version it is reused.
 */
export async function installToolInVenv(tool: string, version: string): Promise<string> {
  const venvPath = path.join(os.tmpdir(), `lint-venv-${tool}-${version.replace(/\./g, '-')}`);
  await fs.mkdir(venvPath, { recursive: true });
  await execFileAsync('python3', ['-m', 'venv', venvPath]);
  const pip = path.join(venvPath, 'bin', 'pip');
  await execFileAsync(pip, ['install', `${tool}==${version}`, '--quiet']);
  return path.join(venvPath, 'bin', tool);
}

/**
 * Run ruff --fix + format with a pinned binary on a directory.
 * Returns true if the directory is clean after the fix, false if errors remain.
 */
export async function runRuffFix(ruffBin: string, targetDir: string): Promise<boolean> {
  await execFileAsync(ruffBin, ['check', '--fix', targetDir]).catch(() => {});
  await execFileAsync(ruffBin, ['format', targetDir]).catch(() => {});
  const { stdout, stderr } = await execFileAsync(ruffBin, ['check', '--no-fix', targetDir]).catch(
    (e) => ({ stdout: '', stderr: String(e) })
  );
  return !stdout.includes('Found') && !stderr.includes('Found');
}

/**
 * Amend the current commit (not a new commit) and force-push.
 */
export async function amendAndPush(
  localRepoPath: string,
  branchName: string,
  remoteName: string
): Promise<void> {
  await execFileAsync('git', ['-C', localRepoPath, 'add', '-u']);
  await execFileAsync('git', ['-C', localRepoPath, 'commit', '--amend', '--no-edit', '--no-verify']);
  await execFileAsync('git', ['-C', localRepoPath, 'push', remoteName, branchName, '--force-with-lease']);
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Watch a PR's CI checks and attempt to auto-fix lint failures.
 *
 * Polling loop:
 *   1. Fetch all check-runs for the PR's HEAD commit.
 *   2. Wait until every check is in a terminal state (completed).
 *   3. For each failing check:
 *      - lint / ruff / format: attempt auto-fix, amend, push.
 *      - CLA / zizmor / mypy / tests: add to manualActionNeeded.
 *   4. After a push, the loop continues so that newly triggered re-runs are
 *      also picked up; but a check name that has already been auto-fixed once
 *      is not re-attempted to avoid infinite loops.
 *   5. Return when all checks pass OR maxWaitMs is exceeded.
 */
export async function watchAndFixPrChecks(args: CIWatchArgs): Promise<CIWatchResult> {
  const {
    prNumber,
    repoFullName,
    branchName,
    localRepoPath,
    token,
    pollIntervalMs = 5 * 60 * 1000,
    maxWaitMs = 60 * 60 * 1000,
    log = () => {},
  } = args;

  const autoFixedChecks: string[] = [];
  const manualActionNeeded: string[] = [];
  // Track which check names we have already attempted to auto-fix so that we
  // do not retry indefinitely if the fix does not actually clear the failure.
  const attemptedFixes = new Set<string>();

  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    let checks: CheckRunSummary[];
    try {
      checks = await listCheckRuns(token, repoFullName, prNumber);
    } catch (err) {
      log(`[ci-check-watcher] Failed to list check-runs: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
      continue;
    }

    if (checks.length === 0) {
      log(`[ci-check-watcher] No check-runs found yet for PR #${prNumber}, waiting…`);
      await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
      continue;
    }

    // Wait until all checks have reached a terminal status.
    const pending = checks.filter((c) => c.status !== 'completed');
    if (pending.length > 0) {
      log(
        `[ci-check-watcher] ${pending.length} check(s) still in-progress (e.g. "${pending[0].name}"), waiting…`
      );
      await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
      continue;
    }

    // All checks are completed. Find failures.
    const failed = checks.filter(
      (c) => c.conclusion !== 'success' && c.conclusion !== 'skipped' && c.conclusion !== 'neutral'
    );

    if (failed.length === 0) {
      log(`[ci-check-watcher] All checks passed for PR #${prNumber}.`);
      return {
        allPassed: true,
        failedChecks: [],
        autoFixedChecks,
        manualActionNeeded,
      };
    }

    log(
      `[ci-check-watcher] ${failed.length} check(s) failing: ${failed.map((c) => c.name).join(', ')}`
    );

    let pushedFix = false;

    for (const check of failed) {
      const name = check.name;

      // Accumulate manual-only checks (de-duplicated).
      if (isManualOnlyCheck(name) && !manualActionNeeded.includes(name)) {
        log(`[ci-check-watcher] Check "${name}" requires manual action, skipping auto-fix.`);
        manualActionNeeded.push(name);
        continue;
      }

      if (!isLintCheck(name)) {
        // Unknown check type — surface as manual.
        if (!manualActionNeeded.includes(name)) {
          log(`[ci-check-watcher] Check "${name}" is not a recognised lint check, adding to manualActionNeeded.`);
          manualActionNeeded.push(name);
        }
        continue;
      }

      if (attemptedFixes.has(name)) {
        log(`[ci-check-watcher] Already attempted fix for "${name}", not retrying.`);
        if (!manualActionNeeded.includes(name)) {
          manualActionNeeded.push(name);
        }
        continue;
      }

      // Attempt auto-fix for lint check.
      log(`[ci-check-watcher] Attempting auto-fix for lint check "${name}"…`);
      attemptedFixes.add(name);

      try {
        // Resolve job id so we can fetch the log.
        const jobId = await resolveCheckRunId(token, repoFullName, prNumber, name);
        let ruffVersion: string | null = null;

        if (jobId !== null) {
          const jobLog = await downloadCheckRunLog(token, repoFullName, jobId);
          ruffVersion = parsePinnedToolVersion(jobLog, 'ruff');
          if (ruffVersion) {
            log(`[ci-check-watcher] Detected pinned ruff version ${ruffVersion} from job log.`);
          }
        }

        let ruffBin: string;
        if (ruffVersion) {
          ruffBin = await installToolInVenv('ruff', ruffVersion);
        } else {
          // Fall back to whichever ruff is on PATH.
          const { stdout } = await execFileAsync('which', ['ruff']).catch(() => ({ stdout: '' }));
          ruffBin = stdout.trim() || 'ruff';
          log(`[ci-check-watcher] No pinned version found; using ruff at "${ruffBin}".`);
        }

        const clean = await runRuffFix(ruffBin, localRepoPath);
        if (clean) {
          log(`[ci-check-watcher] ruff fix succeeded for "${name}", amending and pushing.`);
          await amendAndPush(localRepoPath, branchName, 'origin');
          autoFixedChecks.push(name);
          pushedFix = true;
        } else {
          log(`[ci-check-watcher] ruff fix did not fully clear "${name}"; adding to manualActionNeeded.`);
          if (!manualActionNeeded.includes(name)) {
            manualActionNeeded.push(name);
          }
        }
      } catch (err) {
        log(
          `[ci-check-watcher] Error while attempting auto-fix for "${name}": ${err instanceof Error ? err.message : String(err)}`
        );
        if (!manualActionNeeded.includes(name)) {
          manualActionNeeded.push(name);
        }
      }
    }

    if (pushedFix) {
      // A push was made; wait one full poll interval before re-checking so that
      // GitHub has time to create new check-runs on the amended commit.
      log(`[ci-check-watcher] Fix pushed, waiting ${pollIntervalMs}ms before re-polling…`);
      await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
      continue;
    }

    // No fixes were applied and there are still failures — nothing more to do
    // automatically.
    const stillFailing = failed.map((c) => c.name).filter((n) => !autoFixedChecks.includes(n));
    log(
      `[ci-check-watcher] No further auto-fixes possible. Still failing: ${stillFailing.join(', ')}`
    );
    return {
      allPassed: false,
      failedChecks: stillFailing,
      autoFixedChecks,
      manualActionNeeded,
    };
  }

  // maxWaitMs exceeded.
  log(`[ci-check-watcher] Timed out waiting for PR #${prNumber} checks after ${maxWaitMs}ms.`);
  return {
    allPassed: false,
    failedChecks: ['(timed out)'],
    autoFixedChecks,
    manualActionNeeded,
  };
}
