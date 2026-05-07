/**
 * Introspection agent.
 *
 * - US-104: repo signal gathering
 * - US-105: draft adapter generator via OpenRouter
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

import type {
  RepoCloner,
  RepoSignals,
  DraftAdapter,
  CiWorkflowSignal,
  PackageManifestSignal,
  PackageManifestKind,
  LanguageStack,
  MakefileTargetSignal,
  ContributingDocSignal,
  ComposeServicesSignal,
} from './introspection-types';

import { LLMClient, type LLMUsage, type LLMMessage } from '../llm/client';
import type { LLMClientLike } from '../llm/test-utils';

function execFileAsync(file: string, args: string[], options: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: options.cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Command failed: ${file} ${args.join(' ')}\n${stderr || stdout || err.message}`));
        return;
      }
      resolve();
    });
  });
}

class GitRepoCloner implements RepoCloner {
  async clone(repoFullName: string, destDir: string): Promise<void> {
    const src = resolveCloneSource(repoFullName);
    await execFileAsync('git', ['clone', '--depth', '1', src, destDir]);
  }
}

function resolveCloneSource(repoFullName: string): string {
  // Allow tests/operators to pass an explicit clone URL or local path.
  if (repoFullName.includes('://') || repoFullName.endsWith('.git') || path.isAbsolute(repoFullName)) {
    return repoFullName;
  }
  return `https://github.com/${repoFullName}.git`;
}

function toPosixRelativePath(baseDir: string, absoluteFilePath: string): string {
  const rel = path.relative(baseDir, absoluteFilePath);
  return rel.split(path.sep).join('/');
}

async function safeReadText(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

async function safeExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkFindFiles(
  rootDir: string,
  fileNames: Set<string>,
  options: { maxDepth: number; ignoreDirs: Set<string> },
  depth = 0
): Promise<string[]> {
  if (depth > options.maxDepth) return [];

  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const ent of entries) {
    const abs = path.join(rootDir, ent.name);

    if (ent.isDirectory()) {
      if (options.ignoreDirs.has(ent.name)) continue;
      out.push(...(await walkFindFiles(abs, fileNames, options, depth + 1)));
      continue;
    }

    if (ent.isFile() && fileNames.has(ent.name)) {
      out.push(abs);
    }
  }

  return out;
}

function extractYamlRunBlocks(yamlText: string): string[] {
  const lines = yamlText.split(/\r?\n/);
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(\s*)run:\s*(.*)\s*$/.exec(line);
    if (!m) continue;

    const indent = m[1].length;
    const rest = m[2];

    if (rest === '|' || rest === '>' || rest === '') {
      const blockLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        const leading = /^\s*/.exec(l)?.[0].length ?? 0;
        if (l.trim() === '') {
          blockLines.push('');
          continue;
        }
        if (leading <= indent) break;
        // Strip indentation up to indent+2 (typical YAML child indent), but be defensive.
        const strip = Math.min(leading, indent + 2);
        blockLines.push(l.slice(strip));
        i = j;
      }
      const block = blockLines.join('\n').trim();
      if (block) out.push(block);
      continue;
    }

    const inline = rest.trim();
    if (inline) out.push(inline);
  }

  return out;
}

