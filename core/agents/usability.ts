/**
 * Usability agent (US-015).
 * Exercises the change as a real user would, surfacing developer-experience
 * problems that tests miss. Runs in the same isolated sandbox as the test suite.
 */

import {
  UsabilityAgentInput,
  UsabilityAgentResult,
  UsabilityCheck,
  UsabilityExerciser,
  UsabilityExerciserOutput,
  UsabilityConfig,
  UsabilityCategory,
  UsabilityStatus,
  UsabilitySeverity,
  UsabilityAgentError,
  USABILITY_WORKFLOW_FILE,
  DEFAULT_USABILITY_TIMEOUT_MINUTES,
} from './usability-types';
import { ActionsClient, SandboxRunError } from '../sandbox-types';
import type { SandboxPhaseFailure, SandboxSession } from '../sandbox-session';

/**
 * Validates usability agent configuration.
 */
export function validateUsabilityConfig(input: UsabilityAgentInput): void {
  if (!input.forkFullName || !input.forkFullName.includes('/')) {
    throw new UsabilityAgentError(
      `Invalid forkFullName: "${input.forkFullName}" (must be "org/repo" format)`,
      'validation',
      input.forkFullName || ''
    );
  }
  if (!input.branchName || input.branchName.trim() === '') {
    throw new UsabilityAgentError(
      'branchName is required',
      'validation',
      input.forkFullName
    );
  }
  if (!input.affectedModule || input.affectedModule.trim() === '') {
    throw new UsabilityAgentError(
      'affectedModule is required',
      'validation',
      input.forkFullName
    );
  }
  if (!input.installCommand || input.installCommand.trim() === '') {
    throw new UsabilityAgentError(
      'installCommand is required',
      'validation',
      input.forkFullName
    );
  }
}

/**
 * Builds workflow dispatch inputs for the usability sandbox.
 */
export function buildUsabilityWorkflowInputs(input: UsabilityAgentInput): Record<string, string> {
  const networkPolicy = input.sandboxServices.length === 0
    ? 'none'
    : `allow:${input.sandboxServices.join(',')}`;

  return {
    branch: input.branchName,
    install_command: input.installCommand,
    affected_module: input.affectedModule,
    entry_points: JSON.stringify(input.entryPoints),
    timeout: String(input.timeoutMinutes),
    network_policy: networkPolicy,
    sandbox_services: input.sandboxServices.join(','),
  };
}

/**
 * Calculates a DX score (0-100) from usability checks.
 */
export function calculateDxScore(checks: UsabilityCheck[]): number {
  if (checks.length === 0) return 0;

  const weights: Record<UsabilitySeverity, number> = {
    critical: 30,
    major: 20,
    minor: 10,
    info: 0,
  };

  let totalDeductions = 0;
  for (const check of checks) {
    if (check.status === 'fail') {
      totalDeductions += weights[check.severity];
    } else if (check.status === 'warning') {
      totalDeductions += weights[check.severity] * 0.5;
    }
  }

  return Math.max(0, Math.min(100, 100 - totalDeductions));
}

/**
 * Extracts blocker messages from checks.
 */
export function extractBlockers(checks: UsabilityCheck[]): string[] {
  return checks
    .filter(c => c.status === 'fail' && (c.severity === 'critical' || c.severity === 'major'))
    .map(c => `[${c.category}] ${c.description}: ${c.details}`);
}

/**
 * Extracts suggestion messages from checks.
 */
export function extractSuggestions(checks: UsabilityCheck[]): string[] {
  return checks
    .filter(c => c.status === 'warning' || (c.status === 'fail' && c.severity === 'minor'))
    .map(c => `[${c.category}] ${c.description}: ${c.details}`);
}

/**
 * Generates a human-readable summary from usability results.
 */
export function generateUsabilitySummary(
  checks: UsabilityCheck[],
  dxScore: number,
  installSuccess: boolean
): string {
  const passed = checks.filter(c => c.status === 'pass').length;
  const failed = checks.filter(c => c.status === 'fail').length;
  const warnings = checks.filter(c => c.status === 'warning').length;

  const lines: string[] = [
    `## Usability Report`,
    ``,
    `**DX Score: ${dxScore}/100**`,
    ``,
    `- Installation: ${installSuccess ? '✓ Success' : '✗ Failed'}`,
    `- Checks: ${passed} passed, ${failed} failed, ${warnings} warnings`,
    ``,
  ];

  if (failed > 0) {
    lines.push(`### Issues Found`);
    lines.push(``);
    for (const check of checks.filter(c => c.status === 'fail')) {
      lines.push(`- **[${check.severity}]** ${check.category}: ${check.details}`);
    }
    lines.push(``);
  }

  if (warnings > 0) {
    lines.push(`### Suggestions`);
    lines.push(``);
    for (const check of checks.filter(c => c.status === 'warning')) {
      lines.push(`- ${check.category}: ${check.details}`);
    }
    lines.push(``);
  }

  return lines.join('\n');
}

