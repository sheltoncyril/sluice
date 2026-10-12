import { describe, expect, it } from 'vitest';
import { loadChainConfig } from '../src/config/load';
import { CONFIG_COMMENT_MARKER, validateConfigOnPullRequest } from '../src/config/validate-pr';
import { createEventHandler } from '../src/events';
import type { PortFactory } from '../src/github/ports';
import { nullLogger } from '../src/log';
import { MemoryStore } from '../src/store/memory';
import { BasicFakePort } from './helpers/fake-port-basic';

const MIDSTREAM = { owner: 'me', repo: 'widget' };
const GOOD = `
version: 1
upstream:   { repo: acme/widget }
midstream:  { repo: me/widget }
downstream: { repo: other/deploy }
`;
const BAD = GOOD + 'variabless: []\n';
const now = () => new Date('2026-10-12T12:00:00Z');

function setup(headText: string | null, prFiles: string[] = ['.github/chain.yml']) {
  const port = new BasicFakePort();
  if (headText !== null) port.putFile('me/widget', '.github/chain.yml', headText, 'headsha');
  port.prFiles.set('me/widget#7', prFiles);
  return { port, store: new MemoryStore() };
}
const run = (port: BasicFakePort, store: MemoryStore) =>
  validateConfigOnPullRequest(port, store, { repo: MIDSTREAM, pullNumber: 7, headSha: 'headsha' }, nullLogger, now);

describe('chain.yml validation on pull requests', () => {
  it('comments the errors, with positions, when the PR makes the config invalid', async () => {
    const { port, store } = setup(BAD);
    expect(await run(port, store)).toBe('invalid');
    expect(port.comments).toHaveLength(1);
    const body = port.comments[0]!.body;
    expect(body).toContain(CONFIG_COMMENT_MARKER);
    expect(body).toContain('is invalid');
    expect(body).toContain('variabless');
    expect(body).toMatch(/chain\.yml:\d+:\d+/);
  });

  it('logs the failure to the run log too', async () => {
    const { port, store } = setup(BAD);
    await run(port, store);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ hop: 'config', outcome: 'config_invalid', chain: 'me/widget', prNumber: 7 });
  });

  it('is quiet for a valid config (no comment)', async () => {
    const { port, store } = setup(GOOD);
    expect(await run(port, store)).toBe('valid');
    expect(port.comments).toHaveLength(0);
    expect(store.runs[0]).toMatchObject({ outcome: 'config_valid' });
  });

  it('updates ONE comment in place across pushes and flips it to valid when fixed', async () => {
    const { port, store } = setup(BAD);
    await run(port, store);
    await run(port, store); // same content again: no duplicate, no needless edit
    expect(port.comments).toHaveLength(1);
    expect(port.calls.filter((c) => c === 'updateComment')).toHaveLength(0);

    port.putFile('me/widget', '.github/chain.yml', GOOD, 'headsha');
    expect(await run(port, store)).toBe('valid');
    expect(port.comments).toHaveLength(1);
    expect(port.comments[0]!.body).toContain('is valid');
  });

  it('ignores PRs that do not touch chain.yml, without reading anything', async () => {
    const { port, store } = setup(BAD, ['README.md']);
    expect(await run(port, store)).toBe('not_affected');
    expect(port.calls.filter((c) => c.startsWith('readFile'))).toHaveLength(0);
    expect(port.comments).toHaveLength(0);
  });

  it('reports a chain.yml copied into the wrong repo', async () => {
    const { port, store } = setup(GOOD.replace('midstream:  { repo: me/widget }', 'midstream:  { repo: someone/else }'));
    expect(await run(port, store)).toBe('invalid');
    expect(port.comments[0]!.body).toMatch(/must be in the midstream repo/);
  });

  it('copes with the file being deleted by the PR', async () => {
    const { port, store } = setup(null);
    expect(await run(port, store)).toBe('deleted');
  });
});

describe('loadChainConfig', () => {
  it('returns missing when the repo has no chain.yml (not an error: just not a midstream)', async () => {
    const port = new BasicFakePort();
    expect(await loadChainConfig(port, MIDSTREAM)).toEqual({ status: 'missing' });
  });

  it('returns the parsed config, reading from the requested ref', async () => {
    const port = new BasicFakePort();
    port.putFile('me/widget', '.github/chain.yml', GOOD);
    const r = await loadChainConfig(port, MIDSTREAM);
    expect(r.status).toBe('ok');
    expect(port.calls).toContain('readFile me/widget .github/chain.yml ');
  });

  it('returns invalid with positioned errors', async () => {
    const port = new BasicFakePort();
    port.putFile('me/widget', '.github/chain.yml', BAD);
    const r = await loadChainConfig(port, MIDSTREAM);
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') expect(r.errors[0]).toMatchObject({ path: 'variabless', line: 6 });
  });
});

describe('event routing for pull_request', () => {
  const prEvent = (over: Record<string, unknown> = {}, owner = 'me') => ({
    id: 'd1',
    name: 'pull_request',
    payload: {
      action: 'synchronize',
      installation: { id: 42 },
      repository: { name: 'widget', owner: { login: owner }, default_branch: 'main' },
      pull_request: { number: 7, base: { ref: 'main' }, head: { sha: 'headsha' } },
      ...over,
    },
  });

  function handler(port: BasicFakePort, allowed = ['me']) {
    const asked: number[] = [];
    const ports: PortFactory = {
      forInstallation: async (id) => (asked.push(id), port),
      forRepo: async () => port,
    };
    const store = new MemoryStore();
    return { asked, store, handle: createEventHandler({ allowedOwners: new Set(allowed), ports, store, now }) };
  }

  it('validates when the owner is allowlisted', async () => {
    const { port } = setup(BAD);
    const h = handler(port);
    await h.handle(prEvent(), nullLogger);
    expect(h.asked).toEqual([42]);
    expect(port.comments).toHaveLength(1);
  });

  it('does nothing for an owner outside ALLOWED_OWNERS (no token is even minted)', async () => {
    const { port } = setup(BAD);
    const h = handler(port);
    await h.handle(prEvent({}, 'stranger'), nullLogger);
    expect(h.asked).toEqual([]);
    expect(port.comments).toHaveLength(0);
  });

  it('ignores PRs that do not target the default branch, and irrelevant actions', async () => {
    const { port } = setup(BAD);
    const h = handler(port);
    await h.handle(prEvent({ pull_request: { number: 7, base: { ref: 'dev' }, head: { sha: 'headsha' } } }), nullLogger);
    await h.handle(prEvent({ action: 'closed' }), nullLogger);
    expect(h.asked).toEqual([]);
  });
});
