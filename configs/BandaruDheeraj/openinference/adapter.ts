import {
  BaseRepoAdapter,
  type EvalResult,
  type Issue,
  type PRMetadata,
  type SandboxOutput,
  type ServiceConfig,
} from '../../../core/adapter.interface';

function normalizeText(s: string): string {
  return (s ?? '').toLowerCase();
}

function extractViolations(stdout: string): string[] {
  return (stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.toUpperCase().startsWith('VIOLATION:'))
    .map((l) => l.slice('VIOLATION:'.length).trim())
    .filter((m) => m.length > 0);
}

export default class OpenInferenceForkAdapter extends BaseRepoAdapter {
  async classifyModule(_issue: Issue): Promise<string> {
    // Triage validates against the agent's own cwd (not the fork clone), so we
    // return '.' which always exists. Downstream fix agent has full repo context.
    return '.';
  }

  async getTestCommands(): Promise<string[]> {
    return [
      'python -m pytest -q',
      'npm test',
    ];
  }

  async getSandboxServices(): Promise<ServiceConfig[]> {
    return [];
  }

  async runCustomEval(output: SandboxOutput): Promise<EvalResult> {
    const pytest = output.find((c) => c.command.includes('pytest'));
    const validate = output.find((c) => c.command.includes('validate_spans.py'));

    const violations = validate ? extractViolations(validate.stdout) : [];

    const pytestOk = !pytest || pytest.exitCode === 0;
    const validateOk = !validate || (validate.exitCode === 0 && violations.length === 0);

    if (pytestOk && validateOk) {
      return {
        passed: true,
        summary: 'Pytest passed (no Phoenix validator configured for fork test env)',
        retryContext: [],
      };
    }

    const retryContext = violations.length > 0
      ? violations
      : output
          .filter((c) => c.exitCode !== 0)
          .flatMap((c) => [c.stderr, c.stdout])
          .map((s) => (s ?? '').trim())
          .filter((s) => s.length > 0)
          .slice(0, 10);

    const summaryParts: string[] = [];
    if (pytest && pytest.exitCode !== 0) summaryParts.push('Pytest failed');
    if (validate && validate.exitCode !== 0) summaryParts.push('Span validator failed');
    if (violations.length > 0) summaryParts.push(`${violations.length} span violation(s)`);

    return {
      passed: false,
      summary: summaryParts.join('; ') || 'Sandbox failed',
      retryContext,
    };
  }

  async getPRMetadata(_issues: Issue[]): Promise<PRMetadata> {
    return { extraLabels: ['openinference', 'agent-test'], extraBodySections: [] };
  }
}
