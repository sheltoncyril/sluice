import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../context';
import { safeEqual } from './constant-time';

/**
 * Bearer-token guard for /admin/* (and the secret-submission endpoint in step 5).
 *
 * This is the application-level check. For the secrets endpoint you should ALSO put the route behind
 * Cloudflare Access (see README) so unauthenticated traffic never reaches the Worker at all.
 */
export const requireAdmin: MiddlewareHandler<{ Variables: { ctx: AppContext } }> = async (c, next) => {
  const ctx = c.get('ctx');
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const ok = match ? await safeEqual(match[1]!, ctx.config.adminToken) : false;
  if (!ok) {
    ctx.logger.warn('admin auth rejected', { path: c.req.path });
    return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }
  await next();
};
