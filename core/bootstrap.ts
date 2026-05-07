import * as fs from 'fs';
import * as path from 'path';

import type { RunIntrospectionLike } from './adapter-loader';

export interface WatchedRepo {
  repo: string;
  pm_email: string;
  fork_org: string;
}

function parseRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const parts = repoFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo (expected owner/repo): ${repoFullName}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export function parseWatchedReposJson(json: string): WatchedRepo[] {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error('watched_repos must be a JSON array');
  }
  for (const r of parsed) {
    if (!r || typeof r !== 'object') throw new Error('watched_repos entries must be objects');
    if (typeof r.repo !== 'string') throw new Error('watched_repos[].repo must be a string');
    if (typeof r.pm_email !== 'string') throw new Error('watched_repos[].pm_email must be a string');
    if (typeof r.fork_org !== 'string') throw new Error('watched_repos[].fork_org must be a string');
  }
  return parsed as WatchedRepo[];
}

export function repoHasConfigs(repoRoot: string, repoFullName: string): boolean {
  const { owner, repo } = parseRepoFullName(repoFullName);
  const adapterPath = path.join(repoRoot, 'configs', owner, repo, 'adapter.ts');
  const adapterJsPath = path.join(repoRoot, 'configs', owner, repo, 'adapter.js');
  return fs.existsSync(adapterPath) || fs.existsSync(adapterJsPath);
}

export async function bootstrapWatchedRepos(args: {
  repoRoot?: string;
  watchedRepos: WatchedRepo[];
  runIntrospection: RunIntrospectionLike;
}): Promise<{ triggered: string[]; skipped: string[] }> {
  const repoRoot = args.repoRoot ?? process.cwd();
  const triggered: string[] = [];
  const skipped: string[] = [];

  for (const w of args.watchedRepos) {
    if (repoHasConfigs(repoRoot, w.repo)) {
      skipped.push(w.repo);
      continue;
    }
    await args.runIntrospection(w.repo, w.pm_email, w.fork_org, { repoRoot });
    triggered.push(w.repo);
  }

  return { triggered, skipped };
}
