/**
 * Resend mail integration. Provides:
 *  - ResendMailClient: implements GmailClient (sendEmail real, list/markRead are no-ops)
 *  - Plus-addressing helpers for runId-encoded reply-to addresses
 *  - Inbound webhook verification + parsing (Svix-signed)
 *
 * Inbound replies are pushed to us via Resend's `email.received` webhook
 * instead of being polled. The runId travels in the To address local-part:
 *
 *     bot+<runId>@<inbound-domain>     (we send with this as Reply-To)
 *
 * When the PM hits Reply, their client sends to bot+<runId>@..., the webhook
 * fires, we extract <runId>, fetch the body via the receiving API, and route
 * to the in-process IntrospectionReplyWaiter.
 */
import { Resend } from 'resend';

import {
  GmailClient,
  GmailMessage,
  GmailReply,
  GmailSendError,
  GmailSendResult,
} from './gmail-types';

/** Plus-addressing separator. RFC 5233 standard. */
const PLUS = '+';

/**
 * Build a per-runId reply-to address using plus-addressing.
 * Example: formatPlusReplyTo("bot@example.com", "abc123") -> "bot+abc123@example.com"
 *
 * runId is normalized to be safe in an email local-part:
 *   - lowercased
 *   - non-[a-z0-9-] chars replaced with '-'
 *   - leading/trailing '-' stripped
 */
export function formatPlusReplyTo(baseAddress: string, runId: string): string {
  const at = baseAddress.indexOf('@');
  if (at <= 0) {
    throw new Error(`Invalid base address (no @ or empty local-part): ${baseAddress}`);
  }
  const local = baseAddress.slice(0, at);
  const domain = baseAddress.slice(at + 1);
  const safe = encodeRunIdForLocalPart(runId);
  return `${local}${PLUS}${safe}@${domain}`;
}

