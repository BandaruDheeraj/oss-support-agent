/**
 * Search/replace patch application for the fix agent.
 *
 * Background: when asked to emit complete post-edit file contents for files
 * larger than ~20KB, Claude (even with temperature=0) reliably reproduces the
 * file verbatim and silently DROPS the targeted edit. Forcing the LLM to
 * instead produce a small `{path, oldText, newText}` triple sidesteps that
 * failure mode entirely. This module takes those triples, reads the current
 * file from the branch, validates the substitution is unambiguous, and
 * synthesises a full-content FileChange entry that the downstream commit
 * pipeline can use unmodified.
 */
import type { FileChange, FilePatch, RepoFileReader } from './fix-types';
import { FixAgentError } from './fix-types';

export interface PatchApplyContext {
  forkFullName: string;
  branch: string;
  reader: RepoFileReader;
}

/**
 * Apply one patch and return the synthesised FileChange (action="modify").
 *
 * Throws FixAgentError with kind "patch_not_found" or "patch_ambiguous" when
 * the substitution cannot be applied unambiguously — these are surfaced via
 * the retry loop so the LLM can re-emit a more specific oldText.
 */
export async function applyPatch(
  patch: FilePatch,
  ctx: PatchApplyContext
): Promise<FileChange> {
  if (!patch.path || patch.path.trim().length === 0) {
    throw new FixAgentError(`Patch is missing "path"`, 'patch_invalid');
  }
  if (typeof patch.oldText !== 'string' || patch.oldText.length === 0) {
    throw new FixAgentError(
      `Patch for ${patch.path} has empty "oldText". Provide the existing block of code (3+ lines for uniqueness) you intend to replace.`,
      'patch_invalid'
    );
  }
  if (typeof patch.newText !== 'string') {
    throw new FixAgentError(
      `Patch for ${patch.path} is missing "newText" (use empty string for deletions).`,
      'patch_invalid'
    );
  }

  let original: string;
  try {
    original = await ctx.reader.readFile(ctx.forkFullName, ctx.branch, patch.path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FixAgentError(
      `Patch target ${patch.path} could not be read from the branch: ${msg}. ` +
        `If you intend to create a new file, use sourceChanges with action="create" instead.`,
      'patch_target_missing'
    );
  }

  const occurrences = countOccurrences(original, patch.oldText);
  if (occurrences === 0) {
    throw new FixAgentError(
      `Patch oldText for ${patch.path} was not found in the file. The block you supplied does not match any text on the branch — re-read the file and copy an EXACT existing block (3+ contiguous lines, including indentation) before describing your replacement.`,
      'patch_not_found'
    );
  }
  if (occurrences > 1) {
    throw new FixAgentError(
      `Patch oldText for ${patch.path} matched ${occurrences} times — it is ambiguous. Include MORE surrounding lines in oldText so the block is uniquely identifiable in the file.`,
      'patch_ambiguous'
    );
  }

  const updated = original.replace(patch.oldText, patch.newText);
  if (updated === original) {
    // Should be impossible given occurrences === 1, but guard against
    // pathological inputs (e.g. oldText === newText).
    throw new FixAgentError(
      `Patch for ${patch.path} resulted in zero byte change (oldText and newText are identical?).`,
      'patch_noop'
    );
  }
  return { path: patch.path, action: 'modify', content: updated };
}

/**
 * Apply a list of patches sequentially, accumulating per-path edits so that a
 * second patch on the same file sees the prior patch already applied.
 */
export async function applyPatches(
  patches: FilePatch[],
  ctx: PatchApplyContext
): Promise<FileChange[]> {
  const byPath = new Map<string, string>();
  const result: FileChange[] = [];
  for (const patch of patches) {
    let baseline: string;
    if (byPath.has(patch.path)) {
      baseline = byPath.get(patch.path)!;
    } else {
      try {
        baseline = await ctx.reader.readFile(ctx.forkFullName, ctx.branch, patch.path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new FixAgentError(
          `Patch target ${patch.path} could not be read from the branch: ${msg}.`,
          'patch_target_missing'
        );
      }
    }
    const occurrences = countOccurrences(baseline, patch.oldText);
    if (occurrences === 0) {
      throw new FixAgentError(
        `Patch oldText for ${patch.path} was not found in the file. The block you supplied does not match any text on the branch — re-read the file and copy an EXACT existing block (3+ contiguous lines, including indentation) before describing your replacement.`,
        'patch_not_found'
      );
    }
    if (occurrences > 1) {
      throw new FixAgentError(
        `Patch oldText for ${patch.path} matched ${occurrences} times — it is ambiguous. Include MORE surrounding lines in oldText so the block is uniquely identifiable in the file.`,
        'patch_ambiguous'
      );
    }
    if (!patch.oldText || patch.oldText.length === 0) {
      throw new FixAgentError(
        `Patch for ${patch.path} has empty "oldText".`,
        'patch_invalid'
      );
    }
    const updated = baseline.replace(patch.oldText, patch.newText);
    if (updated === baseline) {
      throw new FixAgentError(
        `Patch for ${patch.path} resulted in zero byte change (oldText and newText are identical?).`,
        'patch_noop'
      );
    }
    byPath.set(patch.path, updated);
  }
  for (const [path, content] of byPath) {
    result.push({ path, action: 'modify', content });
  }
  return result;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}
