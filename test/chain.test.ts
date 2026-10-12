import { describe, expect, it } from 'vitest';
import { createEventHandler } from '../src/events';
import { RateLimitExceededError } from '../src/github/resilient';
import { nullLogger } from '../src/log';
import { buildHopSpec } from '../src/sync/chain';
import { loadChainConfig } from '../src/config/load';
import { runAdminSync } from '../src/sync/admin';
import { syncDownstreamOnPush } from '../src/sync/downstream';
import { pollUpstreams } from '../src/sync/poll';
import { chainScene, chainYml } from './helpers/chain-scene';
import type { ChainScene } from './helpers/chain-scene';

const MID = 'me/widget';
const DOWN = 'other/deploy';
const midRef = { owner: 'me', repo: 'widget' };

const poll = (s: ChainScene, opts: { force?: boolean } = {}, onlyRepos?: Set<string>) =>
  pollUpstreams({ ...s.deps, discovery: s.discovery, ...(onlyRepos ? { onlyRepos } : {}) }, nullLogger, opts);

const push = (s: ChainScene, over: Partial<Parameters<typeof syncDownstreamOnPush>[1]> = {}) =>
  syncDownstreamOnPush(
    s.deps,
    { deliveryId: 'dlv-1', installationId: 1, repo: midRef, ref: 'refs/heads/main', deleted: false, ...over },
    nullLogger,
  );

