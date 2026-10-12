import { fullName } from '../github/port';
import { RateLimitExceededError } from '../github/resilient';
import { errorFields } from '../log';
import type { Logger } from '../log';
import type { ChainDeps } from '../sync/chain';
import type { DiscoveredChain } from '../sync/discover';
import { reconcileChain } from './reconcile';
import type { ReconcileResult } from './reconcile';

export interface ReconcileAllOptions {
  /** Ignore reconcile.interval_hours (admin "run now"). */
  force?: boolean;
  trigger?: string;
}

/** The cron ticks hourly with a little jitter; allow five minutes before calling a chain "not due". */
const DUE_SLACK_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Reconcile every discovered chain whose `reconcile.interval_hours` has elapsed (default daily). It rides
 * on the hourly cron tick, so there is no second schedule to configure.
 */
export async function reconcileAll(
  deps: ChainDeps,
  chains: readonly DiscoveredChain[],
  logger: Logger,
  opts: ReconcileAllOptions = {},
): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = [];
  for (const chain of chains) {
    const key = fullName(chain.holder);
    const log = logger.child({ chain: key });
    const cfg = chain.config.reconcile;
    if (!cfg.enabled && !opts.force) continue;
    try {
      const state = await deps.store.getHopState(key, 'reconcile');
      const intervalMs = cfg.interval_hours * HOUR_MS;
      if (!opts.force && state?.lastPolledAt && deps.now().getTime() - Date.parse(state.lastPolledAt) < intervalMs - DUE_SLACK_MS) {
        log.debug('reconcile not due yet');
        continue;
      }
      const midstreamPort = await deps.ports.forRepo(chain.holder);
      if (!midstreamPort) {
        log.warn('app not installed on midstream (installation changed during the scan)');
        continue;
      }
      const result = await reconcileChain(deps, { holder: chain.holder, config: chain.config, midstreamPort }, { trigger: opts.trigger ?? 'cron', dryRun: false }, log);
      results.push(result);
      if (!result.partial) await deps.store.putHopState(key, 'reconcile', { lastPolledAt: deps.now().toISOString() });
      if (result.partial) break; // rate limited: the rest wait for the next tick
    } catch (e) {
      if (e instanceof RateLimitExceededError) {
        log.warn('reconcile stopped: rate limited', { retryAfterMs: e.retryAfterMs });
        break;
      }
      log.error('chain reconcile failed', errorFields(e));
    }
  }
  logger.info('reconcile finished', { chains: results.map((r) => `${r.chain}:${r.findings.length}`) });
  return results;
}
