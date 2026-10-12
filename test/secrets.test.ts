import { describe, expect, it } from 'vitest';
import { RateLimitExceededError } from '../src/github/resilient';
import type { GitHubPort } from '../src/github/port';
import { createLogger } from '../src/log';
import { distributeSecret } from '../src/secrets/distribute';
import type { SecretDeps, SecretResponse } from '../src/secrets/distribute';
import { NaclSealer } from '../src/secrets/sealer';
import type { SecretSealer } from '../src/secrets/sealer';
import { chainScene, chainYml } from './helpers/chain-scene';
import type { ChainScene } from './helpers/chain-scene';
import { revealSecret } from './helpers/sodium';

const MID = 'me/widget';
const DOWN = 'other/deploy';
const SECRETS = 'secrets:\n  - name: NPM_TOKEN\n  - name: ONLY_MID\n    targets: [midstream]\n  - name: ONLY_DOWN\n    targets: [downstream]\n';
const PLAINTEXT = 'PLAINTEXT-7f3a9c2e-DO-NOT-LEAK';

function setup(over: Parameters<typeof chainScene>[0] = {}, sealer: SecretSealer = new NaclSealer()) {
  const s = chainScene({ configYaml: chainYml({ extra: SECRETS }), ...over });
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (l) => logs.push(l) });
  const deps: SecretDeps = { ...s.deps, sealer };
  const submit = (name: string, value = PLAINTEXT, chain = MID) => distributeSecret(deps, { chain, name, value }, logger);
  return { ...s, deps, logs, logger, submit };
}

describe('distributing a secret', () => {
  it('seals the value to EACH target repo\'s own key and writes it', async () => {
    const s = setup();
    const out = await s.submit('NPM_TOKEN');
    expect(out).toMatchObject({ ok: true, name: 'NPM_TOKEN' });
    expect(out.ok && out.results.map((r) => [r.repo, r.status])).toEqual([
      [MID, 'created'],
      [DOWN, 'created'],
    ]);
    // What GitHub would decrypt with each repo's private key (via the libsodium oracle):
    expect(await revealSecret(s.gh, MID, 'NPM_TOKEN')).toBe(PLAINTEXT);
    expect(await revealSecret(s.gh, DOWN, 'NPM_TOKEN')).toBe(PLAINTEXT);
    // ...and the two ciphertexts differ (different keys, fresh ephemeral key each time).
    expect(s.gh.sealedSecret(MID, 'NPM_TOKEN')).not.toBe(s.gh.sealedSecret(DOWN, 'NPM_TOKEN'));
  });

  it('rotation is re-submission: a second submit replaces the value and reports "updated"', async () => {
    const s = setup();
    await s.submit('NPM_TOKEN', 'first-value-1111');
    const out = await s.submit('NPM_TOKEN', 'second-value-2222');
    expect(out.ok && out.results.map((r) => r.status)).toEqual(['updated', 'updated']);
    expect(await revealSecret(s.gh, MID, 'NPM_TOKEN')).toBe('second-value-2222');
  });

  it('honours the targets declared for each name', async () => {
    const s = setup();
    await s.submit('ONLY_MID');
    await s.submit('ONLY_DOWN');
    expect(s.gh.secretNames(MID)).toEqual(['ONLY_MID']);
    expect(s.gh.secretNames(DOWN)).toEqual(['ONLY_DOWN']);
  });

  it('refuses a name that chain.yml does not declare (you cannot push arbitrary secrets)', async () => {
    const s = setup();
    const out = await s.submit('SNEAKY');
    expect(out).toMatchObject({ ok: false, status: 404 });
    expect(s.gh.secretNames(MID)).toEqual([]);
    expect(s.gh.writes()).toEqual([]);
  });

  it.each([
    [{ chain: 'not-a-repo' }, 400],
    [{ chain: 'stranger/widget' }, 403],
    [{ chain: 'me/uninstalled' }, 404],
  ])('rejects %j with %i', async (over, status) => {
    const s = setup();
    const out = await s.submit('NPM_TOKEN', PLAINTEXT, over.chain);
    expect(out).toMatchObject({ ok: false, status });
    expect(s.gh.writes()).toEqual([]);
  });

  it('reports a missing or invalid chain.yml without writing anything', async () => {
    const bad = setup({ configYaml: chainYml({ extra: 'nonsense: 1\n' }) });
    expect(await bad.submit('NPM_TOKEN')).toMatchObject({ ok: false, status: 422 });
    expect(bad.gh.secretNames(MID)).toEqual([]);
  });
});

