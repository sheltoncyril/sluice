import { describe, expect, it } from 'vitest';
import { RateLimitExceededError } from '../src/github/resilient';
import { nullLogger } from '../src/log';
import { discoverChains } from '../src/sync/discover';
import { healFailedDownstream } from '../src/sync/poll';
import { syncDownstreamOnPush } from '../src/sync/downstream';
import { chainScene, chainYml } from './helpers/chain-scene';
import type { ChainScene } from './helpers/chain-scene';

const MID = 'me/widget';
const DOWN = 'other/deploy';
const midRef = { owner: 'me', repo: 'widget' };

const discover = (s: ChainScene) =>
  discoverChains({ api: s.discovery, ports: s.deps.ports, store: s.store, logger: nullLogger, now: s.clock.now, allowedOwners: s.deps.allowedOwners });
const push = (s: ChainScene) =>
  syncDownstreamOnPush(s.deps, { deliveryId: 'd', installationId: 1, repo: midRef, ref: 'refs/heads/main', deleted: false, defaultBranch: 'main', changedPaths: ['a.txt'] }, nullLogger);

describe('a downstream sync that failed is retried on the hourly tick, not left for the daily reconcile', () => {
  it('re-runs the hop when the latest downstream result is an error, and opens the PR', async () => {
    const s = chainScene();
    s.gh.commit(MID, 'main', { 'a.txt': 'changed\n' });
    s.gh.failNext('compare', new Error('GitHub had a bad moment'));
    expect((await push(s))?.outcome).toBe('error');
    expect(s.gh.prs(DOWN)).toHaveLength(0);

    const results = await healFailedDownstream(s.deps, await discover(s), nullLogger);
    expect(results.map((r) => r.outcome)).toEqual(['pr_opened']);
    expect(s.gh.prs(DOWN)).toHaveLength(1);
    expect(s.store.runs.at(-1)).toMatchObject({ trigger: 'cron', hop: 'midstream_to_downstream', outcome: 'pr_opened' });
  });

  it('does nothing, and calls GitHub not at all, for a healthy chain', async () => {
    const s = chainScene();
    s.gh.commit(MID, 'main', { 'a.txt': 'changed\n' });
    expect((await push(s))?.outcome).toBe('pr_opened');
    const chains = await discover(s);

    s.gh.resetCalls();
    expect(await healFailedDownstream(s.deps, chains, nullLogger)).toEqual([]);
    expect(s.gh.calls).toEqual([]);
  });

  it('does nothing for a chain that has never run, and stops at the first success', async () => {
    const s = chainScene();
    s.gh.resetCalls();
    expect(await healFailedDownstream(s.deps, await discover(s), nullLogger)).toEqual([]);

    // error, then a later success: the NEWEST result decides, so the old error is not retried
    s.gh.commit(MID, 'main', { 'a.txt': 'one\n' });
    s.gh.failNext('compare', new Error('flaky'));
    await push(s);
    s.gh.commit(MID, 'main', { 'a.txt': 'two\n' });
    expect((await push(s))?.outcome).toBe('pr_opened');
    expect(await healFailedDownstream(s.deps, await discover(s), nullLogger)).toEqual([]);
  });

  it('a rate limit during the retry stops it quietly and is not fatal', async () => {
    const s = chainScene();
    s.gh.commit(MID, 'main', { 'a.txt': 'changed\n' });
    s.gh.failNext('compare', new Error('boom'));
    await push(s);
    s.gh.failNext('getBranchSha', new RateLimitExceededError('primary', 3_000_000));
    await expect(healFailedDownstream(s.deps, await discover(s), nullLogger)).resolves.toEqual([]);
  });
});

describe('discovery that hits a rate limit part-way keeps what it found', () => {
  it('returns the chains read before the limit instead of none', async () => {
    const s = chainScene({
      installed: ['me/widget', 'me/gadget', 'other/deploy'],
      installations: [{ id: 1, login: 'me', suspended: false, repos: ['me/widget', 'me/gadget'] }],
    });
    s.gh.createRepo('acme/gadget', { 'g.txt': '1\n' });
    s.gh.fork('acme/gadget', 'me/gadget');
    s.gh.commit('me/gadget', 'main', { '.github/chain.yml': chainYml({ up: 'acme/gadget', mid: 'me/gadget', down: 'other/gadget-deploy' }) });

    // The second repo's read hits the limit; the first has been read by then.
    const limited = new Proxy(s.gh, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== 'readFile' || typeof value !== 'function') return value;
        return async (repo: { owner: string; repo: string }, ...rest: unknown[]) => {
          if (repo.repo === 'gadget') throw new RateLimitExceededError('primary', 3_000_000);
          return (value as (...a: unknown[]) => unknown).call(target, repo, ...rest);
        };
      },
    });
    const ports = { forInstallation: async () => limited, forRepo: async () => limited };

    const chains = await discoverChains({ api: s.discovery, ports, store: s.store, logger: nullLogger, now: s.clock.now, allowedOwners: s.deps.allowedOwners });
    expect(chains.map((c) => c.holder.repo)).toEqual(['widget']);
  });
});
