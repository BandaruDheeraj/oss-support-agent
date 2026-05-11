/**
 * Live deps for the issue-sweep / scope-confirmation flow (Phase 5).
 *
 * - InMemorySweepStateStore: simple Map-backed SweepStateStore.
 *   Sweep state is intentionally NOT file-backed: if the server restarts
 *   between scope-email and PM reply, the run-pipeline call has already
 *   returned anyway (sweep waits inside a Promise). On restart, the user's
 *   reply will arrive but no waiter is registered — the inbound dispatcher
 *   will log and drop it. The user can re-label the issue to retry. This is
 *   an acceptable degradation for the single-server MVP.
 *
 * - listOpenIssues: fetches open issues (title + labels) via GitHub REST.
 *   Used by the sweeper to score candidates against the agreed design.
 */

import type { SweepIssue, SweepStateStore } from '../../core/issue-sweep-types';
import type { EmailThread } from '../../core/gmail-types';
import type { SweepResult } from '../../core/issue-sweep-types';

const GITHUB_API = 'https://api.github.com';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'oss-support-agent',
  };
}

/**
 * Fetch open issues from a GitHub repo. Returns title + labels + number.
 * Bodies are not fetched (heuristic sweeper scores titles only).
 * Excludes pull requests (the REST endpoint returns both unless filtered).
 */
export async function listOpenIssues(
  token: string,
  repoFullName: string,
  limit = 50
): Promise<SweepIssue[]> {
  const per = Math.min(limit, 100);
  const url = `${GITHUB_API}/repos/${repoFullName}/issues?state=open&per_page=${per}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) {
    throw new Error(`GitHub GET ${url} failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as any[];
  return data
    .filter((i) => !i.pull_request) // exclude PRs
    .slice(0, limit)
    .map((i) => ({
      number: i.number as number,
      title: (i.title ?? '') as string,
      labels: (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)),
      reason: '',
    }));
}

/**
 * Fetch a single issue's full details (title, body, labels). Used to hydrate
 * the ConfirmedIssue list after the sweep returns numbers only.
 */
export async function getIssueDetails(
  token: string,
  repoFullName: string,
  issueNumber: number
): Promise<{ number: number; title: string; body: string; labels: string[] } | null> {
  const url = `${GITHUB_API}/repos/${repoFullName}/issues/${issueNumber}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) {
    return null;
  }
  const i = (await res.json()) as any;
  return {
    number: i.number as number,
    title: (i.title ?? '') as string,
    body: (i.body ?? '') as string,
    labels: (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)),
  };
}

interface SweepStateEntry {
  thread: EmailThread;
  sweepResult: SweepResult;
}

/**
 * In-memory SweepStateStore. Single-process only.
 */
export class InMemorySweepStateStore implements SweepStateStore {
  private readonly map = new Map<string, SweepStateEntry>();

  saveSweepState(runId: string, thread: EmailThread, sweepResult: SweepResult): void {
    this.map.set(runId, { thread, sweepResult });
  }

  loadSweepState(runId: string): SweepStateEntry | null {
    return this.map.get(runId) ?? null;
  }

  deleteSweepState(runId: string): void {
    this.map.delete(runId);
  }
}
