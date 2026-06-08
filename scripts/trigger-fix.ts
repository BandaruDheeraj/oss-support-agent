/**
 * One-shot script: run ONLY the fix pipeline for a specific issue, skipping
 * semantic search and the repro pipeline. Requires a pre-saved dossier JSON
 * (produced by trigger-repro.ts --save-dossier or a prior pipeline run).
 *
 * Usage:
 *   GITHUB_TOKEN=$(gh auth token) DEFAULT_FORK_ORG=BandaruDheeraj \
 *   ts-node scripts/trigger-fix.ts BandaruDheeraj/openinference 55 \
 *     --dossier /tmp/dossier-55.json \
 *     [--repro-test tests/repro/test_repro.py] \
 *     [--branch agent/scope-55]
 *
 * The script expects the target branch to already have the repro test committed.
 * Use trigger-repro.ts --save-dossier to produce the dossier, then iterate on
 * the fix pipeline without waiting 15-20 min for semantic search + repro.
 */

import { execSync } from 'child_process';
import { FsManifestRegistry } from '../bin/clients/manifest-registry';
import { FilePipelineRunStateStore } from '../bin/clients/state-stores';
import { processIssueEvent } from '../bin/server';
import type { IssueEvent } from '../core/webhook/types';

async function main() {
  const rawArgs = process.argv.slice(2);

  // Parse flags
  const dossierIdx = rawArgs.indexOf('--dossier');
  const reproTestIdx = rawArgs.indexOf('--repro-test');
  const branchIdx = rawArgs.indexOf('--branch');

  const dossierPath = dossierIdx !== -1 ? rawArgs[dossierIdx + 1] : undefined;
  const reproTestPath = reproTestIdx !== -1 ? rawArgs[reproTestIdx + 1] : 'tests/repro/test_repro.py';
  const branch = branchIdx !== -1 ? rawArgs[branchIdx + 1] : undefined;

  const flagValues = new Set([dossierPath, reproTestPath, branch].filter(Boolean));
  const positionals = rawArgs.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (flagValues.has(a)) return false;
    if (i > 0 && rawArgs[i - 1].startsWith('--')) return false;
    return true;
  });
  const [repoFullName, issueNumberStr] = positionals;

  if (!repoFullName || !issueNumberStr || !dossierPath) {
    console.error(
      'usage: ts-node scripts/trigger-fix.ts <owner/repo> <issue-number> ' +
      '--dossier <file> [--repro-test <path>] [--branch <name>]'
    );
    process.exit(1);
  }
  const issueNumber = parseInt(issueNumberStr, 10);

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

  // Fix-only mode env vars consumed by run-pipeline.ts
  process.env.OSA_FIX_ONLY = '1';
  process.env.OSA_SEED_DOSSIER_PATH = dossierPath;
  process.env.OSA_REPRO_TEST_PATH = reproTestPath;
  if (branch) process.env.OSA_FIX_ONLY_BRANCH = branch;

  console.log(`[trigger-fix] dossier=${dossierPath} reproTest=${reproTestPath}`);
  if (branch) console.log(`[trigger-fix] branch override=${branch}`);

  console.log(`[trigger-fix] fetching issue ${repoFullName}#${issueNumber}...`);
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

  console.log(`[trigger-fix] firing fix-only labeled event for issue #${issueNumber}: "${issueJson.title}"`);
  const result = await processIssueEvent(payload, 'issues', registry, fakeEnv, null, runStateStore);
  console.log(`[trigger-fix] processIssueEvent result:`, JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('[trigger-fix] fatal:', err);
  process.exit(1);
});
