import { describe, expect, it } from 'vitest';
import { RateLimitExceededError } from '../src/github/resilient';
import { createLogger, nullLogger } from '../src/log';
import { CONFIG_INVALID_MARKER, DRIFT_MARKER, renderConfigReport } from '../src/reconcile/report';
import { reconcileAll } from '../src/reconcile/schedule';
import { discoverChains } from '../src/sync/discover';
import type { DiscoveredChain } from '../src/sync/discover';
import { syncDownstreamOnPush } from '../src/sync/downstream';
import { chainScene, chainYml } from './helpers/chain-scene';
import type { ChainScene } from './helpers/chain-scene';
import type { Logger } from '../src/log';

const MID = 'me/widget';
const midRef = { owner: 'me', repo: 'widget' };
const CANARY = 'xK9-CANARY-7f3a-not-a-token';

/** The way a GitHub App without the Issues permission is refused. */
const forbidden = () => Object.assign(new Error('Resource not accessible by integration'), { status: 403 });

const BROKEN = chainYml({ extra: 'variabless: []\n' });
const FIXED = chainYml();

const scan = (s: ChainScene, logger: Logger = nullLogger): Promise<DiscoveredChain[]> =>
  discoverChains({ api: s.discovery, ports: s.deps.ports, store: s.store, logger, now: s.clock.now, allowedOwners: s.deps.allowedOwners });

const issues = (s: ChainScene) => s.gh.issues(MID);
const open = (s: ChainScene) => issues(s).filter((i) => i.state === 'open');
const setConfig = (s: ChainScene, text: string) => s.gh.commit(MID, 'main', { '.github/chain.yml': text }, 'edit chain.yml');
const issueCalls = (s: ChainScene) => s.gh.calls.filter((c) => /Issue/.test(c.op));

const push = (s: ChainScene, over: Partial<Parameters<typeof syncDownstreamOnPush>[1]> = {}, logger: Logger = nullLogger) =>
  syncDownstreamOnPush(
    s.deps,
    {
      deliveryId: 'dlv-1',
      installationId: 1,
      repo: midRef,
      ref: 'refs/heads/main',
      deleted: false,
      defaultBranch: 'main',
      changedPaths: ['.github/chain.yml'],
      ...over,
    },
    logger,
  );

