import { describe, expect, it } from 'vitest';
import { nullLogger } from '../src/log';
import { parseMarker } from '../src/sync/marker';
import { createRestoreCommit, matcher, planProtection } from '../src/sync/protect';
import { BRANCH, MID, openPrs, scene, UP } from './helpers/hop-scene';
import type { HopSpec } from '../src/sync/hop';

const FILES = {
  'a.txt': 'a1\n',
  'b.txt': 'b1\n',
  'LICENSE': 'original licence\n',
  'patches/x.patch': 'orig patch\n',
  '.github/workflows/ci.yml': 'upstream ci v1\n',
};
const PROTECT = ['patches/**', 'LICENSE', '.github/workflows/**'];

function protectedScene(patterns: string[] = PROTECT, method: 'merge' | 'squash' | 'rebase' = 'merge') {
  const s = scene(method, FILES);
  const run = (opts: Parameters<typeof s.run>[0] = {}, over: Partial<HopSpec> = {}) =>
    s.run(opts, { protectedPaths: patterns, ...over });
  return { ...s, run };
}
const writes = (gh: ReturnType<typeof scene>['gh']) => gh.writes().map((w) => w.op);

describe('protected paths: the point of them (both sides edited the same file)', () => {
  it('keeps midstream\'s version, applies the rest of upstream, and raises NO conflict', async () => {
    const s = protectedScene();
    s.gh.commit(MID, 'main', { 'patches/x.patch': 'MIDSTREAM patch\n' }, 'midstream: tune patch');
    const upTip = s.gh.commit(UP, 'main', { 'patches/x.patch': 'upstream rewrote it\n', 'a.txt': 'a2\n' }, 'upstream: big change');

    const r = await s.run();
    expect(r).toMatchObject({ outcome: 'pr_opened', conflicted: false, mergeable: true, protectedKept: ['patches/x.patch'] });
    expect(s.gh.filesAt(MID, BRANCH)).toMatchObject({ 'patches/x.patch': 'MIDSTREAM patch\n', 'a.txt': 'a2\n' });
    expect(s.gh.contains(MID, BRANCH, upTip)).toBe(true); // upstream history is still ancestry
    expect([...openPrs(s.gh)[0]!.labels]).not.toContain('sluice/conflict');
    expect(openPrs(s.gh)[0]!.body).toContain('### Protected paths');
    expect(openPrs(s.gh)[0]!.body).toContain('`patches/x.patch`');
    // One path reads "1 path ... keeps its", several read "N paths ... keep their".
    expect(openPrs(s.gh)[0]!.body).toMatch(/1 path listed under `protected_paths` keeps its `main` content/);
  });

  it('CONTROL: without protection the very same edits conflict', async () => {
    const s = protectedScene([]);
    s.gh.commit(MID, 'main', { 'patches/x.patch': 'MIDSTREAM patch\n' });
    s.gh.commit(UP, 'main', { 'patches/x.patch': 'upstream rewrote it\n', 'a.txt': 'a2\n' });
    expect((await s.run()).outcome).toBe('conflict');
  });

  it('merging the PR lands exactly that result in midstream', async () => {
    const s = protectedScene();
    s.gh.commit(MID, 'main', { 'patches/x.patch': 'MIDSTREAM patch\n' });
    s.gh.commit(UP, 'main', { 'patches/x.patch': 'upstream rewrote it\n', 'a.txt': 'a2\n' });
    const r = await s.run();
    s.gh.mergePr(MID, r.prNumber!, 'merge');
    expect(s.gh.filesAt(MID, 'main')).toMatchObject({ 'patches/x.patch': 'MIDSTREAM patch\n', 'a.txt': 'a2\n' });
    expect((await s.run()).outcome).toBe('up_to_date');
  });

  it('keeps protecting on every later sync: upstream edits it AGAIN, still no conflict', async () => {
    const s = protectedScene();
    s.gh.commit(MID, 'main', { 'patches/x.patch': 'MIDSTREAM patch\n' });
    s.gh.commit(UP, 'main', { 'patches/x.patch': 'upstream v2\n' });
    s.gh.mergePr(MID, (await s.run()).prNumber!, 'merge');

    s.gh.commit(UP, 'main', { 'patches/x.patch': 'upstream v3\n', 'b.txt': 'b2\n' });
    const second = await s.run();
    expect(second).toMatchObject({ outcome: 'pr_opened', conflicted: false });
    s.gh.mergePr(MID, second.prNumber!, 'merge');
    expect(s.gh.filesAt(MID, 'main')).toMatchObject({ 'patches/x.patch': 'MIDSTREAM patch\n', 'b.txt': 'b2\n' });
    expect((await s.run()).outcome).toBe('up_to_date');
  });
});

