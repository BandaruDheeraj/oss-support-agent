/**
 * Heuristic introspection for the usability agent.
 *
 * Derives `installCommand` and `entryPoints` for the usability workflow from
 * the local workspace clone. Best-effort; falls back to sensible defaults when
 * the project layout is unfamiliar.
 */

import type { LocalWorkspace } from './local-workspace';

export interface UsabilityIntrospection {
  installCommand: string;
  entryPoints: string[];
}

export function inferUsabilityIntrospection(
  workspace: LocalWorkspace,
  affectedModule: string
): UsabilityIntrospection {
  const installCommand = inferInstallCommand(workspace);
  const entryPoints = inferEntryPoints(workspace, affectedModule);
  return { installCommand, entryPoints };
}

function inferInstallCommand(workspace: LocalWorkspace): string {
  if (workspace.fileExists('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
  if (workspace.fileExists('yarn.lock')) return 'yarn install --frozen-lockfile';
  if (workspace.fileExists('package-lock.json')) return 'npm ci';
  if (workspace.fileExists('package.json')) return 'npm install';
  if (workspace.fileExists('pyproject.toml')) return 'pip install -e .';
  if (workspace.fileExists('setup.py')) return 'pip install -e .';
  if (workspace.fileExists('requirements.txt')) return 'pip install -r requirements.txt';
  if (workspace.fileExists('go.mod')) return 'go mod download';
  if (workspace.fileExists('Cargo.toml')) return 'cargo build';
  return 'true';
}

function inferEntryPoints(workspace: LocalWorkspace, affectedModule: string): string[] {
  const entries: string[] = [];

  if (workspace.fileExists('package.json')) {
    try {
      const pkg = JSON.parse(workspace.readFile('package.json')) as {
        name?: string;
        main?: string;
        module?: string;
        exports?: Record<string, unknown> | string;
      };
      if (typeof pkg.name === 'string' && pkg.name.length > 0) {
        entries.push(pkg.name);
      }
    } catch {
      // Ignore malformed package.json
    }
  }

  if (workspace.fileExists('pyproject.toml')) {
    try {
      const content = workspace.readFile('pyproject.toml');
      const m = content.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (m && m[1]) entries.push(m[1].replace(/-/g, '_'));
    } catch {
      // Ignore malformed pyproject.toml
    }
  }

  if (affectedModule && affectedModule !== '.' && !entries.includes(affectedModule)) {
    entries.push(affectedModule);
  }

  return entries;
}
