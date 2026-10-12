import { describe, expect, it } from 'vitest';
import { CommitNotReachableError } from '../src/github/errors';
import { BRANCH, MID, openPrs, scene, UP } from './helpers/hop-scene';

/**
 * Seen live: after a sync PR was SQUASH-merged, editing the same file again upstream conflicted. The
 * squashed source commit is not an ancestor of the target, so GitHub's three-way merge used an old merge
 * base and saw both sides change the file. sluice knows that commit was applied (it is the last merged
 * PR's marker), so it seeds the branch with an "ours" merge naming it, and the merge base moves forward.
 */
describe.each(['squash', 'rebase'] as const)('%s: a file edited by two consecutive syncs', (method) => {
  it('does not conflict, and brings in only what is new', async () => {
    const s = scene(method);
    s.gh.commit(UP, 'main', { 'a.txt': 'v2\n' }, 'upstream: a v2');
    expect((await s.run()).outcome).toBe('pr_opened');
    s.gh.mergePr(MID, openPrs(s.gh)[0]!.number, method);

    s.gh.commit(UP, 'main', { 'a.txt': 'v3\n' }, 'upstream: a v3');
    const r = await s.run();

    expect(r).toMatchObject({ outcome: 'pr_opened', conflicted: false, mergeable: true });
    expect(s.gh.filesAt(MID, BRANCH)['a.txt']).toBe('v3\n');
    expect(openPrs(s.gh)[0]!.body).toMatch(/Brings 1 commit/);
  });

  it('keeps going over many rounds (each round edits the same file)', async () => {
    const s = scene(method);
    for (let i = 2; i <= 5; i++) {
      s.gh.commit(UP, 'main', { 'a.txt': `v${i}\n` }, `upstream: a v${i}`);
      const r = await s.run();
      expect(r).toMatchObject({ outcome: 'pr_opened', conflicted: false });
      s.gh.mergePr(MID, openPrs(s.gh)[0]!.number, method);
      expect(s.gh.filesAt(MID, 'main')['a.txt']).toBe(`v${i}\n`);
    }
  });

  it('is idempotent: a second run writes nothing', async () => {
    const s = scene(method);
    s.gh.commit(UP, 'main', { 'a.txt': 'v2\n' });
    await s.run();
    s.gh.mergePr(MID, openPrs(s.gh)[0]!.number, method);
    s.gh.commit(UP, 'main', { 'a.txt': 'v3\n' });
    await s.run();

    s.gh.resetCalls();
    expect((await s.run()).outcome).toBe('pr_unchanged');
    expect(s.gh.writes()).toEqual([]);
  });

  it('falls back to a plain merge (never an error) when the baseline commit is gone', async () => {
    const s = scene(method);
    s.gh.commit(UP, 'main', { 'a.txt': 'v2\n' });
    await s.run();
    s.gh.mergePr(MID, openPrs(s.gh)[0]!.number, method);
    s.gh.commit(UP, 'main', { 'a.txt': 'v3\n' });
    s.gh.failNext('createCommit', new CommitNotReachableError('me/widget', 'f'.repeat(40)));

    const r = await s.run();
    expect(r.outcome).not.toBe('error');
    expect(['pr_opened', 'conflict']).toContain(r.outcome);
  });

  it('seeds the branch with a commit that has the target tree and the baseline as a second parent', async () => {
    const s = scene(method);
    s.gh.commit(UP, 'main', { 'a.txt': 'v2\n' });
    await s.run();
    const baseline = s.gh.tip(UP, 'main');
    s.gh.mergePr(MID, openPrs(s.gh)[0]!.number, method);
    s.gh.commit(UP, 'main', { 'a.txt': 'v3\n' });
    s.gh.resetCalls();
    await s.run();

    const seeds = s.gh.calls.filter((c) => c.op === 'createCommit').map((c) => (c.detail as { parents: string[] }).parents);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toHaveLength(2);
    expect(seeds[0]![1]).toBe(baseline);
  });
});

describe('merge-commit hops are untouched', () => {
  it('creates no seed commit, even when the target has commits of its own', async () => {
    const s = scene('merge');
    s.gh.commit(MID, 'main', { 'local.txt': 'midstream only\n' });
    s.gh.commit(UP, 'main', { 'a.txt': 'v2\n' });
    s.gh.resetCalls();

    expect((await s.run()).outcome).toBe('pr_opened');
    expect(s.gh.calls.filter((c) => c.op === 'createCommit')).toEqual([]);
  });
});
