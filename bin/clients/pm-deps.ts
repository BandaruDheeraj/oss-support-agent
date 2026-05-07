/**
 * Real implementations of PM agent + retry loop dependencies using GitHub REST.
 *
 * - PMIssueSearcher: searches related open issues
 * - PMPRFetcher: fetches recent merged PRs touching the affected module
 * - PMDesignDocFinder: searches the repo for design docs
 * - GitHubIssueLabeler: adds labels to issues
 * - GmailFailureNotifier: sends failure notification emails
 */

import type { IssueSearcher, PRFetcher, DesignDocFinder, RelatedIssue, RelatedPR, DesignDoc } from '../../core/agents/pm-types';
import type { IssueLabeler, FailureNotifier } from '../../core/retry-loop-types';
import type { GmailClient } from '../../core/gmail-types';

const GITHUB_API = 'https://api.github.com';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'oss-support-agent',
  };
}

async function ghJson<T>(token: string, url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) {
    throw new Error(`GitHub GET ${url} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export class GitHubIssueSearcher implements IssueSearcher {
  constructor(private readonly token: string) {}

  async searchRelatedIssues(
    repo: string,
    module: string,
    errorPattern: string | null,
    apiSurface: string | null
  ): Promise<RelatedIssue[]> {
    const terms: string[] = [];
    if (errorPattern) terms.push(`"${errorPattern}"`);
    if (apiSurface) terms.push(`"${apiSurface}"`);
    if (!terms.length && module) terms.push(`"${module}"`);

    const q = `repo:${repo} is:issue is:open ${terms.join(' OR ')}`;
    const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&per_page=10`;
    try {
      const data = await ghJson<any>(this.token, url);
      return (data.items ?? []).slice(0, 10).map((i: any) => ({
        number: i.number,
        title: i.title,
        labels: (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)),
        reason: errorPattern ? `mentions "${errorPattern}"` : `mentions "${module}"`,
      }));
    } catch {
      return [];
    }
  }
}

export class GitHubPRFetcher implements PRFetcher {
  constructor(private readonly token: string) {}

  async getRecentMergedPRs(repo: string, module: string, limit: number): Promise<RelatedPR[]> {
    const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(
      `repo:${repo} is:pr is:merged ${module}`
    )}&sort=updated&order=desc&per_page=${Math.min(limit, 30)}`;
    try {
      const data = await ghJson<any>(this.token, url);
      const results: RelatedPR[] = [];
      for (const item of (data.items ?? []).slice(0, limit)) {
        results.push({
          number: item.number,
          title: item.title,
          files_changed: [],
          merged_at: item.closed_at ?? item.updated_at ?? '',
        });
      }
      return results;
    } catch {
      return [];
    }
  }
}

export class GitHubDesignDocFinder implements DesignDocFinder {
  constructor(private readonly token: string) {}

  async findDesignDocs(repo: string, _module: string): Promise<DesignDoc[]> {
    const q = `repo:${repo} (filename:DESIGN.md OR filename:RFC.md OR path:docs/design)`;
    const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(q)}&per_page=10`;
    try {
      const data = await ghJson<any>(this.token, url);
      return (data.items ?? []).slice(0, 10).map((i: any) => ({
        path: i.path,
        excerpt: i.name,
      }));
    } catch {
      return [];
    }
  }
}

export class GitHubIssueLabeler implements IssueLabeler {
  constructor(private readonly token: string) {}

  async addLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    const url = `${GITHUB_API}/repos/${repo}/issues/${issueNumber}/labels`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(this.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: [label] }),
    });
    if (!res.ok) {
      throw new Error(`GitHub addLabel failed (${res.status}): ${await res.text()}`);
    }
  }
}

export class GmailFailureNotifier implements FailureNotifier {
  constructor(private readonly client: GmailClient) {}

  async sendEmail(to: string, subject: string, body: string, replyTo: string): Promise<void> {
    await this.client.sendEmail({ to, subject, body, replyTo });
  }
}
