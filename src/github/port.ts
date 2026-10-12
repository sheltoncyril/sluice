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

export interface GitHubPort {
  /** Read a UTF-8 text file. Null when the path (or ref) does not exist. */
  readFile(repo: RepoRef, path: string, ref?: string): Promise<RepoFile | null>;

  /** Paths changed by a pull request (current names; removed files excluded). */
  listPullRequestFiles(repo: RepoRef, pullNumber: number): Promise<string[]>;

  /** First comment on an issue/PR whose body contains `marker`, or null. */
  findCommentByMarker(repo: RepoRef, issueNumber: number, marker: string): Promise<IssueComment | null>;
  createComment(repo: RepoRef, issueNumber: number, body: string): Promise<IssueComment>;
  updateComment(repo: RepoRef, commentId: number, body: string): Promise<void>;
}
