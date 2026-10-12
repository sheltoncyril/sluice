import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';

/**
 * GitHub Actions secrets are written as libsodium "sealed boxes" (crypto_box_seal) addressed to a
 * per-repo public key. This is that construction in pure JS:
 *
 *   (epk, esk) = fresh X25519 keypair
 *   nonce      = BLAKE2b-24(epk || recipient_pk)
 *   sealed     = epk || crypto_box(message, nonce, recipient_pk, esk)      (XSalsa20-Poly1305)
 *
 * Why not libsodium-wrappers? It does not run on Cloudflare Workers: it asks for random bytes at module
 * load, and its WASM is instantiated from bytes at runtime, which the Workers runtime refuses
 * ("Wasm code generation disallowed by embedder"). libsodium is kept as a TEST dependency only, as an
 * independent oracle: tests seal here and open with libsodium to prove the two interoperate.
 */
export interface SecretSealer {
  /** Encrypt `plaintext` to a GitHub Actions public key (base64). Returns the sealed box, base64. */
  seal(plaintext: string, publicKeyBase64: string): Promise<string>;
}

export class SealError extends Error {
  constructor(message: string) {
    super(message); // never includes the plaintext
    this.name = 'SealError';
  }
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new SealError('public key is not valid base64');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const NONCE_BYTES = 24;
const KEY_BYTES = 32;

export class NaclSealer implements SecretSealer {
  /** `random` is injectable so tests can be deterministic; the default is the platform CSPRNG. */
  constructor(private readonly random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))) {}

  async seal(plaintext: string, publicKeyBase64: string): Promise<string> {
    const recipient = fromBase64(publicKeyBase64);
    if (recipient.length !== KEY_BYTES) throw new SealError(`public key must be ${KEY_BYTES} bytes, got ${recipient.length}`);

    const message = new TextEncoder().encode(plaintext);
    const esk = this.random(KEY_BYTES);
    try {
      const epk = nacl.scalarMult.base(esk);
      const nonceInput = new Uint8Array(KEY_BYTES * 2);
      nonceInput.set(epk, 0);
      nonceInput.set(recipient, KEY_BYTES);
      const nonce = blake2b(nonceInput, undefined, NONCE_BYTES);
      const box = nacl.box(message, nonce, recipient, esk);

      const sealed = new Uint8Array(KEY_BYTES + box.length);
      sealed.set(epk, 0);
      sealed.set(box, KEY_BYTES);
      return toBase64(sealed);
    } finally {
      // Best effort: JS strings cannot be wiped, but the byte copies and the ephemeral key can.
      message.fill(0);
      esk.fill(0);
    }
  }
}
