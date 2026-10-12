import { describe, expect, it } from 'vitest';
import { loadChainConfig } from '../src/config/load';
import { RateLimitExceededError } from '../src/github/resilient';
import { nullLogger } from '../src/log';
import { DRIFT_MARKER, renderReport } from '../src/reconcile/report';
import type { DriftFinding } from '../src/reconcile/report';
import { reconcileChain, SECRET_SKEW_MS } from '../src/reconcile/reconcile';
import type { ReconcileResult } from '../src/reconcile/reconcile';
import { reconcileAll } from '../src/reconcile/schedule';
import { runAdminReconcile } from '../src/sync/admin';
import { discoverChains } from '../src/sync/discover';
import { chainScene, chainYml } from './helpers/chain-scene';
import type { ChainScene } from './helpers/chain-scene';

const MID = 'me/widget';
const DOWN = 'other/deploy';
const midRef = { owner: 'me', repo: 'widget' };
const downRef = { owner: 'other', repo: 'deploy' };

const EXTRA = `secrets:
  - name: NPM_TOKEN
  - name: ONLY_MID
    targets: [midstream]
    max_age_days: 30
variables:
  - name: REGION
    value: eu-west-1
workflows:
  files:
    - template: ci.yml
      destination: .github/workflows/ci.yml
`;
const TEMPLATE = 'name: CI for {{ repo }}\non: [push]\njobs: {}\n';

function setup(extra = EXTRA, over: Parameters<typeof chainScene>[0] = {}) {
  const s = chainScene({ configYaml: chainYml({ extra }), ...over });
  s.gh.commit(MID, 'main', { 'templates/ci.yml': TEMPLATE }, 'add template');
  return s;
}

async function handleOf(s: ChainScene) {
  const loaded = await loadChainConfig(s.gh, midRef);
  if (loaded.status !== 'ok') throw new Error('config should load: ' + JSON.stringify(loaded));
  return { holder: midRef, config: loaded.config, midstreamPort: s.gh };
}
const reconcile = async (s: ChainScene, opts: { dryRun?: boolean } = {}): Promise<ReconcileResult> =>
  reconcileChain(s.deps, await handleOf(s), { trigger: 'test', dryRun: opts.dryRun ?? false }, nullLogger);

async function putSecret(s: ChainScene, repo: 'me/widget' | 'other/deploy', name: string) {
  const ref = repo === MID ? midRef : downRef;
  const { keyId } = await s.gh.getActionsPublicKey(ref);
  await s.gh.putActionsSecret(ref, name, 'ciphertext-not-checked', keyId);
}

/**
 * Bring a chain to rest: the given secrets exist, variables applied, every sluice PR merged. Returns the
 * last reconcile result; callers assert on its findings (some tests leave a secret missing on purpose).
 */
async function settle(s: ChainScene, secrets: Array<['me/widget' | 'other/deploy', string]> = [[MID, 'NPM_TOKEN'], [DOWN, 'NPM_TOKEN'], [MID, 'ONLY_MID']]) {
  for (const [repo, name] of secrets) await putSecret(s, repo, name);
  for (let i = 0; i < 6; i++) {
    const r = await reconcile(s);
    let merged = 0;
    for (const repo of [MID, DOWN]) {
      for (const pr of s.gh.prs(repo).filter((p) => p.state === 'open' && p.headRef.startsWith('chain/'))) {
        s.gh.mergePr(repo, pr.number, 'merge');
        merged++;
      }
    }
    if (merged === 0) return r;
  }
  throw new Error('chain did not settle');
}
const openIssues = (s: ChainScene) => s.gh.issues(MID).filter((i) => i.state === 'open');
const secretWrites = (s: ChainScene) => s.gh.calls.filter((c) => c.op === 'putActionsSecret' || c.op === 'getActionsPublicKey');

describe('a healthy chain', () => {
  it('reports nothing and keeps no issue', async () => {
    const s = setup();
    expect((await settle(s)).findings).toEqual([]);
    s.gh.resetCalls();
    const r = await reconcile(s);
    expect(r.findings).toEqual([]);
    expect(r.report).toBe('unchanged');
    expect(s.gh.issues(MID)).toHaveLength(0);
    expect(s.gh.writes()).toEqual([]); // and a clean reconcile changes nothing
  });

  it('records the run as clean', async () => {
    const s = setup();
    await settle(s);
    expect(s.store.runs.filter((r) => r.hop === 'reconcile').at(-1)).toMatchObject({ outcome: 'reconcile_clean' });
  });
});

