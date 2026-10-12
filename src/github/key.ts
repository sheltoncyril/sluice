/**
 * GitHub gives you a PKCS#1 key ("-----BEGIN RSA PRIVATE KEY-----"). WebCrypto, and therefore
 * Workers, can only import PKCS#8 ("-----BEGIN PRIVATE KEY-----"). Convert it once:
 *
 *   node scripts/convert-private-key.mjs path/to/app.private-key.pem > private-key-pkcs8.pem
 *   # or: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out pkcs8.pem
 */

export class PrivateKeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivateKeyFormatError';
  }
}

/** Undo the common paste mistakes: literal "\n" sequences, CRLF, surrounding quotes/whitespace. */
export function normalizePrivateKey(raw: string): string {
  let pem = raw.trim();
  if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) {
    pem = pem.slice(1, -1);
  }
  pem = pem.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  return `${pem}\n`;
}

/** Throws a message that tells the operator exactly what to do. Never echoes key material. */
export function assertPkcs8(pem: string): void {
  if (/-----BEGIN RSA PRIVATE KEY-----/.test(pem)) {
    throw new PrivateKeyFormatError(
      'GITHUB_APP_PRIVATE_KEY is a PKCS#1 key (BEGIN RSA PRIVATE KEY). Workers need PKCS#8 (BEGIN PRIVATE KEY): ' +
        'run `node scripts/convert-private-key.mjs <key.pem> > pkcs8.pem` and re-upload with `wrangler secret put GITHUB_APP_PRIVATE_KEY`.',
    );
  }
  if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(pem)) {
    throw new PrivateKeyFormatError(
      'GITHUB_APP_PRIVATE_KEY is not a PEM-encoded PKCS#8 private key (expected BEGIN PRIVATE KEY … END PRIVATE KEY).',
    );
  }
}

/** Prove the key actually imports for RS256 signing, the way the JWT library will use it. */
export async function assertKeyImports(pem: string): Promise<void> {
  assertPkcs8(pem);
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  let der: Uint8Array<ArrayBuffer>;
  try {
    const bin = atob(body);
    der = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  } catch {
    throw new PrivateKeyFormatError('GITHUB_APP_PRIVATE_KEY is not valid base64 PEM.');
  }
  try {
    await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new PrivateKeyFormatError('GITHUB_APP_PRIVATE_KEY could not be imported as an RSA PKCS#8 signing key.');
  }
}
