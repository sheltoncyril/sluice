import { createApp } from './app';
import type { AppContext } from './context';
import type { Env } from './env';
import { parseEnv } from './env';
import { createEventHandler } from './events';
import { GitHubApp } from './github/client';
import { octokitPortFactory } from './github/ports';
import { createLogger } from './log';
import { D1Store } from './store/d1';

let cached: AppContext | undefined;

/** Bindings are constant for the lifetime of an isolate, so build the context once. */
function getContext(env: Env): AppContext {
  if (cached) return cached;
  const config = parseEnv(env);
  const logger = createLogger({ level: config.logLevel });
  const github = new GitHubApp({ appId: config.appId, privateKey: config.privateKey, logger });
  const store = new D1Store(env.DB);
  const now = () => new Date();
  cached = {
    config,
    logger,
    store,
    now,
    describeApp: () => github.describe(),
    handleEvent: createEventHandler({
      allowedOwners: config.allowedOwners,
      ports: octokitPortFactory(github),
      store,
      now,
    }),
  };
  return cached;
}

const app = createApp(getContext);

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    const { logger, store } = getContext(env);
    logger.info('scheduled tick', { cron: controller.cron });
    // Retention: keep two weeks of logs/idempotency rows.
    const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    ctx.waitUntil(store.prune(cutoff).then((n) => logger.info('pruned old rows', { removed: n })));
  },
} satisfies ExportedHandler<Env>;
