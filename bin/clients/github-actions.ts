/**
 * Concrete `ActionsClient` implementation using GitHub's REST API.
 *
 * Used by the regression-guard agent (and, in the future, the usability agent)
 * to dispatch GitHub Actions workflows on the target fork, poll for completion,
 * and download logs. See `core/sandbox-types.ts` for the interface contract.
 *
 * Activated only when `manifest.sandbox_runner === 'gha'`. The local sandbox
 * path remains the default and does not touch this client.
 */

import JSZip from 'jszip';

import type {
  ActionsClient,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunLogs,
} from '../../core/sandbox-types';
import { withExternalOperationSpan } from '../../core/observability';

export type { ActionsClient } from '../../core/sandbox-types';

const GITHUB_API = 'https://api.github.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS_ENV = 'OSA_GH_API_TIMEOUT_MS';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'oss-support-agent',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveRequestTimeoutMs(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const raw = process.env[REQUEST_TIMEOUT_MS_ENV];
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

function isAbortError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'AbortError';
}

async function ghFetch(
  token: string,
  url: string,
  timeoutMs: number,
  init: RequestInit = {}
): Promise<Response> {
  const headers = {
    ...authHeaders(token),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const onAbort = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, headers, signal: controller.signal });
  } catch (err: unknown) {
    if (isAbortError(err)) {
      const method = (init.method ?? 'GET').toUpperCase();
      throw new Error(`GitHub request timed out after ${timeoutMs}ms (${method} ${url})`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    if (upstreamSignal) {
      upstreamSignal.removeEventListener('abort', onAbort);
    }
  }
}

export interface GitHubActionsClientOptions {
  requestTimeoutMs?: number;
}

export class GitHubActionsClient implements ActionsClient {
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly token: string,
    options: GitHubActionsClientOptions = {}
  ) {
    this.requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  }

  private request(url: string, init: RequestInit = {}): Promise<Response> {
    return ghFetch(this.token, url, this.requestTimeoutMs, init);
  }

  async triggerWorkflowDispatch(
    forkFullName: string,
    workflowId: string,
    branch: string,
    inputs: Record<string, string>
  ): Promise<void> {
    return withExternalOperationSpan(
      'github_actions.trigger_workflow_dispatch',
      {
        repo: forkFullName,
        workflow_id: workflowId,
        branch,
        input_count: Object.keys(inputs).length,
      },
      async (span) => {
        const url = `${GITHUB_API}/repos/${forkFullName}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`;
        const res = await this.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: branch, inputs }),
        });
        if (!res.ok) {
          throw new Error(
            `GitHub triggerWorkflowDispatch failed (${res.status}) for ${forkFullName} ${workflowId}@${branch}: ${await res.text()}`
          );
        }
        span.setOutput({ dispatched: true });
      }
    );
  }

  async branchRefExists(repoFullName: string, branch: string): Promise<boolean> {
    const url = `${GITHUB_API}/repos/${repoFullName}/git/ref/heads/${encodeURIComponent(branch)}`;
    const res = await this.request(url);
    if (res.status === 404) {
      return false;
    }
    if (!res.ok) {
      throw new Error(
        `GitHub branchRefExists failed (${res.status}) for ${repoFullName} ${branch}: ${await res.text()}`
      );
    }
    return true;
  }

  async getWorkflowRun(
    forkFullName: string,
    workflowId: string,
    branch: string,
    createdAfter: string
  ): Promise<WorkflowRun | null> {
    const params = new URLSearchParams({
      branch,
      event: 'workflow_dispatch',
      per_page: '10',
    });
    const url = `${GITHUB_API}/repos/${forkFullName}/actions/workflows/${encodeURIComponent(workflowId)}/runs?${params}`;
    const res = await this.request(url);
    if (!res.ok) {
      throw new Error(`GitHub listWorkflowRuns failed (${res.status}): ${await res.text()}`);
    }
    const data: any = await res.json();
    const runs: any[] = data.workflow_runs ?? [];
    const cutoff = new Date(createdAfter).getTime();
    // Sort newest-first so that on retries (which dispatch a new run with the
    // same workflow + branch) the most recent dispatch is returned rather than
    // a stale completed run from an earlier attempt.
    const matching = runs
      .filter((r) => new Date(r.created_at).getTime() >= cutoff)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const run = matching[0];
    if (!run) return null;
    return {
      id: run.id,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url,
      created_at: run.created_at,
    };
  }

  async waitForWorkflowRun(
    forkFullName: string,
    runId: number,
    timeoutMs: number,
    pollIntervalMs: number = 10_000
  ): Promise<WorkflowRunStatus> {
    return withExternalOperationSpan(
      'github_actions.wait_for_workflow_run',
      {
        repo: forkFullName,
        run_id: runId,
        timeout_ms: timeoutMs,
        poll_interval_ms: pollIntervalMs,
      },
      async (span) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const url = `${GITHUB_API}/repos/${forkFullName}/actions/runs/${runId}`;
          const res = await this.request(url);
          if (!res.ok) {
            throw new Error(`GitHub getWorkflowRun failed (${res.status}): ${await res.text()}`);
          }
          const data: any = await res.json();
          if (data.status === 'completed') {
            const result = {
              completed: true,
              conclusion: data.conclusion ?? null,
              timedOut: false,
            };
            span.setAttributes({
              'github_actions.completed': result.completed,
              'github_actions.conclusion': result.conclusion ?? '',
              'github_actions.timed_out': result.timedOut,
            });
            span.setOutput(result);
            return result;
          }
          await sleep(pollIntervalMs);
        }
        const result = { completed: false, conclusion: null, timedOut: true };
        span.setAttributes({
          'github_actions.completed': result.completed,
          'github_actions.timed_out': result.timedOut,
        });
        span.setOutput(result);
        return result;
      }
    );
  }

  async cancelWorkflowRun(forkFullName: string, runId: number): Promise<void> {
    return withExternalOperationSpan(
      'github_actions.cancel_workflow_run',
      { repo: forkFullName, run_id: runId },
      async (span) => {
        const url = `${GITHUB_API}/repos/${forkFullName}/actions/runs/${runId}/cancel`;
        const res = await this.request(url, { method: 'POST' });
        if (!res.ok && res.status !== 409) {
          throw new Error(`GitHub cancelWorkflowRun failed (${res.status}): ${await res.text()}`);
        }
        span.setOutput({ cancelled_or_already_done: true });
      }
    );
  }

  /**
   * Best-effort log retrieval. GitHub returns a zip of all step logs; we
   * concatenate them into a single string and surface it as stdout.
   * Exit code is inferred from the run's conclusion ("success" => 0, else 1).
   */
  async getWorkflowRunLogs(forkFullName: string, runId: number): Promise<WorkflowRunLogs> {
    return withExternalOperationSpan(
      'github_actions.get_workflow_run_logs',
      { repo: forkFullName, run_id: runId },
      async (span) => {
        const runUrl = `${GITHUB_API}/repos/${forkFullName}/actions/runs/${runId}`;
        const runRes = await this.request(runUrl);
        if (!runRes.ok) {
          throw new Error(`GitHub getWorkflowRun failed (${runRes.status}): ${await runRes.text()}`);
        }
        const runData: any = await runRes.json();
        const exitCode = runData.conclusion === 'success' ? 0 : 1;

        const logsUrl = `${GITHUB_API}/repos/${forkFullName}/actions/runs/${runId}/logs`;
        const logsRes = await this.request(logsUrl, { redirect: 'follow' });
        if (!logsRes.ok) {
          // Logs API can 404 briefly after completion; return partial info.
          const result = {
            stdout: '',
            stderr: `Failed to fetch logs (${logsRes.status})`,
            exitCode,
          };
          span.setAttributes({
            'github_actions.logs_ok': false,
            'github_actions.exit_code': exitCode ?? -1,
            'github_actions.logs_status': logsRes.status,
          });
          span.setOutput({
            logs_ok: false,
            exit_code: exitCode,
            logs_status: logsRes.status,
          });
          return result;
        }
        const buf = Buffer.from(await logsRes.arrayBuffer());
        // The logs endpoint returns a zip archive; rather than unzipping here we
        // surface a base64 hash + size so a downstream consumer can fetch the raw
        // zip if needed. Most regression-guard diffing only compares exit codes
        // and the short stdout/stderr we synthesize here.
        const result = {
          stdout: `(GHA log archive: ${buf.byteLength} bytes; run ${runData.html_url})`,
          stderr: '',
          exitCode,
        };
        span.setAttributes({
          'github_actions.logs_ok': true,
          'github_actions.log_archive_bytes': buf.byteLength,
          'github_actions.exit_code': exitCode ?? -1,
        });
        span.setOutput({
          logs_ok: true,
          log_archive_bytes: buf.byteLength,
          exit_code: exitCode,
        });
        return result;
      }
    );
  }

  async downloadWorkflowRunArtifact(
    forkFullName: string,
    runId: number,
    artifactName: string
  ): Promise<string | null> {
    return withExternalOperationSpan(
      'github_actions.download_workflow_run_artifact',
      { repo: forkFullName, run_id: runId, artifact_name: artifactName },
      async (span) => {
        const listUrl = `${GITHUB_API}/repos/${forkFullName}/actions/runs/${runId}/artifacts`;
        const listRes = await this.request(listUrl);
        if (!listRes.ok) {
          throw new Error(`GitHub listArtifacts failed (${listRes.status}): ${await listRes.text()}`);
        }
        const listData: any = await listRes.json();
        const artifacts: any[] = listData.artifacts ?? [];
        const match = artifacts.find((a) => a.name === artifactName);
        if (!match) {
          span.setAttributes({
            'github_actions.artifact_found': false,
            'github_actions.artifact_count': artifacts.length,
          });
          span.setOutput({ artifact_found: false, artifact_count: artifacts.length });
          return null;
        }
        const dlUrl = `${GITHUB_API}/repos/${forkFullName}/actions/artifacts/${match.id}/zip`;
        const dlRes = await this.request(dlUrl, { redirect: 'follow' });
        if (!dlRes.ok) {
          throw new Error(`GitHub downloadArtifact failed (${dlRes.status}): ${await dlRes.text()}`);
        }
        const buf = Buffer.from(await dlRes.arrayBuffer());
        let zip: JSZip;
        try {
          zip = await JSZip.loadAsync(buf);
        } catch (err) {
          throw new Error(
            `GitHub downloadArtifact failed to read zip for "${artifactName}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
        const files = Object.values(zip.files).filter((file) => !file.dir);
        if (files.length === 0) {
          throw new Error(`GitHub artifact "${artifactName}" in run ${runId} had no files`);
        }
        const preferredNames = [
          `${artifactName}.json`,
          `${artifactName}.txt`,
          'semantic-output.json',
          'sandbox-output.json',
        ];
        const targetFile =
          files.find((file) => preferredNames.some((name) => file.name.endsWith(name))) ?? files[0];
        const content = await targetFile.async('string');
        span.setAttributes({
          'github_actions.artifact_found': true,
          'github_actions.artifact_count': artifacts.length,
          'github_actions.artifact_file_count': files.length,
          'github_actions.artifact_chars': content.length,
        });
        span.setOutput({
          artifact_found: true,
          artifact_count: artifacts.length,
          artifact_file_count: files.length,
          artifact_chars: content.length,
        });
        return content;
      }
    );
  }

  /**
   * The Actions REST API does not expose a way for an external client to push
   * a new artifact into an already-completed run. The `uploadArtifact` method
   * on the interface is used by in-workflow callers; for an out-of-band client
   * we no-op and return a placeholder URL.
   */
  async uploadArtifact(
    forkFullName: string,
    runId: number,
    _name: string,
    _content: string
  ): Promise<string> {
    return `https://github.com/${forkFullName}/actions/runs/${runId}`;
  }

  async downloadJobLog(repoFullName: string, jobId: number): Promise<string> {
    return withExternalOperationSpan(
      'github_actions.download_job_log',
      { repo: repoFullName, job_id: jobId },
      async (span) => {
        const url = GITHUB_API + '/repos/' + repoFullName + '/actions/jobs/' + jobId + '/logs';
        const res = await this.request(url);
        if (!res.ok) {
          span.setAttributes({ 'github_actions.logs_ok': false, 'github_actions.status': res.status });
          span.setOutput({ logs_ok: false, status: res.status });
          return '';
        }
        const text = await res.text();
        span.setAttributes({ 'github_actions.logs_ok': true, 'github_actions.log_chars': text.length });
        span.setOutput({ logs_ok: true, log_chars: text.length });
        return text;
      }
    );
  }

  async listPrCheckRuns(
    repoFullName: string,
    prSha: string
  ): Promise<Array<{ name: string; status: string; conclusion: string | null; detailsUrl: string }>> {
    return withExternalOperationSpan(
      'github_actions.list_pr_check_runs',
      { repo: repoFullName, pr_sha: prSha },
      async (span) => {
        const url =
          GITHUB_API + '/repos/' + repoFullName + '/commits/' + prSha + '/check-runs?per_page=100';
        const res = await this.request(url);
        if (!res.ok) {
          span.setAttributes({ 'github_actions.status': res.status, 'github_actions.check_count': 0 });
          span.setOutput({ check_count: 0, status: res.status });
          return [];
        }
        const data: any = await res.json();
        const checks = (data.check_runs || []).map((c: any) => ({
          name: c.name,
          status: c.status,
          conclusion: c.conclusion || null,
          detailsUrl: c.details_url || '',
        }));
        span.setAttributes({ 'github_actions.check_count': checks.length });
        span.setOutput({ check_count: checks.length });
        return checks;
      }
    );
  }
}
