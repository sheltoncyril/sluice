import { fullName } from '../../src/github/port';
import type { PortFactory } from '../../src/github/ports';
import { MemoryStore } from '../../src/store/memory';
import type { ChainDeps } from '../../src/sync/chain';
import type { DiscoveryApi, InstallationInfo } from '../../src/sync/discover';
import { FakeGitHub } from './fake-github';

export const chainYml = (opts: { up?: string; mid?: string; down?: string; extra?: string } = {}) => `version: 1
upstream:   { repo: ${opts.up ?? 'acme/widget'} }
midstream:  { repo: ${opts.mid ?? 'me/widget'} }
downstream: { repo: ${opts.down ?? 'other/deploy'} }
pull_requests:
  labels: [sluice]
  reviewers: [octocat]
  assignees: [octocat]
${opts.extra ?? ''}`;

export interface Clock {
  now: () => Date;
  advance(ms: number): void;
}

export function makeClock(start = '2026-10-12T12:00:00Z'): Clock {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms) => void (t += ms) };
}

export interface InstallationFixture extends InstallationInfo {
  repos: string[];
}

export interface ChainScene {
  gh: FakeGitHub;
  store: MemoryStore;
  clock: Clock;
  deps: ChainDeps;
  discovery: DiscoveryApi;
  /** Calls made to the port factory, to prove no token is minted for strangers. */
  forInstallationCalls: number[];
  forRepoCalls: string[];
  installations: InstallationFixture[];
  installed: Set<string>;
}

/**
 * upstream acme/widget  ->  midstream me/widget (fork, holds chain.yml)  ->  downstream other/deploy (fork, other org)
 */
export function chainScene(
  opts: { configYaml?: string; allowed?: string[]; installed?: string[]; installations?: InstallationFixture[] } = {},
): ChainScene {
  const gh = new FakeGitHub().createRepo('acme/widget', { 'a.txt': '1\n', 'b.txt': '1\n' });
  gh.fork('acme/widget', 'me/widget');
  gh.commit('me/widget', 'main', { '.github/chain.yml': opts.configYaml ?? chainYml() }, 'midstream: add chain.yml');
  gh.fork('me/widget', 'other/deploy');

  const clock = makeClock();
  const store = new MemoryStore();
  const installed = new Set((opts.installed ?? ['me/widget', 'other/deploy']).map((r) => r.toLowerCase()));
  const forInstallationCalls: number[] = [];
  const forRepoCalls: string[] = [];

  const ports: PortFactory = {
    forInstallation: async (id) => (forInstallationCalls.push(id), gh),
    forRepo: async (repo) => {
      forRepoCalls.push(fullName(repo));
      return installed.has(fullName(repo).toLowerCase()) ? gh : null;
    },
  };

  const installations = opts.installations ?? [{ id: 1, login: 'me', suspended: false, repos: ['me/widget'] }];
  const discovery: DiscoveryApi = {
    listInstallations: async () => installations.map(({ id, login, suspended }) => ({ id, login, suspended })),
    listRepositories: async (id) =>
      (installations.find((i) => i.id === id)?.repos ?? []).map((r) => {
        const [owner, repo] = r.split('/') as [string, string];
        return { owner, repo };
      }),
  };

  return {
    gh,
    store,
    clock,
    deps: { ports, store, now: clock.now, allowedOwners: new Set(opts.allowed ?? ['me', 'other']) },
    discovery,
    forInstallationCalls,
    forRepoCalls,
    installations,
    installed,
  };
}
