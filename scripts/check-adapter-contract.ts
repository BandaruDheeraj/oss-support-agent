import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

function extractBlock(src: string, header: string): string {
  const idx = src.indexOf(header);
  if (idx === -1) return '';
  let i = src.indexOf('{', idx);
  if (i === -1) return '';
  let depth = 1;
  let j = i + 1;
  while (j < src.length && depth > 0) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') depth--;
    j++;
  }
  return src.slice(idx, j);
}

function strip(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '');
}

export function computeAdapterInterfaceHash(src: string): string {
  const blocks = [
    extractBlock(src, 'export interface Issue '),
    extractBlock(src, 'export interface ServiceConfig '),
    extractBlock(src, 'export interface SandboxCommandResult '),
    extractBlock(src, 'export interface EvalResult '),
    extractBlock(src, 'export interface PRMetadata '),
    extractBlock(src, 'export interface RepoAdapter '),
  ];

  const aliasMatch = /export\s+type\s+SandboxOutput\s*=\s*[^;]+;/.exec(src);
  if (aliasMatch) blocks.push(aliasMatch[0]);

  const normalized = blocks.map(strip).join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

interface SnapshotFile {
  versions: Record<string, string>;
}

export function checkAdapterContract(projectRoot: string): { ok: true } | { ok: false; message: string } {
  const interfacePath = path.join(projectRoot, 'core', 'adapter.interface.ts');
  const snapshotPath = path.join(projectRoot, 'core', 'adapter.interface.snapshot.json');

  if (!fs.existsSync(interfacePath)) {
    return { ok: false, message: `Missing ${path.relative(projectRoot, interfacePath)}` };
  }
  const src = fs.readFileSync(interfacePath, 'utf8');

  const versionMatch = /export\s+const\s+ADAPTER_INTERFACE_VERSION\s*=\s*(\d+)\s*;/.exec(src);
  if (!versionMatch) {
    return {
      ok: false,
      message: 'Missing ADAPTER_INTERFACE_VERSION constant in core/adapter.interface.ts',
    };
  }
  const version = versionMatch[1];

  if (!fs.existsSync(snapshotPath)) {
    return {
      ok: false,
      message: `Missing ${path.relative(projectRoot, snapshotPath)}; create it with the current contract hash for version ${version}`,
    };
  }

  let snapshot: SnapshotFile;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as SnapshotFile;
  } catch (err: any) {
    return {
      ok: false,
      message: `Failed to parse adapter.interface.snapshot.json: ${err?.message ?? err}`,
    };
  }

  if (!snapshot.versions || typeof snapshot.versions !== 'object') {
    return {
      ok: false,
      message: 'adapter.interface.snapshot.json must have a "versions" object',
    };
  }

  const recordedHash = snapshot.versions[version];
  const currentHash = computeAdapterInterfaceHash(src);

  if (!recordedHash) {
    return {
      ok: false,
      message:
        `ADAPTER_INTERFACE_VERSION=${version} but no matching entry in adapter.interface.snapshot.json. ` +
        `Add: "versions": { "${version}": "${currentHash}" } and update every adapter (or add a default on BaseRepoAdapter).`,
    };
  }

  if (recordedHash !== currentHash) {
    return {
      ok: false,
      message:
        `RepoAdapter contract changed but ADAPTER_INTERFACE_VERSION=${version} was not bumped. ` +
        `Either revert the interface change, or bump ADAPTER_INTERFACE_VERSION and add a new snapshot entry. ` +
        `Expected hash for v${version}: ${recordedHash}; current: ${currentHash}.`,
    };
  }

  return { ok: true };
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const result = checkAdapterContract(projectRoot);
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.error(`Constraint violation (US-113): ${result.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
