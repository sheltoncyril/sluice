import { describe, expect, it } from 'vitest';
import { loadChainConfig } from '../src/config/load';
import { nullLogger } from '../src/log';
import { buildHopSpec } from '../src/sync/chain';
import { runAdminWorkflows } from '../src/sync/admin';
import { syncDownstreamOnPush } from '../src/sync/downstream';
import { pollUpstreams } from '../src/sync/poll';
import { parseWorkflowsMarker } from '../src/workflows/render';
import { syncWorkflows } from '../src/workflows/sync';
import { chainScene, chainYml } from './helpers/chain-scene';
import type { ChainScene } from './helpers/chain-scene';

const MID = 'me/widget';
const DOWN = 'other/deploy';
const midRef = { owner: 'me', repo: 'widget' };
const BRANCH = 'chain/workflows';
const DEST = '.github/workflows/ci.yml';

const WF = `workflows:
  templates_path: templates
  values:
    node_version: "22"
  files:
    - template: ci.yml
      destination: ${DEST}
      targets: [midstream, downstream]
`;
const TEMPLATE = `name: CI for {{ repo }}
on: [push]
env:
  ROLE: {{ role }}
  NODE: "{{ node_version }}"
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "sha is \${{ github.sha }}"
`;

function setup(extra = WF, template: string | null = TEMPLATE, over: Parameters<typeof chainScene>[0] = {}) {
  const s = chainScene({ configYaml: chainYml({ extra }), ...over });
  if (template !== null) s.gh.commit(MID, 'main', { 'templates/ci.yml': template }, 'add template');
  return s;
}

async function handleOf(s: ChainScene) {
  const loaded = await loadChainConfig(s.gh, midRef);
  if (loaded.status !== 'ok') throw new Error('config should load: ' + JSON.stringify(loaded));
  return { holder: midRef, config: loaded.config, midstreamPort: s.gh };
}
const run = async (s: ChainScene, opts: { dryRun?: boolean } = {}) =>
  syncWorkflows(s.deps, await handleOf(s), { trigger: 'test', dryRun: opts.dryRun ?? false }, nullLogger);
const wfPrs = (s: ChainScene, repo: string) => s.gh.prs(repo).filter((p) => p.headRef === BRANCH);
const byTarget = (r: Awaited<ReturnType<typeof run>>, t: 'midstream' | 'downstream') => r.targets.find((x) => x.target === t)!;