describe('cron: upstream -> midstream', () => {
  it('finds the chain by its chain.yml and opens the sync PR in midstream', async () => {
    const s = chainScene();
    const tip = s.gh.commit('acme/widget', 'main', { 'a.txt': '2\n' }, 'upstream feature');
    const results = await poll(s);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ hop: 'upstream_to_midstream', chain: MID, outcome: 'pr_opened', sourceSha: tip });
    expect(s.gh.prs(MID)).toHaveLength(1);
    expect(s.gh.prs(DOWN)).toHaveLength(0);
  });

  it('ignores repos without a chain.yml, quietly', async () => {
    const s = chainScene({
      installations: [{ id: 1, login: 'me', suspended: false, repos: ['me/widget', 'me/other-repo-without-config'] }],
    });
    s.gh.createRepo('me/other-repo-without-config');
    const results = await poll(s);
    expect(results.map((r) => r.chain)).toEqual([MID]);
    expect(s.store.runs.filter((r) => r.outcome === 'error' || r.outcome === 'config_invalid')).toHaveLength(0);
  });

  it('never touches installations outside ALLOWED_OWNERS (no token minted, nothing scanned)', async () => {
    const s = chainScene({
      installations: [
        { id: 1, login: 'me', suspended: false, repos: ['me/widget'] },
        { id: 99, login: 'stranger', suspended: false, repos: ['stranger/widget'] },
      ],
    });
    s.gh.createRepo('stranger/widget', { '.github/chain.yml': chainYml({ mid: 'stranger/widget' }) });
    await poll(s);
    expect(s.forInstallationCalls).toEqual([1]);
  });

  it('skips suspended installations', async () => {
    const s = chainScene({ installations: [{ id: 1, login: 'me', suspended: true, repos: ['me/widget'] }] });
    expect(await poll(s)).toEqual([]);
    expect(s.forInstallationCalls).toEqual([]);
  });

  it('logs an invalid chain.yml, skips that chain, and keeps going', async () => {
    const s = chainScene({
      configYaml: chainYml({ extra: 'variabless: []\n' }),
      installed: ['me/widget', 'me/gadget', 'other/deploy'],
      installations: [{ id: 1, login: 'me', suspended: false, repos: ['me/widget', 'me/gadget'] }],
    });
    s.gh.createRepo('acme/gadget', { 'g.txt': '1\n' });
    s.gh.fork('acme/gadget', 'me/gadget');
    s.gh.commit('me/gadget', 'main', { '.github/chain.yml': chainYml({ up: 'acme/gadget', mid: 'me/gadget', down: 'other/gadget-deploy' }) });
    s.gh.commit('acme/gadget', 'main', { 'g.txt': '2\n' });

    const results = await poll(s);
    expect(results.map((r) => [r.chain, r.outcome])).toEqual([['me/gadget', 'pr_opened']]);
    const bad = s.store.runs.find((r) => r.outcome === 'config_invalid');
    expect(bad).toMatchObject({ chain: MID, hop: 'config' });
    expect(JSON.stringify(bad?.detail)).toContain('variabless');
  });

  it('honours poll_interval_minutes, and force overrides it', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: 'hops:\n  upstream_to_midstream:\n    poll_interval_minutes: 180\n' }) });
    s.gh.commit('acme/widget', 'main', { 'a.txt': '2\n' });
    expect(await poll(s)).toHaveLength(1);

    s.clock.advance(60 * 60_000); // 1h later: the hourly cron fires, the chain is not due
    expect(await poll(s)).toHaveLength(0);
    expect(await poll(s, { force: true })).toHaveLength(1);

    s.clock.advance(3 * 60 * 60_000);
    expect(await poll(s)).toHaveLength(1);
  });

  it('with the default hourly interval, every cron tick runs (and is a no-op when nothing changed)', async () => {
    const s = chainScene();
    s.gh.commit('acme/widget', 'main', { 'a.txt': '2\n' });
    await poll(s);
    s.gh.resetCalls();
    s.clock.advance(60 * 60_000);
    const again = await poll(s);
    expect(again.map((r) => r.outcome)).toEqual(['pr_unchanged']);
    expect(s.gh.writes()).toEqual([]);
  });

  it('retries failed hops on the next tick instead of waiting out the interval', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: 'hops:\n  upstream_to_midstream:\n    poll_interval_minutes: 600\n' }) });
    s.gh.commit('acme/widget', 'main', { 'a.txt': '2\n' });
    s.gh.failNext('createPullRequest', new Error('boom'));
    expect((await poll(s))[0]!.outcome).toBe('error');
    s.clock.advance(60 * 60_000);
    expect((await poll(s))[0]!.outcome).toBe('pr_opened');
  });

  it('stops the whole tick on a rate limit but does not throw', async () => {
    const s = chainScene({
      installed: ['me/widget', 'me/gadget', 'other/deploy'],
      installations: [{ id: 1, login: 'me', suspended: false, repos: ['me/widget', 'me/gadget'] }],
    });
    s.gh.createRepo('acme/gadget', { 'g.txt': '1\n' });
    s.gh.fork('acme/gadget', 'me/gadget');
    s.gh.commit('me/gadget', 'main', { '.github/chain.yml': chainYml({ up: 'acme/gadget', mid: 'me/gadget', down: 'other/gadget-deploy' }) });
    s.gh.commit('acme/gadget', 'main', { 'g.txt': '2\n' });
    s.gh.commit('acme/widget', 'main', { 'a.txt': '2\n' });

    s.gh.failNext('compare', new RateLimitExceededError('primary', 3_600_000));
    const results = await poll(s);
    expect(results).toEqual([]); // the interrupted hop threw; its outcome is in the run log
    expect(s.store.runs.map((r) => r.outcome)).toEqual(['rate_limited']);
    expect(s.gh.prs(MID)).toHaveLength(0);
    expect(s.gh.prs('me/gadget')).toHaveLength(0); // second chain waits for the next tick

    // next tick, limit lifted: both chains are served
    s.clock.advance(60 * 60_000);
    expect((await poll(s)).map((r) => r.outcome)).toEqual(['pr_opened', 'pr_opened']);
  });

  it('CHAIN_REPOS limits the scan to listed midstreams (no installation enumeration)', async () => {
    const s = chainScene({ installations: [{ id: 1, login: 'me', suspended: false, repos: ['me/widget', 'me/unrelated'] }] });
    s.gh.commit('acme/widget', 'main', { 'a.txt': '2\n' });
    const results = await poll(s, {}, new Set(['me/widget']));
    expect(results).toHaveLength(1);
    expect(s.forInstallationCalls).toEqual([]);
    expect(s.forRepoCalls).toContain(MID);
  });

  it('reports transport "git-data" as not implemented instead of attempting it', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: 'transport: git-data\n' }) });
    s.gh.commit('acme/widget', 'main', { 'a.txt': '2\n' });
    const [r] = await poll(s);
    expect(r).toMatchObject({ outcome: 'error' });
    expect(r!.message).toMatch(/not implemented/);
    expect(s.gh.writes()).toEqual([]);
  });
});

