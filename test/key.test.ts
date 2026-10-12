import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertKeyImports, assertPkcs8, normalizePrivateKey, PrivateKeyFormatError } from '../src/github/key';
import { makeAppKeys } from './helpers/keys';

const keys = makeAppKeys();

describe('private key handling', () => {
  it('accepts a PKCS#8 key and proves it imports for RS256', async () => {
    expect(() => assertPkcs8(keys.pkcs8)).not.toThrow();
    await expect(assertKeyImports(keys.pkcs8)).resolves.toBeUndefined();
  });

  it('rejects PKCS#1 with instructions, without echoing the key', () => {
    let message = '';
    try {
      assertPkcs8(keys.pkcs1);
    } catch (e) {
      expect(e).toBeInstanceOf(PrivateKeyFormatError);
      message = (e as Error).message;
    }
    expect(message).toMatch(/PKCS#1/);
    expect(message).toMatch(/convert-private-key\.mjs/);
    expect(message).not.toContain(keys.pkcs1.split('\n')[1]!);
  });

  it('rejects garbage', async () => {
    expect(() => assertPkcs8('hello')).toThrow(PrivateKeyFormatError);
    await expect(assertKeyImports('-----BEGIN PRIVATE KEY-----\n!!!notbase64!!!\n-----END PRIVATE KEY-----\n')).rejects.toThrow(
      PrivateKeyFormatError,
    );
  });

  it('normalises pasted keys: literal \\n, CRLF, surrounding quotes', async () => {
    const mangled = `"${keys.pkcs8.trim().replace(/\n/g, '\\n')}"`;
    const fixed = normalizePrivateKey(mangled);
    expect(fixed).toBe(keys.pkcs8);
    await expect(assertKeyImports(normalizePrivateKey(keys.pkcs8.replace(/\n/g, '\r\n')))).resolves.toBeUndefined();
  });

  it('convert-private-key.mjs turns PKCS#1 into an importable PKCS#8 key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chain-sync-key-'));
    const input = join(dir, 'app.pem');
    writeFileSync(input, keys.pkcs1);
    const out = execFileSync('node', ['scripts/convert-private-key.mjs', input], { encoding: 'utf8' });
    expect(out).toContain('BEGIN PRIVATE KEY');
    expect(out).not.toContain('RSA PRIVATE KEY');
    expect(out.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true); // stdout is ONLY the key (safe to redirect)
    await expect(assertKeyImports(out)).resolves.toBeUndefined();
  });

  it('convert-private-key.mjs passes PKCS#8 through (idempotent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chain-sync-key-'));
    const input = join(dir, 'app8.pem');
    writeFileSync(input, keys.pkcs8);
    const out = execFileSync('node', ['scripts/convert-private-key.mjs', input], { encoding: 'utf8' });
    expect(out).toBe(keys.pkcs8);
  });
});
