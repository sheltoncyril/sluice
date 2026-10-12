import { describe, expect, it, vi } from 'vitest';
import { signWebhookPayload } from '../src/github/signature';
import { makeHarness, WEBHOOK_SECRET } from './helpers/app';

describe('POST /webhook', () => {
  it('rejects an unsigned request with 401 and never calls the handler', async () => {
    const h = makeHarness();
    const res = await h.post('/webhook', '{"zen":"x"}', { 'x-github-event': 'push', 'x-github-delivery': 'd1' });
    expect(res.status).toBe(401);
    await h.settle();
    expect(h.events).toHaveLength(0);
    expect(h.store.deliveries.size).toBe(0);
  });

  it('rejects a bad signature with 401 and never calls the handler', async () => {
    const h = makeHarness();
    const res = await h.signedWebhook({ ref: 'refs/heads/main' }, { secret: 'wrong-secret' });
    expect(res.status).toBe(401);
    await h.settle();
    expect(h.events).toHaveLength(0);
  });

  it('rejects a valid signature over a different body (tampering)', async () => {
    const h = makeHarness();
    const sig = await signWebhookPayload(WEBHOOK_SECRET, '{"ref":"refs/heads/main"}');
    const res = await h.post('/webhook', '{"ref":"refs/heads/evil"}', {
      'x-hub-signature-256': sig,
      'x-github-event': 'push',
      'x-github-delivery': 'd1',
    });
    expect(res.status).toBe(401);
    expect(h.events).toHaveLength(0);
  });

  it('verifies the signature before parsing: unsigned garbage gets 401, not 400', async () => {
    const h = makeHarness();
    const res = await h.post('/webhook', 'not json at all', { 'x-github-event': 'push', 'x-github-delivery': 'd1' });
    expect(res.status).toBe(401);
  });

  it('accepts a correctly signed delivery with 202 and hands it to the handler', async () => {
    const h = makeHarness();
    const res = await h.signedWebhook({ ref: 'refs/heads/main' }, { event: 'push', delivery: 'abc' });
    expect(res.status).toBe(202);
    await h.settle();
    expect(h.events).toEqual([{ id: 'abc', name: 'push', payload: { ref: 'refs/heads/main' } }]);
    expect(h.store.deliveries.get('abc')?.status).toBe('done');
  });

  it('answers ping without invoking the handler', async () => {
    const h = makeHarness();
    const res = await h.signedWebhook({ zen: 'Keep it logically awesome.' }, { event: 'ping' });
    expect(res.status).toBe(200);
    expect(h.events).toHaveLength(0);
  });

  it('400s on a signed payload that is not JSON', async () => {
    const h = makeHarness();
    const raw = 'definitely not json';
    const res = await h.post('/webhook', raw, {
      'x-hub-signature-256': await signWebhookPayload(WEBHOOK_SECRET, raw),
      'x-github-event': 'push',
      'x-github-delivery': 'd1',
    });
    expect(res.status).toBe(400);
  });

  it('400s when the event or delivery headers are missing', async () => {
    const h = makeHarness();
    const raw = '{}';
    const res = await h.post('/webhook', raw, { 'x-hub-signature-256': await signWebhookPayload(WEBHOOK_SECRET, raw) });
    expect(res.status).toBe(400);
  });

  it('ignores a redelivery of a completed delivery', async () => {
    const h = makeHarness();
    await h.signedWebhook({ n: 1 }, { delivery: 'same' });
    await h.settle();
    const again = await h.signedWebhook({ n: 1 }, { delivery: 'same' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'duplicate' });
    await h.settle();
    expect(h.events).toHaveLength(1);
  });

  it('lets a failed delivery be retried by redelivery', async () => {
    let calls = 0;
    const h = makeHarness({
      handleEvent: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
      },
    });
    await h.signedWebhook({ n: 1 }, { delivery: 'flaky' });
    await h.settle();
    expect(h.store.deliveries.get('flaky')?.status).toBe('failed');

    const retry = await h.signedWebhook({ n: 1 }, { delivery: 'flaky' });
    expect(retry.status).toBe(202);
    await h.settle();
    expect(calls).toBe(2);
    expect(h.store.deliveries.get('flaky')?.status).toBe('done');
  });

  it('acknowledges before the handler finishes (GitHub allows 10s)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done = vi.fn();
    const h = makeHarness({
      handleEvent: async () => {
        await gate;
        done();
      },
    });
    const res = await h.signedWebhook({ n: 1 });
    expect(res.status).toBe(202);
    expect(done).not.toHaveBeenCalled();
    release();
    await h.settle();
    expect(done).toHaveBeenCalledOnce();
  });

  it('never writes the request body or signature to the logs', async () => {
    const h = makeHarness();
    await h.signedWebhook({ marker: 'BODY-CONTENT-MARKER', ref: 'refs/heads/main' });
    await h.signedWebhook({ marker: 'BODY-CONTENT-MARKER' }, { secret: 'wrong', delivery: 'bad' });
    await h.settle();
    const all = h.logs.join('\n');
    expect(all).not.toContain('BODY-CONTENT-MARKER');
    expect(all).not.toMatch(/sha256=[0-9a-f]{64}/);
  });

  it('refuses oversized payloads before reading them', async () => {
    const h = makeHarness();
    const res = await h.post('/webhook', '{}', {
      'content-length': String(26 * 1024 * 1024),
      'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
    });
    expect(res.status).toBe(413);
  });
});

describe('GET /healthz', () => {
  it('reports liveness and nothing else', async () => {
    const h = makeHarness();
    const res = await h.app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
