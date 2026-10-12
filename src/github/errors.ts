/** The source commit is not visible from the target repo (target is not a fork in the source's network). */
export class CommitNotReachableError extends Error {
  constructor(
    public readonly repo: string,
    public readonly sha: string,
  ) {
    super(
      `commit ${sha.slice(0, 7)} is not reachable from ${repo}. With transport "fork" the target must be a GitHub ` +
        `fork in the source's network; for unrelated repos the "git-data" transport is needed (not implemented yet)`,
    );
    this.name = 'CommitNotReachableError';
  }
}

/** GitHub refuses a PR whose head adds nothing over its base. */
export class NoCommitsBetweenError extends Error {
  constructor(head: string, base: string) {
    super(`no commits between ${base} and ${head}`);
    this.name = 'NoCommitsBetweenError';
  }
}

/** A write was attempted on a ref outside the chain/ namespace. Always a bug; never retried. */
export class ProtectedBranchWriteError extends Error {
  constructor(operation: string, branch: string) {
    super(`refusing ${operation} on "${branch}": chain-sync only writes to chain/* branches`);
    this.name = 'ProtectedBranchWriteError';
  }
}
