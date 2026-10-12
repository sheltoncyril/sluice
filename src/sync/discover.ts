import { loadChainConfig } from '../config/load';
import { formatIssues } from '../config/parse';
import type { ChainConfig } from '../config/schema';
import type { RepoRef } from '../github/port';
import { fullName, parseRepo } from '../github/port';
import type { PortFactory } from '../github/ports';
import { errorFields } from '../log';
import type { Logger } from '../log';
import { isOwnerAllowed } from '../policy';
import type { Store } from '../store/types';

export interface InstallationInfo {
  id: number;
  login: string;
  suspended: boolean;
}

/** What discovery needs to enumerate installations; the real one wraps the GitHub App. */
export interface DiscoveryApi {
  listInstallations(): Promise<InstallationInfo[]>;
  /** Repos the installation can see, excluding archived/disabled ones. */
  listRepositories(installationId: number): Promise<RepoRef[]>;
}

export interface DiscoveredChain {
  holder: RepoRef;
  installationId: number | null;
  config: ChainConfig;
}

export interface DiscoveryDeps {
  api: DiscoveryApi;
  ports: PortFactory;
  store: Store;
  logger: Logger;
  now: () => Date;
  allowedOwners: ReadonlySet<string>;
  /** Optional explicit list of midstream repos ("owner/name"); skips scanning every repo. */
  onlyRepos?: ReadonlySet<string>;
}

/**
 * Find midstream repos: repos in allowlisted installations that carry a valid .github/chain.yml
 * naming themselves as midstream. Nothing is cached; config is re-read on every scan.
 *
 * Cost per scan: 1 call to list installations, 1 per installation to list repos, 1 per repo to look
 * for chain.yml. Set CHAIN_REPOS to restrict the scan to known midstreams on large accounts.
 */
export async function discoverChains(deps: DiscoveryDeps): Promise<DiscoveredChain[]> {
  const { logger } = deps;
  const found: DiscoveredChain[] = [];

  const consider = async (holder: RepoRef, installationId: number | null, port: Awaited<ReturnType<PortFactory['forInstallation']>>) => {
    try {
      const loaded = await loadChainConfig(port, holder);
      if (loaded.status === 'missing') return;
      if (loaded.status === 'invalid') {
        logger.warn('chain.yml invalid; chain skipped', { repo: fullName(holder), errors: formatIssues(loaded.errors) });
        const at = deps.now().toISOString();
        await deps.store.recordRun({
          startedAt: at,
          finishedAt: at,
          trigger: 'discovery',
          chain: fullName(holder),
          hop: 'config',
          outcome: 'config_invalid',
          detail: { errors: loaded.errors.map((e) => ({ path: e.path, line: e.line, message: e.message })) },
        });
        return;
      }
      found.push({ holder, installationId, config: loaded.config });
    } catch (e) {
      // One unreadable repo must not stop the scan, except rate limits, which the caller handles.
      if ((e as Error)?.name === 'RateLimitExceededError') throw e;
      logger.error('could not read chain.yml', { repo: fullName(holder), ...errorFields(e) });
    }
  };

  if (deps.onlyRepos && deps.onlyRepos.size > 0) {
    for (const name of deps.onlyRepos) {
      const holder = parseRepo(name);
      if (!isOwnerAllowed(deps.allowedOwners, holder.owner)) {
        logger.warn('CHAIN_REPOS entry outside ALLOWED_OWNERS ignored', { repo: name });
        continue;
      }
      const port = await deps.ports.forRepo(holder);
      if (!port) {
        logger.warn('app not installed on configured midstream', { repo: name });
        continue;
      }
      await consider(holder, null, port);
    }
    return found;
  }

  for (const inst of await deps.api.listInstallations()) {
    if (inst.suspended) continue;
    if (!isOwnerAllowed(deps.allowedOwners, inst.login)) {
      logger.debug('installation skipped: not in ALLOWED_OWNERS', { account: inst.login });
      continue;
    }
    const port = await deps.ports.forInstallation(inst.id);
    for (const holder of await deps.api.listRepositories(inst.id)) {
      await consider(holder, inst.id, port);
    }
  }
  return found;
}
