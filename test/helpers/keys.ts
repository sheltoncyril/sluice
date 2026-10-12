import { generateKeyPairSync } from 'node:crypto';

/** Fresh RSA key in both encodings GitHub / WebCrypto care about. Generated per test run, never committed. */
export function makeAppKeys(): { pkcs1: string; pkcs8: string } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    pkcs1: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    pkcs8: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
