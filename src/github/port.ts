/**
 * The narrow slice of GitHub the sync engine needs. Business logic depends on this interface only,
 * so it runs against an in-memory fake in tests and could run against any HTTP client elsewhere.
 * Each port instance is bound to ONE installation (installation tokens are per-account).
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export const fullName = (r: RepoRef): string => `${r.owner}/${r.repo}`;

export function parseRepo(full: string): RepoRef {
  const [owner, repo, ...rest] = full.split('/');
  if (!owner || !repo || rest.length > 0) throw new Error(`not an "owner/name" repo: ${full}`);
  return { owner, repo };
}

export const sameRepo = (a: RepoRef, b: RepoRef): boolean =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

export interface RepoFile {
  text: string;
  /** Blob SHA, useful as a change detector. */
  sha: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface CommitSummary {
  sha: string;
  /** First line of the commit message. */
  subject: string;
  author?: string;
}

export interface CompareResult {
  status: 'identical' | 'ahead' | 'behind' | 'diverged';
  /** Commits in `head` that are not in `base`. */
  aheadBy: number;
  /** Commits in `base` that are not in `head`. */
  behindBy: number;
  /** A page of the head-only commits (oldest first), for PR descriptions. */
  commits: CommitSummary[];
  htmlUrl: string;
}

export interface PullRequest {
  number: number;
  state: 'open' | 'closed';
  /** True only if the PR was merged (closed-without-merging is `state: closed, merged: false`). */
  merged: boolean;
  title: string;
  body: string;
  headRef: string;
  /** Head commit when last seen (for a merged PR: the commit that was merged). */
  headSha: string;
  baseRef: string;
  htmlUrl: string;
}

export interface NewPullRequest {
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
}

export type MergeIntoResult =
  | { result: 'merged'; sha: string }
  | { result: 'up_to_date' }
  | { result: 'conflict' };

export interface GitHubPort {
  /** Tip SHA of a branch, or null if the branch does not exist. */
  getBranchSha(repo: RepoRef, branch: string): Promise<string | null>;

  /**
   * Create `refs/heads/<branch>` at `sha`. Returns 'exists' (without touching it) if already there.
   * Throws {@link CommitNotReachableError} when the repo cannot see `sha`.
   */
  createBranch(repo: RepoRef, branch: string, sha: string): Promise<'created' | 'exists'>;

  /** Move a branch. `force` allows non-fast-forward; used only to reset a fresh or stale bot branch. */
  setBranchSha(repo: RepoRef, branch: string, sha: string, force: boolean): Promise<void>;

  /** Compare two refs/SHAs inside `repo`. Throws {@link CommitNotReachableError} on unknown commits. */
  compare(repo: RepoRef, base: string, head: string): Promise<CompareResult>;

  /**
   * Merge `head` (branch or SHA) into `branch` server-side (GitHub's Merges API). The base branch is
   * the one that moves, so callers must only ever pass a chain/* bot branch.
   */
  mergeIntoBranch(repo: RepoRef, branch: string, head: string, message: string): Promise<MergeIntoResult>;

  findOpenPullRequest(repo: RepoRef, headBranch: string, baseBranch: string): Promise<PullRequest | null>;
  /** Most recently updated first. */
  listClosedPullRequests(repo: RepoRef, headBranch: string, baseBranch: string, limit: number): Promise<PullRequest[]>;

  /**
   * Open a PR. If an open PR for the same head/base already exists (a concurrent run won), returns it
   * with `created: false`. Throws {@link NoCommitsBetweenError} if head adds nothing over base.
   */
  createPullRequest(repo: RepoRef, input: NewPullRequest): Promise<{ pr: PullRequest; created: boolean }>;
  updatePullRequest(
    repo: RepoRef,
    pullNumber: number,
    patch: { title?: string; body?: string; state?: 'closed' },
  ): Promise<void>;

  addLabels(repo: RepoRef, issueNumber: number, labels: string[]): Promise<void>;
  addAssignees(repo: RepoRef, issueNumber: number, logins: string[]): Promise<void>;
  requestReviewers(repo: RepoRef, pullNumber: number, reviewers: string[], teamReviewers: string[]): Promise<void>;


  /** Read a UTF-8 text file. Null when the path (or ref) does not exist. */
  readFile(repo: RepoRef, path: string, ref?: string): Promise<RepoFile | null>;

  /** Paths changed by a pull request (current names; removed files excluded). */
  listPullRequestFiles(repo: RepoRef, pullNumber: number): Promise<string[]>;

  /** First comment on an issue/PR whose body contains `marker`, or null. */
  findCommentByMarker(repo: RepoRef, issueNumber: number, marker: string): Promise<IssueComment | null>;
  createComment(repo: RepoRef, issueNumber: number, body: string): Promise<IssueComment>;
  updateComment(repo: RepoRef, commentId: number, body: string): Promise<void>;
}