describe('what sluice fixes or opens a PR for is NOT a finding', () => {
  it('variable drift is fixed directly, silently', async () => {
    const s = setup();
    await settle(s);
    await s.gh.updateActionsVariable(downRef, 'REGION', 'tampered');
    const r = await reconcile(s);
    expect(s.gh.variablesOf(DOWN).REGION).toBe('eu-west-1');
    expect(r.variables.filter((v) => v.action === 'updated')).toHaveLength(1);
    expect(r.findings).toEqual([]);
    expect(s.gh.issues(MID)).toHaveLength(0);
  });

  it('workflow-file drift gets a PR, not an issue', async () => {
    const s = setup();
    await settle(s);
    s.gh.commit(DOWN, 'main', { '.github/workflows/ci.yml': 'name: hand edited\njobs: {}\n' }, 'hand edit');
    const r = await reconcile(s);
    expect(r.workflows.find((w) => w.target === 'downstream')).toMatchObject({ outcome: 'pr_opened', drift: ['.github/workflows/ci.yml'] });
    expect(r.findings).toEqual([]);
    expect(s.gh.issues(MID)).toHaveLength(0);
  });

  it('a missed webhook is healed: the downstream sync PR is opened by the reconcile', async () => {
    const s = setup();
    await settle(s);
    s.gh.commit(MID, 'main', { 'a.txt': 'midstream moved on; the push webhook never arrived\n' });
    const r = await reconcile(s);
    expect(r.hops[0]).toMatchObject({ hop: 'midstream_to_downstream', outcome: 'pr_opened' });
    expect(s.gh.prs(DOWN).filter((p) => p.state === 'open' && p.headRef === 'chain/sync-midstream')).toHaveLength(1);
    expect(r.findings).toEqual([]);
  });
});

describe('secrets: REPORTED, never fixed', () => {
  it('a declared secret that is missing is reported, and no secret is ever written', async () => {
    const s = setup();
    await settle(s, [[MID, 'NPM_TOKEN'], [DOWN, 'NPM_TOKEN']]); // ONLY_MID was never set
    s.gh.resetCalls();
    const r = await reconcile(s);
    expect(r.findings).toEqual([
      { kind: 'secret_missing', repo: MID, subject: 'ONLY_MID', detail: expect.stringContaining('does not exist') },
    ]);
    expect(secretWrites(s)).toEqual([]); // not even a public-key fetch: there is nothing it could do
    expect(s.gh.secretNames(MID)).toEqual(['NPM_TOKEN']);
  });

  it('a missing secret in downstream names that repo', async () => {
    const s = setup();
    await settle(s, [[MID, 'NPM_TOKEN'], [MID, 'ONLY_MID']]);
    const r = await reconcile(s);
    expect(r.findings.map((f) => [f.kind, f.repo, f.subject])).toEqual([['secret_missing', DOWN, 'NPM_TOKEN']]);
  });

  it('reports a secret older than its max_age_days, and only then', async () => {
    const s = setup();
    await settle(s);
    expect((await reconcile(s)).findings).toEqual([]);

    s.gh.setSecretUpdatedAt(MID, 'ONLY_MID', '2026-08-01T00:00:00Z'); // 72 days before the test clock
    const r = await reconcile(s);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: 'secret_stale', repo: MID, subject: 'ONLY_MID' });
    expect(r.findings[0]!.detail).toMatch(/72 days ago.*30-day rotation policy/);
    // NPM_TOKEN has no max_age_days, so it is never "stale", however old
    s.gh.setSecretUpdatedAt(MID, 'NPM_TOKEN', '2020-01-01T00:00:00Z');
    s.gh.setSecretUpdatedAt(DOWN, 'NPM_TOKEN', '2020-01-01T00:00:00Z');
    expect((await reconcile(s)).findings.map((f) => f.subject)).toEqual(['ONLY_MID']);
  });

  it('reports a rotation that only half succeeded (targets written far apart), but not normal submissions', async () => {
    const s = setup();
    await settle(s);
    s.gh.setSecretUpdatedAt(MID, 'NPM_TOKEN', '2026-10-01T10:00:00Z');
    s.gh.setSecretUpdatedAt(DOWN, 'NPM_TOKEN', '2026-10-01T10:05:00Z'); // 5 minutes: a slow but normal submit
    expect((await reconcile(s)).findings).toEqual([]);

    s.gh.setSecretUpdatedAt(DOWN, 'NPM_TOKEN', '2026-10-01T13:00:00Z'); // 3 hours later
    const r = await reconcile(s);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: 'secret_skew', subject: 'NPM_TOKEN' });
    expect(r.findings[0]!.detail).toContain('submit it again');
    expect(SECRET_SKEW_MS).toBe(15 * 60 * 1000);
  });

  it('never reads or sends a secret value, only lists names and timestamps', async () => {
    const s = setup();
    await settle(s);
    s.gh.resetCalls();
    await reconcile(s);
    const ops = new Set(s.gh.calls.map((c) => c.op));
    expect(ops.has('listActionsSecrets')).toBe(true);
    expect(ops.has('putActionsSecret')).toBe(false);
    expect(ops.has('getActionsPublicKey')).toBe(false);
  });

  it('a repo it cannot check is itself reported', async () => {
    const s = setup(EXTRA, { allowed: ['me'] }); // downstream not allowlisted
    const r = await reconcile(s);
    expect(r.findings.some((f) => f.kind === 'secret_check_error' && f.repo === DOWN)).toBe(true);
  });
});

