/**
 * OpenRouter-backed repro generator.
 *
 * Supports BOTH:
 *   1. The legacy one-shot interface (`OpenRouterReproGenerator`) — kept
 *      for backward compatibility with tests + any caller that still wants
 *      a single-shot answer.
 *   2. The iterative interface (`OpenRouterIterativeReproGenerator`) used
 *      by the new repro-loop. The model is allowed to either (a) request
 *      additional context (read_file / list_dir / find_file / grep) before
 *      committing, or (b) emit a candidate repro. After each turn the loop
 *      feeds back attempt history + accumulated context.
 *
 * Shell commands (setup + run) are NOT produced by the LLM. The pipeline
 * derives them from adapter config + the repro path.
 */

import type {
  IterativeReproGenerator,
  IterativeReproGeneratorInput,
  ReproAgentInput,
  ReproGenerator,
  ReproGeneratorAction,
  ReproGeneratorOutput,
} from '../agents/repro-types';
import { LLMClient, type LLMMessage } from './client';

const REPRO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'content', 'failureSentinel', 'summary'],
  properties: {
    path: { type: 'string', minLength: 1 },
    content: { type: 'string', minLength: 1 },
    failureSentinel: { type: 'string', minLength: 6 },
    summary: { type: 'string', minLength: 1 },
    requiredCredentials: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['envVar', 'purpose'],
        properties: {
          envVar: { type: 'string', minLength: 1 },
          purpose: { type: 'string', minLength: 1 },
          whereToGet: { type: 'string' },
        },
      },
    },
    editableInstalls: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    pipPackages: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
} as const;

const PYTHON_SYSTEM_PROMPT = `You are an OSS bug reproduction agent. Your job is to write ONE self-contained Python file that demonstrates the reported bug.

REQUIRED CONTRACT:
1. The file must run as: \`python <path>\`.
2. It MUST exit with a non-zero status (raise / sys.exit(1)) when the bug is present in the current source tree.
3. It MUST exit zero after a correct fix is applied.
4. When it hits the BUG-SPECIFIC failure path (not a ModuleNotFoundError, not a SyntaxError, not a pip failure), it MUST print the EXACT string given in failureSentinel to stdout BEFORE raising / exiting non-zero.
5. The repo is a monorepo. For ANY repo-internal package the test imports (e.g. \`openinference.instrumentation.<X>\`), declare its source directory in \`editableInstalls\` so the pipeline runs \`pip install -e <dir>\` before the test. \`editableInstalls\` entries are repo-relative directory paths containing a Python package (pyproject.toml or setup.py). Example: \`python/instrumentation/openinference-instrumentation-smolagents\`. Do NOT also use sys.path tricks for these — declare them as editableInstalls so package metadata, entry points, and plugin discovery work correctly.
6. For any third-party PyPI dependencies the test needs (e.g. \`pytest\`, \`openai\`, \`pydantic\`), declare them in \`pipPackages\` as plain PEP-508 specs (e.g. \`pytest\`, \`requests>=2.0\`, \`openai==1.30.1\`). The pipeline will run \`pip install <specs>\` before the test. Do NOT include opentelemetry-api / opentelemetry-sdk / wrapt — the adapter already installs those. Do NOT include flags (\`-r\`, \`--index-url\`), URLs, git refs, or local paths — only bare package names with optional extras + version specs.
7. Only assert the SPECIFIC failure mode described in the issue. Do NOT add extra behavioral assertions the issue does not call for — over-strict tests cause infinite retries.
8. Keep the test under 100 lines. Place it under a tests/ directory with a stable filename like tests/test_repro_issue_<N>.py.
9. DO NOT modify any other repo file.
10. The failureSentinel must be unique (include the bug short-name, e.g. "REPRO_FAILURE_NonRecordingSpan_status").
11. If — and ONLY if — your test reads environment variables (directly via os.environ, or transitively because it instantiates a client that reads them, e.g. the OpenAI SDK reads OPENAI_API_KEY), enumerate EVERY one of them in requiredCredentials. For each: envVar (the exact name), purpose (one-line: what it's for), whereToGet (URL or short instructions). DO NOT include opentelemetry / wrapt / stdlib env vars — only secrets / API keys / base URLs that an end user would need to provide. Prefer in-memory exporters and mocks so the test is fully self-contained; only declare credentials when the bug genuinely cannot be reproduced without a real external API call.

Return JSON matching:
{
  "path": string,
  "content": string,
  "failureSentinel": string,
  "summary": string,  // one-line: "Repro for: <bug>; fails on baseline with <sentinel>, passes once <fix>"
  "requiredCredentials"?: [ { "envVar": string, "purpose": string, "whereToGet"?: string } ],
  "editableInstalls"?: string[],  // repo-relative dirs to \`pip install -e\` before running
  "pipPackages"?: string[]        // PEP-508 specs to \`pip install\` before running
}
`;

