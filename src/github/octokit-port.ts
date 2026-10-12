import type { Client } from './client';
import { CommitNotReachableError, NoCommitsBetweenError } from './errors';
import type {
  CompareResult,
  GitHubPort,
  IssueComment,
  MergeIntoResult,
  NewPullRequest,
  PullRequest,
  RepoFile,
  RepoRef,
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
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
};

function toPullRequest(p: PullListItem): PullRequest {
  return {
    number: p.number,
    state: p.state === 'open' ? 'open' : 'closed',
    merged: p.merged_at !== null,
    title: p.title,
    body: p.body ?? '',
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
        throw new CommitNotReachableError(fullName(repo), head);
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