describe('sync PRs that need a human', () => {
  it('flags a conflicted sync PR', async () => {
    const s = setup();
    await settle(s);
    s.gh.commit(MID, 'main', { 'a.txt': 'midstream version\n' });
    s.gh.commit(DOWN, 'main', { 'a.txt': 'downstream version\n' });
    const r = await reconcile(s);
    expect(r.findings.map((f) => [f.kind, f.repo])).toEqual([['hop_conflict', DOWN]]);
    expect(r.findings[0]!.url).toMatch(/\/pull\/\d+$/);
  });

  it('flags a sync PR that has been open longer than stale_pr_days, and not before', async () => {
    const s = setup(EXTRA + 'reconcile:\n  stale_pr_days: 7\n');
    await settle(s);
    s.gh.commit(MID, 'main', { 'a.txt': 'x\n' });
    await reconcile(s); // opens the downstream sync PR
    const pr = s.gh.prs(DOWN).find((p) => p.state === 'open' && p.headRef === 'chain/sync-midstream')!;

    s.gh.setPrCreatedAt(DOWN, pr.number, '2026-10-09T00:00:00Z'); // 3 days old
    expect((await reconcile(s)).findings).toEqual([]);
    s.gh.setPrCreatedAt(DOWN, pr.number, '2026-10-01T00:00:00Z'); // 11 days old
    const r = await reconcile(s);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: 'hop_stale_pr', repo: DOWN });
    expect(r.findings[0]!.detail).toContain('7 days');
  });
});

describe('the drift report is ONE issue that tracks reality', () => {
  async function withMissing() {
    const s = setup();
    await settle(s, [[MID, 'NPM_TOKEN'], [DOWN, 'NPM_TOKEN']]);
    s.gh.clearIssues(MID); // settling already filed a report; each scenario starts without one
    return s;
  }

  it('creates a labelled issue with the marker, the finding and an assignee', async () => {
    const s = await withMissing();
    const r = await reconcile(s);
    expect(r.report).toBe('created');
    const [issue] = openIssues(s);
    expect(openIssues(s)).toHaveLength(1);
    expect(issue!.title).toBe('sluice: drift report for me/widget');
    expect(issue!.body).toContain(DRIFT_MARKER);
    expect(issue!.body).toContain('`ONLY_MID` in `me/widget`');
    expect(issue!.body).toContain('never fixes one for you');
    expect([...issue!.labels]).toEqual(['sluice/drift']);
    expect(r.reportUrl).toMatch(/\/issues\/\d+$/);
  });

  it('an unchanged report costs ZERO writes and never makes a second issue', async () => {
    const s = await withMissing();
    await reconcile(s);
    s.gh.resetCalls();
    for (let i = 0; i < 3; i++) expect((await reconcile(s)).report).toBe('unchanged');
    expect(s.gh.writes()).toEqual([]);
    expect(s.gh.issues(MID)).toHaveLength(1);
  });

  it('edits the same issue when the findings change', async () => {
    const s = await withMissing();
    await reconcile(s);
    s.gh.setSecretUpdatedAt(DOWN, 'NPM_TOKEN', '2026-10-02T09:00:00Z'); // add a skew finding
    const r = await reconcile(s);
    expect(r.report).toBe('updated');
    expect(s.gh.issues(MID)).toHaveLength(1);
    expect(openIssues(s)[0]!.body).toContain('written at different times');
  });

  it('closes the issue with a comment when everything is in order, and a later problem opens a NEW one', async () => {
    const s = await withMissing();
    await reconcile(s);
    const first = openIssues(s)[0]!;
    await putSecret(s, MID, 'ONLY_MID'); // you submitted the missing secret

    const fixed = await reconcile(s);
    expect(fixed.report).toBe('closed');
    expect(openIssues(s)).toHaveLength(0);
    expect(s.gh.comments(MID, first.number).join('\n')).toMatch(/in order again/);

    s.gh.setSecretUpdatedAt(MID, 'ONLY_MID', '2026-08-01T00:00:00Z');
    await reconcile(s);
    expect(s.gh.issues(MID)).toHaveLength(2); // the old one stays closed
    expect(openIssues(s)).toHaveLength(1);
  });

  it('does not touch an unrelated issue that merely carries the label', async () => {
    const s = await withMissing();
    await s.gh.createIssue(midRef, { title: 'my own issue', body: 'no marker here', labels: ['sluice/drift'] });
    await reconcile(s);
    expect(s.gh.issues(MID).filter((i) => i.title === 'my own issue')[0]!.state).toBe('open');
    expect(s.gh.issues(MID)).toHaveLength(2);
  });

  it('reconcile.report: none keeps findings in the result and run log but opens no issue', async () => {
    const s = setup(EXTRA + 'reconcile:\n  report: none\n');
    await settle(s, [[MID, 'NPM_TOKEN'], [DOWN, 'NPM_TOKEN']]);
    const r = await reconcile(s);
    expect(r.findings).toHaveLength(1);
    expect(r.report).toBe('none');
    expect(s.gh.issues(MID)).toHaveLength(0);
    expect(s.store.runs.filter((x) => x.hop === 'reconcile').at(-1)).toMatchObject({ outcome: 'reconcile_findings', detail: { findings: { secret_missing: 1 } } });
  });

  it('a missing Issues permission is reported plainly and does not lose the findings', async () => {
    const s = await withMissing();
    s.gh.failNext('createIssue', Object.assign(new Error('Resource not accessible by integration'), { status: 403 }));
    const r = await reconcile(s);
    expect(r.report).toBe('failed');
    expect(r.reportError).toMatch(/Issues: Read & write/);
    expect(r.findings).toHaveLength(1);
    expect(s.store.runs.filter((x) => x.hop === 'reconcile').at(-1)).toMatchObject({ detail: { report: 'failed' } });
    // ...and the next run, with the permission granted, files it.
    expect((await reconcile(s)).report).toBe('created');
  });
});