describe('protected paths: every shape of upstream change', () => {
  it('fast-forward case (midstream has no commits of its own): protected file keeps its old content', async () => {
    const s = protectedScene();
    const upTip = s.gh.commit(UP, 'main', { LICENSE: 'NEW licence\n', 'a.txt': 'a2\n' });
    const r = await s.run();
    expect(r.outcome).toBe('pr_opened');
    expect(s.gh.filesAt(MID, BRANCH)).toMatchObject({ LICENSE: 'original licence\n', 'a.txt': 'a2\n' });
    expect(s.gh.contains(MID, BRANCH, upTip)).toBe(true);
    expect(s.gh.tip(MID, BRANCH)).not.toBe(upTip); // the restore commit sits on top of the source tip
  });

  it('a protected file upstream ADDS is left out', async () => {
    const s = protectedScene();
    s.gh.commit(UP, 'main', { 'patches/new.patch': 'from upstream\n', 'a.txt': 'a2\n' });
    await s.run();
    expect(s.gh.filesAt(MID, BRANCH)).not.toHaveProperty('patches/new.patch');
    expect(s.gh.filesAt(MID, BRANCH)['a.txt']).toBe('a2\n');
  });

  it('a protected file upstream DELETES is kept', async () => {
    const s = protectedScene();
    s.gh.commit(UP, 'main', { 'patches/x.patch': null, 'a.txt': 'a2\n' });
    const r = await s.run();
    expect(r.outcome).toBe('pr_opened');
    expect(s.gh.filesAt(MID, BRANCH)['patches/x.patch']).toBe('orig patch\n');
  });

  it('matches dot-directories such as .github/workflows', async () => {
    const s = protectedScene();
    s.gh.commit(MID, 'main', { '.github/workflows/ci.yml': 'MIDSTREAM ci\n' });
    s.gh.commit(UP, 'main', { '.github/workflows/ci.yml': 'upstream ci v2\n', 'a.txt': 'a2\n' });
    const r = await s.run();
    expect(r.conflicted).toBe(false);
    expect(s.gh.filesAt(MID, BRANCH)['.github/workflows/ci.yml']).toBe('MIDSTREAM ci\n');
  });

  it('protects hidden files INSIDE a protected directory (needs dot-matching: config/** vs config/.env)', async () => {
    const s = scene('merge', { ...FILES, 'config/app.conf': 'c1\n', 'config/.env': 'SECRET_NAME=mine\n' });
    s.gh.commit(UP, 'main', { 'config/.env': 'SECRET_NAME=upstream\n', 'config/app.conf': 'c2\n', 'a.txt': 'a2\n' });
    const r = await s.run({}, { protectedPaths: ['config/**'] });
    expect(r.protectedKept).toEqual(['config/.env', 'config/app.conf']);
    expect(s.gh.filesAt(MID, BRANCH)['config/.env']).toBe('SECRET_NAME=mine\n');
    expect(s.gh.filesAt(MID, BRANCH)['a.txt']).toBe('a2\n');
  });

  it('upstream touching ONLY protected paths still opens a PR, with no content change, and converges on merge', async () => {
    const s = protectedScene();
    const before = s.gh.filesAt(MID, 'main');
    s.gh.commit(UP, 'main', { LICENSE: 'NEW licence\n' });
    const r = await s.run();
    expect(r.outcome).toBe('pr_opened');
    expect(s.gh.filesAt(MID, BRANCH)).toEqual(before);
    s.gh.mergePr(MID, r.prNumber!, 'merge');
    expect(s.gh.filesAt(MID, 'main')).toEqual(before);
    expect((await s.run()).outcome).toBe('up_to_date');
  });

  it('works with squash merging too (baseline marker + protection)', async () => {
    const s = protectedScene(PROTECT, 'squash');
    s.gh.commit(MID, 'main', { 'patches/x.patch': 'MIDSTREAM patch\n' });
    const up1 = s.gh.commit(UP, 'main', { 'patches/x.patch': 'upstream v2\n', 'a.txt': 'a2\n' }, 'feat: one');
    const first = await s.run();
    s.gh.mergePr(MID, first.prNumber!, 'squash');
    expect((await s.run()).outcome).toBe('up_to_date');

    s.gh.commit(UP, 'main', { 'b.txt': 'b2\n' }, 'feat: two');
    const second = await s.run();
    expect(second.outcome).toBe('pr_opened');
    expect(parseMarker(openPrs(s.gh)[0]!.body)?.source).toBe(s.gh.tip(UP, 'main'));
    expect(up1).not.toBe(s.gh.tip(UP, 'main'));
    expect(s.gh.filesAt(MID, BRANCH)).toMatchObject({ 'patches/x.patch': 'MIDSTREAM patch\n', 'b.txt': 'b2\n' });
  });
});