describe('webhook: midstream -> downstream (different org)', () => {
  it('a push to midstream opens a sync PR in DOWNSTREAM, never touching either main', async () => {
    const s = chainScene();
    const midTip = s.gh.commit(MID, 'main', { 'a.txt': 'midstream change\n' }, 'midstream: change');
    const downMain = s.gh.tip(DOWN, 'main');
    const midMain = s.gh.tip(MID, 'main');

    const r = await push(s);
    expect(r).toMatchObject({ hop: 'midstream_to_downstream', outcome: 'pr_opened', sourceSha: midTip });
    expect(s.gh.tip(DOWN, 'chain/sync-midstream')).toBe(midTip);
    expect(s.gh.tip(DOWN, 'main')).toBe(downMain);
    expect(s.gh.tip(MID, 'main')).toBe(midMain);
    expect(s.gh.prs(DOWN)).toHaveLength(1);
    expect(s.gh.prs(MID)).toHaveLength(0);
    expect([...s.gh.prs(DOWN)[0]!.reviewers]).toEqual(['octocat']);
    // every write went to the DOWNSTREAM repo
    expect(new Set(s.gh.writes().map((w) => w.repo))).toEqual(new Set([DOWN]));
  });

  it('redelivering the same push is a no-op', async () => {
    const s = chainScene();
    s.gh.commit(MID, 'main', { 'a.txt': 'x\n' });
    await push(s);
    s.gh.resetCalls();
    const again = await push(s, { deliveryId: 'dlv-2' });
    expect(again?.outcome).toBe('pr_unchanged');
    expect(s.gh.writes()).toEqual([]);
    expect(s.gh.prs(DOWN)).toHaveLength(1);
  });

  it('the whole chain: upstream commit -> midstream PR -> (you merge) -> downstream PR -> (you merge) -> quiet', async () => {
    const s = chainScene();
    const up = s.gh.commit('acme/widget', 'main', { 'a.txt': '2\n' }, 'upstream feature');

    const hop1 = (await poll(s))[0]!;
    expect(hop1.outcome).toBe('pr_opened');
    expect(s.gh.prs(DOWN)).toHaveLength(0); // nothing flows downstream until YOU merge

    s.gh.mergePr(MID, hop1.prNumber!, 'merge'); // you review and merge in midstream
    const hop2 = (await push(s, { deliveryId: 'after-merge' }))!;
    expect(hop2.outcome).toBe('pr_opened');
    expect(s.gh.contains(DOWN, 'chain/sync-midstream', up)).toBe(true);
    expect(s.gh.filesAt(DOWN, 'chain/sync-midstream')['.github/chain.yml']).toBeDefined();

    s.gh.mergePr(DOWN, hop2.prNumber!, 'merge'); // you review and merge in downstream
    expect((await push(s, { deliveryId: 'again' }))?.outcome).toBe('up_to_date');
    s.clock.advance(60 * 60_000);
    expect((await poll(s))[0]!.outcome).toBe('up_to_date');
    expect(s.gh.filesAt(DOWN, 'main')['a.txt']).toBe('2\n');
  });

  it('ignores pushes to other branches, branch deletions, and tags', async () => {
    const s = chainScene();
    s.gh.commit(MID, 'main', { 'a.txt': 'x\n' });
    expect(await push(s, { ref: 'refs/heads/feature' })).toBeNull();
    expect(await push(s, { deleted: true })).toBeNull();
    expect(await push(s, { ref: 'refs/tags/v1' })).toBeNull();
    expect(s.gh.writes()).toEqual([]);
  });

  it('ignores pushes to repos that are not a midstream', async () => {
    const s = chainScene();
    s.gh.createRepo('me/plain', { 'x.txt': '1\n' });
    expect(await push(s, { repo: { owner: 'me', repo: 'plain' } })).toBeNull();
    expect(s.gh.writes()).toEqual([]);
  });

  it('logs an invalid chain.yml and does nothing', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: 'nonsense: 1\n' }) });
    expect(await push(s)).toBeNull();
    expect(s.store.runs.at(-1)).toMatchObject({ outcome: 'config_invalid', trigger: 'webhook:push' });
    expect(s.gh.writes()).toEqual([]);
  });

  it('tracks a non-default midstream.branch from chain.yml', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: '' }).replace('midstream:  { repo: me/widget }', 'midstream:  { repo: me/widget, branch: develop }') });
    s.gh.branchFrom(MID, 'develop');
    s.gh.fork(MID, 'other/deploy2'); // unused; keeps the network shape realistic
    s.gh.commit(MID, 'develop', { 'a.txt': 'dev\n' });
    expect(await push(s, { ref: 'refs/heads/main' })).toBeNull();
    // downstream main exists; its fork of midstream has develop? create it so the target branch check passes
    expect((await push(s, { ref: 'refs/heads/develop' }))?.hop).toBe('midstream_to_downstream');
  });

  it('refuses a downstream owner outside ALLOWED_OWNERS: a midstream owner cannot aim PRs at strangers', async () => {
    const s = chainScene({ allowed: ['me'] });
    s.gh.commit(MID, 'main', { 'a.txt': 'x\n' });
    const r = await push(s);
    expect(r?.outcome).toBe('error');
    expect(r?.message).toMatch(/not in ALLOWED_OWNERS/);
    expect(s.forRepoCalls).not.toContain(DOWN); // did not even look up their installation
    expect(s.gh.prs(DOWN)).toHaveLength(0);
    expect(s.store.runs.at(-1)).toMatchObject({ outcome: 'error', hop: 'midstream_to_downstream' });
  });

  it('reports when the app is not installed on downstream', async () => {
    const s = chainScene({ installed: ['me/widget'] });
    s.gh.commit(MID, 'main', { 'a.txt': 'x\n' });
    const r = await push(s);
    expect(r?.outcome).toBe('error');
    expect(r?.message).toMatch(/not installed on other\/deploy/);
    expect(s.gh.writes()).toEqual([]);
  });

  it('ignores pushes from non-allowlisted owners without minting a token', async () => {
    const s = chainScene();
    expect(await push(s, { repo: { owner: 'stranger', repo: 'widget' } })).toBeNull();
    expect(s.forInstallationCalls).toEqual([]);
  });
});

