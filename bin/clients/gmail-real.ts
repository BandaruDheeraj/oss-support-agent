/**
 * Real Gmail client using googleapis with OAuth refresh-token auth.
 *
 * Setup (do this once for the bot mailbox):
 *   1. Create a Google Cloud project, enable the Gmail API.
 *   2. Create an OAuth client (type "Desktop" or "Web").
 *   3. Use the OAuth playground or a one-off script to obtain a refresh token
 *      with scope https://www.googleapis.com/auth/gmail.modify.
 *   4. Set env vars:
 *        GMAIL_CLIENT_ID
 *        GMAIL_CLIENT_SECRET
 *        GMAIL_REFRESH_TOKEN
 *        GMAIL_USER_EMAIL    (the From address)
 */

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import type {
  GmailClient,
  GmailMessage,
  GmailReply,
  GmailSendResult,
} from '../../core/gmail-types';
import { GmailSendError } from '../../core/gmail-types';

export interface RealGmailOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  userEmail: string;
}

function buildAuth(opts: RealGmailOptions): OAuth2Client {
  const auth = new google.auth.OAuth2({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
  });
  auth.setCredentials({ refresh_token: opts.refreshToken });
  return auth;
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeBase64Url(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64').toString('utf-8');
}

function buildRfc822(message: GmailMessage, from: string): string {
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Reply-To: ${message.replyTo}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `MIME-Version: 1.0`,
  ];
  return `${headers.join('\r\n')}\r\n\r\n${message.body}`;
}

function extractTextFromPayload(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';

  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts && payload.parts.length > 0) {
    // Prefer text/plain; fall back to text/html stripped of tags.
    const plain = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (plain) return extractTextFromPayload(plain);

    const html = payload.parts.find((p) => p.mimeType === 'text/html');
    if (html) {
      const raw = extractTextFromPayload(html);
      return raw.replace(/<[^>]+>/g, '');
    }

    // Multipart/alternative or mixed — recurse.
    for (const part of payload.parts) {
      const txt = extractTextFromPayload(part);
      if (txt) return txt;
    }
  }

  return '';
}

function findHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  if (!headers) return '';
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

export class RealGmailClient implements GmailClient {
  private gmail: gmail_v1.Gmail;
  constructor(private readonly opts: RealGmailOptions) {
    this.gmail = google.gmail({ version: 'v1', auth: buildAuth(opts) });
  }

  async sendEmail(message: GmailMessage): Promise<GmailSendResult> {
    try {
      const raw = encodeBase64Url(buildRfc822(message, this.opts.userEmail));
      const res = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw,
          ...(message.threadId ? { threadId: message.threadId } : {}),
        },
      });
      return {
        success: true,
        messageId: res.data.id ?? '',
        threadId: res.data.threadId ?? '',
      };
    } catch (err: any) {
      throw new GmailSendError(
        `Gmail send failed: ${err?.message ?? err}`,
        message.to,
        message.subject
      );
    }
  }

  async listUnreadMessages(query: string): Promise<GmailReply[]> {
    const list = await this.gmail.users.messages.list({
      userId: 'me',
      q: `is:unread ${query}`,
      maxResults: 50,
    });

    const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
    const replies: GmailReply[] = [];

    for (const id of ids) {
      const detail = await this.gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'full',
      });
      const msg = detail.data;
      const headers = msg.payload?.headers;
      const body = extractTextFromPayload(msg.payload);
      replies.push({
        messageId: msg.id ?? id,
        threadId: msg.threadId ?? '',
        body,
        from: findHeader(headers, 'From'),
        receivedAt: msg.internalDate
          ? new Date(parseInt(msg.internalDate, 10)).toISOString()
          : new Date().toISOString(),
        subject: findHeader(headers, 'Subject'),
      });
    }

    return replies;
  }

  async markAsRead(messageId: string): Promise<void> {
    await this.gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
  }
}

export function buildGmailClientFromEnv(env: NodeJS.ProcessEnv): RealGmailClient | null {
  const id = env.GMAIL_CLIENT_ID;
  const secret = env.GMAIL_CLIENT_SECRET;
  const refresh = env.GMAIL_REFRESH_TOKEN;
  const user = env.GMAIL_USER_EMAIL;
  if (!id || !secret || !refresh || !user) return null;
  return new RealGmailClient({
    clientId: id,
    clientSecret: secret,
    refreshToken: refresh,
    userEmail: user,
  });
}
