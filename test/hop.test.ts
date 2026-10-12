import { describe, expect, it } from 'vitest';
import type { MergeMethod } from '../src/config/schema';
import { ProtectedBranchWriteError } from '../src/github/errors';
import { guardBotBranches } from '../src/github/guard';
import { RateLimitExceededError } from '../src/github/resilient';
import { nullLogger } from '../src/log';
import { parseMarker, renderMarker } from '../src/sync/marker';
import { syncHop } from '../src/sync/hop';
import type { HopOptions, HopSpec } from '../src/sync/hop';
import { MemoryStore } from '../src/store/memory';
import { FakeGitHub } from './helpers/fake-github';

const UP = 'acme/widget';
const MID = 'me/widget';
const BRANCH = 'chain/sync-upstream';
const now = () => new Date('2026-10-12T12:00:00Z');

function scene(mergeMethod: MergeMethod = 'merge') {
  const gh = new FakeGitHub().createRepo(UP, { 'a.txt': '1\n', 'b.txt': '1\n', 'c.txt': '1\n' });
  gh.fork(UP, MID);
  const store = new MemoryStore();
  const spec: HopSpec = {
    id: 'upstream_to_midstream',
    chain: MID,
    source: { repo: { owner: 'acme', repo: 'widget' }, branch: 'main' },
    target: { repo: { owner: 'me', repo: 'widget' }, branch: 'main' },
    syncBranch: BRANCH,
    mergeMethod,
    protectedPaths: [],
    pr: { labels: ['chain-sync'], assignees: ['octocat'], reviewers: ['octocat'], teamReviewers: [], draft: false },
  };
  const run = (opts: Partial<HopOptions> = {}, over: Partial<HopSpec> = {}) =>
    syncHop({ ...spec, ...over }, { sourcePort: gh, targetPort: gh, store, logger: nullLogger, now }, { trigger: 'cron', ...opts });
  return { gh, store, spec, run };
}

const openPrs = (gh: FakeGitHub) => gh.prs(MID).filter((p) => p.state === 'open');

