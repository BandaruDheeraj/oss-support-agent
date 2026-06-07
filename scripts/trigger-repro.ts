/**
 * One-shot script: trigger the repro pipeline for a specific issue directly,
 * bypassing the webhook server. Reads credentials from environment.
 *
 * Usage (full run, saves analyst dossier for replay):
 *   GITHUB_TOKEN=$(gh auth token) DEFAULT_FORK_ORG=BandaruDheeraj \
 *   ts-node scripts/trigger-repro.ts BandaruDheeraj/openinference 55 \
 *     --save-dossier /tmp/dossier-55.json
 *
 * Usage (replay — skip 15-20 min analyst, run builder+sandbox only):
 *   GITHUB_TOKEN=$(gh auth token) DEFAULT_FORK_ORG=BandaruDheeraj \
 *   ts-node scripts/trigger-repro.ts BandaruDheeraj/openinference 55 \
 *     --dossier /tmp/dossier-55.json
 */

import { execSync } from 'child_process';
import { FsManifestRegistry } from '../bin/clients/manifest-registry';
import { FilePipelineRunStateStore } from '../bin/clients/state-stores';
import { processIssueEvent } from '../bin/server';
import type { IssueEvent } from '../core/webhook/types';

async function main() {
  const rawArgs = process.argv.slice(2);

  // Parse --dossier and --save-dossier flags first, then collect positionals.
  const dossierIdx = rawArgs.indexOf('--dossier');
  const saveDossierIdx = rawArgs.indexOf('--save-dossier');
  const dossierPath = dossierIdx !== -1 ? rawArgs[dossierIdx + 1] : undefined;
  const saveDossierPath = saveDossierIdx !== -1 ? rawArgs[saveDossierIdx + 1] : undefined;

  // Positional args: skip flag names and their values.
  const flagValues = new Set([dossierPath, saveDossierPath].filter(Boolean));
  const positionals = rawArgs.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (flagValues.has(a)) return false;
    if (i > 0 && rawArgs[i - 1].startsWith('--')) return false;
    return true;
  });
  const [repoFullName, issueNumberStr] = positionals;

  if (!repoFullName || !issueNumberStr) {
    console.error('usage: ts-node scripts/trigger-repro.ts <owner/repo> <issue-number> [--dossier <file>] [--save-dossier <file>]');
    process.exit(1);
  }
  const issueNumber = parseInt(issueNumberStr, 10);

  // Validate required env vars
  const token = process.env.GITHUB_TOKEN;
  const forkOrg = process.env.DEFAULT_FORK_ORG;
  if (!token) {
    console.error('GITHUB_TOKEN is required. Set it with: export GITHUB_TOKEN=$(gh auth token)');
    process.exit(1);
  }
  if (!forkOrg) {
    console.error('DEFAULT_FORK_ORG is required (e.g. BandaruDheeraj)');
    process.exit(1);
  }
  if (!process.env.WEBHOOK_SECRET) process.env.WEBHOOK_SECRET = 'dev-local';
  if (!process.env.STATE_ROOT) process.env.STATE_ROOT = '/tmp/osa-state';
  if (!process.env.OBSERVABILITY_BACKEND) process.env.OBSERVABILITY_BACKEND = 'none';

  // Inject dossier replay/save paths so runReproPipelineImpl picks them up.
  if (dossierPath) {
    process.env.OSA_SEED_DOSSIER_PATH = dossierPath;
    console.log(`[trigger] analyst skipped — replaying dossier from ${dossierPath}`);
  }
  if (saveDossierPath) {
    process.env.OSA_SAVE_DOSSIER_PATH = saveDossierPath;
    console.log(`[trigger] analyst dossier will be saved to ${saveDossierPath}`);
  }

  // Fetch issue details from GitHub
  console.log(`[trigger] fetching issue ${repoFullName}#${issueNumber}...`);
  let issueJson: any;
  try {
    const out = execSync(
      `gh issue view ${issueNumber} --repo ${repoFullName} --json number,title,body,labels,author`,
      { encoding: 'utf-8' }
    );
    issueJson = JSON.parse(out);
  } catch (err: any) {
    console.error(`Failed to fetch issue: ${err.message}`);
    process.exit(1);
  }

  const payload: IssueEvent = {
    action: 'labeled',
    label: { name: 'agent-fix' },
    issue: {
      number: issueJson.number,
      title: issueJson.title,
      body: issueJson.body ?? '',
      labels: (issueJson.labels ?? []).map((l: any) => ({ name: l.name })),
      user: { login: issueJson.author?.login ?? 'unknown' },
    },
    repository: {
      full_name: repoFullName,
    },
  };

  const registry = new FsManifestRegistry(process.env.REPO_ROOT ?? process.cwd());
  const stateRoot = process.env.STATE_ROOT!;
  const runStateStore = new FilePipelineRunStateStore(stateRoot);

  // Stub the env the server normally requires
  const fakeEnv: any = {
    GITHUB_TOKEN: token,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    DEFAULT_FORK_ORG: forkOrg,
    WORKSPACE_ROOT: process.env.WORKSPACE_ROOT ?? `/tmp/osa-workspaces`,
    STATE_ROOT: stateRoot,
    REPO_ROOT: process.env.REPO_ROOT ?? process.cwd(),
    PORT: 3000,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'oss-support-agent',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'agent@users.noreply.github.com',
  };

  console.log(`[trigger] firing labeled event for issue #${issueNumber}: "${issueJson.title}"`);
  const result = await processIssueEvent(payload, 'issues', registry, fakeEnv, null, runStateStore);
  console.log(`[trigger] processIssueEvent result:`, JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('[trigger] fatal:', err);
  process.exit(1);
});
