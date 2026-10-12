import type { HopId, MergeMethod } from '../config/schema';
import { NoCommitsBetweenError } from '../github/errors';
import { guardBotBranches, isBotBranch } from '../github/guard';
import type { CompareResult, GitHubPort, PullRequest, RepoRef } from '../github/port';
import { fullName } from '../github/port';
import { RateLimitExceededError } from '../github/resilient';
import { errorFields, scrubString } from '../log';
import type { Logger } from '../log';
import type { Store } from '../store/types';
import { awaitMergeable, reconcileConflict } from './conflict';
import type { ConflictPolicy, MergeabilityPolling } from './conflict';
import { parseMarker } from './marker';
import { renderSyncPrBody, renderSyncPrTitle } from './pr-body';
import { createRestoreCommit, planProtection } from './protect';

/**
 * One hop of the chain: make sure the TARGET repo has an up-to-date sync PR carrying the SOURCE
 * branch, without ever writing to a tracked branch.
 *
 * Idempotency is structural, not bookkeeping. Every step is either a read, or a write whose
 * "already done" outcome GitHub reports and we accept:
 *   branch exists          -> createBranch returns 'exists'
 *   branch has the source  -> compare says aheadBy === 0, we skip the merge
 *   PR already open        -> findOpenPullRequest returns it / create returns created:false
 *   nothing to merge       -> Merges API answers 204
 * so two overlapping runs (cron + webhook) converge on the same single branch and PR.
 */

export interface HopSpec {
  id: HopId;
  /** The midstream repo that owns chain.yml; used as the log key. */
  chain: string;
  source: { repo: RepoRef; branch: string };
  target: { repo: RepoRef; branch: string };
  /** Bot-owned branch in the target repo (always under chain/). */
  syncBranch: string;
  mergeMethod: MergeMethod;
  /** Globs whose target content must survive the sync (see protect.ts). */
  protectedPaths: readonly string[];
  pr: {
    labels: readonly string[];
    assignees: readonly string[];
    reviewers: readonly string[];
    teamReviewers: readonly string[];
    draft: boolean;
  };
  /** What to do when GitHub says the sync PR cannot be merged cleanly. */
  conflicts: ConflictPolicy;
}

export interface HopDeps {
  /** Reads the source tip. For upstream this is an installation of midstream reading a public repo. */
  sourcePort: GitHubPort;
  /** Installation that covers the TARGET repo: every write happens through this one. */
  targetPort: GitHubPort;
  store: Store;
  logger: Logger;
  now: () => Date;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** How hard to poll GitHub's lazily computed `mergeable`. */
  polling?: MergeabilityPolling;
}

export interface HopOptions {
  trigger: string;
  deliveryId?: string;
  /** Analyse and report what would happen; write nothing (also skips the run log). */
  dryRun?: boolean;
}

export type HopOutcome =
  | 'up_to_date'
  | 'pr_opened'
  | 'pr_updated'
  | 'pr_unchanged'
  | 'stale_pr_closed'
  | 'skipped_rejected'
  | 'conflict'
  | 'rate_limited'
  | 'error'
  | 'dry_run';

export type PlannedAction = 'none' | 'open_pr' | 'update_pr' | 'close_stale_pr' | 'skip_rejected';

export interface HopPlan {
  action: PlannedAction;
  pending: boolean;
  mergeMethod: MergeMethod;
  /** Source commits the target does not have (by ancestry). */
  aheadBy: number;
  /** Target commits the source does not have. */
  behindBy: number;
  existingPr?: number;
  /** Protected paths whose target content would be kept in place of the source's. */
  protectedPaths?: string[];
}

export interface HopResult {
  hop: HopId;
  chain: string;
  outcome: HopOutcome;
  sourceSha?: string;
  targetSha?: string;
  prNumber?: number;
  prUrl?: string;
  /** GitHub says the PR cannot be merged cleanly (labelled, commented and assigned per `conflicts`). */
  conflicted?: boolean;
  /** GitHub's answer when last polled: true/false, or null if it was still computing. */
  mergeable?: boolean | null;
  /** Protected paths whose target content was kept. */
  protectedKept?: string[];
  plan?: HopPlan;
  message?: string;
}

const short = (sha: string) => sha.slice(0, 7);
const normalise = (s: string) => s.replace(/\r\n/g, '\n').trim();

