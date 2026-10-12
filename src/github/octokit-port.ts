import type { Client } from './client';
import type { GitHubPort, IssueComment, RepoFile, RepoRef } from './port';

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}

const isStatus = (e: unknown, status: number): boolean => (e as { status?: number } | null)?.status === status;

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
}
