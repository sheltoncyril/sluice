import { describe, expect, it } from 'vitest';
import { CommitNotReachableError } from '../src/github/errors';
import { openPrs, scene, UP, MID } from './helpers/hop-scene';

const midRef = { owner: 'me', repo: 'widget' };

/**
 * Observed on a live fork chain (public, user -> org, 2026-10-12): a commit that exists only in another
 * repo of the network is
 *   - REFUSED by the Compare API when given bare (404),
 *   - resolved by Compare when qualified `owner:sha`,
 *   - accepted bare by create-ref, the Merges API and the Git Data endpoints.
 * The fake models exactly that, so an engine that forgets the qualifier fails its whole suite, as the
 * production sync did on its first run.
 */
describe('a commit that lives only in another repo of the fork network', () => {
  it('Compare refuses it bare and resolves it qualified with the owner', async () => {
    const s = scene();
    const sha = s.gh.commit(UP, 'main', { 'a.txt': '2\n' });

    await expect(s.gh.compare(midRef, 'main', sha)).rejects.toBeInstanceOf(CommitNotReachableError);
    expect(await s.gh.compare(midRef, 'main', `acme:${sha}`)).toMatchObject({ status: 'ahead', aheadBy: 1, behindBy: 0 });
  });

  it('Compare resolves it bare once it is reachable from a branch of the target', async () => {
    const s = scene();
    const sha = s.gh.commit(UP, 'main', { 'a.txt': '2\n' });
    await s.gh.createBranch(midRef, 'chain/probe', sha);

    expect(await s.gh.compare(midRef, 'main', 'chain/probe')).toMatchObject({ aheadBy: 1 });
    expect(await s.gh.compare(midRef, 'main', sha)).toMatchObject({ aheadBy: 1 }); // reachable from chain/probe now
  });

  it('create-ref, the Merges API and Git Data take it bare', async () => {
    const s = scene();
    const sha = s.gh.commit(UP, 'main', { 'a.txt': '2\n' });

    expect(await s.gh.createBranch(midRef, 'chain/at-foreign', sha)).toBe('created');
    expect(await s.gh.createBranch(midRef, 'chain/merge-into', s.gh.tip(MID, 'main'))).toBe('created');
    expect(await s.gh.mergeIntoBranch(midRef, 'chain/merge-into', sha, 'probe')).toMatchObject({ result: 'merged' });
    expect((await s.gh.getCommitInfo(midRef, sha)).treeSha).toBeTruthy();
  });

  it('a qualifier for an owner outside the network is refused', async () => {
    const s = scene();
    const sha = s.gh.commit(UP, 'main', { 'a.txt': '2\n' });
    await expect(s.gh.compare(midRef, 'main', `stranger:${sha}`)).rejects.toBeInstanceOf(CommitNotReachableError);
  });
});

describe('a tree pushed to the source is not readable through the fork for a few seconds', () => {
  const protectB = { protectedPaths: ['b.txt'] };

  it('waits (1 s, 2 s, ...) and then syncs, instead of failing the push-triggered run', async () => {
    const s = scene();
    s.gh.commit(UP, 'main', { 'a.txt': '2\n', 'b.txt': '2\n' });
    s.gh.treeLagReads = 4; // both tree reads of one attempt run in parallel, so two attempts fail

    const r = await s.run({}, protectB);
    expect(r.outcome).toBe('pr_opened');
    expect(s.sleeps).toEqual([1000, 2000]);
    expect(r.protectedKept).toEqual(['b.txt']);
  });

  it('gives up after four waits (15 s in all) and says the commit is not reachable', async () => {
    const s = scene();
    s.gh.commit(UP, 'main', { 'a.txt': '2\n', 'b.txt': '2\n' });
    s.gh.treeLagReads = 99;

    const r = await s.run({}, protectB);
    expect(r.outcome).toBe('error');
    expect(r.message).toMatch(/not reachable/);
    expect(s.sleeps).toEqual([1000, 2000, 4000, 8000]);
    expect(s.gh.writes()).toEqual([]); // nothing was half-done
  });

  it('does not wait when nothing reads the tree (no protected paths)', async () => {
    const s = scene();
    s.gh.commit(UP, 'main', { 'a.txt': '2\n' });
    s.gh.treeLagReads = 99;

    expect((await s.run()).outcome).toBe('pr_opened');
    expect(s.sleeps).toEqual([]);
  });

  it('and a source that is NOT in the network fails at once, without waiting', async () => {
    const s = scene();
    s.gh.createRepo('stranger/widget', { 'a.txt': '1\n' });
    const sha = s.gh.commit('stranger/widget', 'main', { 'a.txt': '2\n' });
    s.gh.treeLagReads = 99;

    const r = await s.run({}, { source: { repo: { owner: 'stranger', repo: 'widget' }, branch: 'main' }, protectedPaths: ['b.txt'] });
    expect(r.outcome).toBe('error');
    expect(r.message).toContain(sha.slice(0, 7));
    expect(s.sleeps).toEqual([]);
  });
});

