/**
 * OpenRouter-backed repro generator.
 *
 * Produces a self-contained Python repro test for a reported bug. The test
 * MUST:
 *   - exit non-zero when the bug is present
 *   - exit zero after the fix is applied
 *   - print a unique `failureSentinel` ONLY on the bug-specific failure path
 *     (so ModuleNotFoundError / pip errors don't masquerade as valid repros)
 *
 * Shell commands (setup + run) are NOT produced by the LLM. The pipeline
 * derives them from adapter config + the repro path.
 */

import type {
  ReproAgentInput,
  ReproGenerator,
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
