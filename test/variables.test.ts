import { describe, expect, it } from 'vitest';
import { nullLogger } from '../src/log';
import { applyVariables } from '../src/secrets/variables';
import { loadChainConfig } from '../src/config/load';
import { runAdminVariables } from '../src/sync/admin';
import { syncDownstreamOnPush } from '../src/sync/downstream';
import { chainScene, chainYml } from './helpers/chain-scene';
import type { ChainScene } from './helpers/chain-scene';

const MID = 'me/widget';
const DOWN = 'other/deploy';
const midRef = { owner: 'me', repo: 'widget' };
const VARS =
  'variables:\n  - name: REGION\n    value: eu-west-1\n  - name: ONLY_DOWN\n    value: "yes"\n    targets: [downstream]\n  - name: ONLY_MID\n    value: m\n    targets: [midstream]\n';

async function handleOf(s: ChainScene) {
  const loaded = await loadChainConfig(s.gh, midRef);
  if (loaded.status !== 'ok') throw new Error('config should load');
  return { holder: midRef, config: loaded.config, midstreamPort: s.gh };
}
const apply = async (s: ChainScene, dryRun = false) =>
  applyVariables(s.deps, await handleOf(s), { dryRun, trigger: 'test' }, nullLogger);

describe('variables', () => {
  it('creates what is missing, per declared target', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: VARS }) });
    const r = await apply(s);
    expect(r.drifted).toBe(true);
    expect(s.gh.variablesOf(MID)).toEqual({ REGION: 'eu-west-1', ONLY_MID: 'm' });
    expect(s.gh.variablesOf(DOWN)).toEqual({ REGION: 'eu-west-1', ONLY_DOWN: 'yes' });
  });

  it('updates a value that differs and leaves a matching one untouched', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: VARS }) });
    await apply(s);
    await s.gh.updateActionsVariable(midRef, 'REGION', 'us-east-1'); // someone changed it by hand
    s.gh.resetCalls();
    const r = await apply(s);
    expect(r.changes.filter((c) => c.action !== 'unchanged').map((c) => [c.repo, c.name, c.action])).toEqual([[MID, 'REGION', 'updated']]);
    expect(s.gh.writes().map((w) => w.op)).toEqual(['updateActionsVariable']);
    expect(s.gh.variablesOf(MID).REGION).toBe('eu-west-1');
  });

  it('is idempotent: once matching, a run performs ZERO writes', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: VARS }) });
    await apply(s);
    s.gh.resetCalls();
    const r = await apply(s);
    expect(r.drifted).toBe(false);
    expect(s.gh.writes()).toEqual([]);
  });

  it('only touches DECLARED names; other variables in the repo are left alone', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: VARS }) });
    await s.gh.createActionsVariable(midRef, 'SOMEONE_ELSES', 'keep me');
    await apply(s);
    expect(s.gh.variablesOf(MID).SOMEONE_ELSES).toBe('keep me');
  });

  it('a dry run reports the drift and writes nothing', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: VARS }) });
    const r = await apply(s, true);
    expect(r.drifted).toBe(true);
    expect(r.changes.map((c) => c.action)).toContain('created');
    expect(s.gh.writes()).toEqual([]);
    expect(s.store.runs).toHaveLength(0);
  });

  it('refuses a downstream owner outside ALLOWED_OWNERS but still applies midstream', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: VARS }), allowed: ['me'] });
    const r = await apply(s);
    expect(r.changes.filter((c) => c.target === 'downstream').every((c) => c.action === 'error')).toBe(true);
    expect(s.gh.variablesOf(MID).REGION).toBe('eu-west-1');
    expect(s.gh.variablesOf(DOWN)).toEqual({});
  });

  it('a failure on one repo does not stop the other', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: VARS }) });
    s.gh.failNext('listActionsVariables', new Error('boom'));
    const r = await apply(s);
    expect(r.changes.some((c) => c.repo === MID && c.action === 'error')).toBe(true);
    expect(s.gh.variablesOf(DOWN).REGION).toBe('eu-west-1');
  });

  it('logs names and actions, not values', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: 'variables:\n  - name: REGION\n    value: very-specific-value-9\n' }) });
    await apply(s);
    expect(JSON.stringify(s.store.runs)).not.toContain('very-specific-value-9');
    expect(s.store.runs.at(-1)).toMatchObject({ hop: 'variables', outcome: 'variables_applied' });
  });

  it('does nothing (and makes no calls) when no variables are declared', async () => {
    const s = chainScene();
    const r = await apply(s);
    expect(r.changes).toEqual([]);
    expect(s.gh.calls.filter((c) => c.op === 'listActionsVariables')).toHaveLength(0);
  });

  it('admin: reports errors for an unknown chain and applies a known one', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: VARS }) });
    expect(await runAdminVariables(s.deps, { chain: 'stranger/x', dryRun: false }, nullLogger)).toMatchObject({ ok: false, status: 403 });
    expect(await runAdminVariables(s.deps, { chain: MID, dryRun: false }, nullLogger)).toMatchObject({ ok: true });
  });
});

describe('variables: applied when a merged push changes chain.yml', () => {
  const push = (s: ChainScene, over: Partial<Parameters<typeof syncDownstreamOnPush>[1]> = {}) =>
    syncDownstreamOnPush(
      s.deps,
      { deliveryId: 'd', installationId: 1, repo: midRef, ref: 'refs/heads/main', deleted: false, defaultBranch: 'main', changedPaths: ['.github/chain.yml'], ...over },
      nullLogger,
    );
  const listed = (s: ChainScene) => s.gh.calls.filter((c) => c.op === 'listActionsVariables').length;

  it('applies on a default-branch push that touched chain.yml', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: VARS }) });
    await push(s);
    expect(s.gh.variablesOf(MID).REGION).toBe('eu-west-1');
  });

  it('applies when the changed paths are unknown (GitHub truncates big pushes)', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: VARS }) });
    await push(s, { changedPaths: null });
    expect(s.gh.variablesOf(MID).REGION).toBe('eu-west-1');
  });

  it('does NOT run for pushes that did not touch chain.yml, or that are not on the default branch', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: VARS }) });
    await push(s, { changedPaths: ['src/app.ts'] });
    await push(s, { ref: 'refs/heads/feature', defaultBranch: 'main' });
    expect(listed(s)).toBe(0);
  });

  it('does not apply a chain.yml that is invalid', async () => {
    const s = chainScene({ configYaml: chainYml({ extra: 'variables:\n  - name: lower\n    value: x\n' }) });
    await push(s);
    expect(listed(s)).toBe(0);
  });
});
