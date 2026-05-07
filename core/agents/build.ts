/**
 * Build agent for the OSS Autonomous Fix Loop (US-014).
 *
 * Scaffolds new modules or features mirroring existing patterns in the repo.
 * Handles new_feature issues distinctly from bug fixes. All writes are
 * isolated to the fork branch — never upstream.
 */

import {
  BuildAgentInput,
  BuildAgentResult,
  FileChange,
  ScaffoldGenerator,
  ForkCommitter,
  RepoFileReader,
  BuildAgentError,
  ReferenceModule,
} from './build-types';
import { UpstreamWriteAttemptError } from './fix-types';

/** Broad token scopes that would indicate upstream write access */
const DANGEROUS_SCOPES = ['public_repo', 'repo'];

/** File patterns considered documentation (should not be created by build agent) */
const DOC_EXTENSIONS = ['.md', '.rst', '.txt', '.adoc', '.mdx'];

/**
 * Format the commit message per the acceptance criteria:
 * feat({module}): {one-line summary} — closes #{issue_ids}
 */
export function formatBuildCommitMessage(
  affectedModule: string,
  summary: string,
  issueIds: number[]
): string {
  const moduleName = extractModuleName(affectedModule);
  const closesClause = issueIds.map((id) => `#${id}`).join(', ');
  return `feat(${moduleName}): ${summary} — closes ${closesClause}`;
}

/**
 * Extract a short module name from a path.
 * e.g. "src/auth/handlers" → "auth/handlers"
 *      "lib/utils" → "utils"
 */
export function extractModuleName(modulePath: string): string {
  const parts = modulePath.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length > 1 && (parts[0] === 'src' || parts[0] === 'lib')) {
    return parts.slice(1).join('/');
  }
  return parts.join('/');
}

/**
 * Verify the build agent token does NOT have broad write access
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
      `Build agent must use a token scoped only to the fork.`
    );
  }
}

/**
 * Validate that all generated files mirror existing patterns (are source or test files)
 * and do NOT include documentation files.
 */
export function validateNoDocumentation(
  changes: FileChange[]
): { valid: boolean; docFiles: string[] } {
  const docFiles: string[] = [];
  for (const change of changes) {
    const lowerPath = change.path.toLowerCase();
    if (DOC_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))) {
      docFiles.push(change.path);
    }
  }
  return { valid: docFiles.length === 0, docFiles };
}

/**
 * Validate that module files are within the affected module path.
 */
export function validateModuleScope(
  moduleFiles: FileChange[],
  affectedModule: string
): { valid: boolean; outOfScope: string[] } {
  const outOfScope: string[] = [];
  const normalizedModule = affectedModule.replace(/^\/+|\/+$/g, '');

  for (const change of moduleFiles) {
    const normalizedPath = change.path.replace(/^\/+/, '');
    if (!normalizedPath.startsWith(normalizedModule)) {
      outOfScope.push(change.path);
    }
  }

  return { valid: outOfScope.length === 0, outOfScope };
}

/**
 * Validate that test files exist (every module needs a test).
 */
export function validateTestFilePresent(
  testFiles: FileChange[]
): { valid: boolean } {
  return { valid: testFiles.length > 0 };
}

/**
 * Validate that index/registry file updates reference the new module.
 */
export function validateIndexUpdates(
  indexFiles: FileChange[],
  affectedModule: string
): { valid: boolean; reason: string } {
  if (indexFiles.length === 0) {
    return { valid: true, reason: '' };
  }
  const moduleName = extractModuleName(affectedModule);
  for (const file of indexFiles) {
    if (!file.content.includes(moduleName) && !file.content.includes(affectedModule)) {
      return {
        valid: false,
        reason: `Index file "${file.path}" does not reference the new module "${moduleName}"`,
      };
    }
  }
  return { valid: true, reason: '' };
}

/**
 * Detect patterns from reference modules to guide scaffolding.
 * Returns structural metadata about the reference.
 */