/** Encode a runId so it survives as the suffix of an email local-part. */
export function encodeRunIdForLocalPart(runId: string): string {
  return runId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/**
 * Extract a runId from a plus-addressed email recipient.
 * Returns null when the address has no '+' suffix.
 */
export function parseRunIdFromAddress(addr: string): string | null {
  const cleaned = stripDisplayName(addr).trim().toLowerCase();
  const at = cleaned.indexOf('@');
  if (at <= 0) return null;
  const local = cleaned.slice(0, at);
  const plus = local.indexOf(PLUS);
  if (plus < 0) return null;
  const suffix = local.slice(plus + 1);
  return suffix.length > 0 ? suffix : null;
}

/** Strip "Name <addr>" wrapping if present, returning just the bare address. */
export function stripDisplayName(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return m ? m[1] : addr;
}

/**
 * Resend-backed GmailClient. Send is real; the list/markAsRead methods are
 * no-ops because inbound is handled via webhook, not polling.
 */
export class ResendMailClient implements GmailClient {
  private readonly resend: Resend;
  private readonly fromAddress: string;

  constructor(opts: { resend: Resend; fromAddress: string }) {
    this.resend = opts.resend;
    this.fromAddress = opts.fromAddress;
  }

  async sendEmail(message: GmailMessage): Promise<GmailSendResult> {
    try {
      const headers: Record<string, string> = {};
      // If caller supplied an upstream message-id via threadId we use it for
      // RFC threading. The Gmail impl uses threadId differently; this is
      // best-effort and harmless when callers don't set it.
      if (message.threadId) {
        headers['In-Reply-To'] = message.threadId;
        headers['References'] = message.threadId;
      }

      const resp = await this.resend.emails.send({
        from: this.fromAddress,
        to: [message.to],
        subject: message.subject,
        text: message.body,
        replyTo: message.replyTo,
        headers: Object.keys(headers).length ? headers : undefined,
      });

      // resend SDK returns { data, error }. Surface the error path explicitly.
      if ((resp as any).error) {
        const err = (resp as any).error;
        throw new Error(typeof err === 'string' ? err : err.message ?? JSON.stringify(err));
      }

      const data = (resp as any).data ?? resp;
      const id: string = data?.id ?? '';
      if (!id) {
        throw new Error('Resend API returned no message id');
      }
      // We don't track Gmail-style threads on the wire; expose the message id
      // as both messageId and threadId so callers can chain it as In-Reply-To.
      return {
        success: true,
        messageId: `<${id}@resend>`,
        threadId: `<${id}@resend>`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new GmailSendError(`Resend send failed: ${msg}`, message.to, message.subject);
    }
  }

  async listUnreadMessages(): Promise<GmailReply[]> {
    return [];
  }

  async markAsRead(): Promise<void> {
    // no-op: inbound is push-based via webhook
  }
}

/**
 * Inbound webhook event shape (Resend `email.received`).
 * We only model the fields we use.
 */
export interface ResendInboundEvent {
  type: string;
  created_at?: string;
  data: {
    email_id: string;
    created_at?: string;
    from: string;
    to: string[];
    bcc?: string[];
    cc?: string[];
    message_id: string;
    subject: string;
  };
}

/** Minimal shape of the receiving API response. */
export interface ResendReceivedEmailContent {
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string> | null;
}

/**
 * Verify the webhook signature using Resend's SDK (Svix-format).
 * Returns the parsed event on success; throws on invalid signature.
 */
export function verifyResendWebhook(
  resend: Resend,
  rawPayload: string,
  headers: { 'svix-id'?: string; 'svix-timestamp'?: string; 'svix-signature'?: string },
  webhookSecret: string
): ResendInboundEvent {
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signature = headers['svix-signature'];
  if (!id || !timestamp || !signature) {
    throw new Error('Missing svix-* headers on webhook');
  }
  const verified = (resend as any).webhooks.verify({
    payload: rawPayload,
    headers: { id, timestamp, signature },
    webhookSecret,
  });
  return verified as ResendInboundEvent;
}

/**
 * Fetch the parsed body for a received email.
 */
export async function fetchInboundContent(
  resend: Resend,
  emailId: string
): Promise<ResendReceivedEmailContent> {
  const resp: any = await (resend as any).emails.receiving.get(emailId);
  if (resp?.error) {
    const err = resp.error;
    throw new Error(typeof err === 'string' ? err : err.message ?? JSON.stringify(err));
  }
  const data = resp?.data ?? resp;
  return {
    text: data?.text ?? null,
    html: data?.html ?? null,
    headers: data?.headers ?? null,
  };
}

/**
 * Map a verified inbound event + fetched content to a GmailReply, returning
 * the runId to dispatch to. Returns null when no runId can be extracted (the
 * caller should ignore the message — likely not a reply we initiated).
 */
export function buildReplyFromInbound(
  event: ResendInboundEvent,
  content: ResendReceivedEmailContent
): { runId: string; reply: GmailReply } | null {
  if (event.type !== 'email.received') return null;
  const data = event.data;
  // Try every recipient; the first plus-addressed one wins.
  const allRecipients = [
    ...(data.to ?? []),
    ...(data.cc ?? []),
    ...(data.bcc ?? []),
  ];
  let runId: string | null = null;
  for (const r of allRecipients) {
    const parsed = parseRunIdFromAddress(r);
    if (parsed) {
      runId = parsed;
      break;
    }
  }
  if (!runId) return null;

  const body = (content.text ?? stripHtml(content.html ?? '')).trim();

  const reply: GmailReply = {
    messageId: data.message_id,
    // We don't have a Gmail thread id; surface the upstream message_id again
    // as the threadId — downstream code only uses it for routing, which we
    // skip in favor of the explicit runId.
    threadId: data.message_id,
    body,
    from: data.from,
    receivedAt: data.created_at ?? event.created_at ?? new Date().toISOString(),
    subject: data.subject,
  };
  return { runId, reply };
}

/** Crude HTML → text fallback used when the inbound payload only has html. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>(\r?\n)?/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
