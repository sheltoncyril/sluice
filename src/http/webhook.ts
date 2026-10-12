import type { Context } from 'hono';
import { verifyWebhookSignature } from '../github/signature';
import { errorFields } from '../log';
import type { AppContext } from '../context';

/** GitHub caps webhook payloads at 25 MB. */
export const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

type HonoCtx = Context<{ Variables: { ctx: AppContext } }>;

/** Run `work` after the response where the runtime supports it (Workers), else fire-and-forget. */
function defer(c: HonoCtx, work: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    void work;
  }
}

/**
 * POST /webhook
 *
 *  1. read the raw bytes (never the parsed JSON: the signature covers the exact bytes);
 *  2. verify X-Hub-Signature-256 BEFORE anything else looks at the payload;
 *  3. de-duplicate on X-GitHub-Delivery;
 *  4. acknowledge immediately (GitHub gives us 10s) and process via waitUntil.
 *
 * The request body is never logged.
 */
export async function webhookHandler(c: HonoCtx): Promise<Response> {
  const ctx = c.get('ctx');

  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_WEBHOOK_BYTES) return c.json({ error: 'payload too large' }, 413);

  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (raw.byteLength > MAX_WEBHOOK_BYTES) return c.json({ error: 'payload too large' }, 413);

  const valid = await verifyWebhookSignature(ctx.config.webhookSecret, raw, c.req.header('x-hub-signature-256'));
  if (!valid) {
    ctx.logger.warn('webhook rejected: invalid or missing signature', {
      delivery: (c.req.header('x-github-delivery') ?? '').slice(0, 64),
    });
    return c.json({ error: 'invalid signature' }, 401);
  }

  const name = c.req.header('x-github-event');
  const id = c.req.header('x-github-delivery');
  if (!name || !id) return c.json({ error: 'missing X-GitHub-Event or X-GitHub-Delivery' }, 400);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.json({ error: 'payload is not valid JSON' }, 400);
  }

  if (name === 'ping') return c.json({ status: 'pong' }, 200);

  const logger = ctx.logger.child({ delivery: id, event: name });

  let claim;
  try {
    claim = await ctx.store.claimDelivery(id, name, ctx.now().toISOString());
  } catch (e) {
    logger.error('delivery claim failed', errorFields(e));
    return c.json({ error: 'temporarily unavailable' }, 503); // GitHub shows a failed delivery; redeliver later
  }
  if (claim === 'duplicate') {
    logger.info('duplicate delivery ignored');
    return c.json({ status: 'duplicate' }, 200);
  }

  defer(
    c,
    (async () => {
      try {
        await ctx.handleEvent({ id, name, payload }, logger);
        await ctx.store.finishDelivery(id, 'done');
      } catch (e) {
        logger.error('webhook handler failed', errorFields(e));
        await ctx.store.finishDelivery(id, 'failed').catch(() => {});
      }
    })(),
  );
  return c.json({ status: 'accepted' }, 202);
}