export class OpenRouterReproGenerator implements ReproGenerator {
  private readonly client: LLMClient;

  constructor(client?: LLMClient) {
    this.client = client ?? new LLMClient();
  }

  async generate(input: ReproAgentInput): Promise<ReproGeneratorOutput> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: PYTHON_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: JSON.stringify(input, null, 2),
      },
    ];

    const { data } = await this.client.chatJson<ReproGeneratorOutput>(messages, REPRO_SCHEMA, {
      agent: 'REPRO',
      temperature: 0,
    });

    return data;
  }
}

// ---------------------------------------------------------------------------
// Iterative generator
//
// Wraps the same model with a richer contract: each turn the LLM either
// requests more context or commits to a candidate repro. The loop module
// (core/agents/repro-loop.ts) drives this back and forth.
// ---------------------------------------------------------------------------

const ITERATIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'reasoning'],
  properties: {
    kind: { type: 'string', enum: ['request_context', 'repro'] },
    reasoning: { type: 'string', minLength: 1 },
    requests: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'purpose'],
        properties: {
          op: { type: 'string', enum: ['read_file', 'list_dir', 'find_file', 'grep'] },
          purpose: { type: 'string', minLength: 1 },
          path: { type: 'string' },
          suffix: { type: 'string' },
          query: { type: 'string' },
          pathPrefix: { type: 'string' },
          extensions: { type: 'array', items: { type: 'string' } },
          fixedString: { type: 'boolean' },
          maxEntries: { type: 'integer', minimum: 1, maximum: 200 },
          maxResults: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
    },
    output: REPRO_SCHEMA,
  },
} as const;

