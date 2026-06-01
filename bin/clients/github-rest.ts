/**
 * Minimal real GitHub REST clients for label management, issue commenting,
 * fork/branch ops (US-006 GitHubClient interface), and PR creation.
 *
 * Uses Node 18+ built-in fetch. Authenticated with a fine-grained PAT.
 */

import type { RepoLabelClient } from '../../core/agents/introspection-orchestration';
import type { IssueCommenter } from '../../core/agents/triage-types';
import type { GitHubClient } from '../../core/fork-types';

const GITHUB_API = 'https://api.github.com';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'oss-support-agent',
  };
}

async function ghFetch(
  token: string,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = { ...authHeaders(token), ...(init.headers as Record<string, string> | undefined) };
  return fetch(url, { ...init, headers });
}

async function ghJson<T>(
  token: string,
  url: string,
  init: RequestInit = {},
  acceptStatuses: number[] = []
): Promise<T> {
  const res = await ghFetch(token, url, init);
  if (!res.ok && !acceptStatuses.includes(res.status)) {
    throw new Error(`GitHub ${init.method ?? 'GET'} ${url} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class GitHubLabelClient implements RepoLabelClient {
  constructor(private readonly token: string) {}

  async getLabel(repoFullName: string, name: string): Promise<{ name: string } | null> {
    const url = `${GITHUB_API}/repos/${repoFullName}/labels/${encodeURIComponent(name)}`;
    const res = await ghFetch(this.token, url);
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
    const res = await ghFetch(this.token, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: label.name,
        color: label.color ?? 'ededed',
        description: label.description ?? 'Managed by oss-support-agent harness',
      }),
    });
    if (!res.ok && res.status !== 422) {
      throw new Error(`GitHub createLabel failed (${res.status}): ${await res.text()}`);
    }
  }
}

export class GitHubIssueCommenter implements IssueCommenter {
  constructor(private readonly token: string) {}

  async postComment(repo: string, issueNumber: number, comment: string): Promise<void> {
    const url = `${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments`;
    const res = await ghFetch(this.token, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: comment }),
    });
    if (!res.ok) {
      throw new Error(`GitHub postComment failed (${res.status}): ${await res.text()}`);
    }
  }
}

/**
 * REST-based GitHubClient implementing fork/branch ops used by createForkAndBranch.
 */
export class GitHubRestClient implements GitHubClient {
  constructor(
    private readonly token: string,
    private readonly options: { forkReadyTimeoutMs?: number; forkPollIntervalMs?: number } = {}
  ) {}

  async repoExists(fullName: string): Promise<boolean> {
    const res = await ghFetch(this.token, `${GITHUB_API}/repos/${fullName}`);
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(`GitHub repoExists failed (${res.status}): ${await res.text()}`);
    }
    return true;
  }

  async createFork(upstream: string, org: string): Promise<string> {
    const url = `${GITHUB_API}/repos/${upstream}/forks`;
    const myUser = await this.getAuthenticatedUserLogin();
    const isPersonalFork = org === myUser;
    const body: any = {};
    if (!isPersonalFork) body.organization = org;

    const res = await ghFetch(this.token, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`GitHub createFork failed (${res.status}): ${await res.text()}`);
    }
    const json: any = await res.json();
    const forkFullName: string = json.full_name;

    // Fork creation is async; poll until repo is reachable.
    const timeout = this.options.forkReadyTimeoutMs ?? 60_000;
    const poll = this.options.forkPollIntervalMs ?? 2_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.repoExists(forkFullName)) return forkFullName;
      await sleep(poll);
    }
    throw new Error(`Fork ${forkFullName} not ready after ${timeout}ms`);
  }

  async syncFork(forkFullName: string): Promise<void> {
    const defaultBranch = await this.getDefaultBranch(forkFullName);
    const url = `${GITHUB_API}/repos/${forkFullName}/merge-upstream`;
    const res = await ghFetch(this.token, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: defaultBranch }),
    });
    if (!res.ok && res.status !== 409) {
      // 409 = no upstream changes / already up to date — treat as OK
      throw new Error(`GitHub syncFork failed (${res.status}): ${await res.text()}`);
    }
  }

  async getDefaultBranch(fullName: string): Promise<string> {
    const json = await ghJson<any>(this.token, `${GITHUB_API}/repos/${fullName}`);
    return json.default_branch;
  }

  async getFileContents(
    fullName: string,
    filePath: string,
    ref: string
  ): Promise<{ ok: boolean; status: number; content?: string; error?: string }> {
    const url = `${GITHUB_API}/repos/${fullName}/contents/${filePath}?ref=${encodeURIComponent(ref)}`;
    const res = await ghFetch(this.token, url);
    if (res.status === 404) {
      return { ok: false, status: 404 };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: await res.text(),
      };
    }
    const json: any = await res.json();
    if (typeof json.content === 'string') {
      return {
        ok: true,
        status: 200,
        content: Buffer.from(json.content, 'base64').toString('utf-8'),
      };
    }
    return { ok: true, status: 200 };
  }

  async getBranchSha(fullName: string, branch: string): Promise<string | null> {
    const url = `${GITHUB_API}/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`;
    const res = await ghFetch(this.token, url);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GitHub getBranchSha failed (${res.status}): ${await res.text()}`);
    }
    const json: any = await res.json();
    return json.object?.sha ?? null;
  }

  async createBranch(fullName: string, branch: string, sha: string): Promise<void> {
    const url = `${GITHUB_API}/repos/${fullName}/git/refs`;
    const res = await ghFetch(this.token, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
    if (!res.ok) {
      throw new Error(`GitHub createBranch failed (${res.status}): ${await res.text()}`);
    }
  }

  async updateBranchRef(fullName: string, branch: string, sha: string): Promise<void> {
    const url = `${GITHUB_API}/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`;
    const res = await ghFetch(this.token, url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha, force: true }),
    });
    if (!res.ok) {
      throw new Error(`GitHub updateBranchRef failed (${res.status}): ${await res.text()}`);
    }
  }

  async getTokenScopes(): Promise<string[]> {
    const res = await ghFetch(this.token, `${GITHUB_API}/user`);
    if (!res.ok) {
      throw new Error(`GitHub getTokenScopes failed (${res.status}): ${await res.text()}`);
    }
    const scopesHeader = res.headers.get('x-oauth-scopes') ?? '';
    return scopesHeader
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /** Used internally to decide org vs personal fork. */
  async getAuthenticatedUserLogin(): Promise<string> {
    const json = await ghJson<any>(this.token, `${GITHUB_API}/user`);
    return json.login;
  }

  /**
   * Create a draft pull request from {forkFullName}:{branch} into {upstream}:{baseBranch}.
   * Returns PR HTML URL.
   */
  async createPullRequest(args: {
    upstream: string;
    forkFullName: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<{ url: string; number: number }> {
    const url = `${GITHUB_API}/repos/${args.upstream}/pulls`;
    const headOwner = args.forkFullName.split('/')[0];
    const head = `${headOwner}:${args.headBranch}`;
    const res = await ghFetch(this.token, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: args.title,
        body: args.body,
        head,
        base: args.baseBranch,
        draft: args.draft ?? true,
        maintainer_can_modify: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`GitHub createPullRequest failed (${res.status}): ${await res.text()}`);
    }
    const json: any = await res.json();
    return { url: json.html_url, number: json.number };
  }

  async addLabelsToPR(repo: string, prNumber: number, labels: string[]): Promise<void> {
    if (!labels.length) return;
    const url = `${GITHUB_API}/repos/${repo}/issues/${prNumber}/labels`;
    const res = await ghFetch(this.token, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels }),
    });
    if (!res.ok) {
      throw new Error(`GitHub addLabelsToPR failed (${res.status}): ${await res.text()}`);
    }
  }
}
