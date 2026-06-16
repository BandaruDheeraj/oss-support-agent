/**
 * Shared template helpers. Every email follows the same shell:
 *
 *   Header (issue, attempt id, snapshot id)
 *   Body (kind-specific)
 *   Decision section (links + expected actions)
 *   Footer (trace links)
 */

import { renderDossierMarkdown } from '../../hitl/trace-and-dossier-links';
import { redactString } from '../../../observability/redact';
import { markdownToPlainText } from '../../../email-html';
import type { EmailContext } from '../context';
import type { EmailPayload } from '../composer';

export function header(ctx: EmailContext, title: string): string {
  const lines = [
    `# ${title}`,
    `**Issue:** ${ctx.issueUrl ? `[#${ctx.issueNumber}](${ctx.issueUrl})` : `#${ctx.issueNumber}`}`,
    `**Attempt:** \`${ctx.attemptId}\``,
  ];
  if (ctx.dossier) lines.push(`**Dossier snapshot:** \`${ctx.dossier.snapshotId}\``);
  if (ctx.fixNotes) lines.push(`**Investigation notes:** \`${ctx.fixNotes.notesId}\``);
  return lines.join('\n');
}

export function dossierBlock(ctx: EmailContext): string {
  if (!ctx.dossier) return '';
  return '\n\n' + renderDossierMarkdown(ctx.dossier, ctx.fixNotes ?? null);
}

export function decisionSection(ctx: EmailContext, intro: string): string {
  const lines: string[] = [`\n\n## ${intro}`];
  if (ctx.links.approve) lines.push(`- ✅ Approve: ${ctx.links.approve}`);
  if (ctx.links.requestChanges) lines.push(`- ✏️ Request changes: ${ctx.links.requestChanges}`);
  if (ctx.links.abandon) lines.push(`- ⛔ Abandon: ${ctx.links.abandon}`);
  lines.push(`\nOr reply to this email. Expected actions: ${ctx.expectedActions.join(', ')}.`);
  lines.push(`Reply-To: ${ctx.replyTo}`);
  return lines.join('\n');
}

export function footer(ctx: EmailContext): string {
  const lines = ['\n\n---'];
  if (ctx.links.arize) lines.push(`Arize AX trace: ${ctx.links.arize}`);
  if (ctx.links.braintrust) lines.push(`Braintrust trace: ${ctx.links.braintrust}`);
  if (ctx.links.pr) lines.push(`PR: ${ctx.links.pr}`);
  if (ctx.links.issue) lines.push(`Issue: ${ctx.links.issue}`);
  return lines.join('\n');
}

export function toPlainText(md: string): string {
  return markdownToPlainText(md);
}

export function build(
  ctx: EmailContext,
  opts: { kind: string; subject: string; bodyMarkdown: string }
): EmailPayload {
  return {
    kind: opts.kind,
    to: ctx.to,
    subject: opts.subject,
    bodyMarkdown: opts.bodyMarkdown,
    bodyText: toPlainText(opts.bodyMarkdown),
    replyTo: ctx.replyTo,
    inboxEntryId: ctx.inboxEntryId,
    expectedActions: ctx.expectedActions,
    links: {
      arize: ctx.links.arize,
      braintrust: ctx.links.braintrust,
      pr: ctx.links.pr,
      issue: ctx.links.issue,
    },
  };
}

export function redact(s: string | undefined): string {
  return redactString(s ?? '');
}

export function reproTestLine(ctx: EmailContext): string {
  if (ctx.context.reproTestUrl && ctx.context.reproTestPath) {
    return `**Repro test:** [${ctx.context.reproTestPath}](${ctx.context.reproTestUrl})`;
  }
  if (ctx.context.reproTestPath) {
    return `**Repro test:** \`${ctx.context.reproTestPath}\``;
  }
  return '';
}
