import { currentSpan, getTracer } from './tracer';

export interface OnlineEvaluationEvent {
  /** Stable metric key (for example: "repro_passed", "verification_gate_passed"). */
  metric: string;
  /** Human-readable stage bucket (for example: "repro", "fix", "verification"). */
  stage: string;
  /** Numeric score in [0,1]. */
  score: number;
  /** Optional categorical label for UIs that support labels alongside scores. */
  label?: string;
  issueNumber?: number;
  attemptId?: string;
  runId?: string;
  repo?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
}

/**
 * Emit an evaluation span into the active observability backend.
 *
 * The span carries both generic fields (evaluation.name/score/label) and
 * score-keyed attributes (evaluation.key.<metric>) so Arize AX-style
 * metric queries can group by stable keys.
 */
export async function emitOnlineEvaluation(event: OnlineEvaluationEvent): Promise<void> {
  try {
    const metric = normaliseMetricKey(event.metric);
    const score = normaliseScore(event.score);
    const label = event.label ?? (score >= 1 ? 'pass' : 'fail');

    const tracer = getTracer();
    const span = tracer.startSpan(`evaluator.${event.stage}`, {
      kind: 'EVALUATOR',
      parent: currentSpan(),
      attributes: {
        'openinference.span.kind': 'EVALUATOR',
        'evaluation.name': metric,
        'evaluation.stage': event.stage,
        'evaluation.score': score,
        'evaluation.label': label,
        [`evaluation.key.${metric}`]: score,
        [`evaluation.label.${metric}`]: label,
        'evaluation.issue_number': event.issueNumber ?? null,
        'evaluation.attempt_id': event.attemptId ?? null,
        'evaluation.run_id': event.runId ?? null,
        'evaluation.repo': event.repo ?? null,
        'evaluation.status': event.status ?? null,
      },
    });

    if (event.input !== undefined) span.setInput(event.input);
    if (event.output !== undefined) span.setOutput(event.output);
    span.end();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[observability:evaluator] failed to emit evaluation span: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

function normaliseMetricKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
}

function normaliseScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score <= 0) return 0;
  if (score >= 1) return 1;
  return score;
}
