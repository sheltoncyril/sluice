import { blake2b } from 'blakejs';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { fromBase64, NaclSealer, SealError, toBase64 } from '../src/secrets/sealer';
import { openWithLibsodium, sealWithLibsodium } from './helpers/sodium';

const keys = () => nacl.box.keyPair();
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

describe('NaclSealer interoperates with libsodium (the reference GitHub uses)', () => {
  it.each([
    ['one byte', 'x'],
    ['an ordinary token', 'ghp_' + 'A1b2C3d4'.repeat(5)],
    ['multi-byte unicode', 'pässwörd-日本語-🔐'],
    ['newlines and quotes (a PEM-ish value)', '-----BEGIN KEY-----\nabc"def\\ghi\n-----END KEY-----\n'],
    ['the 48 KB maximum', 'z'.repeat(48 * 1024)],
  ])('seals %s and libsodium opens it', async (_name, secret) => {
    const kp = keys();
    const sealed = await new NaclSealer().seal(secret, b64(kp.publicKey));
    expect(await openWithLibsodium(sealed, kp.publicKey, kp.secretKey)).toBe(secret);
  });

  it('agrees with libsodium on layout and nonce derivation (open a LIBSODIUM-sealed message our way)', async () => {
    // Opening the reference implementation's output with only tweetnacl + our nonce rule proves the
    // construction is the standard one, not merely something we can read back ourselves.
    const kp = keys();
    const sealed = fromBase64(await sealWithLibsodium('from the reference implementation', kp.publicKey));
    const epk = sealed.slice(0, 32);
    const nonceInput = new Uint8Array(64);
    nonceInput.set(epk, 0);
    nonceInput.set(kp.publicKey, 32);
    const opened = nacl.box.open(sealed.slice(32), blake2b(nonceInput, undefined, 24), epk, kp.secretKey);
    expect(opened && new TextDecoder().decode(opened)).toBe('from the reference implementation');
  });

  it('output is ephemeralPublicKey(32) + ciphertext + MAC(16)', async () => {
    const kp = keys();
    const sealed = fromBase64(await new NaclSealer().seal('hello', b64(kp.publicKey)));
    expect(sealed.length).toBe(32 + 5 + 16);
  });

  it('is randomised: sealing the same value twice gives different ciphertext', async () => {
    const kp = keys();
    const sealer = new NaclSealer();
    expect(await sealer.seal('same', b64(kp.publicKey))).not.toBe(await sealer.seal('same', b64(kp.publicKey)));
  });

  it('is deterministic given the same randomness (so the construction is testable)', async () => {
    const kp = keys();
    const rng = () => new Uint8Array(32).fill(7);
    const a = await new NaclSealer(rng).seal('same', b64(kp.publicKey));
    const b = await new NaclSealer(rng).seal('same', b64(kp.publicKey));
    expect(a).toBe(b);
  });

  it('only the intended recipient can open it', async () => {
    const mine = keys();
    const other = keys();
    const sealed = await new NaclSealer().seal('for me only', b64(mine.publicKey));
    await expect(openWithLibsodium(sealed, other.publicKey, other.secretKey)).rejects.toThrow();
  });

  it('wipes the ephemeral private key after use', async () => {
    const kp = keys();
    const esk = new Uint8Array(32).fill(9);
    await new NaclSealer(() => esk).seal('x', b64(kp.publicKey));
    expect([...esk].every((b) => b === 0)).toBe(true);
  });
});

describe('NaclSealer errors never mention the plaintext', () => {
  const secret = 'PLAINTEXT-MUST-NOT-APPEAR';

  it('rejects a key of the wrong length', async () => {
    const err = await new NaclSealer().seal(secret, b64(new Uint8Array(31))).catch((e) => e);
    expect(err).toBeInstanceOf(SealError);
    expect(err.message).toMatch(/32 bytes/);
    expect(err.message).not.toContain(secret);
  });

  it('rejects a key that is not base64', async () => {
    const err = await new NaclSealer().seal(secret, '***not base64***').catch((e) => e);
    expect(err).toBeInstanceOf(SealError);
    expect(err.message).not.toContain(secret);
  });
});

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });
});
