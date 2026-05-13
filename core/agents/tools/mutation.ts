/**
 * Mutation-tier tools.
 *
 * apply_patch enforces:
 *   - path is inside affectedModule, or is the repro test path
 *   - a hypothesis tracker exists; that file has at least one unconsumed
 *     hypothesis; a read_file/grep on `file` appears in transcript AFTER
 *     the hypothesis was stated; hypothesis is then marked consumed
 *
 * revert_file resets a single file to baseline. No guard required beyond
 * tier budget.
 */

import { z } from 'zod';
import type { ToolDef } from './types';
import { asHandles } from './handles';

function patchInScope(path: string, affectedModule: string, reproTestPath?: string): boolean {
  const norm = path.replace(/\\/g, '/');
  const trimmed = affectedModule.replace(/^\/+|\/+$/g, '');
  if (trimmed === '' || trimmed === '.') return true;
  if (norm.startsWith(trimmed)) return true;
  if (reproTestPath && norm === reproTestPath.replace(/\\/g, '/')) return true;
  if (norm.includes('__tests__') || norm.includes('test/') || norm.includes('tests/') ||
      norm.includes('.test.') || norm.includes('.spec.')) {
    return true;
  }
  return false;
}

const ApplyPatch = z
  .object({
    path: z.string().min(1),
    oldText: z.string().min(1, 'oldText must be a unique 3+ line block from the existing file'),
    newText: z.string(),
    reason: z.string().optional(),
  })
  .strict();

export const applyPatch: ToolDef<z.infer<typeof ApplyPatch>, unknown> = {
  name: 'apply_patch',
  tier: 'mutation',
  description:
    'Apply a search/replace patch. REQUIRES a prior state_hypothesis with the same `file` and a read_file/grep on that file in the transcript. Path must be inside the affected module (or the repro test path).',
  parameters: ApplyPatch,
  async execute({ path, oldText, newText, reason }, ctx) {
    const h = asHandles(ctx.handles);
    const ws = h.workspace;
    if (!patchInScope(path, ws.affectedModule(), ws.reproTestPath())) {
      throw new Error(`apply_patch path "${path}" is outside affected module "${ws.affectedModule()}". Use revise_plan and ask to widen scope if needed.`);
    }

    const tracker = h.hypotheses;
    if (!tracker) {
      throw new Error('apply_patch is unavailable: no hypothesis tracker attached to this agent.');
    }
    const transcript = ctx.getTranscript();
    const turn = transcript.length > 0 ? transcript[transcript.length - 1].turn : 1;

    // applyPatch must succeed before we mark the hypothesis consumed
    const { patchId } = await ws.applyPatch({ path, oldText, newText });
    const consumed = tracker.consumeForPatch(path, patchId, transcript, turn);

    return {
      applied: true,
      path,
      patch_id: patchId,
      hypothesis_id: consumed.id,
      reason: reason ?? null,
    };
  },
};

const RevertFile = z.object({ path: z.string().min(1) }).strict();
export const revertFile: ToolDef<z.infer<typeof RevertFile>, unknown> = {
  name: 'revert_file',
  tier: 'mutation',
  description: 'Revert one file to its baseline state. Use when a hypothesis is disproven.',
  parameters: RevertFile,
  async execute({ path }, ctx) {
    await asHandles(ctx.handles).workspace.revertFile(path);
    return { reverted: path };
  },
};

export const MUTATION_TOOLS = [applyPatch, revertFile] as const;
