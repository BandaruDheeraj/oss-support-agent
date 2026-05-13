/**
 * Resume hook: when an inbox entry transitions mapped -> resumed, the
 * pipeline re-enters the same attempt with the human's input appended to
 * the dossier as a new 'human_input' evidence record.
 *
 * The resume hook is shape-only: the actual pipeline re-entry is driven by
 * the orchestrator (bin/run-pipeline). This module provides the helper that
 * builds the carry-forward evidence + transitions the inbox entry.
 */

import { InboxStore, type InboxEntry } from './inbox-store';
import { DossierStore } from '../analyst/dossier';

export interface HumanInputRecord {
  decision: string;
  hint?: string;
  repliedAt: string;
  inboxEntryId: string;
}

export interface ResumeOutcome {
  ok: boolean;
  reason?: string;
  human?: HumanInputRecord;
  newSnapshotId?: string;
}

export function resumePipeline(
  store: InboxStore,
  dossier: DossierStore,
  entry: InboxEntry
): ResumeOutcome {
  if (entry.status !== 'mapped') {
    return { ok: false, reason: `inbox entry ${entry.id} not mapped (status=${entry.status})` };
  }
  if (!entry.mapped_action) {
    return { ok: false, reason: 'inbox entry has no mapped_action' };
  }
  const ok = store.transition(entry.id, 'mapped', 'resumed');
  if (!ok) return { ok: false, reason: 'cas_conflict resuming' };

  const human: HumanInputRecord = {
    decision: entry.mapped_action,
    hint: entry.stripped_reply?.slice(0, 2000),
    repliedAt: entry.reply_received_at ?? new Date().toISOString(),
    inboxEntryId: entry.id,
  };

  const prev = dossier.latest();
  if (!prev) {
    return { ok: true, human, reason: 'no_prior_dossier_to_extend' };
  }
  const snap = dossier.append({
    issueNumber: prev.body.issueNumber,
    attemptId: prev.body.attemptId,
    evidence: [
      ...prev.body.evidence,
      {
        id: `human-${entry.id}`,
        kind: 'human_input',
        source: `inbox:${entry.id}`,
        summary: `Human decision: ${human.decision}`,
        detail: human.hint ?? '',
        recordedAt: human.repliedAt,
      },
    ],
    suspectSymbols: prev.body.suspectSymbols,
    openQuestions: prev.body.openQuestions,
    summary: `${prev.body.summary}\n\nHuman input received: ${human.decision}`,
    confidence: prev.body.confidence,
  });

  return { ok: true, human, newSnapshotId: snap.snapshotId };
}
