/**
 * LangSmith adapter.
 *
 * Uses the official langsmith JS SDK (Client + RunTree). We log each pipeline
 * stage as a child run of a per-issue RunTree, and roll up per-run aggregates
 * into a single project-level run summary.
 *
 * Notes on tracing model:
 *   - LangSmith's parent/child relationship is NOT inferred from context — it
 *     must be carried by an explicit RunTree. Calling Client.createRun() with
 *     a parent_run_id works but the UI's "trace tree" view is built off the
 *     RunTree linkage, not the run records directly.
 *   - Our pipeline is not LangChain code, so LangSmith's auto-instrumentation
 *     does nothing for us. The whole adapter is manual log calls.
 */

import { Client, RunTree } from 'langsmith';

import type {
  PerIssueResult,
  PlatformAdapter,
  PingResult,
  RunSummary,
  TraceEvent,
} from '../../core/telemetry';

const PROJECT_NAME_DEFAULT = 'oss-fix-loop';
const DATASET_NAME_DEFAULT = 'triage-golden-set';

export interface GoldenExample {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

export class LangSmithAdapter implements PlatformAdapter {
  public readonly name = 'langsmith';
  private client: Client | null = null;
  private projectName = PROJECT_NAME_DEFAULT;
  private datasetName = DATASET_NAME_DEFAULT;
  private notes: string[] = [];
  /** runId → RunTree so we can attach stage children to the right pipeline trace. */
  private runTrees = new Map<string, RunTree>();
  /** runId → (issue number → issue-level RunTree). */
  private issueRunTrees = new Map<string, Map<number, RunTree>>();