describe('dry run and failures', () => {
  it('a dry run changes NOTHING (no fixes, no PRs, no issue) but still reports drift', async () => {
    const s = setup();
    for (const [repo, name] of [[MID, 'NPM_TOKEN'], [DOWN, 'NPM_TOKEN']] as const) await putSecret(s, repo, name);
    s.gh.resetCalls();
    const r = await reconcile(s, { dryRun: true });
    expect(s.gh.writes()).toEqual([]);
    expect(r.report).toBe('skipped');
    expect(r.findings.some((f) => f.kind === 'secret_missing')).toBe(true); // ONLY_MID missing
    expect(r.variables.some((v) => v.action === 'created')).toBe(true); // would be created
    expect(s.store.runs.filter((x) => x.hop === 'reconcile')).toHaveLength(0);
  });

  it('a failing stage does not stop the others', async () => {
    const s = setup();
    await settle(s, [[MID, 'NPM_TOKEN'], [DOWN, 'NPM_TOKEN']]);
    s.gh.failNext('listActionsVariables', new Error('variables API is down'));
    const r = await reconcile(s);
    const kinds = r.findings.map((f) => f.kind);
    expect(kinds).toContain('variable_error');
    expect(kinds).toContain('secret_missing'); // the secrets stage still ran
  });

  it('a rate limit ends the run cleanly: partial, no report change, logged as partial', async () => {
    const s = setup();
    await settle(s, [[MID, 'NPM_TOKEN'], [DOWN, 'NPM_TOKEN']]);
    await reconcile(s); // create the issue
    s.gh.failNext('listActionsSecrets', new RateLimitExceededError('primary', 3_000_000));
    s.gh.resetCalls();
    const r = await reconcile(s);
    expect(r.partial).toBe(true);
    expect(s.gh.writes()).toEqual([]); // did not close or rewrite the report off half the evidence
    expect(openIssues(s)).toHaveLength(1);
    expect(s.store.runs.filter((x) => x.hop === 'reconcile').at(-1)).toMatchObject({ outcome: 'reconcile_partial' });
  });
});

