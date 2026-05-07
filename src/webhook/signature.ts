import * as crypto from 'crypto';

/**
 * Verify the X-Hub-Signature-256 HMAC signature on a GitHub webhook payload.
 * Returns true if the signature is valid, false otherwise.
 *
 * @param payload - Raw request body as a string or Buffer
 * @param signature - The value of the X-Hub-Signature-256 header
 * @param secret - The webhook secret
 */
export function verifySignature(
  payload: string | Buffer,
  signature: string | undefined | null,
  secret: string
): boolean {
  if (!signature) {
    return false;
  }

  const prefix = 'sha256=';
  if (!signature.startsWith(prefix)) {
    return false;
  }

  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const expected = `${prefix}${expectedHmac}`;

  // Constant-time comparison to prevent timing attacks
  if (expected.length !== signature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature)
  );
}

/**
 * Compute the X-Hub-Signature-256 HMAC for a payload.
 * Useful for tests.
 */
export function computeSignature(payload: string | Buffer, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${hmac}`;
}
