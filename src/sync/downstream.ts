import { loadChainConfig } from '../config/load';
import { formatIssues } from '../config/parse';
import { CONFIG_PATH } from '../config/schema';
import type { RepoRef } from '../github/port';
import { applyVariables } from '../secrets/variables';
import { errorFields } from '../log';
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
  /** The repo's default branch: chain.yml (and, from step 6, templates) are read from it. */
  defaultBranch?: string;
  /**
   * Paths touched by the push, or null if unknown (GitHub truncates large pushes, so null means
   * "assume anything changed"). Undefined behaves like null.
   */
  changedPaths?: string[] | null;
}

/**
 * Everything a push to a midstream repo can trigger.
 *
 *  - a push to midstream's TRACKED branch syncs midstream -> downstream (a merged PR is also a push, so
 *    one trigger covers both);
 *  - a push to the DEFAULT branch that changes chain.yml applies its `variables:` block. That push is
 *    the merge you reviewed, so "nothing is applied without my merge" still holds.
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

  const handle = { holder: push.repo, config: loaded.config, midstreamPort };

  const touched = push.changedPaths ?? null;
  if (
    push.defaultBranch &&
    push.ref === `refs/heads/${push.defaultBranch}` &&
    (touched === null || touched.includes(CONFIG_PATH))
  ) {
    try {
      await applyVariables(deps, handle, { dryRun: false, trigger: 'webhook:push' }, logger);
    } catch (e) {
      logger.error('applying variables failed', errorFields(e));
    }
  }

  if (push.ref !== `refs/heads/${loaded.config.midstream.branch}`) return null;

  return syncChainHop(
    deps,
    handle,
    'midstream_to_downstream',
    { trigger: 'webhook:push', deliveryId: push.deliveryId },
    logger,
  );
}