describe('the engine qualifies every source-side commit it compares', () => {
  type Compare = { base: string; head: string };
  const compares = (s: ReturnType<typeof scene>): Compare[] => s.gh.calls.filter((c) => c.op === 'compare').map((c) => c.detail as Compare);

  it('merge method: the ancestry check and the "already on the sync branch" check', async () => {
    const s = scene();
    const tip = s.gh.commit(UP, 'main', { 'a.txt': '2\n' });
    expect((await s.run()).outcome).toBe('pr_opened');
    s.gh.commit(UP, 'main', { 'b.txt': '2\n' }); // upstream moves again: the sync branch must be compared
    const tip2 = s.gh.tip(UP, 'main');
    expect((await s.run()).outcome).toBe('pr_updated');

    const involving = compares(s).filter((c) => [c.base, c.head].some((r) => r.includes(tip) || r.includes(tip2)));
    expect(involving.length).toBeGreaterThanOrEqual(2);
    for (const c of involving) {
      // The source SHA is only ever the head here, and always owner-qualified.
      expect(c.head).toMatch(/^acme:[0-9a-f]{40}$/);
      expect(c.base).not.toMatch(/^[0-9a-f]{40}$/); // never a bare foreign commit
    }
  });

  it('squash: both ends of the baseline compare are qualified', async () => {
    const s = scene('squash');
    s.gh.commit(UP, 'main', { 'a.txt': '2\n' });
    await s.run();
    s.gh.mergePr(MID, openPrs(s.gh)[0]!.number, 'squash');
    s.gh.commit(UP, 'main', { 'b.txt': '2\n' });
    s.gh.resetCalls();

    expect((await s.run()).outcome).toBe('pr_opened');
    const baseline = compares(s).find((c) => /^acme:[0-9a-f]{40}$/.test(c.base));
    expect(baseline).toBeDefined();
    expect(baseline!.head).toMatch(/^acme:[0-9a-f]{40}$/);
  });
});

describe('a failed run always says something', () => {
  it('records the error type and HTTP status when the error carries no message', async () => {
    const s = scene();
    s.gh.commit(UP, 'main', { 'a.txt': '2\n' });
    s.gh.failNext('getBranchSha', Object.assign(new Error(''), { status: 502 }));

    const r = await s.run();
    expect(r.outcome).toBe('error');
    expect(r.message).toBe('Error (HTTP 502) with no message');
    expect(s.store.runs.at(-1)).toMatchObject({ outcome: 'error', detail: { message: 'Error (HTTP 502) with no message' } });
  });

  it('still prefers the real message, scrubbed', async () => {
    const s = scene();
    s.gh.commit(UP, 'main', { 'a.txt': '2\n' });
    s.gh.failNext('getBranchSha', new Error('boom ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
    const r = await s.run();
    expect(r.message).toContain('boom');
    expect(r.message).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});
