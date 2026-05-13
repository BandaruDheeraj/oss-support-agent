/**
 * HMAC-signed tokens for HITL approval links and Reply-To nonces.
 *
 * Token format: <base64url(payload)>.<base64url(hmac)>
 *   payload = JSON({inboxEntryId, prNumber, action, recipient, exp, jti})
 *   hmac    = HMAC-SHA256(HITL_SIGNING_KEY, payload)
 *
 * Verify() returns the parsed payload or throws on tamper / expiry.
 * Caller is responsible for checking InboxStore.isTokenConsumed(jti).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export interface TokenPayload {
  inboxEntryId: string;
  prNumber: number | null;
  action: string;
  recipient: string;
  exp: number; // epoch seconds
  jti: string;
}

export class HitlTokenError extends Error {
  public readonly kind: 'tampered' | 'expired' | 'malformed' | 'missing_key';
  constructor(kind: HitlTokenError['kind'], message: string) {
    super(message);
    this.name = 'HitlTokenError';
    this.kind = kind;
  }
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Buffer {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function getKey(): Buffer {
  const key = process.env.HITL_SIGNING_KEY;
  if (!key) throw new HitlTokenError('missing_key', 'HITL_SIGNING_KEY not set');
  return Buffer.from(key, 'utf8');
}

export function signToken(
  payload: Omit<TokenPayload, 'jti' | 'exp'> & { ttlSeconds: number; jti?: string }
): { token: string; payload: TokenPayload } {
  const exp = Math.floor(Date.now() / 1000) + payload.ttlSeconds;
  const jti = payload.jti ?? randomBytes(12).toString('hex');
  const tokenPayload: TokenPayload = {
    inboxEntryId: payload.inboxEntryId,
    prNumber: payload.prNumber,
    action: payload.action,
    recipient: payload.recipient,
    exp,
    jti,
  };
  const body = b64urlEncode(Buffer.from(JSON.stringify(tokenPayload), 'utf8'));
  const sig = b64urlEncode(createHmac('sha256', getKey()).update(body).digest());
  return { token: `${body}.${sig}`, payload: tokenPayload };
}

export function verifyToken(token: string): TokenPayload {
  const parts = token.split('.');
  if (parts.length !== 2) throw new HitlTokenError('malformed', 'token must be body.sig');
  const [body, sig] = parts;
  let provided: Buffer;
  try {
    provided = b64urlDecode(sig);
  } catch {
    throw new HitlTokenError('malformed', 'sig not base64url');
  }
  const expected = createHmac('sha256', getKey()).update(body).digest();
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new HitlTokenError('tampered', 'signature mismatch');
  }
  let payload: TokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    throw new HitlTokenError('malformed', 'payload not JSON');
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new HitlTokenError('expired', 'token expired');
  }
  return payload;
}

/** Compact nonce for Reply-To plus-addressing. Not signed with TTL; relies on InboxEntry.nonce lookup. */
export function makeNonce(): string {
  return randomBytes(8).toString('hex');
}
