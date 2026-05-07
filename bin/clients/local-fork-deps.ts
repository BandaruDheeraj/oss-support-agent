/**
 * Local-workspace-backed implementations of the fix agent's RepoFileReader and ForkCommitter.
 *
 * Both clients operate on a single LocalWorkspace instance: the fork has been cloned, the
 * working branch has been checked out, and writes go through git commit + push.
 */

import type {
  FileChange,
  ForkCommitter,
  RepoFileReader,
} from '../../core/agents/fix-types';

import { LocalWorkspace } from './local-workspace';

export class LocalRepoFileReader implements RepoFileReader {
  constructor(private readonly workspace: LocalWorkspace) {}

  async readFile(_forkFullName: string, _branch: string, filePath: string): Promise<string> {
    return this.workspace.readFile(filePath);
  }

  async listFiles(_forkFullName: string, _branch: string, dirPath: string): Promise<string[]> {
    return this.workspace.listFiles(dirPath);
  }
}

export class LocalForkCommitter implements ForkCommitter {
  constructor(
    private readonly workspace: LocalWorkspace,
    private readonly tokenScopes: string[]
  ) {}

  async commitChanges(
    _forkFullName: string,
    _branch: string,
    changes: FileChange[],
    message: string
  ): Promise<string> {
    for (const change of changes) {
      this.workspace.writeFile(change.path, change.content);
    }
    const sha = await this.workspace.commitAll(message);
    await this.workspace.push();
    return sha;
  }

  async getTokenScopes(): Promise<string[]> {
    return this.tokenScopes;
  }
}
