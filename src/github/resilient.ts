import type { Octokit } from '@octokit/core';
import type { OctokitOptions } from '@octokit/core/types';

/**
 * Octokit plugin: retry 5xx / network failures with backoff, and wait out rate limits when the wait
 * is short enough for a Worker invocation. Longer waits throw {@link RateLimitExceededError} so the
 * caller can stop early and let the next cron tick (or webhook redelivery) resume; every operation in
 * this codebase is idempotent, so resuming is always safe.
 *
 * Written as a small hook (instead of @octokit/plugin-retry + plugin-throttling) to avoid Bottleneck
 * and its timer assumptions, and so the wait ceiling is explicit.
 */

export interface ResilienceOptions {
  /** Retries for 5xx and network errors. Default 3. */
  maxServerRetries?: number;
  /** Base for exponential backoff. Default 500ms (500, 1000, 2000, ...). */
  baseDelayMs?: number;
  /** Longest rate-limit wait we are willing to sit through. Default 30s. */
  maxRateLimitWaitMs?: number;
  /** How many times to wait-and-retry after a rate limit for one request. Default 2. */
  maxRateLimitRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  reason: 'server-error' | 'rate-limit-primary' | 'rate-limit-secondary';
  attempt: number;
  waitMs: number;
  method: string;
  url: string;
  status?: number;
}

export class RateLimitExceededError extends Error {
  constructor(
    public readonly kind: 'primary' | 'secondary',
    public readonly retryAfterMs: number,
  ) {
    super(`GitHub ${kind} rate limit hit; would need to wait ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitExceededError';
  }
}

interface HttpErrorLike {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string | number | undefined>; data?: unknown };
}

function header(err: HttpErrorLike, name: string): string | undefined {
  const v = err.response?.headers?.[name];
  return v === undefined ? undefined : String(v);
}

/** Classify an error as a rate limit and say how long GitHub wants us to wait. */
export function classifyRateLimit(
  err: HttpErrorLike,
  nowMs: number,
): { kind: 'primary' | 'secondary'; waitMs: number } | null {
  const status = err.status;
  if (status !== 403 && status !== 429) return null;

  const retryAfter = header(err, 'retry-after');
  const remaining = header(err, 'x-ratelimit-remaining');
  const reset = header(err, 'x-ratelimit-reset');
  const data = err.response?.data as { message?: unknown } | undefined;
  const message = String(data?.message ?? err.message ?? '');

  if (retryAfter !== undefined && Number.isFinite(Number(retryAfter))) {
    return { kind: 'secondary', waitMs: Math.max(0, Number(retryAfter)) * 1000 };
  }
  if (remaining === '0' && reset !== undefined && Number.isFinite(Number(reset))) {
    return { kind: 'primary', waitMs: Math.max(0, Number(reset) * 1000 - nowMs) + 1000 };
  }
  if (status === 429 || /secondary rate limit|abuse detection/i.test(message)) {
    return { kind: 'secondary', waitMs: 60_000 };
  }
  return null; // an ordinary 403 (missing permission, blocked): not retryable
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function resiliencePlugin(octokit: Octokit, options: OctokitOptions): void {
  const o = (options as { resilience?: ResilienceOptions }).resilience ?? {};
  const maxServerRetries = o.maxServerRetries ?? 3;
  const baseDelayMs = o.baseDelayMs ?? 500;
  const maxRateLimitWaitMs = o.maxRateLimitWaitMs ?? 30_000;
  const maxRateLimitRetries = o.maxRateLimitRetries ?? 2;
  const sleep = o.sleep ?? defaultSleep;
  const now = o.now ?? (() => Date.now());
  const random = o.random ?? Math.random;

  octokit.hook.wrap('request', async (request, requestOptions) => {
    let serverAttempts = 0;
    let rateLimitAttempts = 0;
    const method = String(requestOptions.method ?? 'GET');
    const url = String(requestOptions.url ?? '');

    for (;;) {
      try {
        return await request(requestOptions);
      } catch (error) {
        const err = error as HttpErrorLike;
        const status = err.status;

        const limited = classifyRateLimit(err, now());
        if (limited) {
          if (limited.waitMs > maxRateLimitWaitMs || rateLimitAttempts >= maxRateLimitRetries) {
            throw new RateLimitExceededError(limited.kind, limited.waitMs);
          }
          rateLimitAttempts++;
          o.onRetry?.({
            reason: limited.kind === 'primary' ? 'rate-limit-primary' : 'rate-limit-secondary',
            attempt: rateLimitAttempts,
            waitMs: limited.waitMs,
            method,
            url,
            ...(status !== undefined ? { status } : {}),
          });
          await sleep(limited.waitMs);
          continue;
        }

        // Octokit reports fetch/network failures as status 500, so they land here too.
        if (typeof status === 'number' && status >= 500 && serverAttempts < maxServerRetries) {
          const waitMs = Math.round(baseDelayMs * 2 ** serverAttempts * (0.75 + random() * 0.5));
          serverAttempts++;
          o.onRetry?.({ reason: 'server-error', attempt: serverAttempts, waitMs, method, url, status });
          await sleep(waitMs);
          continue;
        }

        throw error;
      }
    }
  });
}
