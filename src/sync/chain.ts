import type { ChainConfig, HopId } from '../config/schema';
import type { GitHubPort, RepoRef } from '../github/port';
import { fullName, parseRepo } from '../github/port';
import type { PortFactory } from '../github/ports';
import type { Logger } from '../log';
import { isOwnerAllowed } from '../policy';
import type { Store } from '../store/types';
import type { ConflictPolicy } from './conflict';
import { syncHop } from './hop';
import type { PrMeta } from './pr-meta';
import type { HopResult, HopSpec } from './hop';

/** Everything chain-level code needs that is not specific to one event. */
export interface ChainDeps {
  ports: PortFactory;
  store: Store;
  now: () => Date;
  allowedOwners: ReadonlySet<string>;
  /** Injectable for tests; defaults to a real timer. Used while waiting for GitHub to compute mergeability. */
  sleep?: (ms: number) => Promise<void>;
}

/** A chain whose config has been loaded, plus the port for the midstream installation. */
export interface ChainHandle {
  /** The midstream repo (holder of chain.yml), as GitHub spells it. */
  holder: RepoRef;
  config: ChainConfig;
  midstreamPort: GitHubPort;
}

/** Who gets pinged on a conflict: the conflict-specific list, else the PR reviewers, else the assignees. */
export function conflictPolicyOf(config: ChainConfig): ConflictPolicy {
  const who =
    config.conflicts.assignees.length > 0
      ? config.conflicts.assignees
      : config.pull_requests.reviewers.length > 0
        ? config.pull_requests.reviewers
        : config.pull_requests.assignees;
  return {
    label: config.conflicts.label,
    comment: config.conflicts.comment,
    assignees: who,
    requestReview: config.conflicts.request_review,
  };
}

export function prMetaOf(config: ChainConfig): PrMeta {
  return {
    labels: config.pull_requests.labels,
    assignees: config.pull_requests.assignees,
    reviewers: config.pull_requests.reviewers,
    teamReviewers: config.pull_requests.team_reviewers,
    draft: config.pull_requests.draft,
  };
}

/**
 * Files sluice renders from templates into a repo. On the sync hops these are protected automatically:
 * otherwise upstream's (or midstream's) copy of `.github/workflows/ci.yml` would be merged over the
 * managed one, and the next template PR would fight the sync PR forever.
 */
export function managedWorkflowPaths(config: ChainConfig, role: 'midstream' | 'downstream'): string[] {
  return config.workflows.files.filter((f) => f.targets.includes(role)).map((f) => f.destination);
}

export function buildHopSpec(handle: ChainHandle, hop: HopId): HopSpec {
  const { config, holder } = handle;
  const chain = fullName(holder);
  const common = { chain, pr: prMetaOf(config), conflicts: conflictPolicyOf(config) };
  if (hop === 'upstream_to_midstream') {
    const h = config.hops.upstream_to_midstream;
    return {
      ...common,
      id: hop,
      source: { repo: parseRepo(config.upstream.repo), branch: config.upstream.branch },
      target: { repo: holder, branch: config.midstream.branch },
      syncBranch: h.sync_branch,
      mergeMethod: h.merge_method,
      protectedPaths: [...new Set([...h.protected_paths, ...managedWorkflowPaths(config, 'midstream')])],
    };
  }
  const h = config.hops.midstream_to_downstream;
  return {
    ...common,
    id: hop,
    source: { repo: holder, branch: config.midstream.branch },
    target: { repo: parseRepo(config.downstream.repo), branch: config.downstream.branch },
    syncBranch: h.sync_branch,
    mergeMethod: h.merge_method,
    protectedPaths: [...new Set([...h.protected_paths, ...managedWorkflowPaths(config, 'downstream')])],
  };
}

export interface RunOptions {
  trigger: string;
  deliveryId?: string;
  dryRun?: boolean;
}

/**
 * Run one hop of a loaded chain. Resolves which installation writes where:
 *   upstream -> midstream:   midstream's installation reads the public upstream and writes midstream.
 *   midstream -> downstream: midstream's installation reads, DOWNSTREAM's installation writes.
 * Downstream may live in another org, so it needs its own installation, and its owner must be on the
 * allowlist: otherwise a midstream owner could aim the sync (and its PRs) at a stranger's repo.
 */
export async function syncChainHop(
  deps: ChainDeps,
  handle: ChainHandle,
  hop: HopId,
  opts: RunOptions,
  logger: Logger,
): Promise<HopResult> {
  const spec = buildHopSpec(handle, hop);
  const fail = async (message: string): Promise<HopResult> => {
    logger.error(message, { chain: spec.chain, hop });
    const result: HopResult = { hop, chain: spec.chain, outcome: 'error', message };
    if (!opts.dryRun) {
      const at = deps.now().toISOString();
      await deps.store.recordRun({
        startedAt: at,
        finishedAt: at,
        trigger: opts.trigger,
        ...(opts.deliveryId ? { deliveryId: opts.deliveryId } : {}),
        chain: spec.chain,
        hop,
        outcome: 'error',
        detail: { message },
      });
    }
    return result;
  };

  if (handle.config.transport !== 'fork') {
    return fail(`transport "${handle.config.transport}" is not implemented yet; only "fork" is supported`);
  }

  let targetPort: GitHubPort;
  if (hop === 'upstream_to_midstream') {
    targetPort = handle.midstreamPort;
  } else {
    if (!isOwnerAllowed(deps.allowedOwners, spec.target.repo.owner)) {
      return fail(`downstream owner "${spec.target.repo.owner}" is not in ALLOWED_OWNERS; refusing to write there`);
    }
    const port = await deps.ports.forRepo(spec.target.repo);
    if (!port) return fail(`the app is not installed on ${fullName(spec.target.repo)} (downstream)`);
    targetPort = port;
  }

  return syncHop(
    spec,
    {
      sourcePort: handle.midstreamPort,
      targetPort,
      store: deps.store,
      logger,
      now: deps.now,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    },
    { trigger: opts.trigger, ...(opts.deliveryId ? { deliveryId: opts.deliveryId } : {}), ...(opts.dryRun ? { dryRun: true } : {}) },
  );
}
