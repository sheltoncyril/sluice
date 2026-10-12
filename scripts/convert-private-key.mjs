#!/usr/bin/env node
/**
 * Convert a GitHub App private key from PKCS#1 ("BEGIN RSA PRIVATE KEY", what GitHub gives you)
 * to PKCS#8 ("BEGIN PRIVATE KEY", what WebCrypto / Cloudflare Workers can import).
 *
 *   node scripts/convert-private-key.mjs app.private-key.pem > private-key-pkcs8.pem
 *   wrangler secret put GITHUB_APP_PRIVATE_KEY < private-key-pkcs8.pem
 *
 * Already-PKCS#8 input passes through unchanged, so the script is safe to re-run. The key is only
 * ever written to stdout; nothing is logged.
 */
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path || path === '-h' || path === '--help') {
  console.error('usage: node scripts/convert-private-key.mjs <app-private-key.pem> > private-key-pkcs8.pem');
  process.exit(path ? 0 : 2);
}

let pem;
try {
  pem = readFileSync(path, 'utf8');
} catch (e) {
  console.error(`cannot read ${path}: ${e.code ?? e.message}`);
  process.exit(1);
}

try {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa') throw new Error(`expected an RSA key, got ${key.asymmetricKeyType}`);
  process.stdout.write(key.export({ type: 'pkcs8', format: 'pem' }));
} catch (e) {
  console.error(`not a usable RSA private key: ${e.message}`);
  process.exit(1);
}
