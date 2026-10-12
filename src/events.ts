import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { validateConfigOnPullRequest } from './config/validate-pr';
import type { WebhookEvent } from './context';
import type { Logger } from './log';
import { isOwnerAllowed } from './policy';
import type { ChainDeps } from './sync/chain';
import { syncDownstreamOnPush } from './sync/downstream';

export type EventHandlerDeps = ChainDeps;

const PR_ACTIONS_THAT_CHANGE_CONTENT = new Set(['opened', 'reopened', 'synchronize', 'edited']);

/**
 * Route verified webhooks. Every branch begins with the owner allowlist: signature verification
 * proves the event came from GitHub, not that we should act on that account's repos.
 */
export function createEventHandler(deps: EventHandlerDeps) {
  return async function handleEvent(event: WebhookEvent, logger: Logger): Promise<void> {
    switch (event.name) {
      case 'pull_request':
        return onPullRequest(deps, event.payload as EmitterWebhookEvent<'pull_request'>['payload'], logger);
      case 'push':
        return onPush(deps, event.id, event.payload as EmitterWebhookEvent<'push'>['payload'], logger);
      case 'installation':
      case 'installation_repositories':
        return onInstallation(
          deps,
          event.name,
          event.payload as EmitterWebhookEvent<'installation'>['payload'],
          logger,
        );
      default:
        logger.debug('event ignored', { name: event.name });
    }
  };
}

async function onPullRequest(
  deps: EventHandlerDeps,
  payload: EmitterWebhookEvent<'pull_request'>['payload'],
  logger: Logger,
): Promise<void> {
  const repo = { owner: payload.repository.owner.login, repo: payload.repository.name };
  if (!isOwnerAllowed(deps.allowedOwners, repo.owner)) {
    logger.debug('pull_request ignored: owner not allowlisted', { owner: repo.owner });
    return;
  }
  if (!PR_ACTIONS_THAT_CHANGE_CONTENT.has(payload.action)) return;

  const installationId = (payload as { installation?: { id: number } }).installation?.id;
  if (!installationId) return;

  // chain.yml is read from the default branch, so only PRs targeting it can change what is in force.
  if (payload.pull_request.base.ref !== payload.repository.default_branch) return;

  const port = await deps.ports.forInstallation(installationId);
  const outcome = await validateConfigOnPullRequest(
    port,
    deps.store,
    { repo, pullNumber: payload.pull_request.number, headSha: payload.pull_request.head.sha },
    logger,
    deps.now,
  );
  logger.info('pull_request processed', { repo: `${repo.owner}/${repo.repo}`, pr: payload.pull_request.number, outcome });
}

async function onPush(
  deps: EventHandlerDeps,
  deliveryId: string,
  payload: EmitterWebhookEvent<'push'>['payload'],
  logger: Logger,
): Promise<void> {
  const repoOwner = payload.repository.owner as { login?: string; name?: string } | null;
  const owner = repoOwner?.login ?? repoOwner?.name;
  if (!owner || !isOwnerAllowed(deps.allowedOwners, owner)) {
    logger.debug('push ignored: owner not allowlisted', { owner });
    return;
  }
  const installationId = (payload as { installation?: { id: number } }).installation?.id;
  if (!installationId) return;

  const result = await syncDownstreamOnPush(
    deps,
    { deliveryId, installationId, repo: { owner, repo: payload.repository.name }, ref: payload.ref, deleted: payload.deleted },
    logger,
  );
  if (result) logger.info('push processed', { chain: result.chain, hop: result.hop, outcome: result.outcome, pr: result.prNumber });
}

async function onInstallation(
  deps: EventHandlerDeps,
  name: string,
  payload: EmitterWebhookEvent<'installation'>['payload'],
  logger: Logger,
): Promise<void> {
  const login = payload.installation.account && 'login' in payload.installation.account ? payload.installation.account.login : undefined;
  if (!isOwnerAllowed(deps.allowedOwners, login)) {
    // A stranger installed the (public) app. We will ignore everything from them; flag it.
    logger.warn('installation from account outside ALLOWED_OWNERS (ignored)', { event: name, action: payload.action, account: login });
    return;
  }
  logger.info('installation event', { event: name, action: payload.action, account: login, installation: payload.installation.id });
}
