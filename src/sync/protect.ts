import picomatch from 'picomatch';
import type { CommitInfo, GitHubPort, RepoRef, TreeChange, TreeEntry } from '../github/port';
import { fullName } from '../github/port';

/**
 * Protected paths: files whose content in the TARGET must survive a sync.
 *
 * Why not "merge, then fix up"? Because the reason to protect a path is that both sides edited it,
 * and that is exactly when GitHub's merge refuses with a conflict. So instead the source commit is
 * REWRITTEN first: a "restore commit" whose tree is the source tree with every protected path reset
 * to the target's content (or removed, if the target has no such file), parented on the source tip.
 * Merging that commit cannot conflict on protected paths (both sides are already equal there), upstream
 * edits to them are discarded, and because the source tip is its parent, ancestry still converges once
 * the PR lands.
 *
 * The restore commit is deterministic (fixed identity and date, no clock), so re-runs and overlapping
 * runs produce the very same object instead of piling up new ones.
 */

export interface ProtectionPlan {
  /** Changes to apply to the source tree so protected paths match the target. */
  changes: TreeChange[];
  /** The protected paths that differ between source and target, sorted. */
  paths: string[];
  source: CommitInfo;
}

/** Same options everywhere: dot-files and dot-directories (.github/...) must match `**`. */
export const matcher = (patterns: readonly string[]) => picomatch([...patterns], { dot: true });

/**
 * Read-only: work out which protected paths differ between the source and the target tip.
 * Returns null when nothing protected would change (so no objects need to be created at all).
 */
export async function planProtection(
  port: GitHubPort,
  repo: RepoRef,
  sourceSha: string,
  targetSha: string,
  patterns: readonly string[],
): Promise<ProtectionPlan | null> {
  if (patterns.length === 0) return null;

  const [source, target] = await Promise.all([port.getCommitInfo(repo, sourceSha), port.getCommitInfo(repo, targetSha)]);
  if (source.treeSha === target.treeSha) return null; // identical content, nothing to protect

  const isProtected = matcher(patterns);
  const [sourceEntries, targetEntries] = await Promise.all([
    port.getTreeEntries(repo, source.treeSha),
    port.getTreeEntries(repo, target.treeSha),
  ]);
  const pick = (entries: TreeEntry[]) => new Map(entries.filter((e) => isProtected(e.path)).map((e) => [e.path, e]));
  const fromSource = pick(sourceEntries);
  const fromTarget = pick(targetEntries);

  const changes: TreeChange[] = [];
  for (const path of new Set([...fromSource.keys(), ...fromTarget.keys()])) {
    const s = fromSource.get(path);
    const t = fromTarget.get(path);
    if (s && t && s.sha === t.sha && s.mode === t.mode) continue; // already identical
    if (t) changes.push({ path, mode: t.mode, type: t.type, sha: t.sha }); // keep the target's version
    else changes.push({ path, mode: s!.mode, type: s!.type, sha: null }); // upstream-only file: drop it
  }
  if (changes.length === 0) return null;

  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { changes, paths: changes.map((c) => c.path), source };
}

const IDENTITY = { name: 'sluice', email: 'sluice@users.noreply.github.com' } as const;

/** Create the restore commit for a plan. Idempotent: same inputs, same SHA. */
export async function createRestoreCommit(
  port: GitHubPort,
  repo: RepoRef,
  plan: ProtectionPlan,
  sourceSha: string,
  targetBranch: string,
): Promise<string> {
  const treeSha = await port.createTree(repo, plan.source.treeSha, plan.changes);
  const n = plan.paths.length;
  return port.createCommit(repo, {
    treeSha,
    parents: [sourceSha],
    message:
      `sluice: keep ${n} protected path${n === 1 ? '' : 's'} as in ${fullName(repo)}:${targetBranch}\n\n` +
      `Upstream changes to protected paths are discarded; everything else is the source commit.\n` +
      `sluice-source: ${sourceSha}`,
    identity: { ...IDENTITY, date: plan.source.committerDate },
  });
}
