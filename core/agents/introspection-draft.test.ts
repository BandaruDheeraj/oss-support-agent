/**
 * Unit tests for US-105 draft adapter generator.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ChatClient } from '../llm/v2/chat-client';
import { MockLLMClient } from '../llm/test-utils';
import { generateDraftAdapter } from './introspection';
import type { RepoSignals } from './introspection-types';

function baseSignals(): RepoSignals {
  return {
    repoFullName: 'acme/demo',
    ciWorkflows: [
      { path: '.github/workflows/ci.yml', commands: ['npm ci', 'npm test'] },
    ],
    packageManifests: [
      { path: 'package.json', kind: 'package.json', stack: 'node', testHint: 'npm test' },
    ],
    makefileTargets: [],
    contributingDocs: [],
    composeServices: [],
    readme: '',
    monorepoLayout: {},
  };
}

function validAdapterTs(): string {
  return `import { BaseRepoAdapter, type Issue, type SandboxOutput, type EvalResult, type PRMetadata, type ServiceConfig } from '../../../core/adapter.interface';

export default class DemoAdapter extends BaseRepoAdapter {
  async classifyModule(_issue: Issue): Promise<string> {
    return '.';
  }

  async getTestCommands(): Promise<string[]> {
    return ['npm test'];
  }

  async getSandboxServices(): Promise<ServiceConfig[]> {
    return [];
  }

  async runCustomEval(output: SandboxOutput): Promise<EvalResult> {
    return super.runCustomEval(output);
  }

  async getPRMetadata(_issues: Issue[]): Promise<PRMetadata> {
    return { extraLabels: ['demo'], extraBodySections: [] };
  }
}
`;
}

describe('generateDraftAdapter (US-105)', () => {
  test('calls chatJson with INTROSPECTION agent, temperature=0, and includes contract + signals in prompt', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oss-agent-us105-'));
    const contractPath = path.join(tmp, 'adapter.interface.ts');

    const mockContract = `/* CONTRACT_MARKER */
export interface Issue { title?: string; body?: string | null; labels?: string[]; number?: number; }
export interface ServiceConfig { name: string; image: string; ports: number[]; env?: Record<string, string>; healthCheckUrl?: string; }
export interface SandboxCommandResult { command: string; exitCode: number; stdout: string; stderr: string; durationSeconds: number; }
export interface SandboxOutput { commands: SandboxCommandResult[]; services: ServiceConfig[]; }
export interface EvalResult { passed: boolean; retryContext?: Record<string, any>; }
export interface PRMetadata { extraLabels: string[]; extraBodySections: string[]; }
export interface RepoAdapter {
  classifyModule(issue: Issue): Promise<string>;
  getTestCommands(): Promise<string[]>;
  getSandboxServices(): Promise<ServiceConfig[]>;
  runCustomEval(output: SandboxOutput): Promise<EvalResult>;
  getPRMetadata(issues: Issue[]): Promise<PRMetadata>;
}
export class BaseRepoAdapter implements RepoAdapter {
  async classifyModule(_issue: Issue): Promise<string> { return '.'; }
  async getTestCommands(): Promise<string[]> { return []; }
  async getSandboxServices(): Promise<ServiceConfig[]> { return []; }
  async runCustomEval(_output: SandboxOutput): Promise<EvalResult> { return { passed: true, retryContext: {} }; }
  async getPRMetadata(_issues: Issue[]): Promise<PRMetadata> { return { extraLabels: [], extraBodySections: [] }; }
}
`;

    await fs.promises.writeFile(contractPath, mockContract, 'utf-8');

    let captured: any = null;

    const llm = new MockLLMClient({
      chatJson: async <T>(messages: any, _schema: any, options: any) => {
        captured = { messages, options };
        return {
          data: {
            adapterTs: validAdapterTs(),
            manifestYaml: 'repo: acme/demo\nfork_org: TODO\npm_email: TODO\n',
            rationale: { test: 'ci' },
            openItems: [],
          } as any as T,
          usage: null,
          raw: null,
        };
      },
    });

    const signals = baseSignals();
    await generateDraftAdapter(signals, 'acme/demo', {
      llmClient: llm,
      adapterInterfacePath: contractPath,
    });

    expect(captured.options.agent).toBe('INTROSPECTION');
    expect(captured.options.temperature).toBe(0);
    expect(captured.messages[0].content).toContain('CONTRACT_MARKER');
    expect(captured.messages[0].content).toContain('repo signals');
    expect(captured.messages[0].content).toContain('npm test');
  });

  test('compiles a valid generated adapter.ts against the contract', async () => {
    const llm = new MockLLMClient({
      chatJson: async <T>() => ({
        data: {
          adapterTs: validAdapterTs(),
          manifestYaml: 'repo: acme/demo\nfork_org: TODO\npm_email: TODO\n',
          rationale: {},
          openItems: [],
        } as any as T,
        usage: null,
        raw: null,
      }),
    });

    await expect(generateDraftAdapter(baseSignals(), 'acme/demo', { llmClient: llm })).resolves.toBeTruthy();
  });

  test('rejects when generated adapter.ts lacks a default class export', async () => {
    const bad = `export class NotDefault {}`;

    const llm = new MockLLMClient({
      chatJson: async <T>() => ({
        data: {
          adapterTs: bad,
          manifestYaml: 'repo: acme/demo\nfork_org: TODO\npm_email: TODO\n',
          rationale: {},
          openItems: [],
        } as any as T,
        usage: null,
        raw: null,
      }),
    });

    await expect(generateDraftAdapter(baseSignals(), 'acme/demo', { llmClient: llm })).rejects.toThrow(
      /export default class/i
    );
  });

  test('retries malformed JSON via ChatClient.chatJson parse retries', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oss-agent-us105-llm-'));

    let call = 0;
    const client = new ChatClient();
    jest.spyOn(client, 'chat').mockImplementation(async () => {
      call++;
      const content =
        call === 1
          ? 'not json'
          : JSON.stringify({
              adapterTs: validAdapterTs(),
              manifestYaml: 'repo: acme/demo\nfork_org: TODO\npm_email: TODO\n',
              rationale: {},
              openItems: [],
            });
      return { content, usage: null, raw: null };
    });

    await expect(
      generateDraftAdapter(baseSignals(), 'acme/demo', { llmClient: client, tmpRoot })
    ).resolves.toBeTruthy();

    expect(call).toBeGreaterThanOrEqual(2);
  });

  test('fails when adapter.ts does not compile against the contract (interface mismatch)', async () => {
    const missingMethod = `import { BaseRepoAdapter, type DoesNotExist } from '../../../core/adapter.interface';

export default class DemoAdapter extends BaseRepoAdapter {
  // Force a compile-time failure if the contract changes unexpectedly.
  private _x!: DoesNotExist;
}
`;

    const llm = new MockLLMClient({
      chatJson: async <T>() => ({
        data: {
          adapterTs: missingMethod,
          manifestYaml: 'repo: acme/demo\nfork_org: TODO\npm_email: TODO\n',
          rationale: {},
          openItems: [],
        } as any as T,
        usage: null,
        raw: null,
      }),
    });

    await expect(generateDraftAdapter(baseSignals(), 'acme/demo', { llmClient: llm })).rejects.toThrow(/TS\d+|compile/i);
  });
});
