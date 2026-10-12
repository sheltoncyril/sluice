import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '../src/env';
import { makeHarness } from './helpers/app';
import { createApp } from '../src/app';
import type { Env } from '../src/env';

const good = {
  GITHUB_APP_ID: '123456',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  GITHUB_WEBHOOK_SECRET: 'whsec',
  ADMIN_TOKEN: 'a'.repeat(32),
  ALLOWED_OWNERS: 'My-Org, other-org',
} as Partial<Env>;

const problems = (env: Partial<Env>): string[] => {
  try {
    parseEnv(env);
    return [];
  } catch (e) {
    return (e as EnvError).problems;
  }
};

describe('parseEnv', () => {
  it('accepts a complete config and normalises the allowlist to lower case', () => {
    const c = parseEnv(good);
    expect([...c.allowedOwners]).toEqual(['my-org', 'other-org']);
    expect(c.appId).toBe('123456');
    expect(c.chainRepos.size).toBe(0);
  });

  it('FAILS CLOSED when ALLOWED_OWNERS is empty or missing', () => {
    expect(problems({ ...good, ALLOWED_OWNERS: '' }).join()).toMatch(/ALLOWED_OWNERS is empty/);
    expect(problems({ ...good, ALLOWED_OWNERS: ' , ,' }).join()).toMatch(/ALLOWED_OWNERS is empty/);
    const { ALLOWED_OWNERS: _omit, ...without } = good;
    expect(problems(without).join()).toMatch(/ALLOWED_OWNERS is empty/);
  });

  it('names every missing secret, never its value', () => {
    const p = problems({ ALLOWED_OWNERS: 'x' });
    expect(p).toEqual(
      expect.arrayContaining(['GITHUB_APP_ID is not set', 'GITHUB_APP_PRIVATE_KEY is not set', 'GITHUB_WEBHOOK_SECRET is not set', 'ADMIN_TOKEN is not set']),
    );
  });

  it('rejects a weak admin token and a non-numeric app id, without echoing them', () => {
    const p = problems({ ...good, ADMIN_TOKEN: 'short', GITHUB_APP_ID: 'abc' });
    expect(p.join()).toMatch(/at least 24/);
    expect(p.join()).toMatch(/numeric/);
    expect(p.join()).not.toContain('short');
  });

  it('validates CHAIN_REPOS entries', () => {
    expect(parseEnv({ ...good, CHAIN_REPOS: 'My-Org/Widget, other/x' }).chainRepos.size).toBe(2);
    expect(problems({ ...good, CHAIN_REPOS: 'not-a-repo' }).join()).toMatch(/CHAIN_REPOS/);
  });
});

describe('misconfigured Worker', () => {
  it('answers 500 "service misconfigured" on webhook/admin routes but keeps /healthz alive', async () => {
    const h = makeHarness();
    const broken = createApp(() => {
      parseEnv({ ...good, ALLOWED_OWNERS: '' });
      throw new Error('unreachable');
    });
    const env = {} as Env;
    expect((await broken.request('/healthz', {}, env)).status).toBe(200);
    const res = await broken.request('/webhook', { method: 'POST', body: '{}' }, env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'service misconfigured' }); // no detail leaked to the caller
    expect(h.events).toHaveLength(0);
  });
});
