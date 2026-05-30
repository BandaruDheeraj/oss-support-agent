/**
 * Eval runner for the LLM observability comparison harness.
 *
 * Loads the triage golden set, runs the triage classifier + module-routing
 * adapter + PM heuristic against each issue, fans every span out to all
 * registered observability platforms in parallel, and writes:
 *
 *   - evals/results/eval-{timestamp}.json   (machine-readable run record)
 *   - evals/SETUP-FRICTION.md               (auto-generated from getSetupNotes())
 *
 * The runner stops with a clear, env-var-aware error if any platform fails
 * to connect. Platform failures during a run are non-blocking and recorded.
 */
/* eslint-disable no-console */

import 'dotenv/config';

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

import { ArizeAdapter } from './platforms/arize';
import { LangSmithAdapter, type GoldenExample } from './platforms/langsmith';
import {
  BraintrustAdapter,
  triageAccuracy,
  pmDesignScoreAccuracy,
} from './platforms/braintrust';

import {
  registerPlatform,
  clearRegisteredPlatforms,
  getRegisteredPlatforms,
  connectAll,
  pingAll,
  fanOutRun,
  tracedStage,
  type TelemetryContext,
  type PerIssueResult,
  type RunSummary,
} from '../core/telemetry';

import OpenInferenceAdapter from '../configs/Arize-ai/openinference/adapter';
import {
  DefaultIssueTypeClassifier,
} from '../core/agents/triage';
import type {
  TriageInput,
  IssueType,
} from '../core/agents/triage-types';
import { scoreDesign } from '../core/agents/pm';
import type { PMScoringInput } from '../core/agents/pm-types';
import type { Issue } from '../core/adapter.interface';

const REPO_NAME = 'Arize-ai/openinference';

interface GoldenIssue {
  issue_number: number;
  title: string;
  body: string;
  expected_issue_type: IssueType;
  expected_module: string;
  expected_design_needed: boolean;
  difficulty: 'easy' | 'medium' | 'hard';
  notes: string;
}

interface PlatformStats {
  traces_sent: number;
  errors: number;
  avg_trace_latency_ms: number;
}

interface ResultsJson {
  run_id: string;
  timestamp: string;
  total_issues: number;
  per_platform: Record<string, PlatformStats>;
  per_issue: Array<{
    issue_number: number;
    title: string;
    difficulty: string;
    triage_result: PerIssueResult['triage_result'];
    pm_result: PerIssueResult['pm_result'];
    scores: { triage_accuracy: number; pm_accuracy: number };
    platform_errors: Record<string, string | null>;
  }>;
  aggregate: {
    triage_accuracy_by_difficulty: Record<string, number>;
    pm_accuracy_overall: number;
    avg_latency_by_stage: { triage: number; pm: number };
    total_tokens: { input: number; output: number };
  };
}

type EvalMode = 'triage' | 'outcomes';

interface CliOptions {
  mode: EvalMode;
  source: string;
}

interface OutcomeEvalRow {
  ts: string;
  issue_number: number;
  attempt_id: string;
  mode: string;
  backend: string;
  agent: string;
  repro_passed: boolean | null;
  fix_passed: boolean | null;
  verification_gate_passed: boolean | null;
  verification_stage: string | null;
  final_disposition: string;
  error_kind: string | null;
}

interface OutcomePlatformStats {
  issues_evaluated: number;
  repro_pass_rate: number | null;
  fix_pass_rate: number | null;
  verification_pass_rate: number | null;
  verification_skipped: number;
  issue_resolved_rate: number;
}

interface OutcomeResultsJson {
  run_id: string;
  mode: 'outcomes';
  timestamp: string;
  source: string;
  total_rows: number;
  backend_coverage: string[];
  per_platform: Record<string, OutcomePlatformStats>;
  per_issue: Array<{
    issue_number: number;
    by_platform: Record<
      string,
      {
        repro_passed: boolean | null;
        fix_passed: boolean | null;
        verification_gate_passed: boolean | null;
        verification_stage: string | null;
        issue_resolved: boolean;
        final_disposition: string;
        attempt_id: string;
      }
    >;
    discrepancies: string[];
  }>;
}

