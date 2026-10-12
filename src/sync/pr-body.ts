import type { CompareResult, RepoRef } from '../github/port';
import { fullName } from '../github/port';
import type { HopId, MergeMethod } from '../config/schema';
import { renderMarker } from './marker';

export interface SyncPrInput {
  hop: HopId;
  source: { repo: RepoRef; branch: string };
  target: { repo: RepoRef; branch: string };
  syncBranch: string;
  sourceSha: string;
  mergeMethod: MergeMethod;
  /** Commits the PR brings in (relative to what the target already has / last synced). */
  compare: CompareResult;
  /** GitHub reports the PR cannot be merged cleanly. */
  conflicted: boolean;
  /** Protected paths whose target content was kept in place of the source's (sorted). */
  protectedPaths?: readonly string[];
}

const MAX_COMMITS_LISTED = 20;
const MAX_PATHS_LISTED = 15;
const MAX_BODY = 60_000; // GitHub's limit is 65,536

export function renderSyncPrTitle(input: Pick<SyncPrInput, 'source' | 'target'>): string {
  return `Sync ${fullName(input.source.repo)}@${input.source.branch} into ${input.target.branch}`;
}

function mergeAdvice(method: MergeMethod, branch: string, sourceSha: string): string {
  switch (method) {
    case 'merge':
      return (
        `**Merge this PR with a merge commit.** sluice decides whether \`${branch}\` is up to date by checking that ` +
        `the source commit is an ancestor of it; squashing or rebasing would make it open this PR again.`
      );
    case 'squash':
    case 'rebase':
      return (
        `Merge method for this hop is **${method}**. That is fine: sluice records the source commit ` +
        `(\`${sourceSha.slice(0, 7)}\`) in the hidden comment at the top of this description and treats the last merged ` +
        `sync PR as the baseline. Please don't delete that comment.`
      );
  }
}

/** Deterministic: the same inputs render the same body, so an unchanged run causes no PR edit. */
export function renderSyncPrBody(input: SyncPrInput): string {
  const { source, target, compare } = input;
  const src = `${fullName(source.repo)}@${source.branch}`;
  const n = compare.aheadBy;

  const lines: string[] = [
    renderMarker({ hop: input.hop, source: input.sourceSha }),
    `## Sync \`${src}\` → \`${target.branch}\``,
    '',
    `Brings ${n} commit${n === 1 ? '' : 's'} from \`${src}\` (now at \`${input.sourceSha.slice(0, 7)}\`) into ` +
      `\`${fullName(target.repo)}:${target.branch}\`.`,
    '',
    mergeAdvice(input.mergeMethod, target.branch, input.sourceSha),
  ];

  if (input.conflicted) {
    lines.push(
      '',
      `> ⚠️ **Merge conflicts.** \`${input.syncBranch}\` cannot be merged into \`${target.branch}\` automatically. ` +
        `Resolve them by pushing to \`${input.syncBranch}\`; sluice never overwrites commits you push there.`,
    );
  }

  const kept = input.protectedPaths ?? [];
  if (kept.length > 0) {
    lines.push(
      '',
      '### Protected paths',
      `${kept.length} path${kept.length === 1 ? '' : 's'} listed under \`protected_paths\` ${kept.length === 1 ? 'keeps its' : 'keep their'} \`${target.branch}\` content; ` +
        `upstream changes to ${kept.length === 1 ? 'it' : 'them'} are not applied:`,
    );
    for (const path of kept.slice(0, MAX_PATHS_LISTED)) lines.push(`- \`${path}\``);
    if (kept.length > MAX_PATHS_LISTED) lines.push(`- … and ${kept.length - MAX_PATHS_LISTED} more`);
  }

  if (compare.commits.length > 0) {
    lines.push('', '### Commits');
    for (const c of compare.commits.slice(0, MAX_COMMITS_LISTED)) {
      lines.push(`- \`${c.sha.slice(0, 7)}\` ${c.subject}${c.author ? ` (@${c.author})` : ''}`);
    }
    const hidden = n - Math.min(compare.commits.length, MAX_COMMITS_LISTED);
    if (hidden > 0) lines.push(`- … and ${hidden} more`);
    if (compare.htmlUrl) lines.push('', `[Full comparison](${compare.htmlUrl})`);
  }

  lines.push('', '---', '_Opened by sluice. Nothing here is applied until you merge it._');
  const body = lines.join('\n');
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n…(truncated)` : body;
}
