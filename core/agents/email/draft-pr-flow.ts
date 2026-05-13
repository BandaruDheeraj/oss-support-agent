/**
 * Draft PR flow: fix_proposal email opens the PR in draft state; approval
 * via signed token flips it to open and adds a label. No `merge_pr` tool
 * exists in the registry — humans merge in GitHub.
 *
 * This module is a thin helper around the GitHub API used by the cutover
 * adapter in bin/run-pipeline.ts. The implementation is intentionally
 * env-aware so tests can run with no token.
 */

export interface OpenDraftOptions {
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

export interface DraftPrOutcome {
  ok: boolean;
  prNumber?: number;
  prUrl?: string;
  reason?: string;
}

async function ghFetch(path: string, init: RequestInit & { method?: string }): Promise<Response> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      'User-Agent': 'oss-support-agent',
      Accept: 'application/vnd.github+json',
    },
  });
  return res;
}

export async function openDraftPr(opts: OpenDraftOptions): Promise<DraftPrOutcome> {
  try {
    const res = await ghFetch(`/repos/${opts.owner}/${opts.repo}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: opts.title, body: opts.body, head: opts.head, base: opts.base, draft: true }),
    });
    if (!res.ok) return { ok: false, reason: `gh ${res.status}: ${await res.text()}` };
    const pr = (await res.json()) as { number: number; html_url: string };
    return { ok: true, prNumber: pr.number, prUrl: pr.html_url };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export async function flipDraftToOpen(owner: string, repo: string, prNumber: number, label = 'osa-approved'): Promise<DraftPrOutcome> {
  try {
    // PATCH the PR to mark it ready_for_review = remove draft
    const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: false }),
    });
    if (!res.ok) return { ok: false, reason: `flip ${res.status}: ${await res.text()}` };
    // Apply label
    await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: [label] }),
    });
    return { ok: true, prNumber };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