  async connect(): Promise<void> {
    // LangSmith SDK reads LANGCHAIN_API_KEY / LANGSMITH_API_KEY from env on
    // its own. We accept either to match the spec while still working with
    // the existing LANGSMITH_API_KEY already used by core/observability.
    const apiKey =
      process.env.LANGCHAIN_API_KEY ||
      process.env.LANGSMITH_API_KEY;
    if (!apiKey) {
      throw new Error(
        'LangSmith adapter requires LANGCHAIN_API_KEY (or LANGSMITH_API_KEY) to be set.'
      );
    }
    this.projectName =
      process.env.LANGCHAIN_PROJECT ||
      process.env.LANGSMITH_PROJECT ||
      PROJECT_NAME_DEFAULT;
    this.datasetName = process.env.LANGSMITH_DATASET_NAME || DATASET_NAME_DEFAULT;

    this.client = new Client({
      apiKey,
      apiUrl: process.env.LANGCHAIN_ENDPOINT || process.env.LANGSMITH_ENDPOINT,
    });

    // Verify credentials via a real API call. SDK has no .ping(); the cheapest
    // signal is listProjects with a tight limit.
    try {
      const it = this.client.listProjects({ limit: 1 } as any);
      // listProjects returns an async iterable, not a Promise.
      for await (const _ of it as AsyncIterable<unknown>) {
        break;
      }
    } catch (err) {
      throw new Error(
        `LangSmith credential check failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    this.notes.push(
      `LangSmith SDK has no .ping() / .health() — verifying credentials required iterating ` +
        `listProjects(). Discovered after a TypeError when treating it as a Promise.`
    );

    // Ensure the project exists. createProject is idempotent-ish; surfaces an
    // error if a project with the same name already exists, so we swallow that.
    try {
      await this.client.createProject({ projectName: this.projectName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists|conflict/i.test(msg)) {
        this.notes.push(
          `LangSmith createProject(${this.projectName}) raised an unexpected error: ${msg}. ` +
            `There is no "createIfMissing" variant; you must catch the duplicate-create error.`
        );
      }
    }

    // Ensure the dataset exists.
    try {
      await this.client.createDataset(this.datasetName, {
        description: 'Golden triage set for OSS Fix Loop',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists|conflict/i.test(msg)) {
        this.notes.push(
          `LangSmith createDataset(${this.datasetName}) failed: ${msg}.`
        );
      }
    }

    this.notes.push(
      `LangSmith's official tracing surface assumes LangChain code: most docs examples wrap a ` +
        `RunnableLambda with traceable(). For non-LangChain code (like ours), the SDK works but ` +
        `every trace requires explicit RunTree construction or explicit Client.createRun + ` +
        `Client.updateRun pairs. Parent/child must be passed via parent_run_id every time.`
    );
    this.notes.push(
      `Dataset evaluation (running an evaluator against a dataset) is a separate code path from ` +
        `tracing. There is no "while tracing this run, also score it against dataset X" — you ` +
        `must call client.evaluate() or use the Eval SDK as a post-pass.`
    );
  }

  async ping(): Promise<PingResult> {
    if (!this.client) {
      return { platform: this.name, connected: false, latency_ms: 0, error: 'not connected' };
    }
    const start = Date.now();
    try {
      const it = this.client.listProjects({ limit: 1 } as any);
      for await (const _ of it as AsyncIterable<unknown>) {
        break;
      }
      return { platform: this.name, connected: true, latency_ms: Date.now() - start };
    } catch (err) {
      return {
        platform: this.name,
        connected: false,
        latency_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async logTrace(t: TraceEvent): Promise<void> {
    if (!this.client) throw new Error('LangSmith adapter not connected');

    let parent = this.runTrees.get(t.ctx.run_id);
    if (!parent) {
      parent = new RunTree({
        name: `pipeline.${t.ctx.run_id}`,
        run_type: 'chain',
        project_name: this.projectName,
        inputs: { run_id: t.ctx.run_id, repo: t.ctx.repo_name },
        client: this.client,
      });
      await parent.postRun();
      this.runTrees.set(t.ctx.run_id, parent);
    }

    let issueRunMap = this.issueRunTrees.get(t.ctx.run_id);
    if (!issueRunMap) {
      issueRunMap = new Map<number, RunTree>();
      this.issueRunTrees.set(t.ctx.run_id, issueRunMap);
    }
    let issueRun = issueRunMap.get(t.ctx.issue_number);
    if (!issueRun) {
      issueRun = await parent.createChild({
        name: `issue.${t.ctx.issue_number}`,
        run_type: 'chain',
        start_time: t.start_time_ms,
        inputs: {
          issue_number: t.ctx.issue_number,
          repo: t.ctx.repo_name,
        },
        extra: {
          metadata: {
            run_id: t.ctx.run_id,
            repo_name: t.ctx.repo_name,
            issue_number: t.ctx.issue_number,
          },
        },
      });
      await issueRun.postRun();
      issueRunMap.set(t.ctx.issue_number, issueRun);
    }

    const child = await issueRun.createChild({
      name: t.span_name,
      run_type: t.is_llm ? 'llm' : 'chain',
      start_time: t.start_time_ms,
      end_time: t.end_time_ms,
      inputs: { ...t.prompt },
      outputs: t.response
        ? {
            content: t.response.content,
            stop_reason: t.response.stop_reason,
            usage: t.response.usage,
          }
        : undefined,
      extra: {
        metadata: {
          agent_name: t.ctx.agent_name,
          stage: t.ctx.stage,
          issue_number: t.ctx.issue_number,
          repo_name: t.ctx.repo_name,
          model: t.model,
          input_tokens: t.input_tokens,
          output_tokens: t.output_tokens,
          latency_ms: t.latency_ms,
        },
      },
      error: t.error?.message,
    });
    await child.postRun();
    await child.patchRun();
  }

  async logRun(run: RunSummary): Promise<void> {
    if (!this.client) throw new Error('LangSmith adapter not connected');

    const byIssue = new Map<number, PerIssueResult>();
    for (const issue of run.per_issue) byIssue.set(issue.issue_number, issue);

    const issueRunMap = this.issueRunTrees.get(run.run_id);
    if (issueRunMap) {
      for (const [issueNumber, issueRun] of issueRunMap.entries()) {
        const issue = byIssue.get(issueNumber);
        await issueRun.end(
          issue
            ? {
                issue_number: issue.issue_number,
                triage: issue.triage_result,
                pm: issue.pm_result,
                scores: issue.scores,
              }
            : { issue_number: issueNumber, missing_result: true },
          undefined,
          run.end_time_ms
        );
        await issueRun.patchRun();

        if (issue) {
          await this.writeFeedback(issueRun.id, 'triage_accuracy', issue.scores.triage_accuracy, {
            repo: run.repo_name,
            run_id: run.run_id,
            issue_number: issue.issue_number,
          });
          await this.writeFeedback(
            issueRun.id,
            'pm_design_score_accuracy',
            issue.scores.pm_accuracy,
            {
              repo: run.repo_name,
              run_id: run.run_id,
              issue_number: issue.issue_number,
            }
          );
        }
      }
    }

    // Close the parent RunTree (if any) with the aggregate output. If none
    // exists, we create a standalone summary run so the UI still sees it.
    const parent = this.runTrees.get(run.run_id);
    let aggregateRunId: string;
    if (parent) {
      await parent.end(
        {
          aggregate: run.aggregate,
          total_issues: run.total_issues,
        },
        undefined,
        run.end_time_ms
      );
      await parent.patchRun();
      aggregateRunId = parent.id;
    } else {
      const summary = new RunTree({
        name: `pipeline.${run.run_id}.summary`,
        run_type: 'chain',
        project_name: this.projectName,
        inputs: { run_id: run.run_id, repo: run.repo_name, total_issues: run.total_issues },
        client: this.client,
      });
      await summary.postRun();
      await summary.end({ aggregate: run.aggregate }, undefined, run.end_time_ms);
      await summary.patchRun();
      aggregateRunId = summary.id;
    }

    await this.writeFeedback(
      aggregateRunId,
      'triage_accuracy_overall',
      run.aggregate.triage_accuracy_overall,
      {
        repo: run.repo_name,
        run_id: run.run_id,
      }
    );
    await this.writeFeedback(
      aggregateRunId,
      'pm_design_score_accuracy_overall',
      run.aggregate.pm_accuracy_overall,
      {
        repo: run.repo_name,
        run_id: run.run_id,
      }
    );

    this.issueRunTrees.delete(run.run_id);
    this.runTrees.delete(run.run_id);
  }

  getSetupNotes(): string[] {
    return [...this.notes];
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async writeFeedback(
    runId: string,
    key: string,
    score: number,
    sourceInfo: Record<string, unknown>
  ): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.createFeedback(runId, key, { score, sourceInfo });
    } catch (err) {
      this.notes.push(
        `LangSmith createFeedback(${key}) failed for run ${runId}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async uploadDatasetExamples(examples: GoldenExample[]): Promise<void> {
    if (!this.client) throw new Error('LangSmith adapter not connected');
    try {
      await this.client.createExamples({
        inputs: examples.map((e) => e.inputs),
        outputs: examples.map((e) => e.outputs),
        datasetName: this.datasetName,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.notes.push(
        `LangSmith createExamples({datasetName}) variant works, but the SDK also offers ` +
          `createExample (singular) and createExamples(datasetId, …). The signatures are ` +
          `overloaded inconsistently across versions. Failure: ${msg}.`
      );
    }
  }
}
