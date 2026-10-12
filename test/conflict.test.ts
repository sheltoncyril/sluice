import { describe, expect, it } from 'vitest';
import { RateLimitExceededError } from '../src/github/resilient';
import { nullLogger } from '../src/log';
import { awaitMergeable, CONFLICT_COMMENT_MARKER, reconcileConflict } from '../src/sync/conflict';
import { FakeGitHub } from './helpers/fake-github';
import { BRANCH, MID, openPrs, scene, UP } from './helpers/hop-scene';

/** midstream and upstream both edit a.txt, differently: GitHub cannot merge it. */
function conflicting() {
  const s = scene();
  s.gh.commit(MID, 'main', { 'a.txt': 'midstream version\n' }, 'midstream edit a');
  s.gh.commit(UP, 'main', { 'a.txt': 'upstream version\n' }, 'upstream edit a');
  return s;
}

const pr = (s: ReturnType<typeof scene>) => openPrs(s.gh)[0]!;
const commentsOn = (s: ReturnType<typeof scene>) => s.gh.comments(MID, pr(s).number);

describe('awaitMergeable (GitHub computes it lazily)', () => {
  const repo = { owner: 'me', repo: 'widget' };

  async function prWith(lag: number) {
    const gh = new FakeGitHub().createRepo(MID);
    gh.branchFrom(MID, 'feature');
    gh.commit(MID, 'feature', { 'x.txt': '1' });
    const { pr } = await gh.createPullRequest(repo, { title: 't', body: '', head: 'feature', base: 'main', draft: false });
    gh.mergeableLag = lag;
    return { gh, number: pr.number };
  }

  it('returns at once when GitHub already knows', async () => {
    const { gh, number } = await prWith(0);
    const sleeps: number[] = [];
    expect(await awaitMergeable(gh, repo, number, undefined, async (ms) => void sleeps.push(ms))).toBe(true);
    expect(sleeps).toEqual([]);
  });

  it('retries with growing waits until GitHub answers', async () => {
    const { gh, number } = await prWith(3);
    const sleeps: number[] = [];
    expect(await awaitMergeable(gh, repo, number, { attempts: 5, delayMs: 1000 }, async (ms) => void sleeps.push(ms))).toBe(true);
    expect(sleeps).toEqual([1000, 2000, 3000]);
  });

  it('gives up with null after the last attempt, without a pointless final sleep', async () => {
    const { gh, number } = await prWith(99);
    const sleeps: number[] = [];
    expect(await awaitMergeable(gh, repo, number, { attempts: 3, delayMs: 10 }, async (ms) => void sleeps.push(ms))).toBeNull();
    expect(sleeps).toEqual([10, 20]);
  });
});

describe('conflict handling: first detection', () => {
  it('labels, comments, assigns and requests review, exactly once each', async () => {
    const s = conflicting();
    const r = await s.run();
    expect(r).toMatchObject({ outcome: 'conflict', conflicted: true, mergeable: false });

    expect([...pr(s).labels]).toContain('sluice/conflict');
    expect([...pr(s).assignees]).toEqual(['octocat']);
    expect([...pr(s).reviewers]).toEqual(['octocat']);
    expect(commentsOn(s)).toHaveLength(1);
    expect(commentsOn(s)[0]).toContain(CONFLICT_COMMENT_MARKER);
    expect(commentsOn(s)[0]).toContain('chain/sync-upstream');
    expect(pr(s).body).toContain('Merge conflicts');
  });

  it('a steady conflict costs ZERO writes per run and never stacks comments', async () => {
    const s = conflicting();
    await s.run();
    const bodyBefore = pr(s).body;
    s.gh.resetCalls();
    for (let i = 0; i < 4; i++) expect((await s.run()).outcome).toBe('conflict');
    expect(s.gh.writes()).toEqual([]);
    expect(commentsOn(s)).toHaveLength(1);
    expect(pr(s).body).toBe(bodyBefore);
  });

  it('works when GitHub is slow to compute mergeability', async () => {
    const s = conflicting();
    s.gh.mergeableLag = 2;
    const r = await s.run();
    expect(r.outcome).toBe('conflict');
    expect(s.sleeps).toEqual([1500, 3000]);
    expect([...pr(s).labels]).toContain('sluice/conflict');
  });

  it('falls back on the merge refusal as evidence when GitHub never answers', async () => {
    const s = conflicting();
    s.gh.mergeableLag = 99;
    const r = await s.run();
    expect(r).toMatchObject({ outcome: 'conflict', mergeable: null });
    expect([...pr(s).labels]).toContain('sluice/conflict');
    expect(s.sleeps).toHaveLength(4); // 5 attempts, 4 waits
  });

  it('does NOT invent a conflict when GitHub never answers and nothing suggests one', async () => {
    const s = scene();
    s.gh.commit(UP, 'main', { 'a.txt': '2\n' });
    s.gh.mergeableLag = 99;
    const r = await s.run();
    expect(r).toMatchObject({ outcome: 'pr_opened', mergeable: null });
    expect([...pr(s).labels]).not.toContain('sluice/conflict');
  });
});

