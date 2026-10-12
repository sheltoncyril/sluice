import { createApp } from '../../src/app';
import type { AppContext, WebhookEvent } from '../../src/context';
import type { Env } from '../../src/env';
import { signWebhookPayload } from '../../src/github/signature';
import { createLogger } from '../../src/log';
import type { Logger } from '../../src/log';
import { MemoryStore } from '../../src/store/memory';

export const WEBHOOK_SECRET = 'whsec_test_secret_value';
export const ADMIN_TOKEN = 'admin-token-that-is-long-enough-123456';

export interface Harness {
  app: ReturnType<typeof createApp>;
  store: MemoryStore;
  events: WebhookEvent[];
  logs: string[];
  pending: Promise<unknown>[];
  /** Await everything handed to waitUntil. */
  settle(): Promise<void>;
  post(path: string, body: string, headers?: Record<string, string>): Promise<Response>;
  signedWebhook(body: unknown, opts?: { event?: string; delivery?: string; secret?: string }): Promise<Response>;
}

export function makeHarness(overrides: Partial<AppContext> = {}): Harness {
  const logs: string[] = [];
  const store = new MemoryStore();
  const events: WebhookEvent[] = [];
  const pending: Promise<unknown>[] = [];
  const logger: Logger = createLogger({ level: 'debug', sink: (l) => logs.push(l) });

  const ctx: AppContext = {
    config: { webhookSecret: WEBHOOK_SECRET, adminToken: ADMIN_TOKEN },
    logger,
    store,
    now: () => new Date('2026-10-12T12:00:00Z'),
    handleEvent: async (e) => {
      events.push(e);
    },
    describeApp: async () => ({ app: { id: 1 }, installations: [] }),
    runSync: async () => ({ ok: false, status: 404, error: 'not wired in this test' }),
    submitSecret: async () => ({ ok: false, status: 404, error: 'not wired in this test' }),
    runVariables: async () => ({ ok: false, status: 404, error: 'not wired in this test' }),
    runWorkflows: async () => ({ ok: false, status: 404, error: 'not wired in this test' }),
    runReconcile: async () => ({ ok: false, status: 404, error: 'not wired in this test' }),
    ...overrides,
  };

  const app = createApp(() => ctx);
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const env = {} as Env;

  const post = async (path: string, body: string, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', body, headers }, env, executionCtx);

  return {
    app,
    store,
    events,
    logs,
    pending,
    settle: async () => void (await Promise.allSettled(pending)),
    post,
    async signedWebhook(body, opts = {}) {
      const raw = JSON.stringify(body);
      const signature = await signWebhookPayload(opts.secret ?? WEBHOOK_SECRET, raw);
      return post('/webhook', raw, {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-event': opts.event ?? 'push',
        'x-github-delivery': opts.delivery ?? 'delivery-1',
      });
    },
  };
}

export function adminGet(h: Harness, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  return Promise.resolve(
    h.app.request(path, { method: 'GET', headers }, {} as Env, {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext),
  );
}