function extractMarkdownCodeBlocks(md: string): string[] {
  const blocks: string[] = [];
  const re = /```[^\n]*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const body = m[1].trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

function extractComposeServiceNames(yamlText: string): string[] {
  const lines = yamlText.split(/\r?\n/);
  let inServices = false;
  let servicesIndent = 0;
  const services: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inServices) {
      const m = /^(\s*)services:\s*$/.exec(line);
      if (m) {
        inServices = true;
        servicesIndent = m[1].length;
      }
      continue;
    }

    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const leading = /^\s*/.exec(line)?.[0].length ?? 0;
    if (leading <= servicesIndent) break;

    // Typical YAML: services:
    //   myservice:
    if (leading === servicesIndent + 2) {
      const m = /^\s*([A-Za-z0-9_.-]+):\s*$/.exec(line);
      if (m) services.push(m[1]);
    }
  }

  return services;
}

function inferStackFromManifest(kind: PackageManifestKind): LanguageStack {
  switch (kind) {
    case 'package.json':
      return 'node';
    case 'pyproject.toml':
    case 'setup.py':
      return 'python';
    case 'Cargo.toml':
      return 'rust';
    case 'go.mod':
      return 'go';
    case 'pom.xml':
      return 'java-maven';
    case 'build.gradle':
    case 'build.gradle.kts':
      return 'java-gradle';
    default:
      return 'unknown';
  }
}

function inferTestHint(kind: PackageManifestKind, content: string): string {
  switch (kind) {
    case 'package.json': {
      try {
        const json = JSON.parse(content || '{}');
        const pkgMgr = typeof json.packageManager === 'string' ? json.packageManager : '';
        const usesPnpm = pkgMgr.toLowerCase().startsWith('pnpm@');
        const usesYarn = pkgMgr.toLowerCase().startsWith('yarn@');
        const runner = usesPnpm ? 'pnpm' : usesYarn ? 'yarn' : 'npm';
        const script = json?.scripts?.test;
        if (typeof script === 'string' && script.trim()) {
          return `${runner} test (script: ${script.trim()})`;
        }
        return `${runner} test`;
      } catch {
        return 'npm test';
      }
    }
    case 'pyproject.toml':
    case 'setup.py': {
      const lower = content.toLowerCase();
      if (lower.includes('pytest')) return 'pytest';
      if (lower.includes('tox')) return 'tox';
      return 'python -m pytest';
    }
    case 'Cargo.toml':
      return 'cargo test';
    case 'go.mod':
      return 'go test ./...';
    case 'pom.xml':
      return 'mvn test';
    case 'build.gradle':
    case 'build.gradle.kts':
      return './gradlew test';
    default:
      return '';
  }
}

function parseMakeLikeTargets(text: string): string[] {
  const targets: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = /^([A-Za-z0-9_.-]+)\s*:(?:\s|$)/.exec(line);
    if (!m) continue;
    const target = m[1];
    if (target.includes('%')) continue;
    if (/(^|[-_.])(test|check|verify)($|[-_.])/i.test(target) || /^(test|check|verify)$/i.test(target)) {
      targets.push(target);
    }
  }
  return Array.from(new Set(targets));
}

export interface GatherRepoSignalsOptions {
  cloner?: RepoCloner;
  /** Override for tests. Defaults to os.tmpdir(). */
  tmpRoot?: string;
  /** How deep to scan for package manifests. Defaults to 4. */
  maxDepth?: number;
}

/**
 * Shallow-clone a repo and extract signals needed for adapter generation.
 */
export async function gatherRepoSignals(repoFullName: string, options: GatherRepoSignalsOptions = {}): Promise<RepoSignals> {
  const cloner = options.cloner ?? new GitRepoCloner();
  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  const maxDepth = options.maxDepth ?? 4;

  const tempDir = await fs.promises.mkdtemp(path.join(tmpRoot, 'oss-agent-introspect-'));
  const repoDir = path.join(tempDir, 'repo');

  try {
    await cloner.clone(repoFullName, repoDir);

    // --- CI Workflows ---
    const workflowDir = path.join(repoDir, '.github', 'workflows');
    const ciWorkflows: CiWorkflowSignal[] = [];

    try {
      const wfEntries = await fs.promises.readdir(workflowDir, { withFileTypes: true });
      for (const ent of wfEntries) {
        if (!ent.isFile()) continue;
        if (!ent.name.endsWith('.yml') && !ent.name.endsWith('.yaml')) continue;
        const abs = path.join(workflowDir, ent.name);
        const text = await safeReadText(abs);
        const commands = extractYamlRunBlocks(text);
        ciWorkflows.push({ path: toPosixRelativePath(repoDir, abs), commands });
      }
    } catch {
      // missing workflows directory is fine
    }

    // --- Package manifests (including monorepo detection) ---
    const manifestNames = new Set<string>([
      'package.json',
      'pyproject.toml',
      'setup.py',
      'Cargo.toml',
      'go.mod',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
    ]);

    const ignoreDirs = new Set<string>(['.git', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__']);
    const manifestFiles = await walkFindFiles(repoDir, manifestNames, { maxDepth, ignoreDirs });

    const packageManifests: PackageManifestSignal[] = [];
    const monorepoLayout: Record<string, LanguageStack[]> = {};

    for (const abs of manifestFiles) {
      const kind = path.basename(abs) as PackageManifestKind;
      const content = await safeReadText(abs);
      const stack = inferStackFromManifest(kind);
      const testHint = inferTestHint(kind, content);
      const rel = toPosixRelativePath(repoDir, abs);

      packageManifests.push({ path: rel, kind, stack, testHint });

      const dir = path.posix.dirname(rel);
      if (dir !== '.') {
        monorepoLayout[dir] = monorepoLayout[dir] ?? [];
        if (!monorepoLayout[dir].includes(stack)) monorepoLayout[dir].push(stack);
      }
    }

    // --- Makefile / justfile targets ---
    const makefileTargets: MakefileTargetSignal[] = [];
    for (const fileName of ['Makefile', 'justfile']) {
      const abs = path.join(repoDir, fileName);
      if (!(await safeExists(abs))) continue;

      const text = await safeReadText(abs);
      const targets = parseMakeLikeTargets(text);
      for (const target of targets) {
        makefileTargets.push({ path: toPosixRelativePath(repoDir, abs), target });
      }
    }

    // --- CONTRIBUTING / DEVELOPMENT docs ---
    const contributingDocs: ContributingDocSignal[] = [];
    for (const fileName of ['CONTRIBUTING.md', 'DEVELOPMENT.md']) {
      const abs = path.join(repoDir, fileName);
      if (!(await safeExists(abs))) continue;
      const md = await safeReadText(abs);
      contributingDocs.push({ path: toPosixRelativePath(repoDir, abs), codeBlocks: extractMarkdownCodeBlocks(md) });
    }

    // --- docker-compose / compose services ---
    const composeServices: ComposeServicesSignal[] = [];
    for (const fileName of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml']) {
      const abs = path.join(repoDir, fileName);
      if (!(await safeExists(abs))) continue;
      const yaml = await safeReadText(abs);
      composeServices.push({
        path: toPosixRelativePath(repoDir, abs),
        services: extractComposeServiceNames(yaml),
      });
    }

    // README fallback only when no other test signals exist.
    const hasAnyTestSignals =
      ciWorkflows.some((wf) => wf.commands.length > 0) || makefileTargets.length > 0 || packageManifests.length > 0;

    const readmePath = path.join(repoDir, 'README.md');
    const readme = !hasAnyTestSignals && (await safeExists(readmePath)) ? await safeReadText(readmePath) : '';

    return {
      repoFullName,
      ciWorkflows,
      packageManifests,
      makefileTargets,
      contributingDocs,
      composeServices,
      readme,
      monorepoLayout,
    };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

export interface GenerateDraftAdapterOptions {
  llmClient?: LLMClientLike;
  /** Optional override for reading the adapter contract source. */
  adapterInterfacePath?: string;
  /** Optional hook to forward token usage into cost guardrails. */
  onUsage?: (usage: LLMUsage) => void;
  /** Override for tests. Defaults to os.tmpdir(). */
  tmpRoot?: string;
}

export class AdapterDraftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterDraftValidationError';
  }
}

const DRAFT_ADAPTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['adapterTs', 'manifestYaml', 'rationale', 'openItems'],
  properties: {
    adapterTs: { type: 'string', minLength: 1 },
    manifestYaml: { type: 'string', minLength: 1 },
    rationale: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    openItems: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} as const;

function toPascalCase(input: string): string {
  return input
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}

function parseRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const parts = repoFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AdapterDraftValidationError(`Invalid repoFullName (expected owner/repo): ${repoFullName}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function findDefaultClassExport(adapterTs: string): { className: string } {
  const m = /\bexport\s+default\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(adapterTs);
  if (!m) {
    throw new AdapterDraftValidationError('Generated adapter.ts must contain `export default class <Name>`');
  }
  return { className: m[1] };
}

async function compileAdapterWithTsc(
  owner: string,
  repo: string,
  adapterTs: string,
  adapterInterfaceSource: string,
  tmpRoot: string
): Promise<void> {
  const tempDir = await fs.promises.mkdtemp(path.join(tmpRoot, 'oss-agent-adapter-compile-'));
  try {
    const coreDir = path.join(tempDir, 'core');
    const adapterDir = path.join(tempDir, 'configs', owner, repo);
    await fs.promises.mkdir(coreDir, { recursive: true });
    await fs.promises.mkdir(adapterDir, { recursive: true });

    await fs.promises.writeFile(path.join(coreDir, 'adapter.interface.ts'), adapterInterfaceSource, 'utf-8');
    await fs.promises.writeFile(path.join(adapterDir, 'adapter.ts'), adapterTs, 'utf-8');

    const tsconfig = {
      compilerOptions: {
        target: 'ES2020',
        module: 'CommonJS',
        moduleResolution: 'Node',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        rootDir: '.',
        types: [],
      },
      include: ['core/**/*.ts', 'configs/**/*.ts'],
    };

    const tsconfigPath = path.join(tempDir, 'tsconfig.json');
    await fs.promises.writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf-8');

    const tscJs = path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
    if (!(await safeExists(tscJs))) {
      throw new AdapterDraftValidationError('TypeScript compiler not found at node_modules/typescript/bin/tsc. Run `npm install`.');
    }

    await execFileAsync(process.execPath, [tscJs, '--noEmit', '--pretty', 'false', '-p', tsconfigPath], { cwd: tempDir });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Generate a per-repo adapter draft and manifest using gathered repo signals.
 */
export async function generateDraftAdapter(
  signals: RepoSignals,
  repoFullName: string,
  options: GenerateDraftAdapterOptions = {}
): Promise<DraftAdapter> {
  const { owner, repo } = parseRepoFullName(repoFullName);

  const adapterInterfacePath =
    options.adapterInterfacePath ?? path.join(process.cwd(), 'core', 'adapter.interface.ts');
  const adapterInterfaceSource = await fs.promises.readFile(adapterInterfacePath, 'utf-8');

  const desiredClassName = `${toPascalCase(repo)}Adapter`;
  const adapterImportPath = '../../../core/adapter.interface';

  const prompt =
    `You are generating a per-repo adapter for an OSS agent harness.\n\n` +
    `The adapter will live at: configs/${owner}/${repo}/adapter.ts\n` +
    `It MUST import the contract from: ${adapterImportPath}\n` +
    `It MUST export a default class named: ${desiredClassName}\n\n` +
    `Requirements:\n` +
    `- Implement all five RepoAdapter interface methods.\n` +
    `- Prefer CI workflow step commands for getTestCommands().\n` +
    `- Prefer docker-compose services for getSandboxServices().\n` +
    `- classifyModule(issue) should route to a reasonable module directory based on repo layout + keywords.\n` +
    `- runCustomEval(output) should check exit codes and, when configured by test commands, also consider coverage output.\n` +
    `- getPRMetadata should return repo-specific labels/body sections when appropriate.\n\n` +
    `Return ONLY JSON with keys: adapterTs, manifestYaml, rationale, openItems.\n\n` +
    `--- BEGIN core/adapter.interface.ts ---\n${adapterInterfaceSource}\n--- END core/adapter.interface.ts ---\n\n` +
    `--- BEGIN repo signals (JSON) ---\n${JSON.stringify(signals, null, 2)}\n--- END repo signals ---\n`;

  const messages: LLMMessage[] = [{ role: 'user', content: prompt }];

  const client = options.llmClient ?? new LLMClient();
  const { data } = await client.chatJson<DraftAdapter>(messages, DRAFT_ADAPTER_SCHEMA, {
    agent: 'INTROSPECTION',
    temperature: 0,
    onUsage: options.onUsage,
  });

  // Validate the adapter export shape before it ever reaches email review.
  findDefaultClassExport(data.adapterTs);

  // Verify it compiles against the contract.
  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  await compileAdapterWithTsc(owner, repo, data.adapterTs, adapterInterfaceSource, tmpRoot);

  return data;
}