describe('event handler: push', () => {
  const pushEvent = (s: ChainScene, owner = 'me', ref = 'refs/heads/main') => ({
    id: 'evt-1',
    name: 'push',
    payload: {
      ref,
      deleted: false,
      installation: { id: 1 },
      repository: { name: 'widget', owner: { login: owner, name: owner } },
    },
  });

  it('routes a signed push through to the downstream sync', async () => {
    const s = chainScene();
    s.gh.commit(MID, 'main', { 'a.txt': 'x\n' });
    await createEventHandler(s.deps)(pushEvent(s), nullLogger);
    expect(s.gh.prs(DOWN)).toHaveLength(1);
    expect(s.store.runs.at(-1)).toMatchObject({ trigger: 'webhook:push', deliveryId: 'evt-1', outcome: 'pr_opened' });
  });

  it('ignores a push from a stranger', async () => {
    const s = chainScene();
    await createEventHandler(s.deps)(pushEvent(s, 'stranger'), nullLogger);
    expect(s.forInstallationCalls).toEqual([]);
  });
});

describe('admin sync', () => {
  const run = (s: ChainScene, over: Partial<Parameters<typeof runAdminSync>[1]> = {}) =>
    runAdminSync(s.deps, { chain: MID, hop: 'upstream_to_midstream', dryRun: true, ...over }, nullLogger);

  it('dry run returns the plan and writes nothing', async () => {
    const s = chainScene();
    s.gh.commit('acme/widget', 'main', { 'a.txt': '2\n' });
    const out = await run(s);
    expect(out).toMatchObject({ ok: true, result: { outcome: 'dry_run', plan: { action: 'open_pr' } } });
    expect(s.gh.writes()).toEqual([]);
    expect(s.store.runs).toHaveLength(0);
  });

  it('a real run does the work and logs it as "admin"', async () => {
    const s = chainScene();
    s.gh.commit('acme/widget', 'main', { 'a.txt': '2\n' });
    const out = await run(s, { dryRun: false });
    expect(out).toMatchObject({ ok: true, result: { outcome: 'pr_opened' } });
    expect(s.store.runs.at(-1)).toMatchObject({ trigger: 'admin' });
  });

  it.each([
    [{ chain: 'not-a-repo' }, 400],
    [{ chain: 'stranger/widget' }, 403],
    [{ chain: 'me/uninstalled' }, 404],
  ])('rejects %j with %i', async (over, status) => {
    const s = chainScene();
    const out = await run(s, over);
    expect(out).toMatchObject({ ok: false, status });
  });

  it('422s with positioned details for an invalid chain.yml', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: 'variabless: []\n' }) });
    const out = await run(s);
    expect(out).toMatchObject({ ok: false, status: 422 });
    if (!out.ok) expect(out.details).toMatch(/variabless/);
  });
});