const ITERATIVE_SYSTEM_PROMPT = `You are an OSS bug reproduction agent. You operate IN A LOOP. Each turn you may either:

  (a) request additional code context from the repo — when you don't yet know enough to write a faithful repro, OR
  (b) commit to a candidate repro that the runner will execute on baseline.

If you commit to a repro, the runner will execute it and feed the outcome (validation reason + redacted stdout/stderr tail + exit code) back to you next turn so you can refine. You CANNOT propose a fix; another agent does that. Your single job is to PROVE the bug reproduces.

You have a budget — see iteration / remainingIterations / remainingBaselineAttempts in the input. Every baseline run is expensive; only commit to a repro when you genuinely think it will reproduce the bug.

==============================
RESPONSE SHAPE — return JSON:
==============================

Either:
  { "kind": "request_context", "reasoning": "<one sentence>", "requests": [ <ContextRequest>, ... ] }

Or:
  { "kind": "repro", "reasoning": "<one sentence>", "output": <ReproOutput> }

ContextRequest is one of:
  { "op": "read_file", "path": "<repo-relative path>", "purpose": "<why>" }
  { "op": "list_dir",  "path": "<repo-relative dir>",  "purpose": "<why>", "maxEntries"?: int }
  { "op": "find_file", "suffix": "<basename or trailing path fragment>", "purpose": "<why>", "maxResults"?: int }
  { "op": "grep",      "query": "<text>", "purpose": "<why>", "pathPrefix"?: "<dir>", "extensions"?: ["py"], "fixedString"?: true, "maxResults"?: int }

Notes on context requests:
  - Paths must be repo-relative; no "..", no leading "/", no backslashes.
  - You may not read .env*, *.pem, *.key, id_rsa*, credentials*, secrets* — those are denied.
  - Prefer narrow grep with pathPrefix + extensions; whole-repo greps are wasteful.
  - Each turn you may include up to 12 requests.
  - Already-fetched results are echoed back to you in loadedContext; do not re-request them.
  - read_file truncates at ~60KB per file and ~200KB per turn. Plan accordingly.

ReproOutput is the same as the one-shot contract:
{
  "path": "tests/test_repro_issue_<N>.py",         // under preferredTestDir, .py only, repo-relative, no ".."
  "content": "<full Python file>",                  // exits non-zero with the BUG-SPECIFIC failure path
  "failureSentinel": "REPRO_FAILURE_<bug_short>",   // unique; printed to stdout BEFORE exiting non-zero
  "summary": "<one line>",
  "requiredCredentials"?: [{ "envVar": "...", "purpose": "...", "whereToGet"?: "..." }],
  "editableInstalls"?: ["<repo-relative dir containing pyproject.toml/setup.py>", ...],
  "pipPackages"?: ["pytest", "openai==1.30.1", ...]
}

==============================
REPRO CONTRACT — read carefully:
==============================
1. The file must run as: \`python <path>\`.
2. It MUST exit non-zero (raise / sys.exit(1)) WHEN the bug is present.
3. It MUST exit zero AFTER a correct fix is applied.
4. When it hits the BUG-SPECIFIC failure path (NOT ModuleNotFoundError, NOT SyntaxError, NOT pip failure) it MUST print the EXACT failureSentinel string to stdout BEFORE raising / exiting non-zero. The validator rejects the run if the sentinel is missing — that's how we distinguish "bug reproduced" from "the test is broken".
5. For repo-internal packages the test imports (e.g. \`openinference.instrumentation.<X>\`), declare the source dir in editableInstalls; the runner will \`pip install -e <dir>\`. Don't use sys.path hacks for these.
6. For third-party deps (pytest, openai, pydantic, ...), declare them in pipPackages. Do NOT include opentelemetry-api / opentelemetry-sdk / wrapt — the adapter installs those. No flags, URLs, git refs, or local paths.
7. Only assert the SPECIFIC failure mode described in the issue. Over-strict tests cause infinite retries.
8. Keep the test under 100 lines; place under preferredTestDir as test_repro_issue_<N>.py.
9. DO NOT modify any other repo file.
10. Prefer in-memory exporters / mocks. Only declare requiredCredentials when the bug genuinely needs a real external API call. Missing credentials are reported back to you as a terminal failure on the next turn.

==============================
USING FEEDBACK FROM PAST ATTEMPTS:
==============================
- previousAttempts contains every prior turn's outcome (stage, reason, stdoutTail, stderrTail, exitCode).
- If a prior attempt failed at "path_validation" / "sentinel_validation" / "setup_validation", FIX the structural issue — the same candidate will be rejected again.
- If a prior attempt failed at "baseline_failed_to_repro" with exitCode=0, your test passed when it should have failed — your assertions don't match the bug. Re-read the issue, request more code if needed.
- If stderr shows ModuleNotFoundError / ImportError, declare the missing package in pipPackages or editableInstalls; do NOT add try/except around the import.
- If the same candidate is emitted twice it is rejected without running. Change SOMETHING.

Be ruthless about correctness: a wrong repro wastes the budget and forces a halt with no PR.
`;

export class OpenRouterIterativeReproGenerator implements IterativeReproGenerator {
  private readonly client: LLMClient;

  constructor(client?: LLMClient) {
    this.client = client ?? new LLMClient();
  }

  async generate(input: IterativeReproGeneratorInput): Promise<ReproGeneratorAction> {
    const messages: LLMMessage[] = [
      { role: 'system', content: ITERATIVE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(input, null, 2) },
    ];
    const { data } = await this.client.chatJson<{
      kind: 'request_context' | 'repro';
      reasoning: string;
      requests?: Array<Record<string, unknown>>;
      output?: ReproGeneratorOutput;
    }>(messages, ITERATIVE_SCHEMA, {
      agent: 'REPRO',
      temperature: 0,
      // Cost guard: the loop has its own retry budget; we don't want chatJson
      // silently multiplying calls 3x per turn.
      parseRetries: 1,
    });

    if (data.kind === 'request_context') {
      return {
        kind: 'request_context',
        reasoning: data.reasoning,
        requests: (data.requests ?? []) as Extract<
          ReproGeneratorAction,
          { kind: 'request_context' }
        >['requests'],
      };
    }
    if (!data.output) {
      // Schema would normally catch this, but be defensive.
      throw new Error("iterative repro generator returned kind='repro' without an output field");
    }
    return { kind: 'repro', reasoning: data.reasoning, output: data.output };
  }
}
