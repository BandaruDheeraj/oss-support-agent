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
    // Real-but-cheap signal for an openinference fork. The local sandbox
    // (bin/clients/local-sandbox.ts) executes these on the agent's runner
    // (e.g. Render) inside the fork's single-branch shallow clone — NOT in
    // GHA — so we can only rely on tools that ship with that container.
    // The Render runner has python + git but no uv/uvx/ruff.
    //
    // Strategy: run `python -m py_compile` only on the Python files the
    // agent changed vs origin/main. This:
    //   - catches real syntax errors the LLM introduces (the most common
    //     destructive failure mode for whole-file LLM rewrites),
    //   - has a stable baseline (we only check files the agent touched, so
    //     pre-existing upstream-main issues never trip the gate),
    //   - runs in <5s on a stock container with no extra installs,
    //   - exits 0 when the agent touched no Python files (e.g. yaml-only
    //     edits) instead of false-failing.
    //
    // The single-branch clone doesn't have origin/main locally, so we
    // shallow-fetch it first. `set -e` ensures any failure (fetch, diff,
    // or compile) propagates as a non-zero exit.
    const pyCompileChanged = [
      'set -e',
      'git fetch --depth=50 origin main >/dev/null 2>&1',
      "files=$(git diff --name-only origin/main...HEAD -- '*.py' || true)",
      'if [ -z "$files" ]; then echo "no python files changed vs origin/main; skipping py_compile"; exit 0; fi',
      'echo "checking $(echo \"$files\" | wc -l) python file(s):"',
      'echo "$files"',
      'echo "$files" | xargs python -m py_compile',
    ].join(' && ');
    return [pyCompileChanged];
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

  /**
   * Adapter-owned (NOT LLM-authored) setup for the repro stage. Keep this
   * tight: only deps the repro file actually imports. The repro uses
   * sys.path tricks to import smolagents from the package's src/ without
   * pip-installing the package itself, but it still needs the otel API.
   */
  async getReproSetupCommands(): Promise<string[]> {
    return ['pip install --quiet opentelemetry-api opentelemetry-sdk wrapt'];
  }
}
