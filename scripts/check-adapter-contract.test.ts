import { checkAdapterContract, computeAdapterInterfaceHash } from './check-adapter-contract';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function writeFile(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function makeProject(opts: {
  version: number;
  interfaceExtra?: string;
  snapshotVersions?: Record<string, string>;
  omitSnapshot?: boolean;
  omitVersion?: boolean;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-agent-us113-contract-'));
  const interfaceTs =
    (opts.omitVersion ? '' : `export const ADAPTER_INTERFACE_VERSION = ${opts.version};\n`) +
    `
export interface Issue { number: number; title: string; body: string; labels: string[]; }
export interface ServiceConfig { name: string; image: string; ports: { hostPort: number; containerPort: number }[]; }
export interface SandboxCommandResult { command: string; exitCode: number; stdout: string; stderr: string; }
export type SandboxOutput = SandboxCommandResult[];
export interface EvalResult { passed: boolean; summary: string; retryContext: string[]; }
export interface PRMetadata { extraLabels: string[]; extraBodySections: string[]; }
export interface RepoAdapter {
  classifyModule(issue: Issue): Promise<string>;
  getTestCommands(): Promise<string[]>;
  getSandboxServices(): Promise<ServiceConfig[]>;
  runCustomEval(output: SandboxOutput): Promise<EvalResult>;
  getPRMetadata(issues: Issue[]): Promise<PRMetadata>;
  ${opts.interfaceExtra ?? ''}
}
`;
  writeFile(path.join(root, 'core', 'adapter.interface.ts'), interfaceTs);
  if (!opts.omitSnapshot) {
    const versions = opts.snapshotVersions ?? { [String(opts.version)]: computeAdapterInterfaceHash(interfaceTs) };
    writeFile(
      path.join(root, 'core', 'adapter.interface.snapshot.json'),
      JSON.stringify({ versions }, null, 2)
    );
  }
  return root;
}

describe('check-adapter-contract (US-113)', () => {
  test('passes when interface hash matches snapshot for current version', () => {
    const root = makeProject({ version: 1 });
    try {
      const res = checkAdapterContract(root);
      expect(res.ok).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails when interface changes but version not bumped', () => {
    const root = makeProject({ version: 1 });
    try {
      // Mutate interface to add a new method without bumping version.
      const p = path.join(root, 'core', 'adapter.interface.ts');
      const src = fs.readFileSync(p, 'utf8').replace(
        'getPRMetadata(issues: Issue[]): Promise<PRMetadata>;',
        'getPRMetadata(issues: Issue[]): Promise<PRMetadata>;\n  newMethod(): Promise<void>;'
      );
      fs.writeFileSync(p, src);

      const res = checkAdapterContract(root);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.message).toMatch(/contract changed/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails when ADAPTER_INTERFACE_VERSION is missing', () => {
    const root = makeProject({ version: 1, omitVersion: true });
    try {
      const res = checkAdapterContract(root);
      expect(res.ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails when version has no matching snapshot entry', () => {
    const root = makeProject({
      version: 2,
      snapshotVersions: { '1': 'oldhash' },
    });
    try {
      const res = checkAdapterContract(root);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toMatch(/no matching entry/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
