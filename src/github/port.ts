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
  /** Label names currently on the PR. */
  labels: string[];
  /** ISO-8601 creation time. */
  createdAt: string;
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

export interface CommitInfo {
  treeSha: string;
  /** ISO-8601 committer date of the commit. */
  committerDate: string;
}

/** A file (or submodule) in a git tree. Directories are not listed; their files are, with full paths. */
export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'commit';
  sha: string;
}

/**
 * One change to apply on top of a base tree. Either `sha` (an existing object; `null` deletes the path)
 * or, for a new text file, `content` (GitHub creates the blob).
 */
export interface TreeChange {
  path: string;
  mode: string;
  type: 'blob' | 'commit';
  sha: string | null;
  content?: string;
}

export interface NewCommit {
  message: string;
  treeSha: string;
  parents: string[];
  /**
   * Used for BOTH author and committer so the commit hash is fully determined by the inputs. Omit it to
   * let GitHub attribute the commit to the app, which signs it ("Verified").
   */
  identity?: { name: string; email: string; date: string };
}

/** GitHub's lazily computed answer to "can this PR be merged?". `mergeable: null` means "not computed yet". */
export interface PullMergeability {
  mergeable: boolean | null;
  state: string;
}

/** The per-repo public key Actions secrets must be sealed to. */
export interface ActionsPublicKey {
  keyId: string;
  /** base64 Curve25519 public key. */
  key: string;
}

/** What GitHub will tell you about a secret: its name and timestamps. Never the value. */
export interface ActionsSecretInfo {
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Variables are not secret: GitHub returns their values. */
export interface ActionsVariable {
  name: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRef {
  number: number;
  htmlUrl: string;
  body: string;
}

export interface NewIssue {
  title: string;
  body: string;
  labels: string[];
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

  /** Git data: enough to build a commit whose tree is another commit's tree with a few paths changed. */
  getCommitInfo(repo: RepoRef, sha: string): Promise<CommitInfo>;
  /** Every file in a tree, recursively. Throws {@link TreeTooLargeError} if GitHub truncates the listing. */
  getTreeEntries(repo: RepoRef, treeSha: string): Promise<TreeEntry[]>;
  createTree(repo: RepoRef, baseTreeSha: string, changes: TreeChange[]): Promise<string>;
  /** Creates an (unreferenced) commit object; identical inputs yield the identical SHA. */
  createCommit(repo: RepoRef, commit: NewCommit): Promise<string>;

  getMergeability(repo: RepoRef, pullNumber: number): Promise<PullMergeability>;

  /** Actions secrets. Write-only on GitHub: values can be set, never read back. */
  getActionsPublicKey(repo: RepoRef): Promise<ActionsPublicKey>;
  /** `encryptedValue` is base64 sealed-box ciphertext. Returns whether the secret was created or replaced. */
  putActionsSecret(repo: RepoRef, name: string, encryptedValue: string, keyId: string): Promise<'created' | 'updated'>;
  listActionsSecrets(repo: RepoRef): Promise<ActionsSecretInfo[]>;

  /** Actions variables (non-sensitive). */
  listActionsVariables(repo: RepoRef): Promise<ActionsVariable[]>;
  createActionsVariable(repo: RepoRef, name: string, value: string): Promise<void>;
  updateActionsVariable(repo: RepoRef, name: string, value: string): Promise<void>;

  /** Issues (the drift report). Requires the app's Issues permission. */
  findOpenIssueByLabelMarker(repo: RepoRef, label: string, marker: string): Promise<IssueRef | null>;
  createIssue(repo: RepoRef, issue: NewIssue): Promise<IssueRef>;
  updateIssue(repo: RepoRef, issueNumber: number, patch: { title?: string; body?: string; state?: 'closed' }): Promise<void>;

  addLabels(repo: RepoRef, issueNumber: number, labels: string[]): Promise<void>;
  /** Removes a label from an issue/PR; a label that is not there is not an error. */
  removeLabel(repo: RepoRef, issueNumber: number, label: string): Promise<void>;
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
