/**
 * Structured hypothesis tracker.
 *
 * Hypotheses follow:
 *   { stepId, file, symbol?, observedEvidenceIds[], expectedEffect, successCheck }
 *
 * `apply_patch(path)` requires a hypothesis with:
 *   - file === patch.path
 *   - consumed === undefined
 *   - created AFTER a read_file/grep that touched `file` (transcript-checked)
 *
 * Single-use per patch. After apply_patch, hypothesis.consumed = { byPatchId }.
 */

import { z } from 'zod';
import type { TranscriptEntry } from '../tools/types';

export const HypothesisSchema = z.object({
  stepId: z.string().min(1),
  file: z.string().min(1),
  symbol: z.string().optional(),
  observedEvidenceIds: z.array(z.string().min(1)).min(1, 'observedEvidenceIds must be non-empty — point to dossier evidence ids'),
  expectedEffect: z.string().min(1),
  successCheck: z.string().min(1),
});
export type HypothesisInput = z.infer<typeof HypothesisSchema>;

export interface Hypothesis extends HypothesisInput {
  id: string;
  createdAtTurn: number;
  consumed?: { byPatchId: string; consumedAtTurn: number };
}

export class HypothesisTracker {
  private readonly hypotheses: Hypothesis[] = [];
  private counter = 0;

  list(): Hypothesis[] {
    return this.hypotheses.slice();
  }

  unconsumedFor(file: string): Hypothesis[] {
    return this.hypotheses.filter((h) => h.file === file && !h.consumed);
  }

  /**
   * Add a new hypothesis. Caller (the tool) must pass the current registry
   * turn so the apply-patch precedence rule can be checked.
   */
  add(input: HypothesisInput, atTurn: number): Hypothesis {
    const parsed = HypothesisSchema.parse(input);
    this.counter += 1;
    const h: Hypothesis = { ...parsed, id: `H${this.counter}`, createdAtTurn: atTurn };
    this.hypotheses.push(h);
    return h;
  }

  /**
   * Pre-flight gate check for apply_patch. Must be called BEFORE ws.applyPatch
   * to avoid dirtying the workspace when the gate rejects.
   *
   * Throws if no unconsumed hypothesis exists for `file`, or if the transcript
   * contains no read_file / github_read_file / grep on `file` at or after the
   * hypothesis was created.
   */
  checkApplyPatchGate(file: string, transcript: TranscriptEntry[]): Hypothesis {
    const candidates = this.unconsumedFor(file);
    if (candidates.length === 0) {
      const err = new Error(
        `apply_patch on ${file} requires a prior state_hypothesis with file="${file}", observedEvidenceIds non-empty, and unconsumed.`
      );
      (err as any).kind = 'hypothesis_required';
      throw err;
    }
    const h = candidates[candidates.length - 1]; // most recent

    // Must have a read_file / github_read_file / grep touching this file at any point before this apply_patch.
    // We intentionally do NOT require the read to happen after the hypothesis was stated — the executor
    // often reads the file once, states multiple hypotheses, then patches them in sequence. Requiring
    // re-reads after each hypothesis causes false gate rejections on the second+ patch.
    const readSeen = transcript.some((entry) => {
      if (entry.tool === 'read_file' || entry.tool === 'github_read_file') {
        return (entry.args as any)?.path === file;
      }
      if (entry.tool === 'grep') {
        const paths = (entry.args as any)?.paths;
        if (Array.isArray(paths)) return paths.includes(file);
        if (typeof paths === 'string') return paths === file || file.startsWith(paths);
        return true;
      }
      return false;
    });
    if (!readSeen) {
      const err = new Error(
        `apply_patch on ${file} requires a read_file, github_read_file, or grep on ${file} after the hypothesis was stated (registry transcript shows none).`
      );
      (err as any).kind = 'hypothesis_required';
      throw err;
    }
    return h;
  }

  /**
   * Mark a hypothesis consumed by a patch. Call AFTER ws.applyPatch succeeds.
   * Gate validation must have been done via checkApplyPatchGate beforehand.
   */
  consumeForPatch(file: string, patchId: string, atTurn: number): Hypothesis {
    const candidates = this.unconsumedFor(file);
    if (candidates.length === 0) {
      const err = new Error(
        `apply_patch on ${file} requires a prior state_hypothesis with file="${file}", observedEvidenceIds non-empty, and unconsumed.`
      );
      (err as any).kind = 'hypothesis_required';
      throw err;
    }
    const h = candidates[candidates.length - 1]; // most recent
    h.consumed = { byPatchId: patchId, consumedAtTurn: atTurn };
    return h;
  }

  /** For Critic / orchestrator audit: every changed file has a consumed hypothesis. */
  allChangedFilesConsumed(changedFiles: string[]): { ok: boolean; missing: string[] } {
    const missing: string[] = [];
    for (const f of changedFiles) {
      const matched = this.hypotheses.some((h) => h.file === f && !!h.consumed);
      if (!matched) missing.push(f);
    }
    return { ok: missing.length === 0, missing };
  }
}