describe('protected paths: idempotency', () => {
  it('re-running changes nothing and creates NO objects', async () => {
    const s = protectedScene();
    s.gh.commit(MID, 'main', { 'patches/x.patch': 'MIDSTREAM patch\n' });
    s.gh.commit(UP, 'main', { 'patches/x.patch': 'upstream v2\n', 'a.txt': 'a2\n' });
    await s.run();
    const tip = s.gh.tip(MID, BRANCH);

    s.gh.resetCalls();
    for (let i = 0; i < 3; i++) expect((await s.run()).outcome).toBe('pr_unchanged');
    expect(s.gh.writes()).toEqual([]);
    expect(s.gh.tip(MID, BRANCH)).toBe(tip);
    expect(s.gh.prs(MID)).toHaveLength(1);
  });

  it('advances the same PR when upstream moves again, keeping protection', async () => {
    const s = protectedScene();
    s.gh.commit(MID, 'main', { 'patches/x.patch': 'MIDSTREAM patch\n' });
    s.gh.commit(UP, 'main', { 'patches/x.patch': 'upstream v2\n' });
    const first = await s.run();

    s.gh.commit(UP, 'main', { 'patches/x.patch': 'upstream v3\n', 'b.txt': 'b2\n' }, 'feat: more');
    const second = await s.run();
    expect(second.outcome).toBe('pr_updated');
    expect(second.prNumber).toBe(first.prNumber);
    expect(s.gh.filesAt(MID, BRANCH)).toMatchObject({ 'patches/x.patch': 'MIDSTREAM patch\n', 'b.txt': 'b2\n' });
    expect(openPrs(s.gh)).toHaveLength(1);
  });

  it('overlapping runs converge: the restore commit is deterministic', async () => {
    const s = protectedScene();
    s.gh.commit(MID, 'main', { 'patches/x.patch': 'MIDSTREAM patch\n' });
    s.gh.commit(UP, 'main', { 'patches/x.patch': 'upstream v2\n', 'a.txt': 'a2\n' });
    const [a, b] = await Promise.all([s.run(), s.run()]);
    expect(a.prNumber).toBe(b.prNumber);
    expect(s.gh.prs(MID)).toHaveLength(1);
    expect(s.gh.filesAt(MID, BRANCH)['patches/x.patch']).toBe('MIDSTREAM patch\n');
  });

  it('createRestoreCommit returns the same commit for the same inputs', async () => {
    const s = protectedScene();
    s.gh.commit(MID, 'main', { 'patches/x.patch': 'MIDSTREAM patch\n' });
    const up = s.gh.commit(UP, 'main', { 'patches/x.patch': 'upstream v2\n' });
    const repo = { owner: 'me', repo: 'widget' };
    const plan = (await planProtection(s.gh, repo, up, s.gh.tip(MID, 'main'), PROTECT))!;
    const one = await createRestoreCommit(s.gh, repo, plan, up, 'main');
    const two = await createRestoreCommit(s.gh, repo, plan, up, 'main');
    expect(one).toBe(two);
  });
});