/**
 * Creates a UsabilityConfig from input.
 */
export function createUsabilityConfig(input: UsabilityAgentInput): UsabilityConfig {
  return {
    forkFullName: input.forkFullName,
    branchName: input.branchName,
    affectedModule: input.affectedModule,
    sandboxServices: [...input.sandboxServices],
    timeoutMinutes: input.timeoutMinutes || DEFAULT_USABILITY_TIMEOUT_MINUTES,
  };
}

/**
 * Runs the usability agent pipeline.
 *
 * Pipeline:
 * 1. Validate input
 * 2. Trigger usability workflow in the same sandbox as test suite
 * 3. Exercise the affected API (install, import, error handling, workflows)
 * 4. Score developer experience
 * 5. Return structured output for eval agent and PR body
 */
export async function runUsabilityAgent(
  input: UsabilityAgentInput,
  exerciser: UsabilityExerciser,
  _actionsClient: ActionsClient,
  sandboxSession?: SandboxSession
): Promise<UsabilityAgentResult> {
  void _actionsClient;

  // 1. Validate input
  validateUsabilityConfig(input);

  const startTime = Date.now();

  // 2. Trigger usability workflow dispatch in the sandbox
  const workflowInputs = buildUsabilityWorkflowInputs(input);

  let workflowRunUrl = '';
  if (!sandboxSession) {
    throw new UsabilityAgentError(
      'SandboxSession is required for usability dispatch',
      'dispatch',
      input.forkFullName
    );
  }

  const workflowResult = await sandboxSession.verifyWorkflowReachability(USABILITY_WORKFLOW_FILE);
  if (!workflowResult.ok) {
    throw new UsabilityAgentError(
      `Usability workflow reachability failed: ${formatSessionFailure(workflowResult)}`,
      'dispatch',
      input.forkFullName
    );
  }

  const dispatch = await sandboxSession.dispatchWorkflow({
    workflowId: USABILITY_WORKFLOW_FILE,
    timeoutMins: input.timeoutMinutes || DEFAULT_USABILITY_TIMEOUT_MINUTES,
    inputs: workflowInputs,
  });
  if (!dispatch.ok) {
    if (isTimeoutDispatchFailure(dispatch.diagnostics)) {
      const durationSeconds = (Date.now() - startTime) / 1000;
      return {
        completed: false,
        dxScore: 0,
        checks: [],
        summary: 'Usability run timed out',
        durationSeconds,
        timedOut: true,
        workflowRunUrl: '',
        blockers: ['Usability run timed out — could not complete DX assessment'],
        suggestions: [],
      };
    }
    throw new UsabilityAgentError(
      `Failed to trigger usability workflow: reason=${dispatch.reason} diagnostics=${JSON.stringify(dispatch.diagnostics)}`,
      'dispatch',
      input.forkFullName
    );
  }
  workflowRunUrl = dispatch.runUrl;

  // 3. Exercise the affected API
  let exerciserOutput: UsabilityExerciserOutput;
  try {
    exerciserOutput = await exerciser.exercise(input);
  } catch (error: any) {
    throw new UsabilityAgentError(
      `Failed to exercise API: ${error.message}`,
      'exercise',
      input.forkFullName
    );
  }

  // 4. Score developer experience
  const checks = exerciserOutput.checks;
  const dxScore = calculateDxScore(checks);
  const blockers = extractBlockers(checks);
  const suggestions = extractSuggestions(checks);

  // Add installation check if it failed
  if (!exerciserOutput.installSuccess) {
    const installCheck: UsabilityCheck = {
      category: 'installation',
      description: 'Fresh package installation',
      status: 'fail',
      details: `Installation failed: ${exerciserOutput.installOutput.slice(0, 200)}`,
      severity: 'critical',
    };
    checks.unshift(installCheck);
    blockers.unshift(`[installation] Fresh package installation failed`);
  }

  const durationSeconds = (Date.now() - startTime) / 1000;
  const finalScore = exerciserOutput.installSuccess ? dxScore : 0;
  const summary = generateUsabilitySummary(checks, finalScore, exerciserOutput.installSuccess);

  // 5. Return structured output
  return {
    completed: true,
    dxScore: finalScore,
    checks,
    summary,
    durationSeconds,
    timedOut: false,
    workflowRunUrl,
    blockers,
    suggestions,
  };
}

function formatSessionFailure(failure: SandboxPhaseFailure): string {
  const diagnostics = failure.diagnostics ? ` diagnostics=${JSON.stringify(failure.diagnostics)}` : '';
  return `phase=${failure.phase} reason=${failure.reason}${diagnostics}`;
}

function isTimeoutDispatchFailure(diagnostics: Record<string, unknown>): boolean {
  const errorText = diagnostics.error;
  return typeof errorText === 'string' && errorText.includes('workflow timed out');
}
