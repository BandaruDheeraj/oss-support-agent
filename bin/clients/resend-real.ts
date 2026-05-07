/**
 * Resend-backed mail wiring used by the live webhook server.
 *
 * Builds a ResendMailClient from env vars and provides a `dispatchInbound`
 * function that the HTTP /inbound route can call directly.
 */
import { Resend } from 'resend';

import {
  ResendMailClient,
  verifyResendWebhook,
  fetchInboundContent,
  buildReplyFromInbound,
  formatPlusReplyTo,
} from '../../core/resend-mail';
import type { IntrospectionReplyWaiter } from '../../core/introspection-email-loop';
import type { EmailThread, GmailReply } from '../../core/gmail-types';

export interface ResendDeps {
  client: ResendMailClient;
  resend: Resend;
  /** "bot@inbound.example.com" — the base address; replies go to bot+<runId>@... */
  replyToBase: string;
  /** "bot@verified-domain.com" — From: header on outbound. */
  fromAddress: string;
  /**
   * Verify + parse an inbound webhook delivery and dispatch to the waiter.
   * Returns a status payload suitable for the HTTP response.
   */
  dispatchInbound: (
    rawBody: string,
    headers: { 'svix-id'?: string; 'svix-timestamp'?: string; 'svix-signature'?: string },
    waiter: IntrospectionReplyWaiter,
    log: (msg: string) => void
  ) => Promise<{ status: number; body: any }>;
}

export interface BuildResendDepsResult {
  deps: ResendDeps;
  webhookSecret: string;
}

/**
 * Returns null when required env vars are missing.
 */
export function buildResendDepsFromEnv(
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void
): BuildResendDepsResult | null {
  const apiKey = env.RESEND_API_KEY;
  const fromAddress = env.RESEND_FROM_ADDRESS;
  const replyToBase = env.RESEND_REPLY_TO_BASE ?? env.RESEND_FROM_ADDRESS;
  const webhookSecret = env.RESEND_WEBHOOK_SECRET;

  const missing: string[] = [];
  if (!apiKey) missing.push('RESEND_API_KEY');
  if (!fromAddress) missing.push('RESEND_FROM_ADDRESS');
  if (!webhookSecret) missing.push('RESEND_WEBHOOK_SECRET');
  if (missing.length > 0) {
    log(`[resend] env vars missing (${missing.join(', ')}); Resend mail flows disabled`);
    return null;
  }

  const resend = new Resend(apiKey!);
  const client = new ResendMailClient({ resend, fromAddress: fromAddress! });

  const dispatchInbound: ResendDeps['dispatchInbound'] = async (
    rawBody,
    headers,
    waiter,
    dlog
  ) => {
    let event;
    try {
      event = verifyResendWebhook(resend, rawBody, headers, webhookSecret!);
    } catch (err: any) {
      dlog(`[inbound] signature verify failed: ${err?.message ?? err}`);
      return { status: 401, body: { error: 'invalid signature' } };
    }

    if (event.type !== 'email.received') {
      return { status: 200, body: { status: 'ignored', reason: `type=${event.type}` } };
    }

    let content;
    try {
      content = await fetchInboundContent(resend, event.data.email_id);
    } catch (err: any) {
      dlog(`[inbound] fetch content failed for ${event.data.email_id}: ${err?.message ?? err}`);
      return { status: 502, body: { error: 'fetch-content-failed' } };
    }

    const built = buildReplyFromInbound(event, content);
    if (!built) {
      dlog(`[inbound] no runId in recipients of ${event.data.email_id} (to=${JSON.stringify(event.data.to)})`);
      return { status: 200, body: { status: 'ignored', reason: 'no-runid' } };
    }

    // Stub thread so we satisfy the ReplyHandler signature; consumers only use `reply`.
    const stubThread: EmailThread = {
      runId: built.runId,
      threadId: built.reply.threadId,
      subject: built.reply.subject,
      conversationHistory: [],
    };
    const reply: GmailReply = built.reply;

    dlog(`[inbound] dispatching reply to runId=${built.runId} from=${reply.from}`);
    await waiter.onReply(built.runId, reply, stubThread);
    return { status: 200, body: { status: 'dispatched', runId: built.runId } };
  };

  return {
    deps: {
      client,
      resend,
      fromAddress: fromAddress!,
      replyToBase: replyToBase!,
      dispatchInbound,
    },
    webhookSecret: webhookSecret!,
  };
}

export { formatPlusReplyTo };
