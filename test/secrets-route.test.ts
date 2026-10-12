import { describe, expect, it, vi } from 'vitest';
import type { SecretInput, SecretResponse } from '../src/secrets/distribute';
import { ADMIN_TOKEN, makeHarness } from './helpers/app';
import type { Harness } from './helpers/app';

const PLAINTEXT = 'ROUTE-PLAINTEXT-5d1e8b-DO-NOT-LEAK';
const GOOD = { chain: 'me/widget', name: 'NPM_TOKEN', value: PLAINTEXT };

function post(h: Harness, body: unknown, headers: Record<string, string> = {}, raw?: string) {
  return h.post('/admin/secrets', raw ?? JSON.stringify(body), {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    'content-type': 'application/json',
    ...headers,
  });
}

function withSubmit(impl: (i: SecretInput) => Promise<SecretResponse> | SecretResponse) {
  const submit = vi.fn(async (i: SecretInput) => impl(i));
  return { submit, h: makeHarness({ submitSecret: submit }) };
}

const ok: SecretResponse = { ok: true, name: 'NPM_TOKEN', results: [{ target: 'midstream', repo: 'me/widget', status: 'created' }] };

describe('POST /admin/secrets: gatekeeping', () => {
  it('requires the admin token, and never reaches the handler without it', async () => {
    const { h, submit } = withSubmit(() => ok);
    const res = await h.post('/admin/secrets', JSON.stringify(GOOD), { 'content-type': 'application/json' });
    expect(res.status).toBe(401);
    const wrong = await h.post('/admin/secrets', JSON.stringify(GOOD), { authorization: 'Bearer nope-nope-nope-nope-nope-nope', 'content-type': 'application/json' });
    expect(wrong.status).toBe(401);
    expect(submit).not.toHaveBeenCalled();
  });

  it('only accepts application/json', async () => {
    const { h, submit } = withSubmit(() => ok);
    const res = await post(h, GOOD, { 'content-type': 'text/plain' });
    expect(res.status).toBe(415);
    expect(submit).not.toHaveBeenCalled();
  });

  it('is POST-only: the value can never arrive in a URL (Workers Logs record URLs)', async () => {
    const { h, submit } = withSubmit(() => ok);
    const res = await h.app.request(`/admin/secrets?value=${PLAINTEXT}&chain=me/widget&name=NPM_TOKEN`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(404);
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects oversized requests before reading them, and oversized values after', async () => {
    const { h, submit } = withSubmit(() => ok);
    expect((await post(h, GOOD, { 'content-length': String(1024 * 1024) })).status).toBe(413);
    const huge = { ...GOOD, value: 'x'.repeat(48 * 1024 + 1) };
    expect((await post(h, huge)).status).toBe(413);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('POST /admin/secrets: strict, non-echoing validation', () => {
  it.each([
    ['not JSON', undefined, `{"value":"${PLAINTEXT}"`],
    ['an array', [PLAINTEXT], undefined],
    ['missing fields', { chain: 'me/widget' }, undefined],
    ['an empty value', { ...GOOD, value: '' }, undefined],
    ['a non-string value', { ...GOOD, value: 12345 }, undefined],
    ['an unknown key (strict)', { ...GOOD, extra: PLAINTEXT }, undefined],
  ])('400s on %s and never echoes what it was sent', async (_n, body, raw) => {
    const { h, submit } = withSubmit(() => ok);
    const res = await post(h, body, {}, raw);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(PLAINTEXT);
    expect(submit).not.toHaveBeenCalled();
    expect(h.logs.join('\n')).not.toContain(PLAINTEXT);
  });

  it('names the offending FIELDS only', async () => {
    const { h } = withSubmit(() => ok);
    const res = await post(h, { chain: 5, name: 'X', value: 'v' });
    expect(((await res.json()) as { error: string }).error).toMatch(/chain/);
  });
});

describe('POST /admin/secrets: happy path', () => {
  it('hands the parsed fields to the handler, sets no-store, and returns results WITHOUT the value', async () => {
    const { h, submit } = withSubmit(() => ok);
    const res = await post(h, GOOD);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(submit).toHaveBeenCalledWith(GOOD);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ name: 'NPM_TOKEN', results: ok.ok ? ok.results : [] });
    expect(text).not.toContain(PLAINTEXT);
  });

  it('writes nothing about the request body to the logs', async () => {
    const { h } = withSubmit(() => ok);
    await post(h, GOOD);
    await h.settle();
    const all = h.logs.join('\n');
    expect(all).not.toContain(PLAINTEXT);
    expect(all).not.toContain('NPM_TOKEN'); // the route itself logs nothing about it at all
  });
});

describe('POST /admin/secrets: failure mapping', () => {
  it('passes handler statuses and per-target results through (207 partial, 502 none)', async () => {
    const results = [
      { target: 'midstream', repo: 'me/widget', status: 'created' },
      { target: 'downstream', repo: 'other/deploy', status: 'error', error: 'not installed' },
    ] as const;
    const { h } = withSubmit(() => ({ ok: false, status: 207, error: 'some targets failed', results: [...results] }));
    const res = await post(h, GOOD);
    expect(res.status).toBe(207);
    expect(((await res.json()) as { results: unknown[] }).results).toHaveLength(2);

    const { h: h2 } = withSubmit(() => ({ ok: false, status: 502, error: 'none written' }));
    expect((await post(h2, GOOD)).status).toBe(502);
  });

  it('an unexpected exception becomes a generic 500, and its text (even if it quotes the value) is scrubbed from logs', async () => {
    const { h } = withSubmit(() => {
      throw new Error(`library blew up while handling ${PLAINTEXT}`);
    });
    const res = await post(h, GOOD);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(PLAINTEXT);
    await h.settle();
    const logged = h.logs.join('\n');
    expect(logged).toContain('secret submission failed'); // it WAS logged...
    expect(logged).not.toContain(PLAINTEXT); // ...without the value
  });
});