describe('hop sync: opening the PR', () => {
  it('does nothing when midstream already has everything', async () => {
    const { gh, run } = scene();
    const r = await run();
    expect(r.outcome).toBe('up_to_date');
    expect(gh.writes()).toEqual([]);
    expect(gh.prs(MID)).toHaveLength(0);
  });

  it('opens ONE PR when midstream is behind, via a chain/* branch, leaving main untouched', async () => {
    const { gh, run } = scene();
    const midMain = gh.tip(MID, 'main');
    const upTip = gh.commit(UP, 'main', { 'a.txt': '2\n' }, 'feat: change a');

    const r = await run();
    expect(r.outcome).toBe('pr_opened');
    expect(r.sourceSha).toBe(upTip);

    // fast-forward case: the sync branch IS the upstream commit, no merge commit needed
    expect(gh.tip(MID, BRANCH)).toBe(upTip);
    // NEVER pushes to the tracked branch
    expect(gh.tip(MID, 'main')).toBe(midMain);
    for (const w of gh.writes().filter((w) => ['createBranch', 'setBranchSha', 'mergeIntoBranch'].includes(w.op))) {
      expect((w.detail as { branch: string }).branch).toMatch(/^chain\//);
    }

    const [pr] = openPrs(gh);
    expect(openPrs(gh)).toHaveLength(1);
    expect(pr).toMatchObject({ headRef: BRANCH, baseRef: 'main', draft: false });
    expect(pr!.title).toBe('Sync acme/widget@main into main');
    expect(pr!.body).toContain('feat: change a');
    expect(parseMarker(pr!.body)).toEqual({ hop: 'upstream_to_midstream', source: upTip });
    expect([...pr!.labels]).toEqual(['chain-sync']);
    expect([...pr!.assignees]).toEqual(['octocat']);
    expect([...pr!.reviewers]).toEqual(['octocat']);
  });

  it('records each run in the log', async () => {
    const { gh, store, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    await run({ trigger: 'cron' });
    await run({ trigger: 'webhook:push', deliveryId: 'dlv-1' });
    expect(store.runs.map((r) => [r.trigger, r.outcome, r.hop])).toEqual([
      ['cron', 'pr_opened', 'upstream_to_midstream'],
      ['webhook:push', 'pr_unchanged', 'upstream_to_midstream'],
    ]);
    expect(store.runs[1]).toMatchObject({ deliveryId: 'dlv-1', prNumber: 1 });
  });
});

describe('hop sync: idempotency', () => {
  it('a second run with nothing new performs ZERO writes and leaves one PR', async () => {
    const { gh, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    await run();

    gh.resetCalls();
    const again = await run();
    expect(again.outcome).toBe('pr_unchanged');
    expect(gh.writes()).toEqual([]);
    expect(openPrs(gh)).toHaveLength(1);
  });

  it('is stable over many repeated runs', async () => {
    const { gh, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    gh.commit(MID, 'main', { 'c.txt': 'midstream patch\n' }, 'midstream: local patch'); // diverged
    await run();
    gh.resetCalls();
    for (let i = 0; i < 5; i++) expect((await run()).outcome).toBe('pr_unchanged');
    expect(gh.writes()).toEqual([]);
    expect(gh.prs(MID)).toHaveLength(1);
  });

  it('advances the SAME PR when upstream moves again', async () => {
    const { gh, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    const first = await run();
    const newTip = gh.commit(UP, 'main', { 'b.txt': '2\n' }, 'feat: change b');

    const second = await run();
    expect(second.outcome).toBe('pr_updated');
    expect(second.prNumber).toBe(first.prNumber);
    expect(gh.prs(MID)).toHaveLength(1);
    expect(gh.contains(MID, BRANCH, newTip)).toBe(true);
    const pr = openPrs(gh)[0]!;
    expect(parseMarker(pr.body)?.source).toBe(newTip);
    expect(pr.body).toContain('feat: change b');
  });

  it('reports up_to_date once the PR is merged, and opens nothing new', async () => {
    const { gh, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    const r = await run();
    gh.mergePr(MID, r.prNumber!, 'merge');

    gh.resetCalls();
    const after = await run();
    expect(after.outcome).toBe('up_to_date');
    expect(gh.writes()).toEqual([]);
    expect(gh.prs(MID)).toHaveLength(1);
  });

  it('opens a fresh PR for the next upstream change, resetting the leftover branch safely', async () => {
    const { gh, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    const first = await run();
    gh.mergePr(MID, first.prNumber!, 'merge');

    const newTip = gh.commit(UP, 'main', { 'b.txt': '2\n' });
    const second = await run();
    expect(second.outcome).toBe('pr_opened');
    expect(second.prNumber).not.toBe(first.prNumber);
    expect(gh.contains(MID, BRANCH, newTip)).toBe(true);
    expect(openPrs(gh)).toHaveLength(1);
  });
});

describe('hop sync: midstream with its own commits', () => {
  it('merges upstream into the sync branch server-side, keeping both histories', async () => {
    const { gh, run } = scene();
    const patch = gh.commit(MID, 'main', { 'c.txt': 'midstream patch\n' }, 'midstream: patch');
    const upTip = gh.commit(UP, 'main', { 'a.txt': '2\n' }, 'upstream change');

    const r = await run();
    expect(r.outcome).toBe('pr_opened');
    expect(gh.contains(MID, BRANCH, upTip)).toBe(true);
    expect(gh.contains(MID, BRANCH, patch)).toBe(true);
    expect(gh.filesAt(MID, BRANCH)).toMatchObject({ 'a.txt': '2\n', 'c.txt': 'midstream patch\n' });
    expect(gh.tip(MID, 'main')).toBe(patch);
  });

  it('after merging, a later run is up to date (merge-commit ancestry converges)', async () => {
    const { gh, run } = scene();
    gh.commit(MID, 'main', { 'c.txt': 'patch\n' });
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    const r = await run();
    gh.mergePr(MID, r.prNumber!, 'merge');
    expect((await run()).outcome).toBe('up_to_date');
  });
});

describe('hop sync: conflicts (labels/comments are step 4; here the PR must still appear, stably)', () => {
  function conflicting() {
    const s = scene();
    s.gh.commit(MID, 'main', { 'a.txt': 'midstream version\n' }, 'midstream edit a');
    s.gh.commit(UP, 'main', { 'a.txt': 'upstream version\n' }, 'upstream edit a');
    return s;
  }

  it('still opens a PR (branch = upstream tip) so the conflict is visible, flagged in the result and body', async () => {
    const { gh, run } = conflicting();
    const r = await run();
    expect(r.outcome).toBe('conflict');
    expect(r.conflicted).toBe(true);
    expect(gh.tip(MID, BRANCH)).toBe(gh.tip(UP, 'main'));
    expect(openPrs(gh)).toHaveLength(1);
    expect(openPrs(gh)[0]!.body).toContain('Merge conflicts');
  });

  it('reports the same conflict every run without churning the PR', async () => {
    const { gh, run } = conflicting();
    await run();
    const bodyBefore = openPrs(gh)[0]!.body;
    const branchBefore = gh.tip(MID, BRANCH);
    for (let i = 0; i < 3; i++) {
      const r = await run();
      expect(r.outcome).toBe('conflict');
    }
    expect(openPrs(gh)).toHaveLength(1);
    expect(openPrs(gh)[0]!.body).toBe(bodyBefore);
    expect(gh.tip(MID, BRANCH)).toBe(branchBefore);
    expect(gh.writes().filter((w) => w.op === 'updatePullRequest')).toHaveLength(0);
  });

  it('heals when the conflict goes away', async () => {
    const { gh, run } = conflicting();
    await run();
    // midstream drops its edit; the PR can now merge cleanly
    gh.commit(MID, 'main', { 'a.txt': '1\n' }, 'revert midstream edit');
    const r = await run();
    expect(r.conflicted).toBe(false);
    expect(openPrs(gh)[0]!.body).not.toContain('Merge conflicts');
  });
});

describe('hop sync: squash and rebase merge methods', () => {
  it.each<MergeMethod>(['squash', 'rebase'])('%s: does not re-open a PR after landing, and handles the next change', async (method) => {
    const { gh, run } = scene(method);
    const up1 = gh.commit(UP, 'main', { 'a.txt': '2\n' }, 'feat: already landed');
    const first = await run();
    expect(first.outcome).toBe('pr_opened');
    gh.mergePr(MID, first.prNumber!, method);

    // Ancestry will NEVER converge (the squash commit is not the upstream commit)...
    expect(gh.contains(MID, 'main', up1)).toBe(false);
    // ...yet the engine knows it landed from the marker in the merged PR.
    gh.resetCalls();
    expect((await run()).outcome).toBe('up_to_date');
    expect(gh.writes()).toEqual([]);

    // The next upstream change opens a new PR that lists only the new commit.
    const up2 = gh.commit(UP, 'main', { 'b.txt': '2\n' }, 'feat: only this one');
    const second = await run();
    expect(second.outcome).toBe('pr_opened');
    const body = openPrs(gh)[0]!.body;
    expect(body).toContain('feat: only this one');
    expect(body).not.toContain('feat: already landed');
    expect(parseMarker(body)?.source).toBe(up2);
    expect(gh.filesAt(MID, BRANCH)).toMatchObject({ 'a.txt': '2\n', 'b.txt': '2\n' });
  });

  it('merge method with a squash-landed PR keeps re-opening: that is why the PR body says to merge-commit', async () => {
    const { gh, run } = scene('merge');
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    const first = await run();
    expect(openPrs(gh)[0]!.body).toContain('Merge this PR with a merge commit');
    gh.mergePr(MID, first.prNumber!, 'squash');
    // content landed, so the branch adds nothing and there is nothing to review
    const again = await run();
    expect(['up_to_date', 'pr_opened']).toContain(again.outcome);
  });
});

describe('hop sync: rejected and stale PRs', () => {
  it('does not re-open a PR the human closed for the same upstream commit', async () => {
    const { gh, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    const first = await run();
    gh.closePrUnmerged(MID, first.prNumber!);

    gh.resetCalls();
    const again = await run();
    expect(again.outcome).toBe('skipped_rejected');
    expect(gh.writes()).toEqual([]);
    expect(openPrs(gh)).toHaveLength(0);
  });

  it('opens a new PR as soon as upstream moves past the rejected commit, keeping the branch', async () => {
    const { gh, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    const first = await run();
    gh.closePrUnmerged(MID, first.prNumber!);

    const newTip = gh.commit(UP, 'main', { 'b.txt': '2\n' });
    const next = await run();
    expect(next.outcome).toBe('pr_opened');
    expect(next.prNumber).not.toBe(first.prNumber);
    expect(gh.contains(MID, BRANCH, newTip)).toBe(true);
  });

  it('never discards a human commit on a leftover branch (closed unmerged PR with extra work)', async () => {
    const { gh, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    const first = await run();
    gh.commit(MID, BRANCH, { 'human.txt': 'my conflict fix\n' }, 'human: fixup on the sync branch');
    const humanWork = gh.tip(MID, BRANCH);
    gh.closePrUnmerged(MID, first.prNumber!);

    const newTip = gh.commit(UP, 'main', { 'b.txt': '2\n' });
    const next = await run();
    expect(next.outcome).toBe('pr_opened');
    expect(gh.contains(MID, BRANCH, humanWork)).toBe(true); // still there
    expect(gh.contains(MID, BRANCH, newTip)).toBe(true);
    expect(gh.filesAt(MID, BRANCH)['human.txt']).toBe('my conflict fix\n');
  });

  it('closes an open sync PR that became unnecessary, with an explanation', async () => {
    const { gh, run } = scene();
    const tip = gh.commit(UP, 'main', { 'a.txt': '2\n' });
    const first = await run();
    // someone brought main up to date by hand
    await gh.setBranchSha({ owner: 'me', repo: 'widget' }, 'main', tip, false);

    const r = await run();
    expect(r.outcome).toBe('stale_pr_closed');
    expect(openPrs(gh)).toHaveLength(0);
    expect(gh.comments(MID, first.prNumber!).join('\n')).toMatch(/no longer needed/);
  });
});

describe('hop sync: races and failures', () => {
  it('two overlapping runs (cron + webhook) converge on one branch and one PR', async () => {
    const { gh, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    const [a, b] = await Promise.all([run({ trigger: 'cron' }), run({ trigger: 'webhook:push' })]);
    expect([a.outcome, b.outcome].every((o) => ['pr_opened', 'pr_unchanged'].includes(o))).toBe(true);
    expect(gh.prs(MID)).toHaveLength(1);
    expect(a.prNumber).toBe(b.prNumber);
  });

  it('survives losing the branch-creation race', async () => {
    const { gh, run } = scene();
    const tip = gh.commit(UP, 'main', { 'a.txt': '2\n' });
    // Another run creates the branch between our existence check and our create.
    const original = gh.createBranch.bind(gh);
    let raced = false;
    gh.createBranch = async (repo, branch, sha) => {
      if (!raced) {
        raced = true;
        await original(repo, branch, sha);
      }
      return original(repo, branch, sha);
    };
    const r = await run();
    expect(r.outcome).toBe('pr_opened');
    expect(gh.tip(MID, BRANCH)).toBe(tip);
  });

  it('a failure mid-way is reported, then the next run finishes the job without duplicates', async () => {
    const { gh, store, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    gh.failNext('createPullRequest', new Error('GitHub is having a moment'));

    const failed = await run();
    expect(failed.outcome).toBe('error');
    expect(failed.message).toMatch(/moment/);
    expect(gh.hasBranch(MID, BRANCH)).toBe(true);
    expect(gh.prs(MID)).toHaveLength(0);
    expect(store.runs.at(-1)).toMatchObject({ outcome: 'error' });

    const ok = await run();
    expect(ok.outcome).toBe('pr_opened');
    expect(gh.prs(MID)).toHaveLength(1);
  });

  it('failing to set labels / reviewers does not fail the sync', async () => {
    const { gh, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    gh.failNext('addLabels', new Error('label forbidden'));
    gh.failNext('requestReviewers', new Error('reviewer is the author'));
    const r = await run();
    expect(r.outcome).toBe('pr_opened');
    expect([...openPrs(gh)[0]!.assignees]).toEqual(['octocat']);
  });

  it('stops and re-throws on a rate limit so the caller can wait, logging it as rate_limited', async () => {
    const { gh, store, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    gh.failNext('compare', new RateLimitExceededError('primary', 3_000_000));
    await expect(run()).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(store.runs.at(-1)).toMatchObject({ outcome: 'rate_limited' });
    expect(gh.writes()).toEqual([]);
  });

  it('explains the fork requirement when the target cannot see the source commit', async () => {
    const gh = new FakeGitHub().createRepo(UP).createRepo(MID); // unrelated networks
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    const store = new MemoryStore();
    const spec = scene().spec;
    const r = await syncHop(spec, { sourcePort: gh, targetPort: gh, store, logger: nullLogger, now }, { trigger: 'cron' });
    expect(r.outcome).toBe('error');
    expect(r.message).toMatch(/fork/);
    expect(r.message).toMatch(/git-data/);
    expect(gh.writes()).toEqual([]);
  });

  it('errors clearly when the source branch does not exist', async () => {
    const { run, gh } = scene();
    const r = await run({}, { source: { repo: { owner: 'acme', repo: 'widget' }, branch: 'nope' } });
    expect(r.outcome).toBe('error');
    expect(r.message).toMatch(/does not exist/);
    expect(gh.writes()).toEqual([]);
  });
});

describe('hop sync: dry run', () => {
  it('reports the plan and writes nothing', async () => {
    const { gh, store, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    const r = await run({ dryRun: true });
    expect(r.outcome).toBe('dry_run');
    expect(r.plan).toMatchObject({ action: 'open_pr', pending: true, aheadBy: 1 });
    expect(gh.writes()).toEqual([]);
    expect(store.runs).toHaveLength(0);
  });

  it('plans update_pr when a PR is open', async () => {
    const { gh, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    await run();
    gh.commit(UP, 'main', { 'b.txt': '2\n' });
    expect((await run({ dryRun: true })).plan?.action).toBe('update_pr');
  });
});

describe('never writes outside chain/*', () => {
  it('engine refuses a spec whose sync branch is a tracked branch', async () => {
    const { gh, run } = scene();
    gh.commit(UP, 'main', { 'a.txt': '2\n' });
    for (const bad of ['main', 'release', 'chain/']) {
      const r = await run({}, { syncBranch: bad });
      expect(r.outcome).toBe('error');
    }
    expect(gh.writes()).toEqual([]);
  });

  it('the guard blocks every ref-moving call on non-bot branches, even if the engine had a bug', async () => {
    const gh = new FakeGitHub().createRepo(MID);
    const repo = { owner: 'me', repo: 'widget' };
    const guarded = guardBotBranches(gh);
    const sha = gh.tip(MID, 'main');
    await expect(guarded.createBranch(repo, 'main', sha)).rejects.toBeInstanceOf(ProtectedBranchWriteError);
    await expect(guarded.setBranchSha(repo, 'main', sha, true)).rejects.toBeInstanceOf(ProtectedBranchWriteError);
    await expect(guarded.mergeIntoBranch(repo, 'main', sha, 'm')).rejects.toBeInstanceOf(ProtectedBranchWriteError);
    await expect(
      guarded.createPullRequest(repo, { title: 't', body: '', head: 'main', base: 'release', draft: false }),
    ).rejects.toBeInstanceOf(ProtectedBranchWriteError);
    expect(gh.writes()).toEqual([]);

    // chain/* and reads pass through
    await expect(guarded.createBranch(repo, 'chain/ok', sha)).resolves.toBe('created');
    await expect(guarded.getBranchSha(repo, 'main')).resolves.toBe(sha);
  });
});

describe('PR marker', () => {
  it('round-trips', () => {
    const m = { hop: 'midstream_to_downstream' as const, source: 'a'.repeat(40) };
    expect(parseMarker(`intro\n${renderMarker(m)}\nrest`)).toEqual(m);
  });
  it('ignores malformed or missing markers', () => {
    expect(parseMarker('')).toBeNull();
    expect(parseMarker(null)).toBeNull();
    expect(parseMarker('<!-- chain-sync:v1 hop=bogus source=' + 'a'.repeat(40) + ' -->')).toBeNull();
    expect(parseMarker('<!-- chain-sync:v1 hop=upstream_to_midstream source=short -->')).toBeNull();
  });
});