describe('an invalid chain.yml found by the scheduled scan', () => {
  it('opens one issue with the errors, their positions and the did-you-mean', async () => {
    const s = chainScene({ configYaml: BROKEN });
    expect(await scan(s)).toEqual([]); // the chain is still skipped

    expect(open(s)).toHaveLength(1);
    const issue = open(s)[0]!;
    expect(issue.labels.has('sluice/drift')).toBe(true);
    expect(issue.body).toContain(DRIFT_MARKER);
    expect(issue.body).toContain(CONFIG_INVALID_MARKER);
    expect(issue.body).toContain('.github/chain.yml:9:1'); // the file is 8 lines before `variabless`
    expect(issue.body).toContain('variabless');
    expect(issue.body).toContain('did you mean "variables"');
    expect(issue.body).toMatch(/paused/);

    expect(s.gh.calls.find((c) => c.op === 'addAssignees')?.detail).toMatchObject({ logins: ['octocat'] });
    expect(s.store.runs.at(-1)).toMatchObject({ outcome: 'config_invalid', hop: 'config', detail: { report: 'created' } });
  });

  it('is quiet while nothing changes: the second scan reads, and writes nothing', async () => {
    const s = chainScene({ configYaml: BROKEN });
    await scan(s);
    s.gh.resetCalls();
    await scan(s);
    await scan(s);
    expect(s.gh.writes()).toEqual([]);
    expect(open(s)).toHaveLength(1);
    expect(s.store.runs.at(-1)).toMatchObject({ outcome: 'config_invalid', detail: { report: 'unchanged' } });
  });

  it('edits the same issue in place when the errors change', async () => {
    const s = chainScene({ configYaml: BROKEN });
    await scan(s);
    const first = open(s)[0]!;
    setConfig(s, chainYml({ extra: 'variabless: []\npull_request: {}\n' }));
    await scan(s);

    expect(issues(s)).toHaveLength(1);
    expect(open(s)[0]!.number).toBe(first.number);
    expect(open(s)[0]!.body).toContain('did you mean "pull_requests"');
    expect(s.store.runs.at(-1)).toMatchObject({ detail: { report: 'updated' } });
  });

  it('closes the issue with a comment once the file is valid, and the chain is back in service', async () => {
    const s = chainScene({ configYaml: BROKEN });
    await scan(s);
    setConfig(s, FIXED);

    const chains = await scan(s);
    expect(chains.map((c) => c.holder)).toEqual([midRef]);
    expect(open(s)).toHaveLength(0);
    expect(issues(s)[0]!.state).toBe('closed');
    expect(s.gh.comments(MID, issues(s)[0]!.number).join('\n')).toMatch(/valid again/);

    s.gh.resetCalls();
    await scan(s); // and it stays that way: a read, no writes
    expect(s.gh.writes()).toEqual([]);
  });

  it('makes the reconcile due again, so drift is restored in the same tick rather than a day later', async () => {
    const extra = 'secrets:\n  - name: NPM_TOKEN\n';
    const s = chainScene({ configYaml: chainYml({ extra }) });

    // A settled chain: the reconcile has run today and found one drift (a declared secret is missing).
    let chains = await scan(s);
    await reconcileAll(s.deps, chains, nullLogger);
    expect(open(s).map((i) => i.body)).toEqual([expect.stringContaining('NPM_TOKEN')]);

    // Someone breaks the file: the drift report is replaced by the config report.
    setConfig(s, chainYml({ extra: `${extra}variabless: []\n` }));
    s.clock.advance(60 * 60_000);
    await scan(s);
    expect(open(s)).toHaveLength(1);
    expect(open(s)[0]!.body).toContain(CONFIG_INVALID_MARKER);
    expect(open(s)[0]!.body).not.toContain('NPM_TOKEN');

    // They fix it. One hour later the scan closes that report and the (otherwise not yet due) reconcile
    // runs straight away and files the drift again.
    setConfig(s, chainYml({ extra }));
    s.clock.advance(60 * 60_000);
    chains = await scan(s);
    expect(await reconcileAll(s.deps, chains, nullLogger)).toHaveLength(1);
    expect(open(s)).toHaveLength(1);
    expect(open(s)[0]!.body).toContain('NPM_TOKEN');
    expect(open(s)[0]!.body).not.toContain(CONFIG_INVALID_MARKER);
  });

  it('never closes a drift report: that is for a reconcile to judge', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: 'secrets:\n  - name: NPM_TOKEN\n' }) });
    const chains = await scan(s);
    await reconcileAll(s.deps, chains, nullLogger);
    expect(open(s)).toHaveLength(1);

    s.gh.resetCalls();
    await scan(s);
    expect(open(s)).toHaveLength(1);
    expect(s.gh.writes()).toEqual([]);
  });

  it('reports a file that is not YAML at all (nothing can opt out of that)', async () => {
    const s = chainScene({ configYaml: 'version: 1\nupstream: [unclosed\n' });
    await scan(s);
    expect(open(s)).toHaveLength(1);
    expect(open(s)[0]!.body).toContain('YAML syntax');
    expect(open(s)[0]!.labels.has('sluice/drift')).toBe(true);
  });

  it('honours reconcile.report: none in the broken file: no issue, and no issue API call at all', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: 'reconcile:\n  report: none\nvariabless: []\n' }) });
    await scan(s);
    expect(issues(s)).toEqual([]);
    expect(issueCalls(s)).toEqual([]);
    expect(s.store.runs.at(-1)).toMatchObject({ outcome: 'config_invalid', detail: { report: 'none' } }); // still in the run log
  });

  it('does not take reconcile.enabled: false as an opt-out', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: 'reconcile:\n  enabled: false\nvariabless: []\n' }) });
    await scan(s);
    expect(open(s)).toHaveLength(1);
  });

  it('files it under the label the broken file asked for', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: 'reconcile:\n  issue_label: ops/drift\nvariabless: []\n' }) });
    await scan(s);
    expect(open(s)[0]!.labels.has('ops/drift')).toBe(true);

    setConfig(s, chainYml({ extra: 'reconcile:\n  issue_label: ops/drift\n' }));
    await scan(s);
    expect(open(s)).toHaveLength(0); // closed under that same label
  });

  it('lists at most 20 errors and says how many more', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `unknown_${i}: 1`).join('\n');
    const s = chainScene({ configYaml: chainYml({ extra: `${many}\n` }) });
    await scan(s);
    expect(open(s)[0]!.body).toContain('… and 10 more');
  });

  describe('without the Issues permission', () => {
    it('does not crash, records what happened, and keeps scanning other chains', async () => {
      const s = chainScene({
        configYaml: BROKEN,
        installed: ['me/widget', 'me/gadget', 'other/deploy'],
        installations: [{ id: 1, login: 'me', suspended: false, repos: ['me/widget', 'me/gadget'] }],
      });
      s.gh.createRepo('acme/gadget', { 'g.txt': '1\n' });
      s.gh.fork('acme/gadget', 'me/gadget');
      s.gh.commit('me/gadget', 'main', { '.github/chain.yml': chainYml({ up: 'acme/gadget', mid: 'me/gadget', down: 'other/gadget-deploy' }) });
      s.gh.failNext('findOpenIssueByLabelMarker', forbidden());

      const chains = await scan(s);
      expect(chains.map((c) => c.holder.repo)).toEqual(['gadget']);
      expect(s.store.runs.find((r) => r.outcome === 'config_invalid')).toMatchObject({
        chain: MID,
        detail: { report: 'failed', reportError: expect.stringContaining('Issues') },
      });
      expect(issues(s)).toEqual([]);
    });

    it('a refused create is the same: no crash, an outcome', async () => {
      const s = chainScene({ configYaml: BROKEN });
      s.gh.failNext('createIssue', forbidden());
      await expect(scan(s)).resolves.toEqual([]);
      expect(s.store.runs.at(-1)).toMatchObject({ detail: { report: 'failed' } });
    });

    it('is quiet on healthy chains: failing to look for a stale report is a debug line, not a warning', async () => {
      const lines: string[] = [];
      const logger = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
      const s = chainScene();
      s.gh.failNext('findOpenIssueByLabelMarker', forbidden());
      const chains = await scan(s, logger);
      expect(chains).toHaveLength(1); // the chain still runs
      const records = lines.map((l) => JSON.parse(l) as { level: string; msg: string });
      expect(records.filter((r) => r.level === 'warn' || r.level === 'error')).toEqual([]);
      expect(records.some((r) => r.level === 'debug' && /stale invalid-config report/.test(r.msg))).toBe(true);
    });

    it('logs one warning per attempt for a config it cannot report', async () => {
      const lines: string[] = [];
      const s = chainScene({ configYaml: BROKEN });
      s.gh.failNext('createIssue', forbidden());
      await scan(s, createLogger({ level: 'debug', sink: (l) => lines.push(l) }));
      const warns = lines.map((l) => JSON.parse(l) as { level: string; msg: string }).filter((r) => r.level === 'warn');
      expect(warns.map((w) => w.msg)).toEqual(['chain.yml invalid; chain skipped', 'could not report the invalid chain.yml']);
    });
  });

  it('lets a rate limit stop the scan, as it does for every other read', async () => {
    const s = chainScene({ configYaml: BROKEN });
    s.gh.failNext('findOpenIssueByLabelMarker', new RateLimitExceededError('primary', 3_000_000));
    await expect(scan(s)).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(s.store.runs.at(-1)).toMatchObject({ outcome: 'config_invalid' }); // the row is still written
  });
});