describe('distributing a secret: failures are visible and recoverable', () => {
  it('refuses a downstream owner outside ALLOWED_OWNERS but still serves midstream (partial = 207)', async () => {
    const s = setup({ allowed: ['me'] });
    const out = await s.submit('NPM_TOKEN');
    expect(out).toMatchObject({ ok: false, status: 207 });
    expect(out.ok === false && out.results?.map((r) => [r.repo, r.status])).toEqual([
      [MID, 'created'],
      [DOWN, 'error'],
    ]);
    expect(s.gh.secretNames(DOWN)).toEqual([]);
    expect(s.forRepoCalls).not.toContain(DOWN);
  });

  it('reports a partial write when GitHub fails for one target, and re-submitting completes it', async () => {
    const s = setup();
    s.gh.failNext('getActionsPublicKey', new Error('boom')); // midstream fails first...
    const first = await s.submit('NPM_TOKEN');
    expect(first).toMatchObject({ ok: false, status: 207 });
    expect(s.gh.secretNames(MID)).toEqual([]);
    expect(s.gh.secretNames(DOWN)).toEqual(['NPM_TOKEN']);

    const again = await s.submit('NPM_TOKEN');
    expect(again.ok && again.results.map((r) => r.status)).toEqual(['created', 'updated']);
  });

  it('all targets failing is 502', async () => {
    const s = setup();
    s.gh.failNext('putActionsSecret', new Error('a'));
    s.gh.failNext('putActionsSecret', new Error('b'));
    expect(await s.submit('NPM_TOKEN')).toMatchObject({ ok: false, status: 502 });
  });

  it('a rate limit stops the run and marks the rest skipped', async () => {
    const s = setup();
    s.gh.failNext('getActionsPublicKey', new RateLimitExceededError('primary', 3_000_000));
    const out = await s.submit('NPM_TOKEN');
    expect(out.ok === false && out.results?.map((r) => r.status)).toEqual(['error', 'skipped']);
  });

  it('records outcomes in the run log: names, repos and statuses only', async () => {
    const s = setup();
    await s.submit('NPM_TOKEN');
    expect(s.store.runs.at(-1)).toMatchObject({
      hop: 'secrets',
      outcome: 'secret_distributed',
      chain: MID,
      detail: { name: 'NPM_TOKEN', targets: [{ repo: MID, status: 'created' }, { repo: DOWN, status: 'created' }] },
    });
  });
});

/**
 * "Secret values must never be persisted: not in D1, KV, logs, or Worker secrets" — proven here by
 * capturing EVERY place the value could go and searching each for it (raw, base64 and hex forms).
 */
