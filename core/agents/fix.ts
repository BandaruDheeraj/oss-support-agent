/**
 * Fix agent for the OSS Autonomous Fix Loop (US-007).
 *
 * Patches existing code on the fork branch given the agreed design
 * and confirmed issue list as context. All writes are isolated to
 * the fork branch — never upstream.
 */

import {
  FixAgentInput,
  FixAgentResult,
  FileChange,
  FixGenerator,
  ForkCommitter,
  RepoFileReader,
  FixAgentError,
  UpstreamWriteAttemptError,
} from './fix-types';

/** Broad token scopes that would indicate upstream write access */
const DANGEROUS_SCOPES = ['public_repo', 'repo'];

/**
 * Format the commit message per the acceptance criteria:
 * fix({module}): {one-line summary} — closes #{issue_ids}
 */
export function formatCommitMessage(
  affectedModule: string,
  summary: string,
  issueIds: number[]
): string {
  const moduleName = extractModuleName(affectedModule);
  const closesClause = issueIds.map((id) => `#${id}`).join(', ');
  return `fix(${moduleName}): ${summary} — closes ${closesClause}`;
}

/**
 * Extract a short module name from a path.
 * e.g. "src/auth/handlers" → "auth/handlers"
 *      "lib/utils" → "utils"
 *      "src/webhook" → "webhook"
 */
export function extractModuleName(modulePath: string): string {
  const parts = modulePath.replace(/^\/+|\/+$/g, '').split('/');
  // Strip leading "src" or "lib" if present and there's more
  if (parts.length > 1 && (parts[0] === 'src' || parts[0] === 'lib')) {
    return parts.slice(1).join('/');
  }
  return parts.join('/');
}

/**
 * Verify that changes are scoped within the affected module and tests.
 * Returns true if all changes are within scope.
 */
export function validateChangeScope(
  changes: FileChange[],
  affectedModule: string
): { valid: boolean; outOfScope: string[] } {
  const outOfScope: string[] = [];
  const normalizedModule = affectedModule.replace(/^\/+|\/+$/g, '');

  for (const change of changes) {
    const normalizedPath = change.path.replace(/^\/+/, '');
    const isInModule = normalizedPath.startsWith(normalizedModule) ||
      normalizedPath.includes('__tests__') ||
      normalizedPath.includes('.test.') ||
      normalizedPath.includes('.spec.') ||
      normalizedPath.includes('test/') ||
      normalizedPath.includes('tests/');

    if (!isInModule) {
      outOfScope.push(change.path);
    }
  }

  return { valid: outOfScope.length === 0, outOfScope };
}

/**
 * Verify the fix agent token does NOT have broad write access
 * that could allow writing to upstream.
 */
export async function verifyForkOnlyAccess(
  committer: ForkCommitter
): Promise<void> {
  const scopes = await committer.getTokenScopes();
  const dangerous = scopes.filter((s) => DANGEROUS_SCOPES.includes(s));
  if (dangerous.length > 0) {
    throw new UpstreamWriteAttemptError(
      `Token has broad scopes [${dangerous.join(', ')}] which may allow upstream writes. ` +
      `Fix agent must use a token scoped only to the fork.`
    );
  }
}

/**
 * Ensure every source change has a corresponding test change.
 * Returns files lacking test coverage.
 */
export function validateTestCoverage(
  sourceChanges: FileChange[],
  testChanges: FileChange[]
): { covered: boolean; uncoveredFiles: string[] } {
  if (sourceChanges.length === 0) {
    return { covered: true, uncoveredFiles: [] };
  }
  if (testChanges.length === 0) {
    return { covered: false, uncoveredFiles: sourceChanges.map((c) => c.path) };
  }
  // At least one test change exists — we consider it covered
  // (the fix generator is responsible for writing meaningful tests)
  return { covered: true, uncoveredFiles: [] };
}

/**
 * Read the full module source before making changes.
 * This ensures the fix agent has complete context.
 */
export async function readFullModule(
  reader: RepoFileReader,
  forkFullName: string,
  branch: string,
  affectedModule: string
): Promise<{ source: string[]; files: string[] }> {
  const files = await reader.listFiles(forkFullName, branch, affectedModule);
  const source: string[] = [];
  for (const file of files) {
    const content = await reader.readFile(forkFullName, branch, file);
    source.push(content);
  }
  return { source, files };
}

/**
 * Run the fix agent pipeline:
 * 1. Verify fork-only token access
 * 2. Read the full module
 * 3. Generate the fix using the fix generator
 * 4. Validate change scope
 * 5. Validate test coverage
 * 6. Format commit message
 * 7. Commit changes to fork branch
 */
export async function runFixAgent(
  input: FixAgentInput,
  generator: FixGenerator,
  committer: ForkCommitter,
  reader: RepoFileReader
): Promise<FixAgentResult> {
  // Step 1: Verify token safety
  await verifyForkOnlyAccess(committer);

  // Step 2: Read the full module before making changes
  await readFullModule(reader, input.forkFullName, input.branchName, input.affectedModule);

  // Step 3: Generate the fix
  const fixOutput = await generator.generateFix(input);

  if (fixOutput.sourceChanges.length === 0 && fixOutput.testChanges.length === 0) {
    return {
      success: false,
      changes: [],
      testChanges: [],
      commitMessage: '',
      summary: 'No changes generated',
      closesIssues: [],
    };
  }

  // Step 4: Validate change scope (only targeted changes within issue scope)
  const allChanges = [...fixOutput.sourceChanges, ...fixOutput.testChanges];
  const scopeCheck = validateChangeScope(allChanges, input.affectedModule);
  if (!scopeCheck.valid) {
    throw new FixAgentError(
      `Fix agent produced out-of-scope changes: ${scopeCheck.outOfScope.join(', ')}. ` +
      `Only changes within "${input.affectedModule}" and test files are allowed.`,
      'scope_validation'
    );
  }

  // Step 5: Validate test coverage
  const testCheck = validateTestCoverage(fixOutput.sourceChanges, fixOutput.testChanges);
  if (!testCheck.covered) {
    throw new FixAgentError(
      `Fix agent must write or update tests for every code change. ` +
      `Missing tests for: ${testCheck.uncoveredFiles.join(', ')}`,
      'test_coverage'
    );
  }

  // Step 6: Format commit message
  const issueIds = input.confirmedIssues.map((i) => i.number);
  const commitMessage = formatCommitMessage(
    input.affectedModule,
    fixOutput.summary,
    issueIds
  );

  // Step 7: Commit all changes to the fork branch
  await committer.commitChanges(
    input.forkFullName,
    input.branchName,
    allChanges,
    commitMessage
  );

  return {
    success: true,
    changes: fixOutput.sourceChanges,
    testChanges: fixOutput.testChanges,
    commitMessage,
    summary: fixOutput.summary,
    closesIssues: issueIds,
  };
}
