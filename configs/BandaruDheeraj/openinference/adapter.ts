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
    // Real-but-cheap signal for an openinference fork. Openinference is a
    // multi-language monorepo (python/ js/ java/) and the fix agent typically
    // edits a single instrumentation module, so running the full upstream
    // suite is both overkill and prohibitively slow for the GHA free tier.
    //
    // We pick lightweight checks that:
    //   - actually exercise the code on the fork branch (not just `echo ok`),
    //   - pass cleanly against upstream main so the regression-guard diff has
    //     a stable baseline,
    //   - complete in <60s on a stock ubuntu-latest runner without any
    //     dependency installs beyond what's already preinstalled.
    //
    // py_compile catches syntax errors anywhere under python/; ruff (fetched
    // via uvx, which is preinstalled on ubuntu-latest) catches the style and
    // common-bug rules the project already enforces in its Makefile.
    return [
      'python -m compileall -q python',
      'uvx ruff@0.9.2 check python --output-format=concise',
    ];
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
