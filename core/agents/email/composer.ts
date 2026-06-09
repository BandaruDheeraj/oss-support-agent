/**
 * Email composer — typed payload, eight kinds, deterministic templates.
 *
 * Templates are pure functions over EmailContext. No LLM in the body
 * rendering path; the only LLM use is for optional headline/summary
 * polish (kept tightly scoped via generateObject in future work).
 */

import { z } from 'zod';
import {
  triageUnrelated,
  needCredentials,
  reproUnreachable,
  fixProposal,
  fixFailed,
  regressionBlocker,
  humanDecisionNeeded,
  prOpened,
  fixReadyForReview,
} from './templates';
import type { EmailContext } from './context';

export type EmailKind =
  | 'triage_unrelated'
  | 'need_credentials'
  | 'repro_unreachable'
  | 'fix_proposal'
  | 'fix_failed'
  | 'regression_blocker'
  | 'human_decision_needed'
  | 'pr_opened'
  | 'fix_ready_for_review';

export const EmailPayloadSchema = z.object({
  kind: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  bodyMarkdown: z.string(),
  bodyText: z.string(),
  replyTo: z.string().optional(),
  inboxEntryId: z.string().optional(),
  expectedActions: z.array(z.string()),
  links: z
    .object({
      phoenix: z.string().nullable().optional(),
      braintrust: z.string().nullable().optional(),
      pr: z.string().nullable().optional(),
      issue: z.string().nullable().optional(),
    })
    .optional(),
});

export type EmailPayload = z.infer<typeof EmailPayloadSchema>;

export interface ComposeOptions {
  kind: EmailKind;
  context: EmailContext;
}

export function composeEmail({ kind, context }: ComposeOptions): EmailPayload {
  switch (kind) {
    case 'triage_unrelated':
      return triageUnrelated(context);
    case 'need_credentials':
      return needCredentials(context);
    case 'repro_unreachable':
      return reproUnreachable(context);
    case 'fix_proposal':
      return fixProposal(context);
    case 'fix_failed':
      return fixFailed(context);
    case 'regression_blocker':
      return regressionBlocker(context);
    case 'human_decision_needed':
      return humanDecisionNeeded(context);
    case 'pr_opened':
      return prOpened(context);
    case 'fix_ready_for_review':
      return fixReadyForReview(context);
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unknown email kind: ${_exhaustive}`);
    }
  }
}
