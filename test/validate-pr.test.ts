import { describe, expect, it } from 'vitest';
import { loadChainConfig } from '../src/config/load';
import { CONFIG_COMMENT_MARKER, validateConfigOnPullRequest } from '../src/config/validate-pr';
import { createEventHandler } from '../src/events';
import type { PortFactory } from '../src/github/ports';
import { nullLogger } from '../src/log';
import { MemoryStore } from '../src/store/memory';
import { FakeGitHub } from './helpers/fake-github';

const MIDSTREAM = { owner: 'me', repo: 'widget' };
const GOOD = `
version: 1
upstream:   { repo: acme/widget }
midstream:  { repo: me/widget }
downstream: { repo: other/deploy }
`;
const BAD = GOOD + 'variabless: []\n';
const now = () => new Date('2026-10-12T12:00:00Z');

/** A PR from `feature` that rewrites chain.yml (or only touches the README). */
async function setup(headText: string, touch: 'config' | 'readme' = 'config') {
  const gh = new FakeGitHub().createRepo('me/widget', { '.github/chain.yml': GOOD, 'README.md': 'r' });
  gh.branchFrom('me/widget', 'feature');
  gh.commit('me/widget', 'feature', touch === 'config' ? { '.github/chain.yml': headText } : { 'README.md': 'changed' });
  const { pr } = await gh.createPullRequest(MIDSTREAM, { title: 't', body: '', head: 'feature', base: 'main', draft: false });
  return { gh, pr, headSha: gh.tip('me/widget', 'feature'), store: new MemoryStore() };
}

type Scene = Awaited<ReturnType<typeof setup>>;
const run = (s: Scene) =>
  validateConfigOnPullRequest(s.gh, s.store, { repo: MIDSTREAM, pullNumber: s.pr.number, headSha: s.headSha }, nullLogger, now);
const commentsOn = (s: Scene) => s.gh.comments('me/widget', s.pr.number);

describe('chain.yml validation on pull requests', () => {
  it('comments the errors, with positions, when the PR makes the config invalid', async () => {
    const s = await setup(BAD);
    expect(await run(s)).toBe('invalid');
    const [body] = commentsOn(s);
    expect(commentsOn(s)).toHaveLength(1);
    expect(body).toContain(CONFIG_COMMENT_MARKER);
    expect(body).toContain('is invalid');
    expect(body).toContain('variabless');
    expect(body).toMatch(/chain\.yml:\d+:\d+/);
  });

  it('logs the failure to the run log too', async () => {
    const s = await setup(BAD);
    await run(s);
    expect(s.store.runs).toHaveLength(1);
    expect(s.store.runs[0]).toMatchObject({ hop: 'config', outcome: 'config_invalid', chain: 'me/widget', prNumber: s.pr.number });
  });

  it('is quiet for a valid config (no comment)', async () => {
    const s = await setup(GOOD + '# touched\n');
    expect(await run(s)).toBe('valid');
    expect(commentsOn(s)).toHaveLength(0);
    expect(s.store.runs[0]).toMatchObject({ outcome: 'config_valid' });
  });

  it('updates ONE comment in place across pushes and flips it to valid when fixed', async () => {
    const s = await setup(BAD);
    await run(s);
    await run(s); // same content again: no duplicate, no needless edit
    expect(commentsOn(s)).toHaveLength(1);
    expect(s.gh.calls.filter((c) => c.op === 'updateComment')).toHaveLength(0);

    s.gh.commit('me/widget', 'feature', { '.github/chain.yml': GOOD + '# fixed\n' });
    const fixed = { ...s, headSha: s.gh.tip('me/widget', 'feature') };
    expect(await run(fixed)).toBe('valid');
    expect(commentsOn(s)).toHaveLength(1);
    expect(commentsOn(s)[0]).toContain('is valid');
  });

  it('ignores PRs that do not touch chain.yml, without reading anything', async () => {
    const s = await setup(BAD, 'readme');
    expect(await run(s)).toBe('not_affected');
    expect(s.gh.calls.filter((c) => c.op === 'readFile')).toHaveLength(0);
    expect(commentsOn(s)).toHaveLength(0);
  });

  it('reports a chain.yml copied into the wrong repo', async () => {
    const s = await setup(GOOD.replace('midstream:  { repo: me/widget }', 'midstream:  { repo: someone/else }'));
    expect(await run(s)).toBe('invalid');
    expect(commentsOn(s)[0]).toMatch(/must be in the midstream repo/);
  });
});

describe('loadChainConfig', () => {
  it('returns missing when the repo has no chain.yml (not an error: just not a midstream)', async () => {
    const gh = new FakeGitHub().createRepo('me/widget', { 'README.md': 'x' });
    expect(await loadChainConfig(gh, MIDSTREAM)).toEqual({ status: 'missing' });
  });

  it('returns the parsed config', async () => {
    const gh = new FakeGitHub().createRepo('me/widget', { '.github/chain.yml': GOOD });
    const r = await loadChainConfig(gh, MIDSTREAM);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.config.downstream.repo).toBe('other/deploy');
  });

  it('returns invalid with positioned errors', async () => {
    const gh = new FakeGitHub().createRepo('me/widget', { '.github/chain.yml': BAD });
    const r = await loadChainConfig(gh, MIDSTREAM);
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') expect(r.errors[0]).toMatchObject({ path: 'variabless', line: 6 });
  });
});

describe('event routing for pull_request', () => {
  const prEvent = (s: Scene, over: Record<string, unknown> = {}, owner = 'me') => ({
    id: 'd1',
    name: 'pull_request',
    payload: {
      action: 'synchronize',
      installation: { id: 42 },
      repository: { name: 'widget', owner: { login: owner }, default_branch: 'main' },
      pull_request: { number: s.pr.number, base: { ref: 'main' }, head: { sha: s.headSha } },
      ...over,
    },
  });

  function handler(s: Scene, allowed = ['me']) {
    const asked: number[] = [];
    const ports: PortFactory = {
      forInstallation: async (id) => (asked.push(id), s.gh),
      forRepo: async () => s.gh,
    };
    return { asked, handle: createEventHandler({ allowedOwners: new Set(allowed), ports, store: s.store, now }) };
  }

  it('validates when the owner is allowlisted', async () => {
    const s = await setup(BAD);
    const h = handler(s);
    await h.handle(prEvent(s), nullLogger);
    expect(h.asked).toEqual([42]);
    expect(commentsOn(s)).toHaveLength(1);
  });

  it('does nothing for an owner outside ALLOWED_OWNERS (no token is even minted)', async () => {
    const s = await setup(BAD);
    const h = handler(s);
    await h.handle(prEvent(s, {}, 'stranger'), nullLogger);
    expect(h.asked).toEqual([]);
    expect(commentsOn(s)).toHaveLength(0);
  });

  it('ignores PRs that do not target the default branch, and irrelevant actions', async () => {
    const s = await setup(BAD);
    const h = handler(s);
    await h.handle(prEvent(s, { pull_request: { number: s.pr.number, base: { ref: 'dev' }, head: { sha: s.headSha } } }), nullLogger);
    await h.handle(prEvent(s, { action: 'closed' }), nullLogger);
    expect(h.asked).toEqual([]);
  });
});
