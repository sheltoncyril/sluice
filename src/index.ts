import { createApp } from './app';
import type { AppContext } from './context';
import type { Env } from './env';
import { parseEnv } from './env';
import { GitHubApp } from './github/client';
import { createLogger } from './log';
import { D1Store } from './store/d1';

let cached: AppContext | undefined;

/** Bindings are constant for the lifetime of an isolate, so build the context once. */
function getContext(env: Env): AppContext {
  if (cached) return cached;
  const config = parseEnv(env);
  const logger = createLogger({ level: config.logLevel });
  const github = new GitHubApp({ appId: config.appId, privateKey: config.privateKey, logger });
  cached = {
    config,
    logger,
    store: new D1Store(env.DB),
    now: () => new Date(),
    describeApp: () => github.describe(),
    // Step 3 replaces this with the real router (push → downstream sync, etc.).
    handleEvent: async (event, log) => {
      log.info('webhook received (no handler wired yet)', { event: event.name });
    },
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
