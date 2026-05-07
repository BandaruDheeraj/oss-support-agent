import {
  BaseRepoAdapter,
  type RepoAdapter,
  type SandboxOutput,
  type ServiceConfig,
} from '../core/adapter.interface';

test('SandboxOutput round-trips through JSON', () => {
  const output: SandboxOutput = [
    {
      command: 'npm test',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    },
    {
      command: 'python -m pytest',
      exitCode: 1,
      stdout: '',
      stderr: 'failed',
    },
  ];

  const json = JSON.stringify(output);
  const parsed = JSON.parse(json) as SandboxOutput;

  expect(parsed).toEqual(output);
});

test('ServiceConfig round-trips through JSON', () => {
  const svc: ServiceConfig = {
    name: 'db',
    image: 'postgres:16',
    ports: [{ hostPort: 5432, containerPort: 5432 }],
    env: { POSTGRES_PASSWORD: 'pw' },
    healthCheckUrl: 'http://localhost:5432/health',
  };

  const json = JSON.stringify(svc);
  const parsed = JSON.parse(json) as ServiceConfig;

  expect(parsed).toEqual(svc);
});

test('minimal adapter implementation compiles against RepoAdapter', () => {
  class MinimalAdapter extends BaseRepoAdapter {}

  // Compile-time check: if the contract changes, this assignment should fail.
  const adapter: RepoAdapter = new MinimalAdapter();

  expect(adapter).toBeInstanceOf(MinimalAdapter);
});

test('BaseRepoAdapter default eval is exit-code based', async () => {
  const adapter = new BaseRepoAdapter();

  const pass = await adapter.runCustomEval([
    { command: 'a', exitCode: 0, stdout: '', stderr: '' },
    { command: 'b', exitCode: 0, stdout: '', stderr: '' },
  ]);
  expect(pass.passed).toBe(true);

  const fail = await adapter.runCustomEval([
    { command: 'a', exitCode: 0, stdout: '', stderr: '' },
    { command: 'b', exitCode: 2, stdout: 'nope', stderr: '' },
  ]);
  expect(fail.passed).toBe(false);
  expect(fail.summary).toContain('b');
});