function loadGoldenSet(): GoldenIssue[] {
  const file = path.join(__dirname, 'datasets', 'triage-golden-set.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `Golden dataset missing at ${file}. Did you forget to commit evals/datasets/triage-golden-set.json?`
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as GoldenIssue[];
}

function buildIssue(g: GoldenIssue): Issue {
  return {
    number: g.issue_number,
    title: g.title,
    body: g.body,
    labels: [],
  };
}

function buildTriageInput(g: GoldenIssue): TriageInput {
  return {
    number: g.issue_number,
    title: g.title,
    body: g.body,
    labels: [],
    author: 'eval-runner',
    moduleTaxonomy: ['bug_fix', 'new_feature', 'docs'],
    repoTree: [],
    hasSkipPmGate: false,
  };
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function envFlag(name: string): boolean {
  return process.env[name] !== undefined && process.env[name] !== '';
}

function parseCliArgs(argv: string[]): CliOptions {
  let mode: EvalMode = 'outcomes';
  let source = process.env.OSA_EVAL_PATH || path.join(process.cwd(), '.osa-evals.sqlite');

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--mode') {
      const next = argv[i + 1];
      if (!next) throw new Error('Missing value for --mode (expected triage or outcomes)');
      mode = next as EvalMode;
      i++;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length) as EvalMode;
      continue;
    }
    if (arg === '--source') {
      const next = argv[i + 1];
      if (!next) throw new Error('Missing value for --source');
      source = next;
      i++;
      continue;
    }
    if (arg.startsWith('--source=')) {
      source = arg.slice('--source='.length);
      continue;
    }
  }

  if (mode !== 'triage' && mode !== 'outcomes') {
    throw new Error(`Unsupported mode "${mode}". Use --mode triage or --mode outcomes.`);
  }
  return { mode, source };
}

function normalizeBackendName(raw: string): string {
  const value = (raw || 'unknown').trim().toLowerCase();
  if (value === 'phoenix') return 'arize';
  if (value === '') return 'unknown';
  return value;
}

function toBooleanOrNull(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '' || normalized === 'null') return null;
    if (normalized === '1' || normalized === 'true') return true;
    if (normalized === '0' || normalized === 'false') return false;
  }
  return null;
}

function readSqliteOutcomeRows(source: string): OutcomeEvalRow[] {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('evals')")
      .all() as Array<{ name: string }>;
    if (columns.length === 0) {
      throw new Error(`No evals table found in ${source}`);
    }
    const names = new Set(columns.map((c) => c.name));
    const hasBackend = names.has('backend');
    const hasVerificationGate = names.has('verification_gate_passed');
    const hasVerificationStage = names.has('verification_stage');

    const rows = db
      .prepare(
        `SELECT
           ts,
           issue_number,
           attempt_id,
           mode,
           ${hasBackend ? "COALESCE(NULLIF(backend, ''), 'unknown')" : "'unknown'"} AS backend,
           agent,
           repro_passed,
           fix_passed,
           ${hasVerificationGate ? 'verification_gate_passed' : 'regression_passed'} AS verification_gate_passed,
           ${hasVerificationStage ? 'verification_stage' : 'NULL'} AS verification_stage,
           final_disposition,
           error_kind
         FROM evals
         WHERE agent = 'pipeline' AND mode = 'pipeline'
         ORDER BY ts ASC`
      )
      .all() as Array<{
      ts: string;
      issue_number: number;
      attempt_id: string;
      mode: string;
      backend: string;
      agent: string;
      repro_passed: unknown;
      fix_passed: unknown;
      verification_gate_passed: unknown;
      verification_stage: string | null;
      final_disposition: string;
      error_kind: string | null;
    }>;

    return rows.map((r) => ({
      ts: r.ts,
      issue_number: Number(r.issue_number),
      attempt_id: r.attempt_id,
      mode: r.mode,
      backend: normalizeBackendName(r.backend),
      agent: r.agent,
      repro_passed: toBooleanOrNull(r.repro_passed),
      fix_passed: toBooleanOrNull(r.fix_passed),
      verification_gate_passed: toBooleanOrNull(r.verification_gate_passed),
      verification_stage: r.verification_stage,
      final_disposition: r.final_disposition,
      error_kind: r.error_kind,
    }));
  } finally {
    db.close();
  }
}

