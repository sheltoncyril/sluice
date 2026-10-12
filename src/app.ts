import { Hono } from 'hono';
import type { AppContext } from './context';
import type { Env } from './env';
import { EnvError } from './env';
import { requireAdmin } from './http/auth';
import { webhookHandler } from './http/webhook';
import { createLogger, errorFields } from './log';
import { z } from 'zod';

export type ContextFactory = (env: Env) => AppContext;

type AppEnv = { Bindings: Env; Variables: { ctx: AppContext } };

/**
 * Build the Hono app. Routes only talk to {@link AppContext}, so the same app runs on Workers, in
 * tests, or (with a different entry file and a SQLite-backed Store) on a plain Node server.
 */
export function createApp(contextFactory: ContextFactory): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Liveness only: no config, no secrets, nothing about the chains.
  app.get('/healthz', (c) => c.json({ ok: true }));

  app.use('*', async (c, next) => {
    if (c.req.path === '/healthz') return next();
    try {
      c.set('ctx', contextFactory(c.env));
    } catch (e) {
      // Misconfiguration (missing secret, empty ALLOWED_OWNERS, ...). Log the *names* of what is
      // wrong, tell the caller nothing useful.
      const logger = createLogger();
      if (e instanceof EnvError) logger.error('worker misconfigured', { problems: e.problems });
      else logger.error('failed to initialise', errorFields(e));
      return c.json({ error: 'service misconfigured' }, 500);
    }
    return next();
  });

  app.post('/webhook', webhookHandler);

  app.use('/admin/*', requireAdmin);
  app.get('/admin/whoami', async (c) => {
    const ctx = c.get('ctx');
    try {
      return c.json(await ctx.describeApp());
    } catch (e) {
      ctx.logger.error('whoami failed', errorFields(e));
      return c.json({ error: 'could not reach GitHub as the app; check GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY' }, 502);
    }
  });

  const syncRequest = z.strictObject({
    chain: z.string().min(3),
    hop: z.enum(['upstream_to_midstream', 'midstream_to_downstream']),
    dry_run: z.boolean().default(false),
  });

  // Run a hop now, exactly like cron/webhooks would. `dry_run: true` reports the plan and writes nothing.
  app.post('/admin/sync', async (c) => {
    const ctx = c.get('ctx');
    const parsed = syncRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'expected {"chain":"owner/midstream","hop":"upstream_to_midstream|midstream_to_downstream","dry_run":false}' }, 400);
    }
    try {
      const out = await ctx.runSync({ chain: parsed.data.chain, hop: parsed.data.hop, dryRun: parsed.data.dry_run });
      return out.ok ? c.json(out.result) : c.json({ error: out.error, ...(out.details ? { details: out.details } : {}) }, out.status);
    } catch (e) {
      ctx.logger.error('admin sync failed', errorFields(e));
      return c.json({ error: 'sync failed; see logs' }, 500);
    }
  });

  // Recent runs for a chain (from the D1 log). Contains outcomes and PR numbers, never payloads.
  app.get('/admin/runs', async (c) => {
    const chain = c.req.query('chain');
    if (!chain) return c.json({ error: 'chain query parameter is required' }, 400);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);
    return c.json({ chain, runs: await c.get('ctx').store.recentRuns(chain, limit) });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return app;
}