describe('conflict handling: transitions', () => {
  it('clears the label and marks the comment resolved when the conflict goes away', async () => {
    const s = conflicting();
    await s.run();
    s.gh.commit(MID, 'main', { 'a.txt': '1\n' }, 'revert midstream edit');

    const r = await s.run();
    expect(r).toMatchObject({ conflicted: false, mergeable: true });
    expect(r.outcome).toBe('pr_updated');
    expect([...pr(s).labels]).not.toContain('sluice/conflict');
    expect(commentsOn(s)).toHaveLength(1);
    expect(commentsOn(s)[0]).toContain('Conflict resolved');
    expect(pr(s).body).not.toContain('Merge conflicts');

    s.gh.resetCalls();
    expect((await s.run()).outcome).toBe('pr_unchanged');
    expect(s.gh.writes()).toEqual([]);
  });

  it('flags a conflict that appears LATER, after a clean PR (target moved on)', async () => {
    const s = scene();
    s.gh.commit(UP, 'main', { 'a.txt': 'upstream version\n' });
    expect((await s.run()).outcome).toBe('pr_opened');
    expect([...pr(s).labels]).not.toContain('sluice/conflict');

    s.gh.commit(MID, 'main', { 'a.txt': 'midstream version\n' }, 'midstream edits the same file');
    const r = await s.run();
    expect(r.outcome).toBe('conflict');
    expect([...pr(s).labels]).toContain('sluice/conflict');
    expect(commentsOn(s)).toHaveLength(1);
  });

  it('re-flags if a human removes the label while the conflict persists, without a second comment', async () => {
    const s = conflicting();
    await s.run();
    pr(s).labels.delete('sluice/conflict');
    await s.run();
    expect([...pr(s).labels]).toContain('sluice/conflict');
    expect(commentsOn(s)).toHaveLength(1);
  });

  it('keeps the flagged state while GitHub is temporarily unsure (no flapping)', async () => {
    const s = conflicting();
    await s.run();
    s.gh.mergeableLag = 99;
    s.gh.resetCalls();
    expect((await s.run()).outcome).toBe('conflict');
    expect([...pr(s).labels]).toContain('sluice/conflict');
    expect(s.gh.writes()).toEqual([]);
  });
});

describe('conflict handling: policy', () => {
  it('honours comment:false', async () => {
    const s = conflicting();
    await s.run({}, { conflicts: { ...s.spec.conflicts, comment: false } });
    expect([...pr(s).labels]).toContain('sluice/conflict');
    expect(commentsOn(s)).toHaveLength(0);
  });

  it('honours requestReview:false (assign only) and a custom label', async () => {
    const s = conflicting();
    await s.run({}, { conflicts: { ...s.spec.conflicts, requestReview: false, label: 'needs-human' } });
    expect([...pr(s).assignees]).toContain('octocat');
    expect([...pr(s).reviewers]).toEqual(['octocat']); // from the normal PR reviewers, not the conflict policy
    expect([...pr(s).labels]).toContain('needs-human');
    expect(s.gh.calls.filter((c) => c.op === 'requestReviewers')).toHaveLength(1);
  });

  it('with nobody to assign, still labels and comments', async () => {
    const s = conflicting();
    await s.run({}, { conflicts: { ...s.spec.conflicts, assignees: [] } });
    expect([...pr(s).labels]).toContain('sluice/conflict');
    expect(commentsOn(s)).toHaveLength(1);
  });

  it('failures in comment / assign / review are logged, not fatal', async () => {
    const s = conflicting();
    s.gh.failNext('createComment', new Error('comments are locked'));
    s.gh.failNext('requestReviewers', new Error('reviewer has no access'));
    const r = await s.run();
    expect(r.outcome).toBe('conflict');
    expect([...pr(s).labels]).toContain('sluice/conflict');
    expect([...pr(s).assignees]).toEqual(['octocat']);
  });
});

describe('conflict handling: safety', () => {
  it('a dry run never polls or writes', async () => {
    const s = conflicting();
    await s.run();
    s.gh.resetCalls();
    await s.run({ dryRun: true });
    expect(s.gh.calls.filter((c) => c.op === 'getMergeability')).toHaveLength(0);
    expect(s.gh.writes()).toEqual([]);
  });

  it('a rate limit while polling stops the hop and is logged as rate_limited', async () => {
    const s = scene();
    s.gh.commit(UP, 'main', { 'a.txt': '2\n' });
    s.gh.failNext('getMergeability', new RateLimitExceededError('primary', 3_000_000));
    await expect(s.run()).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(s.store.runs.at(-1)).toMatchObject({ outcome: 'rate_limited' });
    // the branch and PR already exist, so the next run resumes cleanly instead of duplicating
    expect((await s.run()).outcome).toBe('pr_unchanged');
    expect(s.gh.prs(MID)).toHaveLength(1);
  });

  it('never resets or force-pushes the branch just to report a conflict on an existing PR', async () => {
    const s = conflicting();
    await s.run();
    const tip = s.gh.tip(MID, BRANCH);
    s.gh.commit(MID, BRANCH, { 'a.txt': 'resolved by a human\n' }, 'human resolution');
    const human = s.gh.tip(MID, BRANCH);
    await s.run();
    expect(s.gh.tip(MID, BRANCH)).toBe(human);
    expect(s.gh.contains(MID, BRANCH, tip)).toBe(true);
  });
});

describe('reconcileConflict (unit)', () => {
  const repo = { owner: 'me', repo: 'widget' };
  const ctx = (labels: string[]) => ({
    repo,
    pr: { number: 1, labels },
    policy: { label: 'c', comment: true, assignees: ['u'], requestReview: true },
    syncBranch: 'chain/x',
    targetBranch: 'main',
    sourceName: '`a/b@main`',
    logger: nullLogger,
  });

  it('does nothing in the two steady states', async () => {
    const gh = new FakeGitHub().createRepo(MID);
    expect(await reconcileConflict(gh, ctx([]), false)).toBe('unchanged');
    expect(await reconcileConflict(gh, ctx(['c']), true)).toBe('unchanged');
    expect(gh.writes()).toEqual([]);
  });
});
