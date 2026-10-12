import { createApp } from './app';
import type { AppContext } from './context';
import type { Env } from './env';
import { parseEnv } from './env';
import { createEventHandler } from './events';
import { GitHubApp } from './github/client';
import { octokitDiscovery, octokitPortFactory } from './github/ports';
import { createLogger } from './log';
import { D1Store } from './store/d1';
import { runAdminSync } from './sync/admin';
import type { PollDeps } from './sync/poll';
import { pollUpstreams } from './sync/poll';

interface Runtime {
  ctx: AppContext;
  poll: PollDeps;
}

let cached: Runtime | undefined;

/** Bindings are constant for the lifetime of an isolate, so build everything once. */
function getRuntime(env: Env): Runtime {
  if (cached) return cached;
  const config = parseEnv(env);
  const logger = createLogger({ level: config.logLevel });
  const github = new GitHubApp({ appId: config.appId, privateKey: config.privateKey, logger });
  const store = new D1Store(env.DB);
  const now = () => new Date();
  const ports = octokitPortFactory(github);
  const chainDeps = { ports, store, now, allowedOwners: config.allowedOwners };

  cached = {
    poll: {
      ...chainDeps,
      discovery: octokitDiscovery(github),
      ...(config.chainRepos.size > 0 ? { onlyRepos: config.chainRepos } : {}),
    },
    ctx: {
      config,
      logger,
      store,
      now,
      describeApp: () => github.describe(),
      handleEvent: createEventHandler(chainDeps),
      runSync: (input) => runAdminSync(chainDeps, input, logger),
    },
  };
  return cached;
}

const getContext = (env: Env): AppContext => getRuntime(env).ctx;

const app = createApp(getContext);

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    const { ctx: appCtx, poll } = getRuntime(env);
    const { logger, store } = appCtx;
    logger.info('scheduled tick', { cron: controller.cron });

    // Retention: keep two weeks of logs/idempotency rows. Independent of the poll, so a failing
    // poll (bad credentials, GitHub outage) can never stop old rows from being pruned.
    const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    const message = (e: unknown) => ({ message: e instanceof Error ? e.message : String(e) });
    ctx.waitUntil(
      (async () => {
        await pollUpstreams(poll, logger).catch((e) => logger.error('scheduled poll failed', message(e)));
        await store
          .prune(cutoff)
          .then((removed) => logger.info('pruned old rows', { removed }))
          .catch((e) => logger.error('prune failed', message(e)));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
