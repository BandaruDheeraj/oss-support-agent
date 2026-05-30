/**
 * Braintrust adapter.
 *
 * Uses the official braintrust JS SDK. We model the eval run as a Braintrust
 * Experiment (one Experiment per pipeline run_id). Per-issue stages are logged
 * as nested spans so the trace tree matches the pipeline shape.
 *
 * Notes on the Experiment vs always-on tracing distinction:
 *   - Experiments are scoped to a "run of evals" — they expect input/output/
 *     expected/scores per row and are designed for benchmark-style comparisons.
 *   - Always-on production tracing uses a Logger (initLogger). The two can
 *     coexist but require separate init calls and separate span trees.
 *   - We use Experiments here because the eval runner IS a benchmark. The
 *     logTrace() fan-out also feeds a Logger when BRAINTRUST_ENABLE_LOGGER is
 *     true, so the same trace shows up in both places — useful when comparing
 *     "what does the prod trace UI look like" vs "what does the eval UI show".
 */

import type {
  PlatformAdapter,
  PerIssueResult,
  PingResult,
  RunSummary,
  TraceEvent,
} from '../../core/telemetry';

// The braintrust SDK is large and not all of its exports are statically typed
// for our use case (Experiment, Logger). We use `any` for the SDK boundary
// and rely on documented runtime behaviour.

const PROJECT_NAME_DEFAULT = 'oss-fix-loop';

export class BraintrustAdapter implements PlatformAdapter {
  public readonly name = 'braintrust';
  private sdk: any = null;
  private experiment: any | null = null;
  private logger: any | null = null;
  private projectName = PROJECT_NAME_DEFAULT;
  private notes: string[] = [];
  /** Per-run-id, per-issue-number → row id so we can append scores at logRun. */
  private rowsByRun = new Map<string, Map<number, any>>();

  async connect(): Promise<void> {
    if (!process.env.BRAINTRUST_API_KEY) {
      throw new Error('Braintrust adapter requires BRAINTRUST_API_KEY to be set.');
    }
    this.projectName = process.env.BRAINTRUST_PROJECT || PROJECT_NAME_DEFAULT;

    // Dynamic import keeps test environments without the SDK happy.
    this.sdk = await import('braintrust');

    // initExperiment is the canonical way to start a benchmark run. Naming the
    // experiment with a timestamp keeps runs distinct in the UI.
    const expName = `oss-fix-loop-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      this.experiment = this.sdk.init({
        project: this.projectName,
        experiment: expName,
        // open: true means re-attach if the experiment already exists.
        open: false,
        update: false,
      });
    } catch (err) {
      throw new Error(
        `Braintrust init() failed for project="${this.projectName}", experiment="${expName}": ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Optional always-on logger; useful for the "what would prod look like" view.
    if (process.env.BRAINTRUST_ENABLE_LOGGER === 'true') {
      try {
        this.logger = this.sdk.initLogger({ projectName: this.projectName });
      } catch (err) {
        this.notes.push(
          `BRAINTRUST_ENABLE_LOGGER=true was set but initLogger() failed: ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Experiments and Loggers are separate top-level concepts; both can run together but ` +
            `they do NOT share traces — a single agent call has to be logged twice to appear in ` +
            `both UIs.`
        );
        this.logger = null;
      }
    } else {
      this.notes.push(
        `Braintrust has TWO separate tracing surfaces: Experiments (benchmark runs) and ` +
          `Loggers (always-on prod traces). They cannot share a single emitted span; the SDK has ` +
          `no "tee" function. To compare benchmark vs prod views, you emit each span twice.`
      );
    }

    this.notes.push(
      `Braintrust scorers are evaluated INSIDE Eval() — they take expected/output and return a ` +
        `score. To log a custom score for an arbitrary already-recorded span, the only path is ` +
        `span.log({ scores: { ... } }) on the span you created. There's no separate "addScore" ` +
        `API for an external reviewer to attach scores to existing experiment rows.`
    );
  }

