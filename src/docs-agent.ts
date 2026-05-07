/**
 * Docs agent for the OSS Autonomous Fix Loop (US-010).
 *
 * Handles issues classified as docs without going through the PM gate.
 * Updates documentation, READMEs, and specs only — never application code.
 * Routes to the same sandbox + eval + PR flow as the fix agent.
 */

import {
  DocsAgentInput,
  DocsAgentResult,
  DocsGenerator,
  DocsAgentError,
  DOC_FILE_PATTERNS,
  APP_CODE_EXTENSIONS,
  FileChange,
  ForkCommitter,
  RepoFileReader,
} from './docs-agent-types';

/** Broad token scopes that would indicate upstream write access */
const DANGEROUS_SCOPES = ['public_repo', 'repo'];

/**
 * Format the commit message per the acceptance criteria:
 * docs: {one-line summary} — closes #{issue_ids}
 */
export function formatDocsCommitMessage(
  summary: string,
  issueIds: number[]
): string {
  const closesClause = issueIds.map((id) => `#${id}`).join(', ');
  return `docs: ${summary} — closes ${closesClause}`;
}

/**
 * Check if a file path is a documentation file.
 * Returns true for markdown, rst, txt, adoc files and files in docs/ directories.
 */
export function isDocumentationFile(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
  const fileName = normalizedPath.split('/').pop() || '';

  // Check if it's in a docs directory
  for (const pattern of DOC_FILE_PATTERNS) {
    if (pattern.endsWith('/')) {
      if (normalizedPath.includes(pattern) || normalizedPath.startsWith(pattern)) {
        return true;
      }
    } else if (pattern.startsWith('.')) {
      if (normalizedPath.endsWith(pattern)) {
        return true;
      }
    } else {
      // Named files like README, CHANGELOG, etc.
      if (fileName.startsWith(pattern.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a file path is application code.
 * Returns true for source code files that the docs agent must never modify.
 */
export function isApplicationCode(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  for (const ext of APP_CODE_EXTENSIONS) {
    if (normalizedPath.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

/**
 * Validate that all changes are documentation-only.
 * Rejects any application code modifications.
 */
export function validateDocsOnly(
  changes: FileChange[]
): { valid: boolean; invalidFiles: string[] } {
  const invalidFiles: string[] = [];

  for (const change of changes) {
    if (isApplicationCode(change.path)) {
      invalidFiles.push(change.path);
    } else if (!isDocumentationFile(change.path)) {
      // Not recognized as docs — check if it could be config (allowed) or code (rejected)
      // Be conservative: only allow known doc patterns
      invalidFiles.push(change.path);
    }
  }

  return { valid: invalidFiles.length === 0, invalidFiles };
}

/**
 * Verify the docs agent token does NOT have broad write access
 * that could allow writing to upstream.
 */
export async function verifyForkOnlyAccess(
  committer: ForkCommitter
): Promise<void> {
  const scopes = await committer.getTokenScopes();
  const dangerous = scopes.filter((s) => DANGEROUS_SCOPES.includes(s));
  if (dangerous.length > 0) {
    throw new DocsAgentError(
      `Token has broad scopes [${dangerous.join(', ')}] which may allow upstream writes. ` +
      `Docs agent must use a token scoped only to the fork.`,
      'token_verification'
    );
  }
}

/**
 * Read documentation files from the repository for context.
 */
export async function readDocFiles(
  reader: RepoFileReader,
  forkFullName: string,
  branch: string,
  affectedModule: string
): Promise<{ files: string[]; contents: string[] }> {
  const files = await reader.listFiles(forkFullName, branch, affectedModule);
  const contents: string[] = [];
  for (const file of files) {
    const content = await reader.readFile(forkFullName, branch, file);
    contents.push(content);
  }
  return { files, contents };
}

/**
 * Run the docs agent pipeline:
 * 1. Verify fork-only token access
 * 2. Read documentation files for context
 * 3. Generate documentation changes
 * 4. Validate changes are docs-only (no application code)
 * 5. Format commit message
 * 6. Commit changes to fork branch
 *
 * Skips PM agent entirely — triggered directly from triage.
 * Routes to the same sandbox + eval + PR flow as the fix agent.
 */
export async function runDocsAgent(
  input: DocsAgentInput,
  generator: DocsGenerator,
  committer: ForkCommitter,
  reader: RepoFileReader
): Promise<DocsAgentResult> {
  // Step 1: Verify token safety
  await verifyForkOnlyAccess(committer);

  // Step 2: Read existing docs for context
  await readDocFiles(reader, input.forkFullName, input.branchName, input.affectedModule);

  // Step 3: Generate documentation changes
  const docsOutput = await generator.generateDocs(input);

  if (docsOutput.changes.length === 0) {
    return {
      success: false,
      changes: [],
      commitMessage: '',
      summary: 'No documentation changes generated',
      closesIssues: [],
    };
  }

  // Step 4: Validate docs-only (never application code)
  const docsCheck = validateDocsOnly(docsOutput.changes);
  if (!docsCheck.valid) {
    throw new DocsAgentError(
      `Docs agent must only modify documentation files. ` +
      `Invalid files: ${docsCheck.invalidFiles.join(', ')}. ` +
      `Application code changes are not allowed.`,
      'docs_validation'
    );
  }

  // Step 5: Format commit message
  const issueIds = input.confirmedIssues.map((i) => i.number);
  const commitMessage = formatDocsCommitMessage(docsOutput.summary, issueIds);

  // Step 6: Commit all changes to the fork branch
  await committer.commitChanges(
    input.forkFullName,
    input.branchName,
    docsOutput.changes,
    commitMessage
  );

  return {
    success: true,
    changes: docsOutput.changes,
    commitMessage,
    summary: docsOutput.summary,
    closesIssues: issueIds,
  };
}