describe('step 4 through the chain: conflicts and protected paths', () => {
  const holder = { owner: 'me', repo: 'widget' };

  async function specFor(extra: string, hop: 'upstream_to_midstream' | 'midstream_to_downstream' = 'upstream_to_midstream') {
    const s = chainScene({ configYaml: chainYml({ extra }) });
    const loaded = await loadChainConfig(s.gh, holder);
    if (loaded.status !== 'ok') throw new Error('config should load');
    return buildHopSpec({ holder, config: loaded.config, midstreamPort: s.gh }, hop);
  }

  it('conflict assignees: conflicts.assignees, else pull_requests.reviewers, else pull_requests.assignees', async () => {
    const explicit = await specFor('conflicts:\n  assignees: [alice]\n');
    expect(explicit.conflicts.assignees).toEqual(['alice']);
    expect(explicit.conflicts).toMatchObject({ label: 'sluice/conflict', comment: true, requestReview: true });

    expect((await specFor('')).conflicts.assignees).toEqual(['octocat']); // pull_requests.reviewers

    const onlyAssignees = chainScene({
      configYaml: chainYml().replace('  reviewers: [octocat]\n', ''),
    });
    const loaded = await loadChainConfig(onlyAssignees.gh, holder);
    if (loaded.status !== 'ok') throw new Error('config should load');
    const spec = buildHopSpec({ holder, config: loaded.config, midstreamPort: onlyAssignees.gh }, 'upstream_to_midstream');
    expect(spec.conflicts.assignees).toEqual(['octocat']); // fell through to pull_requests.assignees
  });

  it('protected paths are per hop', async () => {
    const extra = 'hops:\n  upstream_to_midstream:\n    protected_paths: ["patches/**"]\n  midstream_to_downstream:\n    protected_paths: ["deploy/**"]\n';
    expect((await specFor(extra, 'upstream_to_midstream')).protectedPaths).toEqual(['patches/**']);
    expect((await specFor(extra, 'midstream_to_downstream')).protectedPaths).toEqual(['deploy/**']);
  });

  it('cron: an upstream/midstream conflict is flagged in midstream, and downstream is untouched', async () => {
    const s = chainScene();
    s.gh.commit(MID, 'main', { 'a.txt': 'midstream version\n' }, 'midstream edit');
    s.gh.commit('acme/widget', 'main', { 'a.txt': 'upstream version\n' }, 'upstream edit');
    const [r] = await poll(s);
    expect(r).toMatchObject({ outcome: 'conflict', conflicted: true });
    const [prMid] = s.gh.prs(MID);
    expect([...prMid!.labels]).toContain('sluice/conflict');
    expect([...prMid!.assignees]).toEqual(expect.arrayContaining(['octocat']));
    expect(s.gh.prs(DOWN)).toHaveLength(0);
  });

  it('downstream keeps its own files: a push to midstream cannot overwrite a protected downstream path (cross-org)', async () => {
    const s = chainScene({
      configYaml: chainYml({ extra: 'hops:\n  midstream_to_downstream:\n    protected_paths: ["deploy/**"]\n' }),
    });
    s.gh.commit(DOWN, 'main', { 'deploy/prod.env': 'REGION=eu-west-1 (downstream only)\n' }, 'downstream: deployment config');
    s.gh.commit(MID, 'main', { 'deploy/prod.env': 'REGION=us-east-1 (midstream default)\n', 'a.txt': 'new\n' }, 'midstream: change');

    const r = await push(s);
    expect(r).toMatchObject({ outcome: 'pr_opened', conflicted: false, protectedKept: ['deploy/prod.env'] });
    expect(s.gh.filesAt(DOWN, 'chain/sync-midstream')).toMatchObject({
      'deploy/prod.env': 'REGION=eu-west-1 (downstream only)\n',
      'a.txt': 'new\n',
    });
    expect(new Set(s.gh.writes().map((w) => w.repo))).toEqual(new Set([DOWN])); // restore commit made IN downstream
    s.gh.mergePr(DOWN, r!.prNumber!, 'merge');
    expect((await push(s, { deliveryId: 'again' }))?.outcome).toBe('up_to_date');
  });
});