  async ping(): Promise<PingResult> {
    const start = Date.now();
    if (!this.experiment) {
      return { platform: this.name, connected: false, latency_ms: 0, error: 'not connected' };
    }
    try {
      // experiment.summarize({ summarizeScores: false }) is the cheapest call
      // that round-trips to the server and returns immediately.
      await this.experiment.summarize({ summarizeScores: false });
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
    if (!this.experiment) throw new Error('Braintrust adapter not connected');

    // Each unique (run_id, issue_number) gets one experiment row; stages
    // become spans inside that row.
    const issueRows = this.rowsByRun.get(t.ctx.run_id) ?? new Map<number, any>();
    let row = issueRows.get(t.ctx.issue_number);
    if (!row) {
      row = this.experiment.startSpan({
        name: `issue.${t.ctx.issue_number}`,
        type: 'task',
      });
      issueRows.set(t.ctx.issue_number, row);
      this.rowsByRun.set(t.ctx.run_id, issueRows);
    }

    const stageSpan = row.startSpan({
      name: t.span_name,
      type: t.is_llm ? 'llm' : 'function',
      event: {
        input: t.prompt,
        output: t.response,
        metadata: {
          agent_name: t.ctx.agent_name,
          stage: t.ctx.stage,
          model: t.model,
          input_tokens: t.input_tokens,
          output_tokens: t.output_tokens,
          latency_ms: t.latency_ms,
          repo: t.ctx.repo_name,
        },
        metrics:
          t.is_llm && t.input_tokens != null && t.output_tokens != null
            ? {
                prompt_tokens: t.input_tokens,
                completion_tokens: t.output_tokens,
                total_tokens: t.input_tokens + t.output_tokens,
              }
            : undefined,
        ...(t.error ? { error: t.error.message } : {}),
      },
    });
    try {
      stageSpan.end();
    } catch {
      // older SDK builds: end() may be called via close()
      try {
        stageSpan.close?.();
      } catch {
        // ignore
      }
    }

    if (this.logger) {
      try {
        this.logger.log({
          input: t.prompt,
          output: t.response,
          metadata: {
            ...t.ctx,
            model: t.model,
            input_tokens: t.input_tokens,
            output_tokens: t.output_tokens,
            latency_ms: t.latency_ms,
          },
        });
      } catch {
        // Logger errors must not block the agent.
      }
    }
  }

  async logRun(run: RunSummary): Promise<void> {
    if (!this.experiment) throw new Error('Braintrust adapter not connected');

    // Attach per-issue scores to each row, then close the row span.
    const rows = this.rowsByRun.get(run.run_id);
    if (rows) {
      const byIssue = new Map<number, PerIssueResult>();
      for (const r of run.per_issue) byIssue.set(r.issue_number, r);
      for (const [issueNo, rowSpan] of rows.entries()) {
        const r = byIssue.get(issueNo);
        if (!r) continue;
        try {
          rowSpan.log({
            input: { issue_number: issueNo, title: r.title, difficulty: r.difficulty },
            output: { triage: r.triage_result, pm: r.pm_result },
            scores: {
              triage_accuracy: r.scores.triage_accuracy,
              pm_design_score_accuracy: r.scores.pm_accuracy,
            },
          });
          rowSpan.end?.() ?? rowSpan.close?.();
        } catch (err) {
          this.notes.push(
            `Braintrust row span finalisation failed for issue ${issueNo}: ` +
              `${err instanceof Error ? err.message : String(err)}.`
          );
        }
      }
    }

    try {
      const summarySpan = this.experiment.startSpan({
        name: `run.${run.run_id}.summary`,
        type: 'task',
      });
      summarySpan.log({
        input: { run_id: run.run_id, total_issues: run.total_issues },
        output: { aggregate: run.aggregate },
        scores: {
          triage_accuracy_overall: run.aggregate.triage_accuracy_overall,
          pm_design_score_accuracy_overall: run.aggregate.pm_accuracy_overall,
        },
        metadata: {
          repo: run.repo_name,
          duration_ms: run.duration_ms,
          kind: 'run_summary',
        },
      });
      summarySpan.end?.() ?? summarySpan.close?.();
    } catch (err) {
      this.notes.push(
        `Braintrust aggregate score logging failed for run ${run.run_id}: ` +
          `${err instanceof Error ? err.message : String(err)}.`
      );
    }

    try {
      const summary = await this.experiment.summarize();
      // summarize() returns a URL to the experiment view in some SDK builds.
      const url = typeof summary === 'object' && summary && (summary as any).experimentUrl;
      if (url) {
        this.notes.push(`Braintrust experiment URL: ${url}`);
      }
    } catch (err) {
      this.notes.push(
        `Braintrust experiment.summarize() failed: ` +
          `${err instanceof Error ? err.message : String(err)}.`
      );
    }
    try {
      await this.experiment.flush();
    } catch {
      // non-fatal
    }
  }

  getSetupNotes(): string[] {
    return [...this.notes];
  }
}

// ---------------------------------------------------------------------------
// Custom scorers — exported so the eval runner can apply them deterministically
// regardless of which platform is the "scoring authority".
// ---------------------------------------------------------------------------

/**
 * triage_accuracy: 1.0 if exact module match, 0.5 if the parent directory
 * matches, 0.0 otherwise. Empty/dot paths are treated as "no module".
 */
export function triageAccuracy(args: {
  expected_module: string;
  actual_module: string;
}): number {
  const exp = normaliseModule(args.expected_module);
  const act = normaliseModule(args.actual_module);
  if (!exp || !act) return 0;
  if (exp === act) return 1.0;
  const expParent = parentDir(exp);
  const actParent = parentDir(act);
  if (expParent && (expParent === act || expParent === actParent)) return 0.5;
  return 0;
}

/** pm_design_score_accuracy: 1.0 on exact bool match, else 0.0. */
export function pmDesignScoreAccuracy(args: {
  expected_design_needed: boolean;
  actual_design_needed: boolean;
}): number {
  return args.expected_design_needed === args.actual_design_needed ? 1.0 : 0.0;
}

function normaliseModule(s: string): string {
  return (s ?? '').replace(/\\/g, '/').replace(/\/+$/g, '').trim();
}

function parentDir(s: string): string {
  const i = s.lastIndexOf('/');
  return i === -1 ? '' : s.slice(0, i);
}
