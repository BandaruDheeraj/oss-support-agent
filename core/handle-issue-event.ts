import * as path from 'path';

import type { IssueEvent } from './webhook/types';
import { loadManifest } from './manifest/loader';
import type { Manifest } from './manifest/types';
import type { RepoAdapter } from './adapter.interface';
import { loadAdapter } from './adapter-loader';
import type { RunIntrospectionLike } from './adapter-loader';

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

function getRequiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export async function handleIssueEvent(args: {
  event: IssueEvent;
  repoRoot?: string;
  runPipeline: RunPipeline;
  /** Optional: used for onboarding when configs/<org>/<repo>/manifest.yaml is missing. */
  runIntrospection?: RunIntrospectionLike;
  defaultPmEmailEnvVar?: string;
  defaultForkOrgEnvVar?: string;
}): Promise<void> {
  const repoRoot = args.repoRoot ?? process.cwd();
  const repoFullName = args.event.repository.full_name;
  const { owner, repo } = parseRepoFullName(repoFullName);

  const configDir = path.join(repoRoot, 'configs', owner, repo);
  const manifestPath = path.join(configDir, 'manifest.yaml');

  let manifest: Manifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (err: any) {
    // Onboarding path: if manifest is missing, trigger introspection to generate configs.
    const msg = err?.message ?? String(err);
    const missing = msg.includes('Manifest file not found');

    if (!missing || !args.runIntrospection) {
      throw err;
    }

    const pmEnv = args.defaultPmEmailEnvVar ?? 'DEFAULT_PM_EMAIL';
    const forkEnv = args.defaultForkOrgEnvVar ?? 'DEFAULT_FORK_ORG';
    const pmEmail = getRequiredEnv(pmEnv);
    const forkOrg = getRequiredEnv(forkEnv);

    await args.runIntrospection(repoFullName, pmEmail, forkOrg, { repoRoot });
    manifest = loadManifest(manifestPath);
  }

  const adapter = await loadAdapter(repoFullName, { repoRoot, runIntrospection: args.runIntrospection });
  await args.runPipeline({ event: args.event, manifest, adapter });
}
