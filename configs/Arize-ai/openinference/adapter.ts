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

export default class OpenInferenceAdapter extends BaseRepoAdapter {
  async classifyModule(issue: Issue): Promise<string> {
    const text = normalizeText(`${issue.title}\n${issue.body}\n${issue.labels.join(' ')}`);

    // Route explicit instrumentation packages first.
    const m = /openinference-instrumentation-([a-z0-9_-]+)/i.exec(text);
    if (m) {
      return `python/instrumentation/openinference-instrumentation-${m[1].toLowerCase()}`;
    }

    if (text.includes('instrumentation')) {
      return 'python/instrumentation';
    }

    if (text.includes('semantic') && text.includes('convention')) {
      return 'python/openinference-semantic-conventions';
    }

    if (text.includes('javascript') || text.includes('typescript') || text.includes('npm') || text.includes('js/packages') || text.includes('packages/')) {
      return 'js/packages';
    }

    return '.';
  }

  async getTestCommands(): Promise<string[]> {
    return [
      'python -m pytest -q',
      'npm test',
      'python scripts/validate_spans.py --phoenix-url http://localhost:6006/',
    ];
  }

  async getSandboxServices(): Promise<ServiceConfig[]> {
    return [
      {
        name: 'phoenix',
        image: 'arizephoenix/phoenix:latest',
        ports: [{ hostPort: 6006, containerPort: 6006 }],
        healthCheckUrl: 'http://localhost:6006/',
      },
    ];
  }

  async runCustomEval(output: SandboxOutput): Promise<EvalResult> {
    const pytest = output.find((c) => c.command.includes('pytest'));
    const validate = output.find((c) => c.command.includes('validate_spans.py'));

    const violations = validate ? extractViolations(validate.stdout) : [];

    const pytestOk = !pytest || pytest.exitCode === 0;
    const validateOk = !!validate && validate.exitCode === 0 && violations.length === 0;

    if (pytestOk && validateOk) {
      return {
        passed: true,
        summary: 'Pytest passed and no OpenInference span violations detected',
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
    if (!validate) summaryParts.push('Span validator command missing');
    if (validate && validate.exitCode !== 0) summaryParts.push('Span validator failed');
    if (violations.length > 0) summaryParts.push(`${violations.length} span violation(s)`);

    return {
      passed: false,
      summary: summaryParts.join('; ') || 'Sandbox failed',
      retryContext,
    };
  }

  async getPRMetadata(_issues: Issue[]): Promise<PRMetadata> {
    return { extraLabels: ['openinference'], extraBodySections: [] };
  }
}
