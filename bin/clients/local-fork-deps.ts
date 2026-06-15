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
import { withExternalOperationSpan } from '../../core/observability';

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
    return withExternalOperationSpan(
      'git.commit_changes',
      {
        fork: _forkFullName,
        branch: _branch,
        change_count: changes.length,
        path_count: changes.length,
        message,
      },
      async (span) => {
        for (const change of changes) {
          this.workspace.writeFile(change.path, change.content);
        }
        // Commit ONLY the LLM-authored paths. Using commitAll (`git add -A`)
        // here would sweep in untracked side-effects like the per-workspace
        // .agent-venv/ that the sandbox creates for editable pip installs,
        // producing PRs with hundreds of thousands of unrelated additions
        // (see issue #38 → PR #39 incident). The fix-agent's `changes` list
        // is the authoritative set of paths that should land in the commit.
        const paths = changes.map((c) => c.path);
        // Diagnostic: surface git status for the LLM-authored paths before
        // attempting the commit. If the LLM returned content identical to
        // HEAD, `git status` will show nothing for those paths and the
        // commit will fail with "No changes to commit" — log enough context
        // to tell that case apart from a missing-paths case.
        try {
          const status = await this.workspace.statusForPaths(paths);
          console.log(
            `[fix-commit] writing ${paths.length} path(s); ` +
              `git-status lines for those paths: ${status.length === 0 ? '(none — no diff vs HEAD)' : status.length}`
          );
          for (const line of status) console.log(`[fix-commit]   ${line}`);
        } catch {
          // status probe is best-effort; never let it mask the real error
        }
        const sha = await this.workspace.commitPaths(paths, message);
        await this.workspace.push();
        span.setAttributes({ 'git.commit_sha': sha, 'git.path_count': paths.length });
        span.setOutput({ commit_sha: sha, path_count: paths.length });
        return sha;
      }
    );
  }

  async getTokenScopes(): Promise<string[]> {
    return this.tokenScopes;
  }
}
