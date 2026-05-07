/**
 * Introspection agent (US-104: repo signal gathering).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

import type {
  RepoCloner,
  RepoSignals,
  CiWorkflowSignal,
  PackageManifestSignal,
  PackageManifestKind,
  LanguageStack,
  MakefileTargetSignal,
  ContributingDocSignal,
  ComposeServicesSignal,
} from './introspection-types';

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
