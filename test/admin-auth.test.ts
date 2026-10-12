import { describe, expect, it } from 'vitest';
import { safeEqual } from '../src/http/constant-time';
import { adminGet, ADMIN_TOKEN, makeHarness } from './helpers/app';

describe('/admin/* bearer auth', () => {
  it('401s with no credentials', async () => {
    const res = await adminGet(makeHarness(), '/admin/whoami');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('401s with the wrong token', async () => {
    const res = await adminGet(makeHarness(), '/admin/whoami', 'nope-nope-nope-nope-nope-nope');
    expect(res.status).toBe(401);
  });

  it('401s on a non-Bearer scheme', async () => {
    const h = makeHarness();
    const res = await h.app.request('/admin/whoami', { headers: { authorization: `Basic ${ADMIN_TOKEN}` } });
    expect(res.status).toBe(401);
  });

  it('allows the right token', async () => {
    const res = await adminGet(makeHarness(), '/admin/whoami', ADMIN_TOKEN);
    expect(res.status).toBe(200);
  });

  it('does not leak the token in logs when rejecting', async () => {
    const h = makeHarness();
    await adminGet(h, '/admin/whoami', 'guess-guess-guess-guess-guess');
    expect(h.logs.join('\n')).not.toContain('guess-guess');
  });
});

describe('safeEqual', () => {
  it('compares correctly regardless of length', async () => {
    expect(await safeEqual('abc', 'abc')).toBe(true);
    expect(await safeEqual('abc', 'abd')).toBe(false);
    expect(await safeEqual('abc', 'abcd')).toBe(false);
    expect(await safeEqual('', '')).toBe(true);
  });
});
