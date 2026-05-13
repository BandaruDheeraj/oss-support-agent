/**
 * v2 adapter index. Sandbox factory selects backend via OSA_SANDBOX_DRIVER:
 *   - "local"      → local subprocess driver (default; fast, dev/CI)
 *   - "gh-actions" → GitHub Actions workflow_dispatch (production)
 */

export { createWorkspaceFsAdapter } from './workspace-fs';
export type { WorkspaceFsAdapterOptions } from './workspace-fs';
export { createIssueHandle, createRepoHandle } from './issue-repo';
export { createLocalSandboxAdapter } from './sandbox-local';
export type { LocalSandboxAdapterOptions } from './sandbox-local';
export { createGhActionsSandboxAdapter } from './sandbox-gh-actions';
export type { GhActionsSandboxAdapterOptions } from './sandbox-gh-actions';

import type { SandboxHandle } from '../tools/handles';
import type { LocalWorkspace } from '../../../bin/clients/local-workspace';
import type { GhActionsSandboxAdapterOptions } from './sandbox-gh-actions';
import type { LocalSandboxAdapterOptions } from './sandbox-local';
import { createLocalSandboxAdapter } from './sandbox-local';
import { createGhActionsSandboxAdapter } from './sandbox-gh-actions';

export type SandboxDriver = 'local' | 'gh-actions';

export function selectSandboxDriver(envVar?: string): SandboxDriver {
  const v = (envVar ?? process.env.OSA_SANDBOX_DRIVER ?? 'local').toLowerCase();
  return v === 'gh-actions' ? 'gh-actions' : 'local';
}

export function createSandboxAdapter(args: {
  driver?: SandboxDriver;
  workspace: LocalWorkspace;
  localOptions?: LocalSandboxAdapterOptions;
  ghActionsOptions?: GhActionsSandboxAdapterOptions;
}): SandboxHandle {
  const driver = args.driver ?? selectSandboxDriver();
  if (driver === 'gh-actions') {
    if (!args.ghActionsOptions) {
      throw new Error('createSandboxAdapter: gh-actions driver selected but ghActionsOptions missing');
    }
    return createGhActionsSandboxAdapter(args.ghActionsOptions);
  }
  return createLocalSandboxAdapter(args.workspace, args.localOptions);
}