describe('protected paths: when they do nothing', () => {
  it('no matching difference -> no objects created, the source commit is used as-is', async () => {
    const s = protectedScene(['docs/**']);
    const upTip = s.gh.commit(UP, 'main', { 'a.txt': 'a2\n' });
    const r = await s.run();
    expect(r.outcome).toBe('pr_opened');
    expect(r.protectedKept).toBeUndefined();
    expect(writes(s.gh)).not.toContain('createTree');
    expect(writes(s.gh)).not.toContain('createCommit');
    expect(s.gh.tip(MID, BRANCH)).toBe(upTip);
    expect(openPrs(s.gh)[0]!.body).not.toContain('Protected paths');
  });

  it('protected files identical on both sides -> nothing to restore', async () => {
    const s = protectedScene();
    s.gh.commit(UP, 'main', { 'a.txt': 'a2\n' }); // touches nothing protected
    const r = await s.run();
    expect(r.protectedKept).toBeUndefined();
    expect(writes(s.gh)).not.toContain('createCommit');
  });

  it('a dry run reports which paths would be kept and writes nothing', async () => {
    const s = protectedScene();
    s.gh.commit(MID, 'main', { 'patches/x.patch': 'MIDSTREAM patch\n' });
    s.gh.commit(UP, 'main', { 'patches/x.patch': 'upstream v2\n', LICENSE: 'NEW\n', 'a.txt': 'a2\n' });
    const r = await s.run({ dryRun: true });
    expect(r.outcome).toBe('dry_run');
    expect(r.plan?.protectedPaths).toEqual(['LICENSE', 'patches/x.patch']);
    expect(s.gh.writes()).toEqual([]);
  });
});

describe('protected paths: failure modes', () => {
  it('refuses (does not guess) when GitHub truncates the tree listing', async () => {
    const s = protectedScene();
    s.gh.commit(UP, 'main', { LICENSE: 'NEW\n' });
    s.gh.treesTruncated = true;
    const r = await s.run();
    expect(r.outcome).toBe('error');
    expect(r.message).toMatch(/protected_paths cannot be enforced/);
    expect(s.gh.writes()).toEqual([]);
  });
});

describe('matcher', () => {
  const m = matcher(['patches/**', '*.md', '.github/**', 'src/{a,b}.ts']);
  it('matches what people expect', () => {
    for (const p of ['patches/x.patch', 'patches/deep/y', 'README.md', '.github/workflows/ci.yml', 'src/a.ts']) {
      expect(m(p), p).toBe(true);
    }
  });
  it('globs reach into dot-files and dot-directories', () => {
    expect(matcher(['config/**'])('config/.env')).toBe(true);
    expect(matcher(['**/*.yml'])('.github/ci.yml')).toBe(true);
  });
  it('does not match what they do not', () => {
    for (const p of ['docs/README.md', 'src/c.ts', 'patchesx/y', 'a/patches/x']) expect(m(p), p).toBe(false);
  });
});