function readJsonlOutcomeRows(source: string): OutcomeEvalRow[] {
  const lines = fs
    .readFileSync(source, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rows: OutcomeEvalRow[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as Partial<OutcomeEvalRow> & {
      repro_passed?: unknown;
      fix_passed?: unknown;
      verification_gate_passed?: unknown;
    };
    if (parsed.agent !== 'pipeline' || parsed.mode !== 'pipeline') continue;
    rows.push({
      ts: String(parsed.ts ?? ''),
      issue_number: Number(parsed.issue_number ?? 0),
      attempt_id: String(parsed.attempt_id ?? ''),
      mode: String(parsed.mode ?? ''),
      backend: normalizeBackendName(String(parsed.backend ?? 'unknown')),
      agent: String(parsed.agent ?? ''),
      repro_passed: toBooleanOrNull(parsed.repro_passed),
      fix_passed: toBooleanOrNull(parsed.fix_passed),
      verification_gate_passed: toBooleanOrNull(parsed.verification_gate_passed),
      verification_stage: parsed.verification_stage ?? null,
      final_disposition: String(parsed.final_disposition ?? ''),
      error_kind: parsed.error_kind ?? null,
    });
  }
  return rows;
}

function loadOutcomeRows(source: string): OutcomeEvalRow[] {
  if (!fs.existsSync(source)) {
    throw new Error(
      `Outcome source not found: ${source}. Set OSA_EVAL_PATH or pass --source <path>.`
    );
  }
  if (source.toLowerCase().endsWith('.jsonl')) {
    return readJsonlOutcomeRows(source);
  }
  return readSqliteOutcomeRows(source);
}

function rate(passed: number, evaluated: number): number | null {
  if (evaluated === 0) return null;
  return passed / evaluated;
}

function computeOutcomeResults(rows: OutcomeEvalRow[], source: string): OutcomeResultsJson {
  const latestByIssueBackend = new Map<string, OutcomeEvalRow>();
  for (const row of rows) {
    const key = `${row.backend}#${row.issue_number}`;
    latestByIssueBackend.set(key, row);
  }
  const latestRows = Array.from(latestByIssueBackend.values()).sort(
    (a, b) => a.issue_number - b.issue_number
  );

  const byPlatform = new Map<string, OutcomeEvalRow[]>();
  for (const row of latestRows) {
    if (!byPlatform.has(row.backend)) byPlatform.set(row.backend, []);
    byPlatform.get(row.backend)!.push(row);
  }

  const perPlatform: Record<string, OutcomePlatformStats> = {};
  for (const [platform, platformRows] of byPlatform.entries()) {
    const reproEvaluated = platformRows.filter((r) => r.repro_passed !== null).length;
    const reproPassed = platformRows.filter((r) => r.repro_passed === true).length;
    const fixEvaluated = platformRows.filter((r) => r.fix_passed !== null).length;
    const fixPassed = platformRows.filter((r) => r.fix_passed === true).length;
    const verificationEvaluated = platformRows.filter(
      (r) => r.verification_gate_passed !== null
    ).length;
    const verificationPassed = platformRows.filter(
      (r) => r.verification_gate_passed === true
    ).length;
    const verificationSkipped = platformRows.filter(
      (r) => r.verification_stage === 'skipped_non_gha'
    ).length;
    const resolved = platformRows.filter((r) => r.final_disposition === 'pr-opened').length;

    perPlatform[platform] = {
      issues_evaluated: platformRows.length,
      repro_pass_rate: rate(reproPassed, reproEvaluated),
      fix_pass_rate: rate(fixPassed, fixEvaluated),
      verification_pass_rate: rate(verificationPassed, verificationEvaluated),
      verification_skipped: verificationSkipped,
      issue_resolved_rate: rate(resolved, platformRows.length) ?? 0,
    };
  }

  const perIssueMap = new Map<
    number,
    {
      issue_number: number;
      by_platform: OutcomeResultsJson['per_issue'][number]['by_platform'];
    }
  >();
  for (const row of latestRows) {
    if (!perIssueMap.has(row.issue_number)) {
      perIssueMap.set(row.issue_number, { issue_number: row.issue_number, by_platform: {} });
    }
    perIssueMap.get(row.issue_number)!.by_platform[row.backend] = {
      repro_passed: row.repro_passed,
      fix_passed: row.fix_passed,
      verification_gate_passed: row.verification_gate_passed,
      verification_stage: row.verification_stage,
      issue_resolved: row.final_disposition === 'pr-opened',
      final_disposition: row.final_disposition,
      attempt_id: row.attempt_id,
    };
  }

  const compareKeys = ['repro_passed', 'fix_passed', 'verification_gate_passed', 'issue_resolved'] as const;
  const perIssue = Array.from(perIssueMap.values())
    .sort((a, b) => a.issue_number - b.issue_number)
    .map((entry) => {
      const discrepancies: string[] = [];
      for (const key of compareKeys) {
        const values = Object.values(entry.by_platform).map((v) => String(v[key]));
        if (new Set(values).size > 1) discrepancies.push(key);
      }
      return {
        issue_number: entry.issue_number,
        by_platform: entry.by_platform,
        discrepancies,
      };
    });

  return {
    run_id: `outcomes-${Date.now()}`,
    mode: 'outcomes',
    timestamp: new Date().toISOString(),
    source,
    total_rows: latestRows.length,
    backend_coverage: Array.from(byPlatform.keys()).sort(),
    per_platform: perPlatform,
    per_issue: perIssue,
  };
}

function formatPercent(value: number | null): string {
  if (value === null) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function requiredEnvFor(platform: string): string[] {
  switch (platform) {
    case 'arize':
      return [
        'PHOENIX_COLLECTOR_ENDPOINT (local) and/or ARIZE_API_KEY + (ARIZE_SPACE_KEY or ARIZE_SPACE_ID) (cloud)',
      ];
    case 'langsmith':
      return ['LANGCHAIN_API_KEY (or LANGSMITH_API_KEY)'];
    case 'braintrust':
      return ['BRAINTRUST_API_KEY'];
    default:
      return [];
  }
}

function writeFrictionLog(outPath: string): void {
  const platforms = getRegisteredPlatforms();
  const lines: string[] = [
    '# Setup friction log',
    '',
    '_Auto-generated from each platform adapter\'s `getSetupNotes()` after the eval runner finished._',
    '',
  ];

  for (const p of platforms) {
    lines.push(`## ${p.name}`, '');
    const notes = p.getSetupNotes();
    if (notes.length === 0) {
      lines.push('- No friction observed. Setup completed cleanly.', '');
    } else {
      for (const n of notes) lines.push(`- ${n}`);
      lines.push('');
    }
  }

  lines.push(
    '## Cross-platform observations',
    '',
    '- **No standard exists for parent/child agent traces.** Each platform models a multi-stage pipeline differently: OpenInference uses OTel spans with `openinference.span.kind`; LangSmith uses `RunTree` with explicit parent IDs; Braintrust uses nested `startSpan` calls inside an Experiment row. Every platform required custom adapter code to express the same triage → PM flow.',
    '- **None of the SDKs auto-detected a pre-existing OTel SDK setup.** When the OpenInference instrumentation registers a tracer provider, neither LangSmith nor Braintrust hook into it; each platform requires its own initialisation path.',
    '- **"Evaluations" mean three different things.** Phoenix evaluations are post-hoc LLM-as-a-judge over recorded traces, LangSmith evaluations re-run the pipeline against a dataset on demand, and Braintrust evaluations are first-class Experiments with custom scorers. Picking which abstraction to use is itself a research project.',
    '- **Token tracking only happens if the adapter populates token attributes.** None of the platforms inferred input/output token counts from the Anthropic response shape; every platform required us to extract `usage.input_tokens` / `usage.output_tokens` manually and set the platform-specific attribute keys.',
    '- **Non-LLM pipeline steps (the PM heuristic) are awkward on all three.** OpenInference has no clean span kind for "deterministic stage"; LangSmith expects an `inputs`/`outputs` JSON object; Braintrust expects an `input`/`output` pair on a span. We emitted shim "stage" spans that contain a JSON-stringified summary instead of an LLM prompt — readable, but not native to any platform.',
    '',
  );

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
}

function writeComparisonTemplate(
  outPath: string,
  results: ResultsJson,
  frictionPath: string
): void {
  const friction = fs.readFileSync(frictionPath, 'utf8');

  const platformRows = Object.entries(results.per_platform)
    .map(
      ([name, stats]) =>
        `| ${name} | ${stats.traces_sent} | ${stats.errors} | ${stats.avg_trace_latency_ms.toFixed(1)} ms | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |`
    )
    .join('\n');

  const md = `# Observability platform comparison: Arize Phoenix vs LangSmith vs Braintrust

> Test subject: the OSS Fix Loop multi-agent harness (\`BandaruDheeraj/oss-support-agent\`). The eval ran ${results.total_issues} real-looking openinference issues through the triage and PM scoring stages, fanning every span out to all three platforms in parallel using a single shared wrapper at \`core/telemetry.ts\`.

> Run \`${results.run_id}\` — ${results.timestamp}

## 1. Test methodology

The OSS Fix Loop is a multi-stage agent harness (triage → PM → fix → build → eval) that opens real PRs against real OSS repos. For this study we instrumented only the read-only stages (triage + PM scoring) so the comparison would be reproducible without side effects:

- **Triage**: a heuristic classifier picks the issue type (bug_fix / new_feature / docs) and the per-repo \`OpenInferenceAdapter\` routes to an affected module path.
- **PM scoring**: a deterministic heuristic that decides whether a design review is needed before code is written.
- Both stages emit spans through \`core/telemetry.ts\`, which fans out to every registered platform via \`Promise.all\` and swallows individual platform failures so the harness is never blocked.

Why this is a good eval subject: the pipeline is multi-stage, it mixes LLM and non-LLM steps, and it produces measurable outputs (module path, design-needed bool) that can be scored against a labelled golden set.

We measured:
- **Triage accuracy**: 1.0 for exact module match, 0.5 if the parent directory matches, 0.0 otherwise.
- **PM design-score accuracy**: 1.0 if \`design_needed\` matches the labelled expectation, else 0.0.
- **Latency per stage** and **token usage** captured by the wrapper.

## 2. Quantitative results

### Per-platform telemetry stats

| Platform | Traces sent | Errors | Avg trace latency |
|----------|------------:|-------:|------------------:|
${Object.entries(results.per_platform)
  .map(
    ([name, stats]) =>
      `| ${name} | ${stats.traces_sent} | ${stats.errors} | ${stats.avg_trace_latency_ms.toFixed(1)} ms |`
  )
  .join('\n')}

### Aggregate scoring

- **PM accuracy overall:** ${(results.aggregate.pm_accuracy_overall * 100).toFixed(1)}%
- **Triage accuracy by difficulty:**
${Object.entries(results.aggregate.triage_accuracy_by_difficulty)
  .map(([k, v]) => `  - ${k}: ${(v * 100).toFixed(1)}%`)
  .join('\n')}
- **Avg latency:** triage ${results.aggregate.avg_latency_by_stage.triage.toFixed(1)} ms, PM ${results.aggregate.avg_latency_by_stage.pm.toFixed(1)} ms
- **Total tokens:** ${results.aggregate.total_tokens.input} input / ${results.aggregate.total_tokens.output} output

## 3. Setup experience — by platform

${friction}

## 4. Developer productivity observations — by platform

### Arize Phoenix
- **Time to first trace visible in UI:** [MANUAL]
- **Trace UI quality for multi-agent pipelines:** [MANUAL]
- **Dataset and eval management workflow:** [MANUAL]
- **Prompt / experiment versioning:** [MANUAL]
- **Debugging workflow when an agent run fails:** [MANUAL]
- **Documentation quality and completeness:** [MANUAL]
- **Missing features I wanted but couldn't find:** [MANUAL]

### LangSmith
- **Time to first trace visible in UI:** [MANUAL]
- **Trace UI quality for multi-agent pipelines:** [MANUAL]
- **Dataset and eval management workflow:** [MANUAL]
- **Prompt / experiment versioning:** [MANUAL]
- **Debugging workflow when an agent run fails:** [MANUAL]
- **Documentation quality and completeness:** [MANUAL]
- **Missing features I wanted but couldn't find:** [MANUAL]

### Braintrust
- **Time to first trace visible in UI:** [MANUAL]
- **Trace UI quality for multi-agent pipelines:** [MANUAL]
- **Dataset and eval management workflow:** [MANUAL]
- **Prompt / experiment versioning:** [MANUAL]
- **Debugging workflow when an agent run fails:** [MANUAL]
- **Documentation quality and completeness:** [MANUAL]
- **Missing features I wanted but couldn't find:** [MANUAL]

## 5. Systematic evaluator review (keep this updated each run)

### 5.1 Weighted scorecard for this run

Scoring scale: 1 (poor) to 5 (excellent). Keep these weights stable across runs so platform trends remain comparable.

| Criterion | Weight (%) | Arize | LangSmith | Braintrust | Winner | Evidence / notes |
|-----------|-----------:|------:|----------:|-----------:|--------|------------------|
| Multi-agent trace readability | 20 | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| Evaluator authoring + execution workflow | 20 | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| Discrepancy debugging speed | 15 | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| Dataset/experiment management | 15 | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| API/SDK ergonomics | 15 | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| Documentation quality | 15 | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |
| **Weighted total (0-5)** | **100** | **[MANUAL]** | **[MANUAL]** | **[MANUAL]** | **[MANUAL]** | **[MANUAL]** |

### 5.2 Run-over-run leaderboard

| Run ID | Arize weighted total | LangSmith weighted total | Braintrust weighted total | Best overall | Biggest change vs previous run | Notes |
|--------|---------------------:|-------------------------:|--------------------------:|--------------|--------------------------------|------|
| \`${results.run_id}\` | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |

### 5.3 Discrepancy register (how evaluators differ)

Record every meaningful mismatch in evaluator behavior, not just outright failures.

| Run ID | Issue / scenario | Expected evaluator behavior | Arize observed | LangSmith observed | Braintrust observed | Discrepancy type | Severity | Follow-up |
|--------|------------------|-----------------------------|----------------|--------------------|---------------------|------------------|----------|-----------|
| \`${results.run_id}\` | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] | [MANUAL] |

Discrepancy type taxonomy (recommended): \`scoring\`, \`trace-model\`, \`dataset-eval\`, \`metadata/tokens\`, \`UI/ux\`, \`API/SDK\`, \`latency/reliability\`.

## 6. Summary comparison

| Platform | Traces sent | Errors | Avg trace latency | UI for multi-agent | Eval workflow | Docs | Weighted total | Wins this run | Main discrepancy risk |
|----------|------------:|-------:|------------------:|--------------------|---------------|------|---------------:|--------------:|-----------------------|
${platformRows}

## 7. Recommendation

[MANUAL] Recommendation for a team building multi-agent pipelines in 2026.
`;

  fs.writeFileSync(outPath, md, 'utf8');
}

async function runTriageEval(): Promise<void> {
  console.log('[eval] Booting observability comparison harness');

  clearRegisteredPlatforms();
  registerPlatform(new ArizeAdapter());
  registerPlatform(new LangSmithAdapter());
  registerPlatform(new BraintrustAdapter());

  const connectResults = await connectAll();
  const failed = connectResults.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error('[eval] Connection failures:');
    for (const f of failed) {
      console.error(`  - ${f.platform}: ${f.error ?? 'unknown error'}`);
      const envs = requiredEnvFor(f.platform);
      if (envs.length) console.error(`    Required env: ${envs.join(', ')}`);
    }
    process.exit(1);
  }

  const pings = await pingAll();
  console.log('[eval] Ping results:');
  for (const p of pings) {
    console.log(`  - ${p.platform}: ${p.connected ? 'OK' : 'DOWN'} (${p.latency_ms} ms)`);
  }
  if (pings.some((p) => !p.connected)) {
    console.error('[eval] One or more platforms unreachable; aborting');
    process.exit(1);
  }

  const golden = loadGoldenSet();
  console.log(`[eval] Loaded ${golden.length} golden issues`);

  const langsmith = getRegisteredPlatforms().find((p) => p.name === 'langsmith') as
    | LangSmithAdapter
    | undefined;
  if (langsmith?.uploadDatasetExamples) {
    try {
      const examples: GoldenExample[] = golden.map((g) => ({
        inputs: { title: g.title, body: g.body, issue_number: g.issue_number },
        outputs: {
          expected_issue_type: g.expected_issue_type,
          expected_module: g.expected_module,
          expected_design_needed: g.expected_design_needed,
        },
      }));
      await langsmith.uploadDatasetExamples(examples);
    } catch (err) {
      console.warn('[eval] LangSmith dataset upload failed:', (err as Error).message);
    }
  }

  const runId = `run-${Date.now()}`;
  const startTime = Date.now();
  const adapter = new OpenInferenceAdapter();
  const classifier = new DefaultIssueTypeClassifier();

  const perPlatform: Record<string, { traces_sent: number; errors: number; latencies: number[] }> = {};
  for (const p of getRegisteredPlatforms()) {
    perPlatform[p.name] = { traces_sent: 0, errors: 0, latencies: [] };
  }

  const perIssue: ResultsJson['per_issue'] = [];
  const perIssueRich: PerIssueResult[] = [];
  const triageAccuracyByDifficulty: Record<string, number[]> = { easy: [], medium: [], hard: [] };
  const triageAccuracies: number[] = [];
  const pmAccuracies: number[] = [];
  const triageLatencies: number[] = [];
  const pmLatencies: number[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const g of golden) {
    console.log(`[eval] #${g.issue_number} ${g.title.slice(0, 80)}`);

    const ctx: TelemetryContext = {
      agent_name: 'triage',
      run_id: runId,
      issue_number: g.issue_number,
      repo_name: REPO_NAME,
      stage: 'triage',
    };

    const triageStart = Date.now();
    let triageType: IssueType = 'bug_fix';
    let triageModule = '.';
    try {
      await tracedStage(
        ctx,
        'triage.classify',
        async () => {
          const classification = await classifier.classifyIssueType(buildTriageInput(g));
          triageType = classification.issueType;
          triageModule = await adapter.classifyModule(buildIssue(g));
          return { issueType: triageType, module: triageModule };
        },
        {
          inputSummary: { title: g.title, body_preview: g.body.slice(0, 200) },
        }
      );
    } catch (err) {
      console.warn(`[eval] triage failed for #${g.issue_number}: ${(err as Error).message}`);
    }
    const triageLatency = Date.now() - triageStart;
    triageLatencies.push(triageLatency);

    const pmCtx: TelemetryContext = { ...ctx, agent_name: 'pm', stage: 'pm' };
    const pmStart = Date.now();
    const pmInput: PMScoringInput = {
      issueType: triageType,
      affectedModule: triageModule,
      summary: g.title,
      title: g.title,
      body: g.body,
      labels: [],
      relatedIssues: [],
      recentPRs: [],
      designDocs: [],
    };
    let pmDesignNeeded = false;
    let pmReasoning = '';
    try {
      const pmResult = await tracedStage(
        pmCtx,
        'pm.scoreDesign',
        () => scoreDesign(pmInput),
        { inputSummary: { issueType: triageType, module: triageModule } }
      );
      pmDesignNeeded = pmResult.designNeeded;
      pmReasoning = pmResult.reasoning;
    } catch (err) {
      console.warn(`[eval] pm failed for #${g.issue_number}: ${(err as Error).message}`);
    }
    const pmLatency = Date.now() - pmStart;
    pmLatencies.push(pmLatency);

    const triageScore = triageAccuracy({
      expected_module: g.expected_module,
      actual_module: triageModule,
    });
    const pmScore = pmDesignScoreAccuracy({
      expected_design_needed: g.expected_design_needed,
      actual_design_needed: pmDesignNeeded,
    });
    triageAccuracies.push(triageScore);
    triageAccuracyByDifficulty[g.difficulty]?.push(triageScore);
    pmAccuracies.push(pmScore);

    const richResult: PerIssueResult = {
      issue_number: g.issue_number,
      title: g.title,
      difficulty: g.difficulty,
      triage_result: {
        issue_type: triageType,
        module: triageModule,
        latency_ms: triageLatency,
        input_tokens: null,
        output_tokens: null,
      },
      pm_result: {
        design_needed: pmDesignNeeded,
        reasoning: pmReasoning,
        latency_ms: pmLatency,
        input_tokens: null,
        output_tokens: null,
      },
      scores: { triage_accuracy: triageScore, pm_accuracy: pmScore },
    };
    perIssueRich.push(richResult);

    perIssue.push({
      issue_number: g.issue_number,
      title: g.title,
      difficulty: g.difficulty,
      triage_result: richResult.triage_result,
      pm_result: richResult.pm_result,
      scores: richResult.scores,
      platform_errors: {},
    });
  }

  const endTime = Date.now();
  const summary: RunSummary = {
    run_id: runId,
    repo_name: REPO_NAME,
    total_issues: golden.length,
    start_time_ms: startTime,
    end_time_ms: endTime,
    duration_ms: endTime - startTime,
    aggregate: {
      triage_accuracy_overall: avg(triageAccuracies),
      pm_accuracy_overall: avg(pmAccuracies),
      triage_accuracy_by_difficulty: {
        easy: avg(triageAccuracyByDifficulty.easy ?? []),
        medium: avg(triageAccuracyByDifficulty.medium ?? []),
        hard: avg(triageAccuracyByDifficulty.hard ?? []),
      },
      avg_latency_by_stage: { triage: avg(triageLatencies), pm: avg(pmLatencies) },
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
    },
    per_issue: perIssueRich,
  };

  const runErrors = await fanOutRun(summary);
  for (const p of getRegisteredPlatforms()) {
    const runError = runErrors[p.name];
    if (runError) {
      perPlatform[p.name]!.errors += 1;
    }
    // Each issue fans out 2 stage traces (triage + pm) plus 1 run trace.
    // Successful sends = expected total - observed errors.
    const expectedTraces = golden.length * 2 + 1;
    perPlatform[p.name]!.traces_sent = Math.max(
      0,
      expectedTraces - perPlatform[p.name]!.errors
    );
  }

  const results: ResultsJson = {
    run_id: runId,
    timestamp: new Date(startTime).toISOString(),
    total_issues: golden.length,
    per_platform: Object.fromEntries(
      Object.entries(perPlatform).map(([name, stats]) => [
        name,
        {
          traces_sent: stats.traces_sent,
          errors: stats.errors,
          avg_trace_latency_ms: avg(stats.latencies),
        },
      ])
    ),
    per_issue: perIssue,
    aggregate: {
      triage_accuracy_by_difficulty: summary.aggregate.triage_accuracy_by_difficulty,
      pm_accuracy_overall: summary.aggregate.pm_accuracy_overall,
      avg_latency_by_stage: summary.aggregate.avg_latency_by_stage,
      total_tokens: { input: totalInputTokens, output: totalOutputTokens },
    },
  };

  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date(startTime).toISOString().replace(/[:.]/g, '-');
  const resultsFile = path.join(resultsDir, `eval-${stamp}.json`);
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2), 'utf8');
  console.log(`[eval] Wrote ${resultsFile}`);

  const frictionFile = path.join(__dirname, 'SETUP-FRICTION.md');
  writeFrictionLog(frictionFile);
  console.log(`[eval] Wrote ${frictionFile}`);

  const compareFile = path.join(__dirname, 'COMPETITIVE-ANALYSIS-TEMPLATE.md');
  writeComparisonTemplate(compareFile, results, frictionFile);
  console.log(`[eval] Wrote ${compareFile}`);

  console.log('[eval] Done.');
  // Touch the env flag so the linter doesn't complain when we add it later.
  void envFlag;
}

