import type { Client } from './client';
import { CommitNotReachableError, NoCommitsBetweenError, TreeTooLargeError } from './errors';
import type {
  ActionsPublicKey,
  IssueRef,
  NewIssue,
  ActionsSecretInfo,
  ActionsVariable,
  CommitInfo,
  CompareResult,
  GitHubPort,
  IssueComment,
  MergeIntoResult,
  NewCommit,
  NewPullRequest,
  PullMergeability,
  PullRequest,
  RepoFile,
  RepoRef,
  TreeChange,
  TreeEntry,
} from './port';
import { fullName } from './port';

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}

const isStatus = (e: unknown, status: number): boolean => (e as { status?: number } | null)?.status === status;

/** Every human-readable message GitHub attached to an error (top-level + validation errors). */
export function githubErrorMessages(e: unknown): string[] {
  const data = (e as { response?: { data?: { message?: unknown; errors?: unknown } } } | null)?.response?.data;
  const out: string[] = [];
  if (typeof data?.message === 'string') out.push(data.message);
  if (Array.isArray(data?.errors)) {
    for (const err of data.errors) {
      if (typeof err === 'string') out.push(err);
      else if (err && typeof err === 'object') {
        const m = (err as { message?: unknown; code?: unknown }).message ?? (err as { code?: unknown }).code;
        if (typeof m === 'string') out.push(m);
      }
    }
  }
  if (out.length === 0 && e instanceof Error) out.push(e.message);
  return out;
}

const mentions = (e: unknown, re: RegExp): boolean => githubErrorMessages(e).some((m) => re.test(m));

type PullListItem = {
  number: number;
  state: string;
  merged_at: string | null;
  title: string;
  body: string | null;
  labels?: Array<{ name: string }>;
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
  created_at: string;
};

function toPullRequest(p: PullListItem): PullRequest {
  return {
    number: p.number,
    state: p.state === 'open' ? 'open' : 'closed',
    merged: p.merged_at !== null,
    title: p.title,
    body: p.body ?? '',
    labels: (p.labels ?? []).map((l) => l.name),
    createdAt: p.created_at,
    headRef: p.head.ref,
    headSha: p.head.sha,
    baseRef: p.base.ref,
    htmlUrl: p.html_url,
  };
}

/** {@link GitHubPort} over Octokit (one installation). All retry/rate-limit handling is in the client. */
export class OctokitPort implements GitHubPort {
  constructor(readonly client: Client) {}

