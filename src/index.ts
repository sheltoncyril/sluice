import { createApp } from './app';
import type { AppContext } from './context';
import type { Env } from './env';
import { parseEnv } from './env';
import { createEventHandler } from './events';
import { GitHubApp } from './github/client';
import { octokitDiscovery, octokitPortFactory } from './github/ports';
import { createLogger } from './log';
import { D1Store } from './store/d1';
import { distributeSecret } from './secrets/distribute';
import { NaclSealer } from './secrets/sealer';
import { reconcileAll } from './reconcile/schedule';
import { runAdminReconcile, runAdminSync, runAdminVariables, runAdminWorkflows } from './sync/admin';
import { discoverChains } from './sync/discover';
import type { PollDeps } from './sync/poll';
import { healFailedDownstream, pollUpstreams } from './sync/poll';

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
  const chainDeps = {
    ports,
    store,
    now,
    allowedOwners: config.allowedOwners,
    // Restore commits are attributed to this app's own bot account.
    commitIdentity: () => github.botIdentity(),
  };
  const sealer = new NaclSealer();

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
      submitSecret: (input) => distributeSecret({ ...chainDeps, sealer }, input, logger),
      runVariables: (input) => runAdminVariables(chainDeps, input, logger),
      runWorkflows: (input) => runAdminWorkflows(chainDeps, input, logger),
      runReconcile: (input) => runAdminReconcile(chainDeps, input, logger),
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
        // One scan of installations per tick serves both the upstream poll and the reconcile.
        const chains = await discoverChains({
          api: poll.discovery,
          ports: poll.ports,
          store: poll.store,
          now: poll.now,
          allowedOwners: poll.allowedOwners,
          ...(poll.onlyRepos ? { onlyRepos: poll.onlyRepos } : {}),
          logger,
        }).catch((e) => {
          logger.error('discovery failed', message(e));
          return [];
        });
        await pollUpstreams(poll, logger, { chains }).catch((e) => logger.error('scheduled poll failed', message(e)));
        await healFailedDownstream(poll, chains, logger).catch((e) => logger.error('downstream retry failed', message(e)));
        await reconcileAll(poll, chains, logger).catch((e) => logger.error('scheduled reconcile failed', message(e)));
        await store
          .prune(cutoff)
          .then((removed) => logger.info('pruned old rows', { removed }))
          .catch((e) => logger.error('prune failed', message(e)));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
