import { Hono } from 'hono';
import type { AppContext } from './context';
import type { Env } from './env';
import { EnvError } from './env';
import { requireAdmin } from './http/auth';
import { webhookHandler } from './http/webhook';
import { createLogger, errorFields } from './log';
import { z } from 'zod';
import { MAX_SECRET_BYTES } from './secrets/distribute';

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

  const variablesRequest = z.strictObject({ chain: z.string().min(3), dry_run: z.boolean().default(false) });

  // Apply (or preview) the variables: block of chain.yml. Variables are not secret, so values are shown.
  app.post('/admin/variables', async (c) => {
    const ctx = c.get('ctx');
    const parsed = variablesRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'expected {"chain":"owner/midstream","dry_run":false}' }, 400);
    try {
      const out = await ctx.runVariables({ chain: parsed.data.chain, dryRun: parsed.data.dry_run });
      return out.ok ? c.json(out.result) : c.json({ error: out.error, ...(out.details ? { details: out.details } : {}) }, out.status);
    } catch (e) {
      ctx.logger.error('admin variables failed', errorFields(e));
      return c.json({ error: 'applying variables failed; see logs' }, 500);
    }
  });

  // Render the workflow templates and open/refresh the PRs (dry_run previews drift and writes nothing).
  app.post('/admin/workflows', async (c) => {
    const ctx = c.get('ctx');
    const parsed = variablesRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'expected {"chain":"owner/midstream","dry_run":false}' }, 400);
    try {
      const out = await ctx.runWorkflows({ chain: parsed.data.chain, dryRun: parsed.data.dry_run });
      return out.ok ? c.json(out.result) : c.json({ error: out.error, ...(out.details ? { details: out.details } : {}) }, out.status);
    } catch (e) {
      ctx.logger.error('admin workflows failed', errorFields(e));
      return c.json({ error: 'workflow sync failed; see logs' }, 500);
    }
  });

  // Run the drift reconcile now. dry_run reports drift and changes nothing.
  app.post('/admin/reconcile', async (c) => {
    const ctx = c.get('ctx');
    const parsed = variablesRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'expected {"chain":"owner/midstream","dry_run":false}' }, 400);
    try {
      const out = await ctx.runReconcile({ chain: parsed.data.chain, dryRun: parsed.data.dry_run });
      return out.ok ? c.json(out.result) : c.json({ error: out.error, ...(out.details ? { details: out.details } : {}) }, out.status);
    } catch (e) {
      ctx.logger.error('admin reconcile failed', errorFields(e));
      return c.json({ error: 'reconcile failed; see logs' }, 500);
    }
  });

  const secretRequest = z.strictObject({
    chain: z.string().min(3).max(200),
    name: z.string().min(1).max(100),
    value: z.string().min(1),
  });
  const MAX_SECRET_BODY = MAX_SECRET_BYTES + 4096; // the value plus JSON framing

  /**
   * Submit a secret. THE value travels only in this request body (never the URL or a header: Workers
   * Logs record URLs) and is handed to the sealer and dropped. Nothing here logs the body, echoes it,
   * or puts it in an error message.
   */
  app.post('/admin/secrets', async (c) => {
    const ctx = c.get('ctx');
    c.header('Cache-Control', 'no-store');
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'content-type must be application/json' }, 415);
    }
    if (Number(c.req.header('content-length') ?? 0) > MAX_SECRET_BODY) return c.json({ error: 'request too large' }, 413);

    const raw = await c.req.text();
    if (raw.length > MAX_SECRET_BODY) return c.json({ error: 'request too large' }, 413);

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return c.json({ error: 'body is not valid JSON' }, 400); // no parser detail: it could quote the body
    }
    const parsed = secretRequest.safeParse(json);
    if (!parsed.success) {
      // Field names only; zod issues can carry the received value.
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(body)'))];
      return c.json({ error: `invalid request; check: ${fields.join(', ')}` }, 400);
    }
    if (new TextEncoder().encode(parsed.data.value).byteLength > MAX_SECRET_BYTES) {
      return c.json({ error: 'secret value is larger than GitHub allows (48 KB)' }, 413);
    }

    try {
      const out = await ctx.submitSecret(parsed.data);
      if (out.ok) return c.json({ name: out.name, results: out.results });
      return c.json(
        { error: out.error, ...(out.results ? { results: out.results } : {}), ...(out.details ? { details: out.details } : {}) },
        out.status,
      );
    } catch (e) {
      ctx.logger.withSecrets([parsed.data.value]).error('secret submission failed', errorFields(e));
      return c.json({ error: 'secret submission failed; see logs' }, 500);
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
