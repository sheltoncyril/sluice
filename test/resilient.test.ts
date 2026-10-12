import { Octokit } from '@octokit/core';
import { describe, expect, it } from 'vitest';
import { classifyRateLimit, RateLimitExceededError, resiliencePlugin } from '../src/github/resilient';
import type { RetryInfo } from '../src/github/resilient';

const Resilient = Octokit.plugin(resiliencePlugin);

type Step = { status: number; headers?: Record<string, string>; body?: unknown };

function client(steps: Step[], resilience: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const retries: RetryInfo[] = [];
  let i = 0;
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
    const step = steps[Math.min(i++, steps.length - 1)]!;
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status,
      headers: { 'content-type': 'application/json', ...(step.headers ?? {}) },
    });
  };
  const octokit = new Resilient({
    request: { fetch },
    resilience: {
      sleep: async (ms: number) => void sleeps.push(ms),
      random: () => 0.5,
      now: () => 1_700_000_000_000,
      onRetry: (r: RetryInfo) => retries.push(r),
      ...resilience,
    },
  } as never);
  return { octokit, calls, sleeps, retries };
}

describe('resilience plugin', () => {
  it('retries 5xx with exponential backoff, then succeeds', async () => {
    const { octokit, calls, sleeps } = client([{ status: 502 }, { status: 503 }, { status: 200, body: { ok: 1 } }]);
    const res = await octokit.request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' });
    expect(res.data).toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('gives up after maxServerRetries and surfaces the last error', async () => {
    const { octokit, calls } = client([{ status: 500 }], { maxServerRetries: 2 });
    await expect(octokit.request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' })).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(3);
  });

  it.each([400, 401, 404, 409, 422])('does not retry %i', async (status) => {
    const { octokit, calls } = client([{ status }]);
    await expect(octokit.request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' })).rejects.toMatchObject({ status });
    expect(calls).toHaveLength(1);
  });

  it('does not retry an ordinary 403 (missing permission)', async () => {
    const { octokit, calls } = client([{ status: 403, body: { message: 'Resource not accessible by integration' } }]);
    await expect(octokit.request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' })).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
  });

  it('waits out a short primary rate limit using x-ratelimit-reset', async () => {
    const nowSec = 1_700_000_000;
    const { octokit, sleeps, retries } = client([
      { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(nowSec + 5) } },
      { status: 200, body: { ok: 1 } },
    ]);
    await octokit.request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' });
    expect(sleeps).toEqual([6000]);
    expect(retries[0]?.reason).toBe('rate-limit-primary');
  });

  it('honours retry-after on a secondary rate limit', async () => {
    const { octokit, sleeps, retries } = client([
      { status: 403, headers: { 'retry-after': '3' }, body: { message: 'You have exceeded a secondary rate limit.' } },
      { status: 200 },
    ]);
    await octokit.request('POST /repos/{owner}/{repo}/pulls', { owner: 'o', repo: 'r', title: 't', head: 'h', base: 'b' });
    expect(sleeps).toEqual([3000]);
    expect(retries[0]?.reason).toBe('rate-limit-secondary');
  });

  it('throws RateLimitExceededError instead of sleeping for longer than the ceiling', async () => {
    const nowSec = 1_700_000_000;
    const { octokit, sleeps } = client([
      { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(nowSec + 3000) } },
    ]);
    const err = await octokit.request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitExceededError);
    expect(err.kind).toBe('primary');
    expect(sleeps).toEqual([]);
  });

  it('bounds repeated rate-limit retries', async () => {
    const { octokit, calls } = client([{ status: 429, headers: { 'retry-after': '1' } }], { maxRateLimitRetries: 2 });
    await expect(octokit.request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' })).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(calls).toHaveLength(3);
  });
});

describe('classifyRateLimit', () => {
  it('returns null for non-rate-limit statuses', () => {
    expect(classifyRateLimit({ status: 500 }, 0)).toBeNull();
    expect(classifyRateLimit({ status: 404 }, 0)).toBeNull();
  });
  it('treats a bare 429 as secondary with a default wait', () => {
    expect(classifyRateLimit({ status: 429 }, 0)).toEqual({ kind: 'secondary', waitMs: 60_000 });
  });
});
