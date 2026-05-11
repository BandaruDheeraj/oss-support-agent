/**
 * Read-only GitHub code browser for the PM design agent.
 *
 * Exposes three primitives the LLM can request via the action loop:
 *   - listDirectory: list files in a path
 *   - readFile: fetch a file's text content (truncated to MAX_FILE_BYTES)
 *   - searchCode: GitHub code search restricted to one repo
 *
 * Uses the GitHub REST API directly (same auth pattern as pm-deps.ts).
 */

const GITHUB_API = 'https://api.github.com';
const MAX_FILE_BYTES = 50_000;

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'oss-support-agent',
  };
}

export interface DirEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size: number;
}

export interface FileResult {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
}

export interface CodeSearchHit {
  path: string;
  matches: string[];
}

export class GitHubCodeBrowser {
  constructor(private readonly token: string) {}

  async listDirectory(repo: string, dirPath: string, ref?: string): Promise<DirEntry[]> {
    const cleanPath = (dirPath ?? '').replace(/^\/+|\/+$/g, '');
    const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const url = `${GITHUB_API}/repos/${repo}/contents/${cleanPath}${refQuery}`;
    const res = await fetch(url, { headers: authHeaders(this.token) });
    if (!res.ok) {
      throw new Error(`listDirectory ${repo}/${cleanPath} failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as Array<{ path: string; type: DirEntry['type']; size?: number }> | { type: string };
    if (!Array.isArray(data)) {
      throw new Error(`listDirectory ${repo}/${cleanPath} did not return a directory`);
    }
    return data.map((e) => ({ path: e.path, type: e.type, size: e.size ?? 0 }));
  }

  async readFile(repo: string, filePath: string, ref?: string): Promise<FileResult> {
    const cleanPath = filePath.replace(/^\/+/, '');
    const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const url = `${GITHUB_API}/repos/${repo}/contents/${cleanPath}${refQuery}`;
    const res = await fetch(url, { headers: authHeaders(this.token) });
    if (!res.ok) {
      throw new Error(`readFile ${repo}/${cleanPath} failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { type: string; encoding?: string; content?: string; size?: number };
    if (data.type !== 'file') {
      throw new Error(`readFile ${repo}/${cleanPath} is not a file (type=${data.type})`);
    }
    if (data.encoding !== 'base64' || typeof data.content !== 'string') {
      throw new Error(`readFile ${repo}/${cleanPath} unexpected encoding ${data.encoding}`);
    }
    const buf = Buffer.from(data.content, 'base64');
    const truncated = buf.byteLength > MAX_FILE_BYTES;
    const slice = truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf;
    return {
      path: cleanPath,
      content: slice.toString('utf8'),
      truncated,
      size: data.size ?? buf.byteLength,
    };
  }

  async searchCode(repo: string, query: string): Promise<CodeSearchHit[]> {
    const q = `repo:${repo} ${query}`;
    const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(q)}&per_page=10`;
    const res = await fetch(url, { headers: authHeaders(this.token) });
    if (!res.ok) {
      throw new Error(`searchCode ${repo} '${query}' failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { items?: Array<{ path: string; text_matches?: Array<{ fragment: string }> }> };
    return (data.items ?? []).map((item) => ({
      path: item.path,
      matches: (item.text_matches ?? []).map((m) => m.fragment),
    }));
  }
}
