import { fullName } from '../github/port';
import { RateLimitExceededError } from '../github/resilient';
import { errorFields } from '../log';
import type { Logger } from '../log';
import { syncChainHop } from './chain';
import type { ChainDeps } from './chain';
import { discoverChains } from './discover';
import type { DiscoveredChain, DiscoveryApi } from './discover';
import type { HopResult } from './hop';

export interface PollDeps extends ChainDeps {
  discovery: DiscoveryApi;
  onlyRepos?: ReadonlySet<string>;
}

export interface PollOptions {
  /** Ignore poll_interval_minutes (admin "run now"). */
  force?: boolean;
  trigger?: string;
  /** Chains already discovered this tick (so one scan serves the poll and the reconcile). */
  chains?: readonly DiscoveredChain[];
}

/** Cron fires on a coarse schedule; allow a minute and a half of jitter before calling a hop "not due". */
const DUE_SLACK_MS = 90_000;

/**
 * Scheduled upstream -> midstream sync.
 *
 * For every chain found in allowlisted installations: if its poll interval has elapsed, compare
 * upstream with midstream (using midstream's installation token, so rate limits are midstream's
 * 5000/h, not an anonymous 60/h) and open or refresh the one sync PR.
 */
export async function pollUpstreams(deps: PollDeps, logger: Logger, opts: PollOptions = {}): Promise<HopResult[]> {
  const results: HopResult[] = [];
  const hop = 'upstream_to_midstream' as const;

  let chains: readonly DiscoveredChain[];
  try {
    chains = opts.chains ?? await discoverChains({
      api: deps.discovery,
      ports: deps.ports,
      store: deps.store,
      now: deps.now,
      allowedOwners: deps.allowedOwners,
      ...(deps.onlyRepos ? { onlyRepos: deps.onlyRepos } : {}),
      logger,
    });
  } catch (e) {
    if (e instanceof RateLimitExceededError) {
      logger.warn('poll aborted during discovery: rate limited', { retryAfterMs: e.retryAfterMs });
      return results;
    }
    throw e;
  }
  logger.info('poll started', { chains: chains.length });

  for (const chain of chains) {
    const key = fullName(chain.holder);
    const log = logger.child({ chain: key });
    try {
      const state = await deps.store.getHopState(key, hop);
      const intervalMs = chain.config.hops.upstream_to_midstream.poll_interval_minutes * 60_000;
      if (!opts.force && state?.lastPolledAt && deps.now().getTime() - Date.parse(state.lastPolledAt) < intervalMs - DUE_SLACK_MS) {
        log.debug('upstream poll not due yet');
        continue;
      }

      const midstreamPort = await deps.ports.forRepo(chain.holder);
      if (!midstreamPort) {
        log.warn('app not installed on midstream (installation changed during the scan)');
        continue;
      }

      const result = await syncChainHop(
        deps,
        { holder: chain.holder, config: chain.config, midstreamPort },
        hop,
        { trigger: opts.trigger ?? 'cron' },
        log,
      );
      results.push(result);

      // Failures retry on the next tick instead of waiting out a long interval.
      if (result.outcome !== 'error' && result.outcome !== 'rate_limited') {
        await deps.store.putHopState(key, hop, {
          lastPolledAt: deps.now().toISOString(),
          ...(result.sourceSha ? { lastSourceSha: result.sourceSha } : {}),
        });
      }
    } catch (e) {
      if (e instanceof RateLimitExceededError) {
        log.warn('poll stopped early: rate limited; remaining chains wait for the next tick', { retryAfterMs: e.retryAfterMs });
        break;
      }
      log.error('chain poll failed', errorFields(e));
    }
  }

  logger.info('poll finished', { results: results.map((r) => `${r.chain}:${r.outcome}`) });
  return results;
}
