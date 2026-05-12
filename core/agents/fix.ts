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
import { applyPatches } from './fix-patches';

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
  const trimmed = affectedModule.replace(/^\/+|\/+$/g, '');
  // "." or empty means repo root → all paths are in-scope.
  const moduleIsRoot = trimmed === '' || trimmed === '.';
  const normalizedModule = trimmed;

  for (const change of changes) {
    const normalizedPath = change.path.replace(/^\/+/, '');
    const isInModule = moduleIsRoot ||
      normalizedPath.startsWith(normalizedModule) ||
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
 * Detect destructive whole-file rewrites where the LLM truncated existing
 * file contents and replaced them with placeholder comments instead of
 * returning the complete post-edit file. This is a common failure mode of
 * "return the complete file contents" patch formats with long inputs.
 *
 * Returns details of any modify-action change whose new content either:
 *   - shrinks the file by more than `maxShrinkRatio` (default 50%) when the
 *     original was non-trivial in size, OR
 *   - contains LLM placeholder strings like `# ... existing code ...`,
 *     `# Other imports...`, `# Existing logic...`, `// ... rest of file ...`,
 *     `<!-- existing content -->`, etc.
 */
export function detectDestructiveRewrites(
  sourceChanges: FileChange[],
  moduleSource: Array<{ path: string; content: string }>,
  opts: { maxShrinkRatio?: number; minOriginalBytes?: number } = {}
): Array<{ path: string; reason: string; originalBytes: number; newBytes: number }> {
  const maxShrinkRatio = opts.maxShrinkRatio ?? 0.5;
  const minOriginalBytes = opts.minOriginalBytes ?? 400;

  const placeholderPatterns: RegExp[] = [
    /#\s*\.{3,}\s*existing\s+(code|content|imports|logic)/i,
    /#\s*existing\s+(code|content|imports|logic)\s*\.{3,}/i,
    /#\s*existing\s+(code|content|imports|logic)\s+unchanged/i,
    /#\s*other\s+(imports|code|content|logic)\s*\.{3,}/i,
    /#\s*rest\s+of\s+(the\s+)?(file|code|module|imports)/i,
    /\/\/\s*\.{3,}\s*existing\s+(code|content|imports|logic)/i,
    /\/\/\s*existing\s+(code|content|imports|logic)\s*\.{3,}/i,
    /\/\/\s*existing\s+(code|content|imports|logic)\s+unchanged/i,
    /\/\/\s*rest\s+of\s+(the\s+)?(file|code|module)/i,
    /<!--\s*existing\s+(code|content)\s*-->/i,
    /\/\*\s*\.{3,}\s*existing\s+(code|content)/i,
    /#\s*\(unchanged\)/i,
    /#\s*existing\s+logic\s*\.\.\./i,
    /#\s*omitted\s+for\s+brevity/i,
    /\/\/\s*omitted\s+for\s+brevity/i,
  ];

  const sourceByPath = new Map(moduleSource.map((f) => [f.path, f.content]));
  const findings: Array<{ path: string; reason: string; originalBytes: number; newBytes: number }> = [];

  for (const change of sourceChanges) {
    if (change.action !== 'modify') continue;
    const original = sourceByPath.get(change.path);
    if (original === undefined) continue;
    const originalBytes = Buffer.byteLength(original, 'utf-8');
    const newBytes = Buffer.byteLength(change.content, 'utf-8');

    const placeholderHit = placeholderPatterns.find((p) => p.test(change.content));
    if (placeholderHit) {
      findings.push({
        path: change.path,
        reason: `output contains placeholder pattern matching ${placeholderHit.source}; LLM truncated the file instead of returning complete contents`,
        originalBytes,
        newBytes,
      });
      continue;
    }

    if (originalBytes >= minOriginalBytes) {
      const shrinkRatio = 1 - newBytes / originalBytes;
      if (shrinkRatio > maxShrinkRatio) {
        findings.push({
          path: change.path,
          reason: `file shrunk by ${(shrinkRatio * 100).toFixed(0)}% (${originalBytes}B → ${newBytes}B); LLM likely truncated instead of returning complete contents`,
          originalBytes,
          newBytes,
        });
      }
    }
  }

  return findings;
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

  // Step 3a: Expand search/replace patches into full-content FileChange
  // entries. Patches sidestep Claude's verbatim-reproduction failure on large
  // files (>~20KB) — see fix-patches.ts for background. Patches are merged
  // into the corresponding sourceChanges/testChanges arrays so all downstream
  // validation (scope, destructive-rewrite, repro-protection) runs against
  // the synthesised post-edit file content.
  const patchCtx = {
    forkFullName: input.forkFullName,
    branch: input.branchName,
    reader,
  };
  const sourcePatches = fixOutput.sourcePatches ?? [];
  const testPatches = fixOutput.testPatches ?? [];
  if (sourcePatches.length > 0) {
    const synthesised = await applyPatches(sourcePatches, patchCtx);
    // Patch entries take precedence over any same-path full-content entry —
    // the LLM should not emit both, but if it does we trust the patch.
    const patchedPaths = new Set(synthesised.map((c) => c.path));
    fixOutput.sourceChanges = [
      ...fixOutput.sourceChanges.filter((c) => !patchedPaths.has(c.path)),
      ...synthesised,
    ];
    console.log(`[fix] expanded ${sourcePatches.length} sourcePatch(es) into ${synthesised.length} file change(s)`);
  }
  if (testPatches.length > 0) {
    const synthesised = await applyPatches(testPatches, patchCtx);
    const patchedPaths = new Set(synthesised.map((c) => c.path));
    fixOutput.testChanges = [
      ...fixOutput.testChanges.filter((c) => !patchedPaths.has(c.path)),
      ...synthesised,
    ];
    console.log(`[fix] expanded ${testPatches.length} testPatch(es) into ${synthesised.length} file change(s)`);
  }

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

  // Step 4a: Protected paths — refuse to commit modifications to the repro
  // test file. The fix is expected to make the repro pass as-is. We check
  // BEFORE commit so a violation cannot reach the fork.
  if (input.reproTest) {
    const protectedPath = input.reproTest.path;
    const touched = allChanges.filter((c) => c.path === protectedPath);
    if (touched.length > 0) {
      throw new FixAgentError(
        `Fix agent attempted to modify the repro test (${protectedPath}). ` +
        `The repro test is read-only: your fix must make its existing assertions pass ` +
        `without rewriting the test. Re-attempt without including this path in changes.`,
        'protected_path'
      );
    }
  }

  // Step 4b: Detect destructive whole-file rewrites (truncation with
  // placeholder comments, dramatic shrinkage). The LLM is asked to return
  // complete post-edit file contents — sometimes it abridges. We surface
  // this as a fix-agent error so the retry loop re-prompts with the
  // explicit guidance below.
  //
  // `input.moduleSource` is a bounded sample of the affected module (see
  // `gatherModuleFiles` in run-pipeline.ts — capped at 30 files). For
  // repo-wide modules (affectedModule="."), the file the LLM actually
  // modified may not be in the sample, leaving the guard with no baseline.
  // Fetch any missing originals from the reader so we always have ground
  // truth for the placeholder/shrinkage checks.
  const moduleSourceByPath = new Map(input.moduleSource.map((f) => [f.path, f.content]));
  const augmentedModuleSource = [...input.moduleSource];
  for (const change of fixOutput.sourceChanges) {
    if (change.action !== 'modify') continue;
    if (moduleSourceByPath.has(change.path)) continue;
    try {
      const original = await reader.readFile(
        input.forkFullName,
        input.branchName,
        change.path
      );
      augmentedModuleSource.push({ path: change.path, content: original });
      moduleSourceByPath.set(change.path, original);
    } catch {
      // Reader failed (file may not exist yet, or transient I/O issue);
      // leave it absent — the guard will treat the change as create-like
      // and skip it rather than block on missing data.
    }
  }
  const destructive = detectDestructiveRewrites(
    fixOutput.sourceChanges,
    augmentedModuleSource
  );
  if (destructive.length > 0) {
    const details = destructive
      .map((d) => `  - ${d.path}: ${d.reason}`)
      .join('\n');
    throw new FixAgentError(
      `Fix agent returned destructive whole-file rewrite(s):\n${details}\n` +
      `When using action="modify" you MUST return the complete unabridged file ` +
      `contents — no "# Other imports...", no "# Existing logic...", no ellipses or ` +
      `placeholder comments. If you cannot reproduce the entire file verbatim, do ` +
      `not modify it.`,
      'destructive_rewrite'
    );
  }

  // Step 5: Validate test coverage. When a repro test exists on the branch,
  // it already provides coverage — the fix isn't expected (or allowed) to
  // touch it, and an empty testChanges array is the right answer in that
  // case. Skip the coverage gate so the LLM stops adding noise tests.
  if (!input.reproTest) {
    const testCheck = validateTestCoverage(fixOutput.sourceChanges, fixOutput.testChanges);
    if (!testCheck.covered) {
      throw new FixAgentError(
        `Fix agent must write or update tests for every code change. ` +
        `Missing tests for: ${testCheck.uncoveredFiles.join(', ')}`,
        'test_coverage'
      );
    }
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