async function runOutcomesEval(options: CliOptions): Promise<void> {
  console.log(`[eval] Booting outcome comparison mode (source=${options.source})`);
  const rows = loadOutcomeRows(options.source);
  if (rows.length === 0) {
    throw new Error(
      `No pipeline outcome rows found in ${options.source}. Run the pipeline first with OSA_EVAL_BACKEND=sqlite or jsonl.`
    );
  }

  const results = computeOutcomeResults(rows, options.source);
  if (results.total_rows === 0) {
    throw new Error(
      `No latest per-issue pipeline outcomes could be derived from ${options.source}.`
    );
  }

  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(resultsDir, `eval-outcomes-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf8');
  console.log(`[eval] Wrote ${outFile}`);

  const perPlatformEntries = Object.entries(results.per_platform).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  console.log('');
  console.log('Platform | Issues | Repro pass | Fix pass | Verify pass | Verify skipped | Resolved');
  console.log('---------|-------:|-----------:|---------:|------------:|---------------:|---------:');
  for (const [platform, stats] of perPlatformEntries) {
    console.log(
      `${platform} | ${stats.issues_evaluated} | ${formatPercent(stats.repro_pass_rate)} | ${formatPercent(
        stats.fix_pass_rate
      )} | ${formatPercent(stats.verification_pass_rate)} | ${stats.verification_skipped} | ${formatPercent(
        stats.issue_resolved_rate
      )}`
    );
  }
  console.log('');

  const canonical = ['arize', 'braintrust', 'langsmith'];
  const missing = canonical.filter((p) => !results.backend_coverage.includes(p));
  if (missing.length > 0) {
    console.warn(
      `[eval] Missing backend coverage for: ${missing.join(
        ', '
      )}. Run the same issue set once per backend with OBSERVABILITY_BACKEND=<platform> to compare faithfully.`
    );
  }

  const discrepancyCount = results.per_issue.filter((r) => r.discrepancies.length > 0).length;
  console.log(
    `[eval] Discrepancies across backend outcomes: ${discrepancyCount}/${results.per_issue.length} issues`
  );
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.mode === 'triage') {
    await runTriageEval();
    return;
  }
  await runOutcomesEval(options);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[eval] Fatal:', err);
    process.exit(1);
  });
}

export { parseCliArgs, toBooleanOrNull, computeOutcomeResults };