describe('an invalid chain.yml found by a push', () => {
  it('reports at once when the default branch changed chain.yml', async () => {
    const s = chainScene({ configYaml: BROKEN });
    expect(await push(s)).toBeNull();
    expect(open(s)).toHaveLength(1);
    expect(s.store.runs.at(-1)).toMatchObject({ trigger: 'webhook:push', outcome: 'config_invalid', detail: { report: 'created' } });
  });

  it('also reports when the changed paths are unknown (GitHub truncates big pushes)', async () => {
    const s = chainScene({ configYaml: BROKEN });
    await push(s, { changedPaths: null });
    expect(open(s)).toHaveLength(1);
  });

  it('does not look at issues for a push that cannot have changed the file', async () => {
    const s = chainScene({ configYaml: BROKEN });
    await push(s, { changedPaths: ['src/app.ts'] });
    await push(s, { ref: 'refs/heads/feature' });
    await push(s, { defaultBranch: undefined });
    expect(issueCalls(s)).toEqual([]);
    expect(s.store.runs.filter((r) => r.outcome === 'config_invalid')).toHaveLength(3); // still logged
  });

  it('is idempotent across repeated pushes', async () => {
    const s = chainScene({ configYaml: BROKEN });
    await push(s);
    s.gh.resetCalls();
    await push(s, { deliveryId: 'dlv-2' });
    expect(s.gh.writes()).toEqual([]);
  });

  it('closes the report when the push that fixes the file lands, with no wait for the next scan', async () => {
    const s = chainScene({ configYaml: BROKEN });
    await push(s);
    setConfig(s, FIXED);
    await push(s, { deliveryId: 'dlv-2' });
    expect(open(s)).toHaveLength(0);
    expect(issues(s)[0]!.state).toBe('closed');
  });

  it('does not read issues on ordinary pushes to a healthy chain', async () => {
    const s = chainScene();
    await push(s, { changedPaths: ['src/app.ts'] });
    expect(issueCalls(s)).toEqual([]);
  });

  it('does not crash the push handler without the Issues permission', async () => {
    const s = chainScene({ configYaml: BROKEN });
    s.gh.failNext('findOpenIssueByLabelMarker', forbidden());
    await expect(push(s)).resolves.toBeNull();
    expect(s.store.runs.at(-1)).toMatchObject({ detail: { report: 'failed' } });
  });
});

