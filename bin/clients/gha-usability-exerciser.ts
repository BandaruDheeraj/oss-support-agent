/**
 * Concrete UsabilityExerciser that interprets the usability-test.yml workflow run.
 *
 * The workflow defines one job per UsabilityCheck category (installation,
 * import_paths, error_messages, documentation_examples). After the workflow
 * completes, this exerciser lists the run's jobs and maps each job's conclusion
 * to a UsabilityCheck.
 *
 * This avoids unzipping log archives or parsing artifact contents while still
 * surfacing per-category pass/fail granularity.
 */

import type {
  UsabilityAgentInput,
  UsabilityCategory,
  UsabilityCheck,
  UsabilityExerciser,
  UsabilityExerciserOutput,
  UsabilitySeverity,
} from '../../core/agents/usability-types';
import { USABILITY_WORKFLOW_FILE } from '../../core/agents/usability-types';
import type { ActionsClient } from '../../core/sandbox-types';

const GITHUB_API = 'https://api.github.com';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'oss-support-agent',
  };
}

interface JobInfo {
  name: string;
  conclusion: string | null;
  status: string;
  html_url: string;
}

/**
 * Maps a workflow job name to a UsabilityCategory and severity.
 * Job names in usability-test.yml are kept in lockstep with these category keys.
 */
const JOB_TO_CATEGORY: Record<string, { category: UsabilityCategory; severity: UsabilitySeverity }> = {
  installation: { category: 'installation', severity: 'critical' },
  import_paths: { category: 'import_paths', severity: 'major' },
  error_messages: { category: 'error_messages', severity: 'minor' },
  documentation_examples: { category: 'documentation_examples', severity: 'minor' },
  common_workflows: { category: 'common_workflows', severity: 'major' },
};

export class GHAUsabilityExerciser implements UsabilityExerciser {
  constructor(
    private readonly token: string,
    private readonly client: ActionsClient,
    private readonly lookbackMs: number = 30 * 60 * 1000
  ) {}

  async exercise(input: UsabilityAgentInput): Promise<UsabilityExerciserOutput> {
    const createdAfter = new Date(Date.now() - this.lookbackMs).toISOString();
    const run = await this.client.getWorkflowRun(
      input.forkFullName,
      USABILITY_WORKFLOW_FILE,
      input.branchName,
      createdAfter
    );

    if (!run) {
      return {
        checks: [],
        installSuccess: false,
        installOutput: 'No usability workflow run found for branch (was it dispatched?)',
      };
    }

    const jobs = await this.listJobs(input.forkFullName, run.id);
    const installJob = jobs.find((j) => j.name === 'installation');
    const installSuccess = installJob ? installJob.conclusion === 'success' : false;
    const installOutput = installJob
      ? `installation job: conclusion=${installJob.conclusion ?? 'unknown'} ${installJob.html_url}`
      : 'installation job not found in workflow run';

    const checks: UsabilityCheck[] = [];
    for (const job of jobs) {
      const mapping = JOB_TO_CATEGORY[job.name];
      if (!mapping) continue;
      // Skip installation here — the agent runner adds its own installation
      // check based on installSuccess; including it twice would double-count.
      if (job.name === 'installation') continue;

      const status =
        job.conclusion === 'success'
          ? 'pass'
          : job.conclusion === 'skipped' || job.conclusion === 'cancelled'
            ? 'warning'
            : 'fail';
      checks.push({
        category: mapping.category,
        description: humanizeJobName(job.name),
        status,
        details: `Job '${job.name}' conclusion=${job.conclusion ?? 'unknown'} (${job.html_url})`,
        severity: mapping.severity,
      });
    }

    return {
      checks,
      installSuccess,
      installOutput,
    };
  }

  private async listJobs(forkFullName: string, runId: number): Promise<JobInfo[]> {
    const url = `${GITHUB_API}/repos/${forkFullName}/actions/runs/${runId}/jobs?per_page=50`;
    const res = await fetch(url, { headers: authHeaders(this.token) });
    if (!res.ok) {
      throw new Error(`GitHub listWorkflowRunJobs failed (${res.status}): ${await res.text()}`);
    }
    const data: any = await res.json();
    const jobs: any[] = data.jobs ?? [];
    return jobs.map((j) => ({
      name: String(j.name ?? ''),
      conclusion: j.conclusion ?? null,
      status: String(j.status ?? ''),
      html_url: String(j.html_url ?? ''),
    }));
  }
}

function humanizeJobName(name: string): string {
  switch (name) {
    case 'import_paths':
      return 'Import paths resolve from a fresh install';
    case 'error_messages':
      return 'Error constructors carry messages';
    case 'documentation_examples':
      return 'Affected module is referenced in README';
    case 'common_workflows':
      return 'Common end-user workflows succeed';
    case 'installation':
      return 'Package installs from a fresh checkout';
    default:
      return name;
  }
}
