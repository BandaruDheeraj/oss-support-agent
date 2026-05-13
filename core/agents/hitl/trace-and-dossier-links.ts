/**
 * Helpers that build:
 *   - dossier markdown render (for email bodies)
 *   - Phoenix / Braintrust deep-trace links from a trace id
 *   - Reply-To plus-addressed nonce extraction
 */

import type { DossierSnapshot } from '../analyst/dossier';
import type { InvestigationNotes } from '../fix-loop/investigation-notes';
import { redactString } from '../../observability/redact';

export function renderDossierMarkdown(snapshot: DossierSnapshot, notes?: InvestigationNotes | null): string {
  const lines: string[] = [];
  lines.push(`### Dossier (snapshot \`${snapshot.snapshotId}\`)`);
  lines.push(`**Summary:** ${redactString(snapshot.body.summary)}`);
  lines.push(`**Confidence:** ${snapshot.body.confidence}`);
  if (snapshot.body.suspectSymbols.length) {
    lines.push('\n**Suspect symbols:**');
    for (const s of snapshot.body.suspectSymbols) {
      lines.push(`- \`${s.file}::${s.symbol}\` — ${redactString(s.reasoning)}`);
    }
  }
  if (snapshot.body.openQuestions.length) {
    lines.push('\n**Open questions:**');
    for (const q of snapshot.body.openQuestions) lines.push(`- ${redactString(q)}`);
  }
  if (notes) {
    lines.push(`\n### Investigation notes (\`${notes.notesId}\`)`);
    lines.push(`**Root cause:** ${redactString(notes.body.rootCauseHypothesis)}`);
    lines.push(`**Suggested approach:** ${redactString(notes.body.suggestedApproach)}`);
    if (notes.body.risks.length) {
      lines.push('**Risks:** ' + notes.body.risks.map(redactString).join('; '));
    }
  }
  return lines.join('\n');
}

export function phoenixTraceUrl(traceId: string): string | null {
  const base = process.env.PHOENIX_UI_BASE_URL;
  if (!base || !traceId) return null;
  return `${base.replace(/\/+$/, '')}/projects/default/traces/${traceId}`;
}

export function braintrustTraceUrl(traceId: string): string | null {
  const project = process.env.BRAINTRUST_PROJECT;
  const org = process.env.BRAINTRUST_ORG;
  if (!project || !org || !traceId) return null;
  return `https://www.braintrust.dev/app/${encodeURIComponent(org)}/p/${encodeURIComponent(project)}/logs?traceId=${encodeURIComponent(traceId)}`;
}

/** Build the Reply-To plus-address for a given inbox entry. */
export function replyToFor(inboxEntryId: string, nonce: string): string {
  const baseAddr = process.env.HITL_REPLY_TO_BASE || 'osa-reply@oss-support-agent.local';
  const [local, domain] = baseAddr.split('@');
  return `${local}+${inboxEntryId}.${nonce}@${domain}`;
}

/** Extract the inbox entry id from a plus-addressed To: header value, if present. */
export function parsePlusAddress(to: string): { inboxEntryId: string; nonce: string } | null {
  const m = to.match(/\+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)@/);
  if (!m) return null;
  return { inboxEntryId: m[1], nonce: m[2] };
}
