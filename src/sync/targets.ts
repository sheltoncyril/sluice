import type { GitHubPort, RepoRef } from '../github/port';
import { fullName, parseRepo } from '../github/port';
import { isOwnerAllowed } from '../policy';
import type { ChainDeps, ChainHandle } from './chain';

export type Role = 'midstream' | 'downstream';

export interface ResolvedTarget {
  role: Role;
  repo: RepoRef;
  /** A port bound to the installation that covers THIS repo (installations are per account). */
  port: GitHubPort;
  /** The branch the repo tracks (the base for PRs). */
  branch: string;
}

export type TargetResolution = { ok: true; target: ResolvedTarget } | { ok: false; role: Role; repo: RepoRef; error: string };

/**
 * Turn "midstream" / "downstream" from chain.yml into a repo plus a usable port. Downstream may be in
 * another org, so it needs its own installation, and its owner must be on the allowlist: otherwise a
 * midstream owner could aim secrets, variables or PRs at a stranger's repo.
 */
export async function resolveTarget(deps: ChainDeps, handle: ChainHandle, role: Role): Promise<TargetResolution> {
  if (role === 'midstream') {
    return {
      ok: true,
      target: { role, repo: handle.holder, port: handle.midstreamPort, branch: handle.config.midstream.branch },
    };
  }
  const repo = parseRepo(handle.config.downstream.repo);
  if (!isOwnerAllowed(deps.allowedOwners, repo.owner)) {
    return { ok: false, role, repo, error: `downstream owner "${repo.owner}" is not in ALLOWED_OWNERS` };
  }
  const port = await deps.ports.forRepo(repo);
  if (!port) return { ok: false, role, repo, error: `the app is not installed on ${fullName(repo)} (downstream)` };
  return { ok: true, target: { role, repo, port, branch: handle.config.downstream.branch } };
}