export async function syncHop(spec: HopSpec, deps: HopDeps, opts: HopOptions): Promise<HopResult> {
  const startedAt = deps.now().toISOString();
  const logger = deps.logger.child({ chain: spec.chain, hop: spec.id });
  let result: HopResult;
  let rethrow: unknown;

  try {
    result = await runHop(spec, deps, opts, logger);
  } catch (e) {
    if (e instanceof RateLimitExceededError) {
      logger.warn('hop stopped: rate limited', { kind: e.kind, retryAfterMs: e.retryAfterMs });
      result = { hop: spec.id, chain: spec.chain, outcome: 'rate_limited', message: e.message };
      rethrow = e;
    } else {
      logger.error('hop failed', errorFields(e));
      result = { hop: spec.id, chain: spec.chain, outcome: 'error', message: scrubString(e instanceof Error ? e.message : String(e)) };
    }
  }

  if (!opts.dryRun) {
    await deps.store
      .recordRun({
        startedAt,
        finishedAt: deps.now().toISOString(),
        trigger: opts.trigger,
        ...(opts.deliveryId ? { deliveryId: opts.deliveryId } : {}),
        chain: spec.chain,
        hop: spec.id,
        outcome: result.outcome,
        ...(result.sourceSha ? { sourceSha: result.sourceSha } : {}),
        ...(result.targetSha ? { targetSha: result.targetSha } : {}),
        ...(result.prNumber !== undefined ? { prNumber: result.prNumber } : {}),
        ...(result.message ? { detail: { message: result.message } } : {}),
      })
      .catch((e) => logger.error('could not write run log', errorFields(e)));
  }

  if (rethrow) throw rethrow;
  return result;
}