  async readFile(repo: RepoRef, path: string, ref?: string): Promise<RepoFile | null> {
    try {
      const res = await this.client.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: repo.owner,
        repo: repo.repo,
        path,
        ...(ref ? { ref } : {}),
      });
      const data = res.data;
      if (Array.isArray(data) || data.type !== 'file') return null;
      if (!('content' in data) || data.encoding !== 'base64' || !data.content) {
        throw new Error(`${path} is too large to read through the contents API (>1 MB)`);
      }
      return { text: decodeBase64Utf8(data.content), sha: data.sha };
    } catch (e) {
      if (isStatus(e, 404)) return null;
      throw e;
    }
  }

  async listPullRequestFiles(repo: RepoRef, pullNumber: number): Promise<string[]> {
    const files = await this.client.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    return files.filter((f) => f.status !== 'removed').map((f) => f.filename);
  }

  async findCommentByMarker(repo: RepoRef, issueNumber: number, marker: string): Promise<IssueComment | null> {
    const iterator = this.client.paginate.iterator('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    for await (const page of iterator) {
      const hit = page.data.find((c) => typeof c.body === 'string' && c.body.includes(marker));
      if (hit) return { id: Number(hit.id), body: hit.body ?? '' };
    }
    return null;
  }

  async createComment(repo: RepoRef, issueNumber: number, body: string): Promise<IssueComment> {
    const res = await this.client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issueNumber,
      body,
    });
    return { id: Number(res.data.id), body: res.data.body ?? body };
  }

  async updateComment(repo: RepoRef, commentId: number, body: string): Promise<void> {
    await this.client.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
      owner: repo.owner,
      repo: repo.repo,
      comment_id: commentId,
      body,
    });
  }

  // ---- refs ---------------------------------------------------------------------------------

  async getBranchSha(repo: RepoRef, branch: string): Promise<string | null> {
    try {
      const res = await this.client.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner: repo.owner,
        repo: repo.repo,
        ref: `heads/${branch}`,
      });
      return res.data.object.sha;
    } catch (e) {
      if (isStatus(e, 404)) return null;
      throw e;
    }
  }

  async createBranch(repo: RepoRef, branch: string, sha: string): Promise<'created' | 'exists'> {
    try {
      await this.client.request('POST /repos/{owner}/{repo}/git/refs', {
        owner: repo.owner,
        repo: repo.repo,
        ref: `refs/heads/${branch}`,
        sha,
      });
      return 'created';
    } catch (e) {
      if (isStatus(e, 422) && mentions(e, /reference already exists/i)) return 'exists';
      if ((isStatus(e, 422) || isStatus(e, 404)) && mentions(e, /object does not exist|not a valid object|no commit found/i)) {
        throw new CommitNotReachableError(fullName(repo), sha);
      }
      throw e;
    }
  }

  async setBranchSha(repo: RepoRef, branch: string, sha: string, force: boolean): Promise<void> {
    try {
      await this.client.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
        owner: repo.owner,
        repo: repo.repo,
        ref: `heads/${branch}`,
        sha,
        force,
      });
    } catch (e) {
      if ((isStatus(e, 422) || isStatus(e, 404)) && mentions(e, /object does not exist|not a valid object/i)) {
        throw new CommitNotReachableError(fullName(repo), sha);
      }
      throw e;
    }
  }

  // ---- compare / merge ----------------------------------------------------------------------

  async compare(repo: RepoRef, base: string, head: string): Promise<CompareResult> {
    try {
      const res = await this.client.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
        owner: repo.owner,
        repo: repo.repo,
        basehead: `${base}...${head}`,
        per_page: 30,
      });
      const d = res.data;
      return {
        status: d.status as CompareResult['status'],
        aheadBy: d.ahead_by,
        behindBy: d.behind_by,
        htmlUrl: d.html_url,
        commits: d.commits.map((c) => ({
          sha: c.sha,
          subject: (c.commit.message ?? '').split('\n')[0] ?? '',
          ...(c.author?.login ? { author: c.author.login } : c.commit.author?.name ? { author: c.commit.author.name } : {}),
        })),
      };
    } catch (e) {
      // 404 "No common ancestor" / "Not Found": a SHA this repo cannot see.
      if (isStatus(e, 404) || (isStatus(e, 422) && mentions(e, /no commit found|not a valid/i))) {
        // Report the commit, not the `owner:` qualifier the engine put in front of it.
        throw new CommitNotReachableError(fullName(repo), head.replace(/^[^:/]+:/, ''));
      }
      throw e;
    }
  }

  async mergeIntoBranch(repo: RepoRef, branch: string, head: string, message: string): Promise<MergeIntoResult> {
    try {
      const res = await this.client.request('POST /repos/{owner}/{repo}/merges', {
        owner: repo.owner,
        repo: repo.repo,
        base: branch,
        head,
        commit_message: message,
      });
      // 204 = "Nothing to merge": the branch already contains head.
      if ((res.status as number) === 204 || !res.data) return { result: 'up_to_date' };
      return { result: 'merged', sha: res.data.sha };
    } catch (e) {
      if (isStatus(e, 409)) return { result: 'conflict' };
      if ((isStatus(e, 404) || isStatus(e, 422)) && mentions(e, /not found|does not exist|no commit found/i)) {
        throw new CommitNotReachableError(fullName(repo), head);
      }
      throw e;
    }
  }

  // ---- pull requests ------------------------------------------------------------------------

  async findOpenPullRequest(repo: RepoRef, headBranch: string, baseBranch: string): Promise<PullRequest | null> {
    const res = await this.client.request('GET /repos/{owner}/{repo}/pulls', {
      owner: repo.owner,
      repo: repo.repo,
      state: 'open',
      head: `${repo.owner}:${headBranch}`,
      base: baseBranch,
      per_page: 5,
    });
    const hit = res.data.find((p) => p.head.ref === headBranch);
    return hit ? toPullRequest(hit) : null;
  }

  async listClosedPullRequests(repo: RepoRef, headBranch: string, baseBranch: string, limit: number): Promise<PullRequest[]> {
    const res = await this.client.request('GET /repos/{owner}/{repo}/pulls', {
      owner: repo.owner,
      repo: repo.repo,
      state: 'closed',
      head: `${repo.owner}:${headBranch}`,
      base: baseBranch,
      sort: 'updated',
      direction: 'desc',
      per_page: Math.min(Math.max(limit, 1), 100),
    });
    return res.data.filter((p) => p.head.ref === headBranch).map(toPullRequest);
  }

  async createPullRequest(repo: RepoRef, input: NewPullRequest): Promise<{ pr: PullRequest; created: boolean }> {
    try {
      const res = await this.client.request('POST /repos/{owner}/{repo}/pulls', {
        owner: repo.owner,
        repo: repo.repo,
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft,
        maintainer_can_modify: false,
      });
      return { pr: toPullRequest(res.data as unknown as PullListItem), created: true };
    } catch (e) {
      if (isStatus(e, 422)) {
        if (mentions(e, /no commits between/i)) throw new NoCommitsBetweenError(input.head, input.base);
        if (mentions(e, /pull request already exists/i)) {
          const existing = await this.findOpenPullRequest(repo, input.head, input.base);
          if (existing) return { pr: existing, created: false };
        }
      }
      throw e;
    }
  }

  async updatePullRequest(
    repo: RepoRef,
    pullNumber: number,
    patch: { title?: string; body?: string; state?: 'closed' },
  ): Promise<void> {
    await this.client.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pullNumber,
      ...patch,
    });
  }

  // ---- git data -----------------------------------------------------------------------------

  async getCommitInfo(repo: RepoRef, sha: string): Promise<CommitInfo> {
    try {
      const res = await this.client.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
        owner: repo.owner,
        repo: repo.repo,
        commit_sha: sha,
      });
      return { treeSha: res.data.tree.sha, committerDate: res.data.committer.date };
    } catch (e) {
      if (isStatus(e, 404) || isStatus(e, 422)) throw new CommitNotReachableError(fullName(repo), sha);
      throw e;
    }
  }

  async getTreeEntries(repo: RepoRef, treeSha: string): Promise<TreeEntry[]> {
    let res;
    try {
      res = await this.client.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
        owner: repo.owner,
        repo: repo.repo,
        tree_sha: treeSha,
        recursive: '1',
      });
    } catch (e) {
      // Through a fork, the tree of a commit pushed to the PARENT a moment ago answers 422 "Invalid object
      // requested" for a few seconds (observed live: ~3 s; the commit itself is readable in under one).
      // Not a failure of the repo, so say "not reachable (yet)" and let the engine retry.
      if (isStatus(e, 404) || isStatus(e, 422)) throw new CommitNotReachableError(fullName(repo), treeSha);
      throw e;
    }
    if (res.data.truncated) throw new TreeTooLargeError(fullName(repo));
    const entries: TreeEntry[] = [];
    for (const e of res.data.tree) {
      if ((e.type === 'blob' || e.type === 'commit') && e.path && e.mode && e.sha) {
        entries.push({ path: e.path, mode: e.mode, type: e.type, sha: e.sha });
      }
    }
    return entries;
  }

  async createTree(repo: RepoRef, baseTreeSha: string, changes: TreeChange[]): Promise<string> {
    const res = await this.client.request('POST /repos/{owner}/{repo}/git/trees', {
      owner: repo.owner,
      repo: repo.repo,
      base_tree: baseTreeSha,
      tree: changes.map((c) =>
        c.content !== undefined
          ? { path: c.path, mode: c.mode as '100644', type: c.type, content: c.content }
          : // `sha: null` removes the path from the base tree.
            { path: c.path, mode: c.mode as '100644', type: c.type, sha: c.sha as string },
      ),
    });
    return res.data.sha;
  }

  async createCommit(repo: RepoRef, commit: NewCommit): Promise<string> {
    const res = await this.client.request('POST /repos/{owner}/{repo}/git/commits', {
      owner: repo.owner,
      repo: repo.repo,
      message: commit.message,
      tree: commit.treeSha,
      parents: commit.parents,
      ...(commit.identity ? { author: commit.identity, committer: commit.identity } : {}),
    });
    return res.data.sha;
  }

  async getMergeability(repo: RepoRef, pullNumber: number): Promise<PullMergeability> {
    const res = await this.client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pullNumber,
    });
    return { mergeable: res.data.mergeable ?? null, state: res.data.mergeable_state ?? 'unknown' };
  }

  async removeLabel(repo: RepoRef, issueNumber: number, label: string): Promise<void> {
    try {
      await this.client.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
        owner: repo.owner,
        repo: repo.repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch (e) {
      if (!isStatus(e, 404)) throw e; // already gone
    }
  }

  // ---- Actions secrets and variables ----------------------------------------------------------

  async getActionsPublicKey(repo: RepoRef): Promise<ActionsPublicKey> {
    const res = await this.client.request('GET /repos/{owner}/{repo}/actions/secrets/public-key', {
      owner: repo.owner,
      repo: repo.repo,
    });
    return { keyId: res.data.key_id, key: res.data.key };
  }

  async putActionsSecret(repo: RepoRef, name: string, encryptedValue: string, keyId: string): Promise<'created' | 'updated'> {
    const res = await this.client.request('PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
      owner: repo.owner,
      repo: repo.repo,
      secret_name: name,
      encrypted_value: encryptedValue,
      key_id: keyId,
    });
    return (res.status as number) === 201 ? 'created' : 'updated';
  }

  async listActionsSecrets(repo: RepoRef): Promise<ActionsSecretInfo[]> {
    const rows = await this.client.paginate('GET /repos/{owner}/{repo}/actions/secrets', {
      owner: repo.owner,
      repo: repo.repo,
      per_page: 100,
    });
    return rows.map((r) => ({ name: r.name, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  async listActionsVariables(repo: RepoRef): Promise<ActionsVariable[]> {
    const rows = await this.client.paginate('GET /repos/{owner}/{repo}/actions/variables', {
      owner: repo.owner,
      repo: repo.repo,
      per_page: 30, // GitHub's maximum for this endpoint
    });
    return rows.map((r) => ({ name: r.name, value: r.value, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  async createActionsVariable(repo: RepoRef, name: string, value: string): Promise<void> {
    try {
      await this.client.request('POST /repos/{owner}/{repo}/actions/variables', { owner: repo.owner, repo: repo.repo, name, value });
    } catch (e) {
      // Lost a race with another writer: it exists now, so make it say what we want.
      if (isStatus(e, 409) || (isStatus(e, 422) && mentions(e, /already exists/i))) return this.updateActionsVariable(repo, name, value);
      throw e;
    }
  }

  async updateActionsVariable(repo: RepoRef, name: string, value: string): Promise<void> {
    await this.client.request('PATCH /repos/{owner}/{repo}/actions/variables/{name}', {
      owner: repo.owner,
      repo: repo.repo,
      name,
      value,
    });
  }

  // ---- issues (drift report) ----------------------------------------------------------------

  async findOpenIssueByLabelMarker(repo: RepoRef, label: string, marker: string): Promise<IssueRef | null> {
    const iterator = this.client.paginate.iterator('GET /repos/{owner}/{repo}/issues', {
      owner: repo.owner,
      repo: repo.repo,
      state: 'open',
      labels: label,
      per_page: 30,
    });
    for await (const page of iterator) {
      // The issues endpoint also lists pull requests; skip those.
      const hit = page.data.find((i) => !i.pull_request && typeof i.body === 'string' && i.body.includes(marker));
      if (hit) return { number: hit.number, htmlUrl: hit.html_url, body: hit.body ?? '' };
    }
    return null;
  }

  async createIssue(repo: RepoRef, issue: NewIssue): Promise<IssueRef> {
    const res = await this.client.request('POST /repos/{owner}/{repo}/issues', {
      owner: repo.owner,
      repo: repo.repo,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
    });
    return { number: res.data.number, htmlUrl: res.data.html_url, body: res.data.body ?? issue.body };
  }

  async updateIssue(repo: RepoRef, issueNumber: number, patch: { title?: string; body?: string; state?: 'closed' }): Promise<void> {
    await this.client.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issueNumber,
      ...patch,
      ...(patch.state === 'closed' ? { state_reason: 'completed' as const } : {}),
    });
  }

  async addLabels(repo: RepoRef, issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issueNumber,
      labels,
    });
  }

  async addAssignees(repo: RepoRef, issueNumber: number, logins: string[]): Promise<void> {
    if (logins.length === 0) return;
    await this.client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/assignees', {
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issueNumber,
      assignees: logins,
    });
  }

  async requestReviewers(repo: RepoRef, pullNumber: number, reviewers: string[], teamReviewers: string[]): Promise<void> {
    if (reviewers.length === 0 && teamReviewers.length === 0) return;
    await this.client.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers', {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pullNumber,
      reviewers,
      team_reviewers: teamReviewers,
    });
  }
}