describe('report rendering', () => {
  const f = (kind: DriftFinding['kind'], repo: string, subject: string, detail = 'd'): DriftFinding => ({ kind, repo, subject, detail });

  it('is deterministic and ordered, whatever order the findings arrive in', () => {
    const a = [f('hop_stale_pr', DOWN, '#9'), f('secret_missing', MID, 'B'), f('secret_missing', MID, 'A'), f('variable_error', MID, 'V')];
    expect(renderReport(MID, a)).toBe(renderReport(MID, [...a].reverse()));
    const text = renderReport(MID, a);
    expect(text.indexOf('### Secrets')).toBeLessThan(text.indexOf('### Sync PRs'));
    expect(text.indexOf('`A`')).toBeLessThan(text.indexOf('`B`'));
  });

  it('pluralises and links', () => {
    expect(renderReport(MID, [f('secret_missing', MID, 'A')])).toContain('1 item needs attention');
    expect(renderReport(MID, [{ ...f('hop_conflict', MID, 'x'), url: 'https://example.test/1' }])).toContain('([link](https://example.test/1))');
    expect(renderReport(MID, [f('secret_missing', MID, 'A'), f('secret_missing', MID, 'B')])).toContain('2 items need attention');
  });
});

describe('the scheduler', () => {
  async function discovered(s: ChainScene) {
    return discoverChains({ api: s.discovery, ports: s.deps.ports, store: s.store, logger: nullLogger, now: s.clock.now, allowedOwners: s.deps.allowedOwners });
  }

  it('runs on the first tick, then at most once per reconcile.interval_hours (default 24)', async () => {
    const s = setup();
    const chains = await discovered(s);
    expect(await reconcileAll(s.deps, chains, nullLogger)).toHaveLength(1);

    s.clock.advance(60 * 60_000);
    expect(await reconcileAll(s.deps, chains, nullLogger)).toHaveLength(0); // an hour later: not due
    s.clock.advance(22 * 60 * 60_000);
    expect(await reconcileAll(s.deps, chains, nullLogger)).toHaveLength(0); // 23h: not due
    s.clock.advance(60 * 60_000);
    expect(await reconcileAll(s.deps, chains, nullLogger)).toHaveLength(1); // 24h: due
  });

  it('honours a custom interval, enabled:false, and force', async () => {
    const s = setup(EXTRA + 'reconcile:\n  interval_hours: 2\n');
    const chains = await discovered(s);
    await reconcileAll(s.deps, chains, nullLogger);
    s.clock.advance(2 * 60 * 60_000);
    expect(await reconcileAll(s.deps, chains, nullLogger)).toHaveLength(1);
    expect(await reconcileAll(s.deps, chains, nullLogger)).toHaveLength(0);
    expect(await reconcileAll(s.deps, chains, nullLogger, { force: true })).toHaveLength(1);

    const off = setup(EXTRA + 'reconcile:\n  enabled: false\n');
    expect(await reconcileAll(off.deps, await discovered(off), nullLogger)).toHaveLength(0);
  });

  it('retries sooner after a rate-limited (partial) run instead of waiting a day', async () => {
    const s = setup();
    for (const [repo, name] of [[MID, 'NPM_TOKEN'], [DOWN, 'NPM_TOKEN'], [MID, 'ONLY_MID']] as const) await putSecret(s, repo, name);
    const chains = await discovered(s);
    s.gh.failNext('listActionsSecrets', new RateLimitExceededError('primary', 3_000_000));
    const first = await reconcileAll(s.deps, chains, nullLogger);
    expect(first[0]!.partial).toBe(true);
    s.clock.advance(60 * 60_000);
    expect(await reconcileAll(s.deps, chains, nullLogger)).toHaveLength(1);
  });

  it('never reconciles installations outside ALLOWED_OWNERS', async () => {
    const s = chainScene({
      configYaml: chainYml({ extra: EXTRA }),
      installations: [{ id: 99, login: 'stranger', suspended: false, repos: ['stranger/widget'] }],
    });
    s.gh.createRepo('stranger/widget', { '.github/chain.yml': chainYml({ mid: 'stranger/widget' }) });
    expect(await reconcileAll(s.deps, await discovered(s), nullLogger)).toHaveLength(0);
    expect(s.forInstallationCalls).toEqual([]);
  });
});

describe('POST /admin/reconcile (function)', () => {
  it('previews with dry_run and rejects unknown chains', async () => {
    const s = setup();
    const out = await runAdminReconcile(s.deps, { chain: MID, dryRun: true }, nullLogger);
    expect(out).toMatchObject({ ok: true, result: { chain: MID, report: 'skipped' } });
    expect(s.gh.writes()).toEqual([]);
    expect(await runAdminReconcile(s.deps, { chain: 'stranger/x', dryRun: false }, nullLogger)).toMatchObject({ ok: false, status: 403 });
    expect(await runAdminReconcile(s.deps, { chain: 'me/uninstalled', dryRun: false }, nullLogger)).toMatchObject({ ok: false, status: 404 });
  });
});
