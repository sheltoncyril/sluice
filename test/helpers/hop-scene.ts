import type { MergeMethod } from '../../src/config/schema';
import { nullLogger } from '../../src/log';
import { MemoryStore } from '../../src/store/memory';
import { syncHop } from '../../src/sync/hop';
import type { HopDeps, HopOptions, HopSpec } from '../../src/sync/hop';
import { FakeGitHub } from './fake-github';

export const UP = 'acme/widget';
export const MID = 'me/widget';
export const BRANCH = 'chain/sync-upstream';
export const now = () => new Date('2026-10-12T12:00:00Z');

/** upstream acme/widget -> midstream me/widget (a fork). Runs the upstream->midstream hop. */
export function scene(mergeMethod: MergeMethod = 'merge', files: Record<string, string> = { 'a.txt': '1\n', 'b.txt': '1\n', 'c.txt': '1\n' }) {
  const gh = new FakeGitHub().createRepo(UP, files);
  gh.fork(UP, MID);
  const store = new MemoryStore();
  const sleeps: number[] = [];
  const spec: HopSpec = {
    id: 'upstream_to_midstream',
    chain: MID,
    source: { repo: { owner: 'acme', repo: 'widget' }, branch: 'main' },
    target: { repo: { owner: 'me', repo: 'widget' }, branch: 'main' },
    syncBranch: BRANCH,
    mergeMethod,
    protectedPaths: [],
    pr: { labels: ['sluice'], assignees: ['octocat'], reviewers: ['octocat'], teamReviewers: [], draft: false },
    conflicts: { label: 'sluice/conflict', comment: true, assignees: ['octocat'], requestReview: true },
  };
  const deps: HopDeps = {
    sourcePort: gh,
    targetPort: gh,
    store,
    logger: nullLogger,
    now,
    sleep: async (ms) => void sleeps.push(ms),
  };
  const run = (opts: Partial<HopOptions> = {}, over: Partial<HopSpec> = {}, depsOver: Partial<HopDeps> = {}) =>
    syncHop({ ...spec, ...over }, { ...deps, ...depsOver }, { trigger: 'cron', ...opts });
  return { gh, store, spec, run, sleeps };
}

export const openPrs = (gh: FakeGitHub) => gh.prs(MID).filter((p) => p.state === 'open');
