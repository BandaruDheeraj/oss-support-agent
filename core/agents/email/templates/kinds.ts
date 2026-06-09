import type { EmailContext } from '../context';
import type { EmailPayload } from '../composer';
import { build, header, dossierBlock, decisionSection, footer, redact } from './shared';

export function triageUnrelated(ctx: EmailContext): EmailPayload {
  const md = [
    header(ctx, 'Issue appears unrelated to this project'),
    '',
    'The triage classifier marked this issue as **not actionable** for the OSS support agent.',
    '',
    redact(ctx.context.summary),
    dossierBlock(ctx),
    decisionSection(ctx, 'What should we do?'),
    footer(ctx),
  ].join('\n');
  return build(ctx, { kind: 'triage_unrelated', subject: `[osa] Triage: #${ctx.issueNumber} appears unrelated`, bodyMarkdown: md });
}

export function needCredentials(ctx: EmailContext): EmailPayload {
  const md = [
    header(ctx, 'Missing credential — pipeline halted'),
    '',
    `Bootstrap detected a missing credential: \`${ctx.context.missingCredential ?? 'unknown'}\`.`,
    '',
    'Please reply with the credential reference (env var name) or instructions on how the agent should authenticate.',
    decisionSection(ctx, 'Reply to unblock'),
    footer(ctx),
  ].join('\n');
  return build(ctx, { kind: 'need_credentials', subject: `[osa] Need credentials for #${ctx.issueNumber}`, bodyMarkdown: md });
}

export function reproUnreachable(ctx: EmailContext): EmailPayload {
  const md = [
    header(ctx, 'Repro could not be produced'),
    '',
    'The Repro loop was unable to converge on a failing test that reproduces the reported behaviour.',
    '',
    '**Last failure snippet:**',
    '```',
    redact(ctx.context.failureSnippet).slice(0, 2000),
    '```',
    dossierBlock(ctx),
    decisionSection(ctx, 'Please advise'),
    footer(ctx),
  ].join('\n');
  return build(ctx, { kind: 'repro_unreachable', subject: `[osa] Repro unreachable for #${ctx.issueNumber}`, bodyMarkdown: md });
}

export function fixProposal(ctx: EmailContext): EmailPayload {
  const md = [
    header(ctx, 'Proposed fix ready for review'),
    '',
    '**What the issue is:**',
    redact(ctx.context.summary),
    '',
    '**How we reproduced it:**',
    '```',
    redact(ctx.context.failureSnippet).slice(0, 1500),
    '```',
    '',
    '**Proposed fix approach:**',
    redact(ctx.context.fixApproach),
    '',
    '**Diff summary:**',
    redact(ctx.context.diffSummary),
    '',
    '**Changed files:**',
    ...(ctx.context.changedFiles ?? []).map((f) => `- \`${f}\``),
    '',
    '**Tests passed outside repro:** ' + (ctx.context.testsRunOutside?.join(', ') || '(none)'),
    dossierBlock(ctx),
    decisionSection(ctx, 'Approve and open PR?'),
    footer(ctx),
  ].join('\n');
  return build(ctx, { kind: 'fix_proposal', subject: `[osa] Fix proposal for #${ctx.issueNumber}`, bodyMarkdown: md });
}

export function fixFailed(ctx: EmailContext): EmailPayload {
  const md = [
    header(ctx, 'Fix attempts exhausted'),
    '',
    'The Fix loop could not converge on a passing fix within the retry budget.',
    '',
    '**Last failure:**',
    '```',
    redact(ctx.context.failureSnippet).slice(0, 2000),
    '```',
    dossierBlock(ctx),
    decisionSection(ctx, 'Please advise'),
    footer(ctx),
  ].join('\n');
  return build(ctx, { kind: 'fix_failed', subject: `[osa] Fix failed for #${ctx.issueNumber}`, bodyMarkdown: md });
}

export function regressionBlocker(ctx: EmailContext): EmailPayload {
  const md = [
    header(ctx, 'Regression guard blocked the fix'),
    '',
    `**Regression status:** ${ctx.context.regressionStatus ?? 'unknown'}`,
    `**Failure kind:** ${ctx.context.failureKind ?? 'unspecified'}`,
    '',
    '**Output:**',
    '```',
    redact(ctx.context.failureSnippet).slice(0, 2500),
    '```',
    dossierBlock(ctx),
    decisionSection(ctx, 'Override or abandon?'),
    footer(ctx),
  ].join('\n');
  return build(ctx, { kind: 'regression_blocker', subject: `[osa] Regression blocker on #${ctx.issueNumber}`, bodyMarkdown: md });
}

export function humanDecisionNeeded(ctx: EmailContext): EmailPayload {
  const md = [
    header(ctx, 'Human decision needed'),
    '',
    redact(ctx.context.humanQuestion),
    dossierBlock(ctx),
    decisionSection(ctx, 'Please choose'),
    footer(ctx),
  ].join('\n');
  return build(ctx, { kind: 'human_decision_needed', subject: `[osa] Human decision needed for #${ctx.issueNumber}`, bodyMarkdown: md });
}

export function fixReadyForReview(ctx: EmailContext): EmailPayload {
  const md = [
    header(ctx, 'Fix committed — ready for your review'),
    '',
    '> The agent committed a fix to the branch listed below. GHA sandbox verification',
    '> could not run automatically, so the fix needs manual review before merging.',
    '',
    '## Root cause analysis',
    redact(ctx.context.summary),
    '',
    '## Fix approach',
    redact(ctx.context.fixApproach),
    '',
    '## Branch & commit',
    ctx.context.branchUrl ? `**Branch:** [${ctx.context.branchUrl}](${ctx.context.branchUrl})` : '',
    ctx.context.commitSha ? `**Commit SHA:** \`${ctx.context.commitSha}\`` : '',
    ctx.context.reproTestPath ? `**Repro test:** \`${ctx.context.reproTestPath}\`` : '',
    '',
    '## Changed files',
    ...(ctx.context.changedFiles ?? []).map((f) => `- \`${f}\``),
    '',
    '## Diff',
    '```diff',
    redact(ctx.context.diff ?? '(diff unavailable)').slice(0, 20_000),
    '```',
    dossierBlock(ctx),
    footer(ctx),
  ].filter(Boolean).join('\n');
  return build(ctx, {
    kind: 'fix_ready_for_review',
    subject: `[osa] Fix ready for review — #${ctx.issueNumber}`,
    bodyMarkdown: md,
  });
}

export function prOpened(ctx: EmailContext): EmailPayload {
  const md = [
    header(ctx, 'PR opened from approved fix'),
    '',
    `PR: ${ctx.prUrl ?? '(no url)'}`,
    '',
    'This email is informational; no action required.',
    footer(ctx),
  ].join('\n');
  return build(ctx, { kind: 'pr_opened', subject: `[osa] PR opened for #${ctx.issueNumber}`, bodyMarkdown: md });
}