describe('the secret value never reaches logs, storage, GitHub requests or responses', () => {
  const forms = (v: string) => [v, Buffer.from(v).toString('base64'), Buffer.from(v).toString('hex')];

  /** Wrap a port so every argument of every call is captured, like a network tap. */
  function tap(gh: GitHubPort) {
    const sent: string[] = [];
    const port = new Proxy(gh, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          sent.push(`${String(prop)} ${JSON.stringify(args)}`);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return { port, sent };
  }

  function instrumented(s: ChainScene, logs: string[]) {
    const { port, sent } = tap(s.gh);
    const deps: SecretDeps = {
      ...s.deps,
      ports: { forInstallation: async () => port, forRepo: async (r) => (s.installed.has(`${r.owner}/${r.repo}`.toLowerCase()) ? port : null) },
      sealer: new NaclSealer(),
    };
    const logger = createLogger({ level: 'debug', sink: (l) => logs.push(l) });
    const everywhere = (extra: unknown[] = []) =>
      JSON.stringify({
        logs,
        runs: s.store.runs,
        deliveries: [...s.store.deliveries],
        hopStates: [...s.store.hopStates],
        sent,
        extra,
      });
    return { deps, logger, sent, everywhere };
  }

  it('success path: only ciphertext is ever sent; the plaintext is in no log, row, request or response', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: SECRETS }) });
    const logs: string[] = [];
    const t = instrumented(s, logs);
    const out = await distributeSecret(t.deps, { chain: MID, name: 'NPM_TOKEN', value: PLAINTEXT }, t.logger);

    const haystack = t.everywhere([out]);
    for (const form of forms(PLAINTEXT)) expect(haystack, `found ${form.slice(0, 12)}…`).not.toContain(form);

    // Sanity: the thing we searched really did carry the operation (so an empty capture can't pass).
    expect(t.sent.some((c) => c.startsWith('putActionsSecret'))).toBe(true);
    expect(logs.some((l) => l.includes('secret written'))).toBe(true);
    // ...and the ciphertext that WAS sent decrypts to the value, so it was a real secret write.
    expect(await revealSecret(s.gh, MID, 'NPM_TOKEN')).toBe(PLAINTEXT);
  });

  it('even when a failing dependency ECHOES the plaintext in its error, it is scrubbed from logs and the response', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: SECRETS }) });
    const logs: string[] = [];
    const t = instrumented(s, logs);
    // A real HTTP library may quote what it was given. Simulate the worst case, for both failure points.
    s.gh.failNext('getActionsPublicKey', new Error(`request failed for value=${PLAINTEXT}`));
    s.gh.failNext('putActionsSecret', Object.assign(new Error(`rejected ${PLAINTEXT} (422)`), { status: 422 }));
    const out = await distributeSecret(t.deps, { chain: MID, name: 'NPM_TOKEN', value: PLAINTEXT }, t.logger);

    expect(out.ok).toBe(false);
    const haystack = JSON.stringify({ logs, runs: s.store.runs, out });
    for (const form of forms(PLAINTEXT)) expect(haystack).not.toContain(form);
    expect(logs.some((l) => l.includes('secret write failed'))).toBe(true); // it was logged, scrubbed
  });

  it('a sealer that throws with the plaintext in its message cannot leak it either', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: SECRETS }) });
    const logs: string[] = [];
    const t = instrumented(s, logs);
    const hostile: SecretSealer = { seal: async (plaintext) => Promise.reject(new Error(`cannot seal ${plaintext}`)) };
    const out = await distributeSecret({ ...t.deps, sealer: hostile }, { chain: MID, name: 'NPM_TOKEN', value: PLAINTEXT }, t.logger);
    expect(out.ok).toBe(false);
    for (const form of forms(PLAINTEXT)) expect(JSON.stringify({ logs, runs: s.store.runs, out })).not.toContain(form);
    expect(s.gh.secretNames(MID)).toEqual([]); // and nothing was written
  });

  it('the failure responses and run log never contain values from the request either', async () => {
    const s = setup({ allowed: ['me'] });
    const out = await s.submit('NPM_TOKEN');
    const haystack = JSON.stringify({ out, runs: s.store.runs, logs: s.logs });
    for (const form of forms(PLAINTEXT)) expect(haystack).not.toContain(form);
  });

  it('CONTROL: the detector really does catch a leak (so the passes above mean something)', async () => {
    const logs: string[] = [];
    // A logger WITHOUT the request-scoped scrubber, logging the value inside a free-text message:
    const naive = createLogger({ level: 'debug', sink: (l) => logs.push(l) });
    naive.info(`debug: submitting ${PLAINTEXT}`);
    expect(JSON.stringify({ logs })).toContain(PLAINTEXT);
    // ...and WITH it, the same line is clean:
    const clean: string[] = [];
    createLogger({ level: 'debug', sink: (l) => clean.push(l) }).withSecrets([PLAINTEXT]).info(`debug: submitting ${PLAINTEXT}`);
    expect(JSON.stringify({ clean })).not.toContain(PLAINTEXT);
  });
});

describe('response typing', () => {
  it('a successful response carries results only (type-level guard that no value field exists)', async () => {
    const s = setup();
    const out: SecretResponse = await s.submit('NPM_TOKEN');
    expect(Object.keys(out).sort()).toEqual(['name', 'ok', 'results']);
  });
});
