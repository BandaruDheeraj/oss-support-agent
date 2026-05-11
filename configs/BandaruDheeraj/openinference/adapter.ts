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
    // E2E test stub: always-pass commands so we can verify the full pipeline
    // (fix → sandbox → eval → PR). Real test infra isn't available in the
    // ephemeral sandbox clone for this fork.
    return ['echo "sandbox ok"'];
  }

  async getSandboxServices(): Promise<ServiceConfig[]> {
    return [];
  }

  async runCustomEval(output: SandboxOutput): Promise<EvalResult> {
    const allOk = output.every((c) => c.exitCode === 0);
    return {
      passed: allOk,
      summary: allOk ? 'E2E stub eval passed' : 'A sandbox command failed',
      retryContext: allOk ? [] : output.filter((c) => c.exitCode !== 0).map((c) => `${c.command}: ${c.stderr || c.stdout}`),
    };
  }

  async getPRMetadata(_issues: Issue[]): Promise<PRMetadata> {
    return { extraLabels: ['openinference', 'agent-test'], extraBodySections: [] };
  }
}
