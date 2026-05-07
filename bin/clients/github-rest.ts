/**
 * Minimal real GitHub REST clients for label management and issue commenting.
 *
 * Uses Node 18+ built-in fetch. Authenticated with a fine-grained PAT that has:
 *   - issues:write, metadata:read on the upstream repo (label create + comment)
 */

import type { RepoLabelClient } from '../../core/agents/introspection-orchestration';
import type { IssueCommenter } from '../../core/agents/triage-types';

const GITHUB_API = 'https://api.github.com';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'oss-support-agent',
  };
}

export class GitHubLabelClient implements RepoLabelClient {
  constructor(private readonly token: string) {}

  async getLabel(repoFullName: string, name: string): Promise<{ name: string } | null> {
    const url = `${GITHUB_API}/repos/${repoFullName}/labels/${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: authHeaders(this.token) });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GitHub getLabel failed (${res.status}): ${await res.text()}`);
    }
    const json: any = await res.json();
    return { name: json.name };
  }

  async createLabel(
    repoFullName: string,
    label: { name: string; color?: string; description?: string }
  ): Promise<void> {
    const url = `${GITHUB_API}/repos/${repoFullName}/labels`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(this.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: label.name,
        color: label.color ?? 'ededed',
        description: label.description ?? 'Managed by oss-support-agent harness',
      }),
    });
    if (!res.ok && res.status !== 422) {
      // 422 = label already exists; treat as idempotent.
      throw new Error(`GitHub createLabel failed (${res.status}): ${await res.text()}`);
    }
  }
}

export class GitHubIssueCommenter implements IssueCommenter {
  constructor(private readonly token: string) {}

  async postComment(repo: string, issueNumber: number, comment: string): Promise<void> {
    const url = `${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(this.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: comment }),
    });
    if (!res.ok) {
      throw new Error(`GitHub postComment failed (${res.status}): ${await res.text()}`);
    }
  }
}
