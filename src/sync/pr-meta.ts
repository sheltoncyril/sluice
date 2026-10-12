import type { GitHubPort, RepoRef } from '../github/port';
import { RateLimitExceededError } from '../github/resilient';
import { errorFields } from '../log';
import type { Logger } from '../log';

export interface PrMeta {
  labels: readonly string[];
  assignees: readonly string[];
  reviewers: readonly string[];
  teamReviewers: readonly string[];
  draft: boolean;
}

/** Labels / assignees / reviewers are conveniences: a bad login must not fail the sync. */
export async function decoratePullRequest(
  port: GitHubPort,
  repo: RepoRef,
  pr: number,
  meta: PrMeta,
  logger: Logger,
): Promise<void> {
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof RateLimitExceededError) throw e;
      logger.warn(`could not set ${what} on sluice PR`, { pr, ...errorFields(e) });
    }
  };
  await attempt('labels', () => port.addLabels(repo, pr, [...meta.labels]));
  await attempt('assignees', () => port.addAssignees(repo, pr, [...meta.assignees]));
  await attempt('reviewers', () => port.requestReviewers(repo, pr, [...meta.reviewers], [...meta.teamReviewers]));
}