describe('workflow template PRs: opening', () => {
  it('renders per target, commits to chain/workflows, and opens a PR in EACH repo, never touching main', async () => {
    const s = setup();
    const midMain = s.gh.tip(MID, 'main');
    const downMain = s.gh.tip(DOWN, 'main');
    const r = await run(s);

    expect(r.targets.map((t) => [t.target, t.outcome])).toEqual([['midstream', 'pr_opened'], ['downstream', 'pr_opened']]);
    expect(s.gh.tip(MID, 'main')).toBe(midMain);
    expect(s.gh.tip(DOWN, 'main')).toBe(downMain);

    const mid = s.gh.filesAt(MID, BRANCH)[DEST]!;
    const down = s.gh.filesAt(DOWN, BRANCH)[DEST]!;
    expect(mid).toContain('name: CI for me/widget');
    expect(mid).toContain('ROLE: midstream');
    expect(down).toContain('name: CI for other/deploy');
    expect(down).toContain('ROLE: downstream');
    expect(mid).toContain('NODE: "22"');
    expect(mid).toContain('${{ github.sha }}'); // a GitHub expression survived untouched
    expect(mid).toMatch(/^# This file is managed by sluice and rendered from me\/widget:templates\/ci\.yml/);
  });

  it('opens a normal PR: title, labels, assignees, reviewers, digest marker, and lists the file', async () => {
    const s = setup();
    await run(s);
    const [pr] = wfPrs(s, MID);
    expect(pr).toMatchObject({ baseRef: 'main', state: 'open', draft: false });
    expect(pr!.title).toBe('Update managed workflows (sluice)');
    expect([...pr!.labels]).toContain('sluice');
    expect([...pr!.assignees]).toEqual(['octocat']);
    expect([...pr!.reviewers]).toEqual(['octocat']);
    expect(pr!.body).toContain(`\`${DEST}\``);
    expect(pr!.body).toContain('`templates/ci.yml`');
    expect(parseWorkflowsMarker(pr!.body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('honours per-file targets', async () => {
    const s = setup(WF.replace('targets: [midstream, downstream]', 'targets: [downstream]'));
    const r = await run(s);
    expect(r.targets.map((t) => t.target)).toEqual(['downstream']);
    expect(wfPrs(s, MID)).toHaveLength(0);
    expect(wfPrs(s, DOWN)).toHaveLength(1);
  });

  it('does nothing when no workflow files are configured', async () => {
    const s = setup('');
    expect((await run(s)).targets).toEqual([]);
    expect(s.gh.writes()).toEqual([]);
  });

  it('only ever writes to the chain/workflows branch (never a tracked branch)', async () => {
    const s = setup();
    await run(s);
    for (const w of s.gh.writes().filter((w) => ['createBranch', 'setBranchSha'].includes(w.op))) {
      expect((w.detail as { branch: string }).branch).toBe(BRANCH);
    }
  });
});

describe('workflow template PRs: idempotency', () => {
  it('a second run performs ZERO writes and keeps one PR per repo', async () => {
    const s = setup();
    await run(s);
    s.gh.resetCalls();
    const again = await run(s);
    expect(again.targets.map((t) => t.outcome)).toEqual(['pr_unchanged', 'pr_unchanged']);
    expect(s.gh.writes()).toEqual([]);
    expect(wfPrs(s, MID)).toHaveLength(1);
    expect(wfPrs(s, DOWN)).toHaveLength(1);
  });

  it('is stable over repeated runs', async () => {
    const s = setup();
    await run(s);
    s.gh.resetCalls();
    for (let i = 0; i < 4; i++) await run(s);
    expect(s.gh.writes()).toEqual([]);
  });

  it('a template change updates the SAME PR (new commit, new digest)', async () => {
    const s = setup();
    await run(s);
    const [before] = wfPrs(s, MID);
    const digestBefore = parseWorkflowsMarker(before!.body);
    s.gh.commit(MID, 'main', { 'templates/ci.yml': TEMPLATE.replace('ubuntu-latest', 'ubuntu-24.04') }, 'tweak template');

    const r = await run(s);
    expect(byTarget(r, 'midstream').outcome).toBe('pr_updated');
    expect(wfPrs(s, MID)).toHaveLength(1);
    expect(s.gh.filesAt(MID, BRANCH)[DEST]).toContain('ubuntu-24.04');
    expect(parseWorkflowsMarker(wfPrs(s, MID)[0]!.body)).not.toBe(digestBefore);
  });

  it('a change to workflows.values in chain.yml updates the PRs', async () => {
    const s = setup();
    await run(s);
    s.gh.commit(MID, 'main', { '.github/chain.yml': chainYml({ extra: WF.replace('"22"', '"24"') }) }, 'bump node');
    await run(s);
    expect(s.gh.filesAt(DOWN, BRANCH)[DEST]).toContain('NODE: "24"');
    expect(wfPrs(s, DOWN)).toHaveLength(1);
  });

  it('does nothing at all when the target files already match', async () => {
    const s = setup();
    await run(s);
    for (const repo of [MID, DOWN]) s.gh.mergePr(repo, wfPrs(s, repo)[0]!.number, 'merge');
    s.gh.resetCalls();
    const r = await run(s);
    expect(r.targets.map((t) => t.outcome)).toEqual(['up_to_date', 'up_to_date']);
    expect(s.gh.writes()).toEqual([]);
  });

  it('two overlapping runs converge on one PR per repo', async () => {
    const s = setup();
    await Promise.all([run(s), run(s)]);
    expect(wfPrs(s, MID)).toHaveLength(1);
    expect(wfPrs(s, DOWN)).toHaveLength(1);
  });
});

describe('workflow template PRs: drift, rejection and conflicts', () => {
  it('after landing, a hand edit to a managed file produces a NEW PR that restores it', async () => {
    const s = setup();
    await run(s);
    s.gh.mergePr(MID, wfPrs(s, MID)[0]!.number, 'merge');
    s.gh.mergePr(DOWN, wfPrs(s, DOWN)[0]!.number, 'merge');

    s.gh.commit(DOWN, 'main', { [DEST]: '# someone hand-edited this\nname: hacked\njobs: {}\n' }, 'hand edit');
    const r = await run(s);
    expect(byTarget(r, 'downstream')).toMatchObject({ outcome: 'pr_opened', drift: [DEST] });
    expect(byTarget(r, 'midstream').outcome).toBe('up_to_date');
    expect(s.gh.filesAt(DOWN, BRANCH)[DEST]).toContain('name: CI for other/deploy');
    expect(wfPrs(s, DOWN)).toHaveLength(2); // the merged one and the new one
  });

  it('a PR you closed is not reopened for the same content, but is when the template changes', async () => {
    const s = setup();
    await run(s);
    s.gh.closePrUnmerged(MID, wfPrs(s, MID)[0]!.number);

    s.gh.resetCalls();
    const again = await run(s);
    expect(byTarget(again, 'midstream').outcome).toBe('skipped_rejected');
    expect(s.gh.writes().filter((w) => w.repo === MID.toLowerCase())).toEqual([]);

    s.gh.commit(MID, 'main', { 'templates/ci.yml': TEMPLATE + '# new\n' }, 'change template');
    expect(byTarget(await run(s), 'midstream').outcome).toBe('pr_opened');
  });

  it('closes an open PR that became unnecessary (target already matches)', async () => {
    const s = setup();
    await run(s);
    // someone applied the change by hand: main now has exactly the rendered file
    const rendered = s.gh.filesAt(MID, BRANCH)[DEST]!;
    s.gh.commit(MID, 'main', { [DEST]: rendered }, 'applied by hand');
    const r = await run(s);
    expect(byTarget(r, 'midstream').outcome).toBe('stale_pr_closed');
    expect(wfPrs(s, MID).filter((p) => p.state === 'open')).toHaveLength(0);
  });

  it('flags a conflict (target edited the same file differently) with label, comment and assignee', async () => {
    const s = setup();
    await run(s);
    s.gh.commit(MID, 'main', { [DEST]: 'name: edited on main\njobs: {}\n' }, 'edit on main');
    const r = await run(s);
    expect(byTarget(r, 'midstream')).toMatchObject({ outcome: 'conflict', conflicted: true });
    const pr = wfPrs(s, MID).find((p) => p.state === 'open')!;
    expect([...pr.labels]).toContain('sluice/conflict');
    expect(s.gh.comments(MID, pr.number).length).toBe(1);
    expect(pr.body).toContain('Merge conflicts');
  });

  it('never discards a human commit on the workflow branch', async () => {
    const s = setup();
    await run(s);
    s.gh.commit(MID, BRANCH, { 'README-extra.md': 'my note\n' }, 'human commit');
    const human = s.gh.tip(MID, BRANCH);
    s.gh.commit(MID, 'main', { 'templates/ci.yml': TEMPLATE + '# v2\n' });
    await run(s);
    expect(s.gh.contains(MID, BRANCH, human)).toBe(true);
    expect(s.gh.filesAt(MID, BRANCH)['README-extra.md']).toBe('my note\n');
  });
});

describe('workflow template PRs: leftover branches', () => {
  it('keeps human work on a leftover branch (PR closed unmerged) when it opens the next PR', async () => {
    const s = setup();
    await run(s);
    s.gh.commit(MID, BRANCH, { 'notes-from-a-human.md': 'do not lose me\n' }, 'human work on the bot branch');
    const human = s.gh.tip(MID, BRANCH);
    s.gh.closePrUnmerged(MID, wfPrs(s, MID)[0]!.number);

    s.gh.commit(MID, 'main', { 'templates/ci.yml': TEMPLATE + '# v2\n' }, 'new template');
    const r = await run(s);
    expect(byTarget(r, 'midstream').outcome).toBe('pr_opened');
    expect(s.gh.contains(MID, BRANCH, human)).toBe(true);
    expect(s.gh.filesAt(MID, BRANCH)['notes-from-a-human.md']).toBe('do not lose me\n');
  });

  it('resets a leftover branch that only holds what already landed, so the next PR starts clean', async () => {
    const s = setup();
    await run(s);
    s.gh.mergePr(MID, wfPrs(s, MID)[0]!.number, 'merge');
    s.gh.commit(MID, 'main', { 'templates/ci.yml': TEMPLATE + '# v2\n' }, 'new template');
    const r = await run(s);
    expect(byTarget(r, 'midstream').outcome).toBe('pr_opened');
    expect(wfPrs(s, MID).filter((p) => p.state === 'open')).toHaveLength(1);
    expect(s.gh.filesAt(MID, BRANCH)[DEST]).toContain('# v2');
  });
});

describe('workflow template PRs: errors are reported, nothing is half-applied', () => {
  it('a missing template', async () => {
    const s = setup(WF, null);
    const r = await run(s);
    expect(byTarget(r, 'midstream')).toMatchObject({ outcome: 'error' });
    expect(byTarget(r, 'midstream').message).toMatch(/templates\/ci\.yml was not found/);
    expect(s.gh.writes()).toEqual([]);
  });

  it('an undefined variable lists every missing name', async () => {
    const s = setup(WF, TEMPLATE + 'x: {{ missing_one }} {{ missing_two }}\n');
    const r = await run(s);
    expect(byTarget(r, 'midstream').message).toMatch(/missing_one.*missing_two|missing_two.*missing_one/);
    expect(s.gh.writes()).toEqual([]);
  });

  it('a template that renders to invalid YAML is rejected before anything is pushed', async () => {
    const s = setup(WF, 'name: [unclosed\njobs: {}\n');
    const r = await run(s);
    expect(byTarget(r, 'midstream').message).toMatch(/invalid YAML/);
    expect(s.gh.writes()).toEqual([]);
  });

  it('explains the Workflows permission when GitHub refuses the write', async () => {
    const s = setup();
    s.gh.failNext(
      'setBranchSha',
      Object.assign(new Error('refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission'), { status: 403 }),
    );
    const r = await run(s);
    expect(byTarget(r, 'midstream').outcome).toBe('error');
    expect(byTarget(r, 'midstream').message).toMatch(/Workflows: Read & write/);
  });

  it('refuses a downstream owner outside ALLOWED_OWNERS but still serves midstream', async () => {
    const s = setup(WF, TEMPLATE, { allowed: ['me'] });
    const r = await run(s);
    expect(byTarget(r, 'downstream')).toMatchObject({ outcome: 'error' });
    expect(byTarget(r, 'downstream').message).toMatch(/ALLOWED_OWNERS/);
    expect(byTarget(r, 'midstream').outcome).toBe('pr_opened');
    expect(wfPrs(s, DOWN)).toHaveLength(0);
  });

  it('a failure is retried cleanly on the next run without duplicates', async () => {
    const s = setup();
    s.gh.failNext('createPullRequest', new Error('boom'));
    const first = await run(s);
    expect(byTarget(first, 'midstream').outcome).toBe('error');
    const second = await run(s);
    expect(byTarget(second, 'midstream').outcome).toBe('pr_opened');
    expect(wfPrs(s, MID)).toHaveLength(1);
  });

  it('a dry run reports the drift and writes nothing', async () => {
    const s = setup();
    const r = await run(s, { dryRun: true });
    expect(r.targets.map((t) => [t.outcome, t.drift])).toEqual([['dry_run', [DEST]], ['dry_run', [DEST]]]);
    expect(s.gh.writes()).toEqual([]);
    expect(s.store.runs).toHaveLength(0);
  });

  it('records a run per target with the files, not the contents', async () => {
    const s = setup();
    await run(s);
    const runs = s.store.runs.filter((r) => r.hop === 'workflows');
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ outcome: 'pr_opened', detail: { target: 'midstream', files: [DEST] } });
    expect(JSON.stringify(runs)).not.toContain('ubuntu-latest');
  });
});

describe('managed workflow files are protected on the sync hops', () => {
  it('buildHopSpec adds each hop\'s managed destinations to its protected paths', async () => {
    const s = setup();
    const handle = await handleOf(s);
    expect(buildHopSpec(handle, 'upstream_to_midstream').protectedPaths).toContain(DEST);
    expect(buildHopSpec(handle, 'midstream_to_downstream').protectedPaths).toContain(DEST);
    const downOnly = setup(WF.replace('targets: [midstream, downstream]', 'targets: [downstream]'));
    const h2 = await handleOf(downOnly);
    expect(buildHopSpec(h2, 'upstream_to_midstream').protectedPaths).not.toContain(DEST);
    expect(buildHopSpec(h2, 'midstream_to_downstream').protectedPaths).toContain(DEST);
  });

  it('cron: upstream editing the same workflow file does NOT conflict with midstream\'s managed copy', async () => {
    const s = setup();
    await run(s);
    s.gh.mergePr(MID, wfPrs(s, MID)[0]!.number, 'merge'); // midstream now has its managed ci.yml
    s.gh.commit('acme/widget', 'main', { [DEST]: 'name: upstream ci\njobs: {}\n', 'a.txt': 'new\n' }, 'upstream adds its own ci.yml');

    const [hop] = await pollUpstreams({ ...s.deps, discovery: s.discovery }, nullLogger, { force: true });
    expect(hop).toMatchObject({ outcome: 'pr_opened', conflicted: false, protectedKept: [DEST] });
    expect(s.gh.filesAt(MID, 'chain/sync-upstream')[DEST]).toContain('managed by sluice');
    expect(s.gh.filesAt(MID, 'chain/sync-upstream')['a.txt']).toBe('new\n');
  });

  it('push: midstream\'s rendered copy does not flow downstream over downstream\'s own', async () => {
    const s = setup();
    await run(s);
    for (const repo of [MID, DOWN]) s.gh.mergePr(repo, wfPrs(s, repo)[0]!.number, 'merge');
    const downsOwn = s.gh.filesAt(DOWN, 'main')[DEST]!;

    s.gh.commit(MID, 'main', { 'a.txt': 'midstream change\n' });
    const r = await syncDownstreamOnPush(
      s.deps,
      { deliveryId: 'd', installationId: 1, repo: midRef, ref: 'refs/heads/main', deleted: false, defaultBranch: 'main', changedPaths: ['a.txt'] },
      nullLogger,
    );
    expect(r).toMatchObject({ outcome: 'pr_opened', conflicted: false });
    expect(s.gh.filesAt(DOWN, 'chain/sync-midstream')[DEST]).toBe(downsOwn);
    expect(s.gh.filesAt(DOWN, 'chain/sync-midstream')[DEST]).toContain('CI for other/deploy');
  });
});

describe('workflow PRs are triggered by merged config/template changes', () => {
  const push = (s: ChainScene, changedPaths: string[] | null, over: Record<string, unknown> = {}) =>
    syncDownstreamOnPush(
      s.deps,
      { deliveryId: 'd', installationId: 1, repo: midRef, ref: 'refs/heads/main', deleted: false, defaultBranch: 'main', changedPaths, ...over },
      nullLogger,
    );

  it.each([
    ['a template', ['templates/ci.yml']],
    ['chain.yml', ['.github/chain.yml']],
    ['unknown paths (GitHub truncated the push)', null],
  ])('a default-branch push touching %s opens the workflow PRs', async (_n, paths) => {
    const s = setup();
    await push(s, paths);
    expect(wfPrs(s, MID)).toHaveLength(1);
    expect(wfPrs(s, DOWN)).toHaveLength(1);
  });

  it('an unrelated push, or a push to another branch, does not', async () => {
    const s = setup();
    await push(s, ['src/app.ts']);
    await push(s, ['templates/ci.yml'], { ref: 'refs/heads/feature' });
    expect(wfPrs(s, MID)).toHaveLength(0);
    expect(s.gh.calls.filter((c) => c.op === 'createPullRequest' && JSON.stringify(c.detail).includes(BRANCH))).toHaveLength(0);
  });

  it('merging the workflow PR (a push of the managed file) does not retrigger it', async () => {
    const s = setup();
    await push(s, ['templates/ci.yml']);
    s.gh.mergePr(MID, wfPrs(s, MID)[0]!.number, 'merge');
    s.gh.resetCalls();
    await push(s, [DEST]);
    expect(s.gh.calls.filter((c) => c.op === 'findOpenPullRequest' && JSON.stringify(c.detail).includes(BRANCH))).toHaveLength(0);
  });
});

describe('POST /admin/workflows (function)', () => {
  it('previews with dry_run and applies otherwise', async () => {
    const s = setup();
    const preview = await runAdminWorkflows(s.deps, { chain: MID, dryRun: true }, nullLogger);
    expect(preview).toMatchObject({ ok: true });
    expect(s.gh.writes()).toEqual([]);
    const applied = await runAdminWorkflows(s.deps, { chain: MID, dryRun: false }, nullLogger);
    expect(applied.ok && applied.result.targets.map((t) => t.outcome)).toEqual(['pr_opened', 'pr_opened']);
  });

  it('rejects a stranger and an unknown chain', async () => {
    const s = setup();
    expect(await runAdminWorkflows(s.deps, { chain: 'stranger/x', dryRun: false }, nullLogger)).toMatchObject({ ok: false, status: 403 });
    expect(await runAdminWorkflows(s.deps, { chain: 'me/uninstalled', dryRun: false }, nullLogger)).toMatchObject({ ok: false, status: 404 });
  });
});
