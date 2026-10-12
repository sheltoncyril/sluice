import { Hono } from 'hono';
import type { AppContext } from './context';
import type { Env } from './env';
import { EnvError } from './env';
import { requireAdmin } from './http/auth';
import { webhookHandler } from './http/webhook';
import { createLogger, errorFields } from './log';

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

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return app;
}
