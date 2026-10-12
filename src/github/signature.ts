/**
 * X-Hub-Signature-256 verification using WebCrypto.
 *
 * `crypto.subtle.verify` for HMAC compares in constant time, so a mismatch leaks nothing about how
 * many leading bytes were right. We hash the exact bytes GitHub sent (never a re-serialised JSON).
 */

const HEADER_RE = /^sha256=([0-9a-fA-F]{64})$/;
const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** Returns true only when `header` is a well-formed `sha256=<hex>` matching the HMAC of `body`. */
export async function verifyWebhookSignature(
  secret: string,
  body: BufferSource,
  header: string | null | undefined,
): Promise<boolean> {
  if (!secret || !header) return false;
  const match = HEADER_RE.exec(header.trim());
  if (!match) return false;
  try {
    const key = await hmacKey(secret, 'verify');
    return await crypto.subtle.verify('HMAC', key, hexToBytes(match[1]!), body);
  } catch {
    return false;
  }
}

/** Compute the header value GitHub would send. Used by tests and the admin tooling. */
export async function signWebhookPayload(secret: string, body: string | BufferSource): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  const data = typeof body === 'string' ? encoder.encode(body) : body;
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return `sha256=${bytesToHex(new Uint8Array(sig))}`;
}
