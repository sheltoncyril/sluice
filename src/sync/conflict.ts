import type { GitHubPort, PullRequest, RepoRef } from '../github/port';
import { RateLimitExceededError } from '../github/resilient';
import { errorFields } from '../log';
import type { Logger } from '../log';

/** Hidden marker so the conflict comment is one comment, edited in place, never a stack of them. */
export const CONFLICT_COMMENT_MARKER = '<!-- sluice:conflict -->';

export interface ConflictPolicy {
  label: string;
  comment: boolean;
  /** Who to assign. Already resolved from conflicts.assignees / pull_requests.reviewers / .assignees. */
  assignees: readonly string[];
  requestReview: boolean;
}

export interface MergeabilityPolling {
  /** Reads before giving up (GitHub computes mergeability lazily, so the first read is often `null`). */
  attempts: number;
  /** Linear back-off: wait delayMs, 2*delayMs, ... between reads. */
  delayMs: number;
}

export const DEFAULT_POLLING: MergeabilityPolling = { attempts: 5, delayMs: 1500 };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Ask GitHub whether the PR can be merged. `true`/`false` are answers; `null` means GitHub was still
 * computing after every attempt (the next run asks again).
 */
export async function awaitMergeable(
  port: GitHubPort,
  repo: RepoRef,
  pullNumber: number,
  polling: MergeabilityPolling = DEFAULT_POLLING,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<boolean | null> {
  for (let attempt = 1; attempt <= polling.attempts; attempt++) {
    const { mergeable } = await port.getMergeability(repo, pullNumber);
    if (mergeable !== null) return mergeable;
    if (attempt < polling.attempts) await sleep(polling.delayMs * attempt);
  }
  return null;
}

export interface ConflictContext {
  repo: RepoRef;
  pr: Pick<PullRequest, 'number' | 'labels'>;
  policy: ConflictPolicy;
  syncBranch: string;
  targetBranch: string;
  sourceName: string;
  logger: Logger;
}

export type ConflictAction = 'flagged' | 'cleared' | 'unchanged';

export function conflictCommentBody(c: Pick<ConflictContext, 'syncBranch' | 'targetBranch' | 'sourceName'>): string {
  return [
    CONFLICT_COMMENT_MARKER,
    '### ⚠️ Merge conflict',
    '',
    `\`${c.syncBranch}\` cannot be merged into \`${c.targetBranch}\` automatically: ${c.sourceName} and \`${c.targetBranch}\` changed the same lines.`,
    '',
    `To resolve it, check out \`${c.syncBranch}\`, merge \`${c.targetBranch}\` into it (or use GitHub's conflict editor), fix the conflicts and push. ` +
      `sluice never overwrites commits you push to that branch.`,
    '',
    'If upstream keeps overwriting something that is yours alone, list it under `protected_paths` in `.github/chain.yml`.',
  ].join('\n');
}

export function conflictResolvedBody(c: Pick<ConflictContext, 'syncBranch' | 'targetBranch'>): string {
  return [
    CONFLICT_COMMENT_MARKER,
    '### ✅ Conflict resolved',
    '',
    `\`${c.syncBranch}\` can be merged into \`${c.targetBranch}\` cleanly again.`,
  ].join('\n');
}

/**
 * Bring the PR's conflict markers in line with GitHub's answer.
 *
 * The conflict label is the "already flagged" state, so each transition acts exactly once and a steady
 * state (still conflicting, or still clean) performs no writes:
 *   conflicted, no label  -> label, comment, assign, request review
 *   clean, has label      -> remove label, mark the comment resolved
 * Labelling comes first so a half-failed attempt is not repeated in full next run. Everything past the
 * label is a convenience: a login GitHub rejects must not fail the sync.
 */
export async function reconcileConflict(port: GitHubPort, ctx: ConflictContext, conflicted: boolean): Promise<ConflictAction> {
  const { repo, pr, policy, logger } = ctx;
  const hasLabel = pr.labels.includes(policy.label);

  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof RateLimitExceededError) throw e;
      logger.warn(`could not ${what} for conflicted sync PR`, { pr: pr.number, ...errorFields(e) });
    }
  };

  if (conflicted && !hasLabel) {
    await port.addLabels(repo, pr.number, [policy.label]);
    if (policy.comment) {
      await attempt('comment', async () => {
        const existing = await port.findCommentByMarker(repo, pr.number, CONFLICT_COMMENT_MARKER);
        const body = conflictCommentBody(ctx);
        if (!existing) await port.createComment(repo, pr.number, body);
        else if (existing.body.trim() !== body.trim()) await port.updateComment(repo, existing.id, body);
      });
    }
    const who = [...policy.assignees];
    if (who.length > 0) {
      await attempt('assign', () => port.addAssignees(repo, pr.number, who));
      if (policy.requestReview) await attempt('request review', () => port.requestReviewers(repo, pr.number, who, []));
    }
    logger.info('flagged conflicted sync PR', { pr: pr.number });
    return 'flagged';
  }

  if (!conflicted && hasLabel) {
    await port.removeLabel(repo, pr.number, policy.label);
    if (policy.comment) {
      await attempt('update comment', async () => {
        const existing = await port.findCommentByMarker(repo, pr.number, CONFLICT_COMMENT_MARKER);
        const body = conflictResolvedBody(ctx);
        if (existing && existing.body.trim() !== body.trim()) await port.updateComment(repo, existing.id, body);
      });
    }
    logger.info('conflict on sync PR resolved', { pr: pr.number });
    return 'cleared';
  }

  return 'unchanged';
}
