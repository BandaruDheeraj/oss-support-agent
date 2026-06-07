/**
 * LLM-based harness repair agent.
 *
 * Called by the builder whenever any stage of the repro pipeline fails:
 * pip install, sandbox errors, wrong test failure, unexpected test pass.
 * Returns updated test files and installSpec to retry with.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel, MissingLlmApiKeyError } from '../../llm/v2/client';
import { withAgentSpan } from '../../observability/spans';

const RepairOutputSchema = z.object({
  explanation: z.string().describe('What you changed and why, in 1-3 sentences'),
  testFileUpdates: z
    .array(
      z.object({
        path: z.string().describe('File path relative to repo root'),
        content: z.string().describe('Full new content for this file'),
      })
    )
    .describe('Files to rewrite. Omit files that do not need to change.'),
  installSpec: z
    .object({
      editableInstall: z
        .array(z.string())
        .describe('Repo-relative paths to install editably with pip install -e'),
      additionalPackages: z
        .array(z.string())
        .describe('PyPI package names/specs to install with pip install'),
    })
    .describe('The new install spec. Return the current one unchanged if no fix is needed here.'),
  abandon: z
    .boolean()
    .describe(
      'Set true if you are confident the bug cannot be reproduced with a simple test (e.g. requires external service, credentials, or is fundamentally non-deterministic)'
    ),
  abandonReason: z.string().optional(),
});

export type RepairOutput = z.infer<typeof RepairOutputSchema>;

export type RepairErrorPhase =
  | 'pip_install'
  | 'sandbox_error'
  | 'test_run_threw'
  | 'test_pass_unexpected'
  | 'expected_output_absent'
  | 'write_failed';

export interface RepairContext {
  attemptId: string;
  errorPhase: RepairErrorPhase;
  errorOutput: string;
  currentTestFiles: ReadonlyArray<{ path: string; content: string }>;
  currentInstallSpec: { editableInstall: string[]; additionalPackages: string[] };
  availableEditableInstalls: string[];
  issueTitle?: string;
  issueBody?: string;
  roundNumber: number;
  maxRounds: number;
  repairHistory: string[];
}

const PHASE_CONTEXT: Record<RepairErrorPhase, string> = {
  pip_install:
    'A pip install command failed. The package either does not exist at that path, the path is wrong, or the sandbox requires a specific setup sequence.',
  sandbox_error:
    'The sandbox threw an unexpected error before any test output was produced. This is usually a package path problem or a sandbox lifecycle violation.',
  test_run_threw:
    'The sandbox threw when trying to run the test (infrastructure failure, not a test assertion failure).',
  test_pass_unexpected:
    'The test PASSED (exit code 0) but it MUST FAIL to reproduce the bug. The test is not actually exercising the buggy code path.',
  expected_output_absent:
    'The test failed (good!) but the failure output does not contain the expected error message/signature. The test is triggering a different error than the bug.',
  write_failed:
    'Writing a test file to the workspace failed.',
};

export async function repairHarness(ctx: RepairContext): Promise<RepairOutput | null> {
  let model;
  try {
    model = getModel('REPRO_REPAIR');
  } catch (err) {
    if (err instanceof MissingLlmApiKeyError) return null;
    throw err;
  }

  const filesSummary = ctx.currentTestFiles
    .map((f) => `=== ${f.path} ===\n${f.content}`)
    .join('\n\n');

  const availableSection =
    ctx.availableEditableInstalls.length > 0
      ? `Available editable install candidates discovered in the repo:\n${ctx.availableEditableInstalls.map((p) => `  - ${p}`).join('\n')}`
      : 'No editable install candidates were discovered in the repo.';

  const historySection =
    ctx.repairHistory.length > 0
      ? `\nPrevious repair rounds (${ctx.repairHistory.length}):\n${ctx.repairHistory.map((h, i) => `  Round ${i + 1}: ${h}`).join('\n')}`
      : '';

  const issueSection =
    ctx.issueTitle
      ? `\nIssue title: ${ctx.issueTitle}\n${ctx.issueBody ? `Issue body (truncated):\n${ctx.issueBody.slice(0, 800)}` : ''}`
      : '';

  const prompt = `You are a test-harness repair agent. A Python test that should reproduce a library bug is failing for the WRONG reason.
Your job: fix the test files and/or install spec so the test reproduces the actual bug.${issueSection}

━━━ ERROR (round ${ctx.roundNumber + 1} of ${ctx.maxRounds}) ━━━
Phase: ${ctx.errorPhase}
${PHASE_CONTEXT[ctx.errorPhase]}

Error output:
\`\`\`
${ctx.errorOutput.slice(0, 3000)}
\`\`\`

━━━ CURRENT TEST FILES ━━━
${filesSummary}

━━━ CURRENT INSTALL SPEC ━━━
editableInstall: ${JSON.stringify(ctx.currentInstallSpec.editableInstall)}
additionalPackages: ${JSON.stringify(ctx.currentInstallSpec.additionalPackages)}

${availableSection}${historySection}

━━━ REPAIR RULES ━━━
1. "SandboxSession.dispatch requires setupDependencies()" → The editable install path causes a sandbox lifecycle failure. Remove it from editableInstall, or swap it for a correct path from the available candidates list. Consider whether the package is even needed (it may be a transitive dep of another package you're already installing).
2. ImportError / ModuleNotFoundError → Fix the import in the test, or add/correct the package in installSpec. Check the available candidates for the right path.
3. Test PASSED when it should fail → Rewrite the test to actually call the function that has the bug and assert the incorrect (buggy) behavior triggers.
4. Test fails with wrong error → The test is hitting a setup error before reaching the buggy code. Fix imports, mocks, and setup so the test reaches the bug.
5. Keep changes minimal. Only return files you actually changed.
6. Set abandon=true only if reproducing the bug requires external services, live network calls, or real credentials that cannot be mocked.`;

  const result = await withAgentSpan(
    'REPRO_REPAIR',
    {
      attempt_id: ctx.attemptId,
      'repro.repair.round': ctx.roundNumber,
      'repro.repair.phase': ctx.errorPhase,
    },
    async () =>
      generateObject({
        model,
        schema: RepairOutputSchema,
        prompt,
        experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
      })
  );

  // eslint-disable-next-line no-console
  console.log(
    `[v2-repair] attempt=${ctx.attemptId} round=${ctx.roundNumber} phase=${ctx.errorPhase} abandon=${result.object.abandon} explanation=${JSON.stringify(result.object.explanation).slice(0, 200)}`
  );

  return result.object;
}