export function analyzeReferenceModules(
  referenceModules: ReferenceModule[]
): { filePatterns: string[]; hasTests: boolean; hasIndex: boolean } {
  const filePatterns: string[] = [];
  let hasTests = false;
  let hasIndex = false;

  for (const ref of referenceModules) {
    for (const file of ref.files) {
      const relativePath = file.path.replace(ref.path, '').replace(/^\/+/, '');
      if (relativePath && !filePatterns.includes(relativePath)) {
        filePatterns.push(relativePath);
      }
      if (file.path.includes('.test.') || file.path.includes('.spec.') ||
          file.path.includes('__tests__')) {
        hasTests = true;
      }
      if (file.path.includes('index.')) {
        hasIndex = true;
      }
    }
  }

  return { filePatterns, hasTests, hasIndex };
}

/**
 * Run the build agent pipeline:
 * 1. Verify fork-only token access
 * 2. Analyze reference modules for patterns
 * 3. Generate scaffold using the scaffold generator
 * 4. Validate no documentation changes
 * 5. Validate module scope
 * 6. Validate test file present
 * 7. Validate index updates
 * 8. Format commit message
 * 9. Commit changes to fork branch
 */
export async function runBuildAgent(
  input: BuildAgentInput,
  generator: ScaffoldGenerator,
  committer: ForkCommitter,
  reader: RepoFileReader
): Promise<BuildAgentResult> {
  // Step 1: Verify token safety
  await verifyForkOnlyAccess(committer);

  // Step 2: Analyze reference modules
  analyzeReferenceModules(input.referenceModules);

  // Step 3: Generate the scaffold
  const scaffoldOutput = await generator.generateScaffold(input);

  if (
    scaffoldOutput.moduleFiles.length === 0 &&
    scaffoldOutput.testFiles.length === 0 &&
    scaffoldOutput.indexFiles.length === 0
  ) {
    return {
      success: false,
      moduleFiles: [],
      testFiles: [],
      indexFiles: [],
      commitMessage: '',
      summary: 'No scaffold generated',
      closesIssues: [],
    };
  }

  // Step 4: Validate no documentation changes
  const allChanges = [
    ...scaffoldOutput.moduleFiles,
    ...scaffoldOutput.testFiles,
    ...scaffoldOutput.indexFiles,
  ];
  const docCheck = validateNoDocumentation(allChanges);
  if (!docCheck.valid) {
    throw new BuildAgentError(
      `Build agent must not create documentation files. ` +
      `Defer docs to a follow-up docs agent pass. Found: ${docCheck.docFiles.join(', ')}`,
      'doc_validation'
    );
  }

  // Step 5: Validate module scope
  const scopeCheck = validateModuleScope(scaffoldOutput.moduleFiles, input.affectedModule);
  if (!scopeCheck.valid) {
    throw new BuildAgentError(
      `Build agent produced module files outside the affected module: ${scopeCheck.outOfScope.join(', ')}. ` +
      `Files must be within "${input.affectedModule}".`,
      'scope_validation'
    );
  }

  // Step 6: Validate test file present
  const testCheck = validateTestFilePresent(scaffoldOutput.testFiles);
  if (!testCheck.valid) {
    throw new BuildAgentError(
      `Build agent must create a test file for the new module.`,
      'test_validation'
    );
  }

  // Step 7: Validate index updates reference the module
  const indexCheck = validateIndexUpdates(scaffoldOutput.indexFiles, input.affectedModule);
  if (!indexCheck.valid) {
    throw new BuildAgentError(indexCheck.reason, 'index_validation');
  }

  // Step 8: Format commit message
  const issueIds = input.confirmedIssues.map((i) => i.number);
  const commitMessage = formatBuildCommitMessage(
    input.affectedModule,
    scaffoldOutput.summary,
    issueIds
  );

  // Step 9: Commit all changes to the fork branch
  await committer.commitChanges(
    input.forkFullName,
    input.branchName,
    allChanges,
    commitMessage
  );

  return {
    success: true,
    moduleFiles: scaffoldOutput.moduleFiles,
    testFiles: scaffoldOutput.testFiles,
    indexFiles: scaffoldOutput.indexFiles,
    commitMessage,
    summary: scaffoldOutput.summary,
    closesIssues: issueIds,
  };
}
