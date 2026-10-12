import { loadChainConfig } from '../config/load';
import { formatIssues } from '../config/parse';
import type { RepoRef } from '../github/port';
import { fullName } from '../github/port';
import type { Logger } from '../log';
import { isOwnerAllowed } from '../policy';
import { syncChainHop } from './chain';
import type { ChainDeps } from './chain';
import type { HopResult } from './hop';

export interface PushInput {
  deliveryId: string;
  installationId: number;
  repo: RepoRef;
  /** Full ref, e.g. refs/heads/main. */
  ref: string;
  deleted: boolean;
}

/**
 * midstream -> downstream, driven by a push to midstream.
 *
 * A merged PR is also a push, so this one trigger covers "a merged PR / push on midstream's branch".
 * Returns null when the push is irrelevant (not a midstream repo, other branch, branch deletion).
 */
export async function syncDownstreamOnPush(deps: ChainDeps, push: PushInput, logger: Logger): Promise<HopResult | null> {
  if (push.deleted || !isOwnerAllowed(deps.allowedOwners, push.repo.owner)) return null;
  if (!push.ref.startsWith('refs/heads/')) return null;

  const midstreamPort = await deps.ports.forInstallation(push.installationId);
  const loaded = await loadChainConfig(midstreamPort, push.repo);

  if (loaded.status === 'missing') return null; // not a midstream: nothing to do
  if (loaded.status === 'invalid') {
    logger.warn('push ignored: chain.yml is invalid', { repo: fullName(push.repo), errors: formatIssues(loaded.errors) });
    const at = deps.now().toISOString();
    await deps.store.recordRun({
      startedAt: at,
      finishedAt: at,
      trigger: 'webhook:push',
      deliveryId: push.deliveryId,
      chain: fullName(push.repo),
      hop: 'config',
      outcome: 'config_invalid',
      detail: { errors: loaded.errors.map((e) => ({ path: e.path, line: e.line, message: e.message })) },
    });
    return null;
  }

  if (push.ref !== `refs/heads/${loaded.config.midstream.branch}`) return null;

  return syncChainHop(
    deps,
    { holder: push.repo, config: loaded.config, midstreamPort },
    'midstream_to_downstream',
    { trigger: 'webhook:push', deliveryId: push.deliveryId },
    logger,
  );
}