async function runHop(spec: HopSpec, deps: HopDeps, opts: HopOptions, logger: Logger): Promise<HopResult> {
  const { source, target } = spec;
  const base = { hop: spec.id, chain: spec.chain };

  // Defence in depth on top of schema validation.
  if (!isBotBranch(spec.syncBranch) || spec.syncBranch === target.branch || spec.syncBranch === source.branch) {
    throw new Error(`sync branch "${spec.syncBranch}" must be a chain/* bot branch distinct from the tracked branches`);
  }

  const out = guardBotBranches(deps.targetPort);

  const sourceSha = await deps.sourcePort.getBranchSha(source.repo, source.branch);
  if (!sourceSha) throw new Error(`source branch ${fullName(source.repo)}@${source.branch} does not exist`);
  const targetSha = await out.getBranchSha(target.repo, target.branch);
  if (!targetSha) throw new Error(`target branch ${fullName(target.repo)}@${target.branch} does not exist`);

  const open = await out.findOpenPullRequest(target.repo, spec.syncBranch, target.branch);

  // Closed sync PRs tell us what already landed / was rejected. Fetched at most once, only if needed.
  let closedCache: PullRequest[] | undefined;
  const closed = async () => (closedCache ??= await out.listClosedPullRequests(target.repo, spec.syncBranch, target.branch, 10));

  // ---- Is the target behind the source? ----------------------------------------------------
  const ancestry: CompareResult =
    sourceSha === targetSha
      ? { status: 'identical', aheadBy: 0, behindBy: 0, commits: [], htmlUrl: '' }
      : await out.compare(target.repo, target.branch, sourceSha);

  let pending = ancestry.aheadBy > 0;
  let described = ancestry; // what the PR body lists as "commits"
  if (pending && spec.mergeMethod !== 'merge') {
    // Squash/rebase never make the source an ancestor of the target. Use the last merged sync PR's
    // recorded source commit as the baseline instead.
    const baseline = (await closed()).filter((p) => p.merged).map((p) => parseMarker(p.body)?.source).find(Boolean);
    if (baseline === sourceSha) {
      pending = false;
    } else if (baseline) {
      described = await out.compare(target.repo, baseline, sourceSha);
      pending = described.aheadBy > 0;
    }
  }

  const latestClosed = pending && !open ? (await closed())[0] : undefined;
  // A PR for exactly this source commit was closed without merging: respect that until the source moves.
  const wasRejected = !!latestClosed && !latestClosed.merged && parseMarker(latestClosed.body)?.source === sourceSha;

  // Protected paths the source would overwrite (read-only; objects are only created if we really sync).
  const protection =
    pending && !wasRejected && spec.protectedPaths.length > 0
      ? await planProtection(out, target.repo, sourceSha, targetSha, spec.protectedPaths)
      : null;

  const plan: HopPlan = {
    action: !pending ? (open ? 'close_stale_pr' : 'none') : wasRejected ? 'skip_rejected' : open ? 'update_pr' : 'open_pr',
    pending,
    mergeMethod: spec.mergeMethod,
    aheadBy: ancestry.aheadBy,
    behindBy: ancestry.behindBy,
    ...(open ? { existingPr: open.number } : {}),
    ...(protection ? { protectedPaths: protection.paths } : {}),
  };
  const context = { ...base, sourceSha, targetSha };
  logger.debug('hop analysed', { ...plan, source: short(sourceSha), target: short(targetSha) });

  if (opts.dryRun) return { ...context, outcome: 'dry_run', plan };

  // ---- Nothing to do ----------------------------------------------------------------------
  if (!pending) {
    if (open) {
      await out.createComment(
        target.repo,
        open.number,
        `sluice: \`${target.branch}\` already contains \`${fullName(source.repo)}@${source.branch}\` (\`${short(sourceSha)}\`), ` +
          `so this PR is no longer needed. Closing it; a new one opens when the source moves again.`,
      );
      await out.updatePullRequest(target.repo, open.number, { state: 'closed' });
      logger.info('closed stale sync PR', { pr: open.number });
      return { ...context, outcome: 'stale_pr_closed', prNumber: open.number, prUrl: open.htmlUrl, plan };
    }
    return { ...context, outcome: 'up_to_date', plan };
  }

  if (wasRejected) {
    logger.info('sync skipped: PR for this source commit was closed without merging', { pr: latestClosed!.number });
    return {
      ...context,
      outcome: 'skipped_rejected',
      prNumber: latestClosed!.number,
      prUrl: latestClosed!.htmlUrl,
      plan,
      message: `PR #${latestClosed!.number} for ${short(sourceSha)} was closed without merging; waiting for the source to move`,
    };
  }

  // ---- Make the sync branch carry the source ----------------------------------------------
  // What we bring in is the source commit itself, or its "restore" twin when protected paths differ
  // (created lazily, so a run that changes nothing creates no objects).
  let restored: string | undefined;
  const effective = async (): Promise<string> =>
    protection ? (restored ??= await createRestoreCommit(out, target.repo, protection, sourceSha, target.branch)) : sourceSha;

  // Target has no commits of its own -> the branch can simply BE that commit (fast-forward).
  // Otherwise start from the target tip and let GitHub merge it in.
  const fastForward = ancestry.behindBy === 0;
  const startSha = async (): Promise<string> => (fastForward ? effective() : targetSha);

  let branchSha = await out.getBranchSha(target.repo, spec.syncBranch);
  let freshBranch = false;
  let branchChanged = false;

  if (branchSha && !open) {
    // A leftover from a PR that already landed, or was abandoned. Reset it only when that cannot
    // lose work: it is exactly what was merged, or it adds nothing over the target.
    const latest = (await closed())[0];
    const exactlyMerged = latest?.merged === true && latest.headSha === branchSha;
    const addsNothing = !exactlyMerged && (await out.compare(target.repo, target.branch, spec.syncBranch)).aheadBy === 0;
    if (exactlyMerged || addsNothing) {
      branchSha = await startSha();
      await out.setBranchSha(target.repo, spec.syncBranch, branchSha, true);
      freshBranch = true;
      branchChanged = true;
      logger.info('reset leftover sync branch', { branch: spec.syncBranch });
    }
  }

  if (!branchSha) {
    const start = await startSha();
    const created = await out.createBranch(target.repo, spec.syncBranch, start);
    if (created === 'created') {
      branchSha = start;
      freshBranch = true;
      branchChanged = true;
      logger.info('created sync branch', { branch: spec.syncBranch, at: short(start) });
    } else {
      branchSha = await out.getBranchSha(target.repo, spec.syncBranch); // lost a race; carry on with theirs
    }
  }

  // A fresh fast-forward branch already is the commit. Any other branch needs the merge unless it
  // already contains the source (then re-running is a no-op).
  const needsMerge = freshBranch
    ? !fastForward
    : branchSha !== sourceSha && (await out.compare(target.repo, spec.syncBranch, sourceSha)).aheadBy > 0;

  let structuralConflict = false; // GitHub refused the merge just now (evidence, before it has polled)
  if (needsMerge) {
    const head = await effective();
    const merged = await out.mergeIntoBranch(
      target.repo,
      spec.syncBranch,
      head,
      `sluice: merge ${fullName(source.repo)}@${source.branch} (${short(sourceSha)}) into ${spec.syncBranch}`,
    );
    if (merged.result === 'merged') branchChanged = true;
    if (merged.result === 'conflict') {
      structuralConflict = true;
      // A branch we just made has no human work on it: point it at the commit so the PR exists and
      // displays the conflict. A pre-existing branch is left exactly as it is.
      if (freshBranch) {
        await out.setBranchSha(target.repo, spec.syncBranch, head, true);
        branchChanged = true;
      }
      logger.warn('merge conflict while syncing', { branch: spec.syncBranch, source: short(sourceSha) });
    }
  }

  // ---- Open or refresh the PR ---------------------------------------------------------------
  const title = renderSyncPrTitle(spec);
  const hadConflictLabel = open?.labels.includes(spec.conflicts.label) ?? false;
  const render = (conflicted: boolean) =>
    renderSyncPrBody({
      hop: spec.id,
      source,
      target,
      syncBranch: spec.syncBranch,
      sourceSha,
      mergeMethod: spec.mergeMethod,
      compare: described,
      conflicted,
      ...(protection ? { protectedPaths: protection.paths } : {}),
    });

  // The body shows the last known conflict state; it is corrected below once GitHub has answered.
  let renderedConflict = structuralConflict || hadConflictLabel;
  let body = render(renderedConflict);
  let pr: { number: number; htmlUrl: string; labels: string[] };
  let created = false;
  let edited = false;

  if (open) {
    if (normalise(open.body) !== normalise(body) || open.title !== title) {
      await out.updatePullRequest(target.repo, open.number, { title, body });
      edited = true;
    }
    pr = open;
  } else {
    try {
      const res = await out.createPullRequest(target.repo, {
        title,
        body,
        head: spec.syncBranch,
        base: target.branch,
        draft: spec.pr.draft,
      });
      pr = res.pr;
      created = res.created;
      if (created) {
        await decorate(out, target.repo, pr.number, spec, logger);
        logger.info('opened sync PR', { pr: pr.number });
      }
    } catch (e) {
      if (e instanceof NoCommitsBetweenError) {
        // Squashed content already present: the branch adds nothing, so there is nothing to review.
        return { ...context, outcome: 'up_to_date', plan, message: 'sync branch adds nothing over the target branch' };
      }
      throw e;
    }
  }

  // ---- Conflicts: ask GitHub (it computes mergeability lazily, so poll) ----------------------
  const mergeable = await awaitMergeable(out, target.repo, pr.number, deps.polling, deps.sleep);
  // `null` = still computing after every attempt: fall back on what we already know.
  const conflicted = mergeable === null ? structuralConflict || hadConflictLabel : !mergeable;
  if (conflicted !== renderedConflict) {
    renderedConflict = conflicted;
    body = render(conflicted);
    await out.updatePullRequest(target.repo, pr.number, { title, body });
    edited = true;
  }
  await reconcileConflict(
    out,
    {
      repo: target.repo,
      pr: { number: pr.number, labels: pr.labels },
      policy: spec.conflicts,
      syncBranch: spec.syncBranch,
      targetBranch: target.branch,
      sourceName: `\`${fullName(source.repo)}@${source.branch}\``,
      logger,
    },
    conflicted,
  );

  const outcome: HopOutcome = conflicted
    ? 'conflict'
    : created
      ? 'pr_opened'
      : open && (branchChanged || edited)
        ? 'pr_updated'
        : 'pr_unchanged';
  if (open && outcome !== 'pr_unchanged') logger.info('sync PR refreshed', { pr: pr.number, outcome });

  return {
    ...context,
    outcome,
    prNumber: pr.number,
    prUrl: pr.htmlUrl,
    conflicted,
    mergeable,
    plan,
    ...(protection ? { protectedKept: protection.paths } : {}),
  };
}

/** Labels / assignees / reviewers are conveniences: a bad login must not fail the sync. */
async function decorate(port: GitHubPort, repo: RepoRef, pr: number, spec: HopSpec, logger: Logger): Promise<void> {
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof RateLimitExceededError) throw e;
      logger.warn(`could not set ${what} on sync PR`, { pr, ...errorFields(e) });
    }
  };
  await attempt('labels', () => port.addLabels(repo, pr, [...spec.pr.labels]));
  await attempt('assignees', () => port.addAssignees(repo, pr, [...spec.pr.assignees]));
  await attempt('reviewers', () => port.requestReviewers(repo, pr, [...spec.pr.reviewers], [...spec.pr.teamReviewers]));
}
