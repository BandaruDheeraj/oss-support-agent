/**
 * Reply-mapping agent: ingest a Resend inbound email, route to its inbox
 * entry, and produce a structured action via generateObject.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '../../llm/v2/client';
import { withAgentSpan } from '../../observability/spans';
import { redactString } from '../../observability/redact';
import { InboxStore } from './inbox-store';
import { parsePlusAddress } from './trace-and-dossier-links';

export const MappedActionSchema = z.object({
  action: z.string().min(1),
  confidence: z.number().min(0).max(1),
  hint: z.string().optional(),
  needsClarification: z.boolean().default(false),
  clarificationQuestion: z.string().optional(),
});
export type MappedAction = z.infer<typeof MappedActionSchema>;

export interface InboundEmail {
  inboundMessageId: string;   // e.g. RFC822 Message-ID
  to: string;                 // Reply-To plus-address we should parse
  from: string;
  subject: string;
  bodyText: string;           // already-stripped if you have stripping logic
  rawBody?: string;
}

export interface IngestResult {
  ok: boolean;
  inboxEntryId?: string;
  status?: string;
  mapped?: MappedAction;
  reason?: string;
}

export async function ingestInboundEmail(email: InboundEmail, store: InboxStore): Promise<IngestResult> {
  // 1. Idempotency: drop replays of the same message-id
  if (email.inboundMessageId && store.byInboundMessageId(email.inboundMessageId)) {
    return { ok: true, reason: 'duplicate_message_id_noop' };
  }

  // 2. Route via plus-addressed inbox entry id
  const route = parsePlusAddress(email.to);
  if (!route) return { ok: false, reason: 'no_plus_address_route' };

  const entry = store.get(route.inboxEntryId);
  if (!entry) return { ok: false, reason: 'unknown_inbox_entry' };
  if (entry.nonce !== route.nonce) return { ok: false, reason: 'nonce_mismatch' };
  if (entry.status === 'superseded' || entry.status === 'expired') {
    return { ok: true, inboxEntryId: entry.id, status: entry.status, reason: 'closed_entry_noop' };
  }
  if (entry.status === 'mapped' || entry.status === 'resumed') {
    return { ok: true, inboxEntryId: entry.id, status: entry.status, reason: 'already_mapped' };
  }

  // 3. CAS to reply_received
  const accepted = store.transition(entry.id, entry.status as 'sent' | 'needs_clarification', 'reply_received', {
    raw_reply: email.rawBody ?? email.bodyText,
    stripped_reply: redactString(email.bodyText).slice(0, 8000),
    inbound_message_id: email.inboundMessageId,
  });
  if (!accepted) return { ok: false, inboxEntryId: entry.id, reason: 'cas_conflict' };

  const expectedActions = JSON.parse(entry.expected_actions) as string[];

  // 4. One-shot LLM mapping
  const mapped = await withAgentSpan(
    'REPLY_MAPPER',
    { attempt_id: entry.attempt_id, issue_number: 0, inbox_entry_id: entry.id, 'inbox.kind': entry.kind },
    async () => {
      try {
        const result = await generateObject({
          model: getModel('REPLY_MAPPER'),
          schema: MappedActionSchema,
          system: `You map a human email reply to a discrete action. The expected actions are: ${expectedActions.join(', ')}.

Return needsClarification=true and provide a clarificationQuestion when the reply is ambiguous, off-topic, or not in expected actions.
Be strict: confidence < 0.6 means clarification is required.`,
          prompt: `Email kind: ${entry.kind}\nExpected actions: ${expectedActions.join(', ')}\nSubject: ${redactString(email.subject)}\nReply body:\n${redactString(email.bodyText).slice(0, 4000)}`,
          experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
        });
        return result.object;
      } catch (err) {
        return {
          action: 'unknown',
          confidence: 0,
          needsClarification: true,
          clarificationQuestion: 'Mapping LLM failed; please reply with one of the expected actions explicitly.',
        };
      }
    }
  );

  // 5. Decide next status
  const inExpected = expectedActions.includes(mapped.action);
  if (!inExpected || mapped.confidence < 0.6 || mapped.needsClarification) {
    store.transition(entry.id, 'reply_received', 'needs_clarification', {
      mapping_confidence: mapped.confidence,
      mapped_action: inExpected ? mapped.action : null,
      mapping_error: mapped.needsClarification
        ? mapped.clarificationQuestion ?? 'low confidence'
        : `unexpected action "${mapped.action}"`,
    });
    return { ok: true, inboxEntryId: entry.id, status: 'needs_clarification', mapped };
  }

  store.transition(entry.id, 'reply_received', 'mapped', {
    mapping_confidence: mapped.confidence,
    mapped_action: mapped.action,
  });
  return { ok: true, inboxEntryId: entry.id, status: 'mapped', mapped };
}
