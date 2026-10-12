import sodium from 'libsodium-wrappers';
import type { FakeGitHub } from './fake-github';

/**
 * libsodium (the reference implementation GitHub's own docs use) as an independent ORACLE: whatever our
 * pure-JS sealer produces must open with it. libsodium is a test-only dependency (it cannot run on
 * Workers), so nothing in src/ imports it.
 */
export async function openWithLibsodium(sealedBase64: string, publicKey: Uint8Array, secretKey: Uint8Array): Promise<string> {
  await sodium.ready;
  const sealed = sodium.from_base64(sealedBase64, sodium.base64_variants.ORIGINAL);
  return new TextDecoder().decode(sodium.crypto_box_seal_open(sealed, publicKey, secretKey));
}

/** What GitHub would do with the stored ciphertext: decrypt it with the repo's private key. */
export async function revealSecret(gh: FakeGitHub, repo: string, name: string): Promise<string | undefined> {
  const sealed = gh.sealedSecret(repo, name);
  if (sealed === undefined) return undefined;
  const { publicKey, secretKey } = gh.actionsKeys(repo);
  return openWithLibsodium(sealed, publicKey, secretKey);
}

export async function sealWithLibsodium(plaintext: string, publicKey: Uint8Array): Promise<string> {
  await sodium.ready;
  return sodium.to_base64(sodium.crypto_box_seal(plaintext, publicKey), sodium.base64_variants.ORIGINAL);
}
