import OpenInferenceAdapter from './adapter';
import type { SandboxOutput } from '../../../core/adapter.interface';

describe('OpenInferenceAdapter (US-111)', () => {
  test('passes when pytest succeeds and validate_spans has no violations', async () => {
    const adapter = new OpenInferenceAdapter();
    const output: SandboxOutput = [
      { command: 'python -m pytest -q', exitCode: 0, stdout: 'ok', stderr: '' },
      { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '' },
      { command: 'python scripts/validate_spans.py --arize-url https://otlp.arize.com/v1/traces', exitCode: 0, stdout: '', stderr: '' },
    ];

    const res = await adapter.runCustomEval(output);
    expect(res.passed).toBe(true);
    expect(res.retryContext).toEqual([]);
  });

  test('fails when validate_spans emits violations', async () => {
    const adapter = new OpenInferenceAdapter();
    const output: SandboxOutput = [
      { command: 'python -m pytest -q', exitCode: 0, stdout: 'ok', stderr: '' },
      { command: 'python scripts/validate_spans.py --arize-url https://otlp.arize.com/v1/traces', exitCode: 1, stdout: 'VIOLATION: bad span\nVIOLATION: missing attribute\n', stderr: '' },
    ];

    const res = await adapter.runCustomEval(output);
    expect(res.passed).toBe(false);
    expect(res.retryContext).toEqual(['bad span', 'missing attribute']);
  });

  test('classifyModule routes to instrumentation submodule when package mentioned', async () => {
    const adapter = new OpenInferenceAdapter();
    const modulePath = await adapter.classifyModule({
      number: 1,
      title: 'Bug in openinference-instrumentation-openai',
      body: 'Stack trace mentions openinference-instrumentation-openai',
      labels: [],
    });

    expect(modulePath).toBe('python/instrumentation/openinference-instrumentation-openai');
  });
});
