import * as path from 'path';

import type { IssueEvent } from './webhook/types';
import { loadManifest } from './manifest/loader';
import type { Manifest } from './manifest/types';
import type { RepoAdapter } from './adapter.interface';
import { loadAdapter } from './adapter-loader';

export type RunPipeline = (args: {
  event: IssueEvent;
  manifest: Manifest;
  adapter: RepoAdapter;
}) => Promise<void>;

function parseRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const parts = repoFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repoFullName (expected owner/repo): ${repoFullName}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export async function handleIssueEvent(args: {
  event: IssueEvent;
  repoRoot?: string;
  runPipeline: RunPipeline;
}): Promise<void> {
  const repoRoot = args.repoRoot ?? process.cwd();
  const repoFullName = args.event.repository.full_name;
  const { owner, repo } = parseRepoFullName(repoFullName);

  const manifestPath = path.join(repoRoot, 'configs', owner, repo, 'manifest.yaml');
  const manifest = loadManifest(manifestPath);

  const adapter = await loadAdapter(repoFullName, { repoRoot });
  await args.runPipeline({ event: args.event, manifest, adapter });
}