describe('what the report may contain', () => {
  it('has no trace of values typed into the wrong place, in the issue, the run log, the comments or the logs', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
    const config = chainYml({
      extra: [
        'secrets:',
        '  - name: NPM_TOKEN',
        `    value: ${CANARY}`, // a value where only a name may go
        `    ${CANARY}-key: 1`, // a value used as a key
        'workflows:',
        '  values:',
        `    "${CANARY}-var": x`, // a bad template variable name
        `    ok: *${CANARY}-alias`, // an alias that does not exist
        'hops:',
        '  midstream_to_downstream:',
        `    sync_branch: "${CANARY} branch"`,
        `    merge_method: ${CANARY}`,
        '',
      ].join('\n'),
    });
    const s = chainScene({ configYaml: config });

    await scan(s, logger);
    await push(s, {}, logger);

    const seen = JSON.stringify({
      issues: issues(s),
      comments: s.gh.comments(MID, issues(s)[0]?.number ?? 0),
      runs: s.store.runs,
      logs: lines,
      calls: s.gh.calls,
    });
    expect(issues(s)).toHaveLength(1);
    expect(seen).not.toContain(CANARY);
  });

  it('renders deterministically', () => {
    const errors = [
      { severity: 'error' as const, path: 'a', message: 'm', line: 3, column: 1 },
      { severity: 'error' as const, path: '', message: 'file', },
    ];
    expect(renderConfigReport(MID, errors)).toBe(renderConfigReport(MID, [...errors]));
    expect(renderConfigReport(MID, errors)).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no timestamps, so no churn
  });
});
