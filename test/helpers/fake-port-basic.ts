import type { GitHubPort, IssueComment, RepoFile, RepoRef } from '../../src/github/port';
import { fullName } from '../../src/github/port';

/** Minimal in-memory GitHubPort for config/PR-comment tests. (The full fake lives in fake-github.ts.) */
export class BasicFakePort implements GitHubPort {
  files = new Map<string, RepoFile>(); // key: `${repo}@${ref ?? ''}:${path}`
  prFiles = new Map<string, string[]>(); // key: `${repo}#${n}`
  comments: Array<IssueComment & { repo: string; issue: number }> = [];
  private nextId = 1;
  calls: string[] = [];

  putFile(repo: string, path: string, text: string, ref = ''): void {
    this.files.set(`${repo}@${ref}:${path}`, { text, sha: `blob-${text.length}` });
  }

  async readFile(repo: RepoRef, path: string, ref?: string): Promise<RepoFile | null> {
    this.calls.push(`readFile ${fullName(repo)} ${path} ${ref ?? ''}`);
    return this.files.get(`${fullName(repo)}@${ref ?? ''}:${path}`) ?? null;
  }
  async listPullRequestFiles(repo: RepoRef, n: number): Promise<string[]> {
    return this.prFiles.get(`${fullName(repo)}#${n}`) ?? [];
  }
  async findCommentByMarker(repo: RepoRef, issue: number, marker: string): Promise<IssueComment | null> {
    const c = this.comments.find((c) => c.repo === fullName(repo) && c.issue === issue && c.body.includes(marker));
    return c ? { id: c.id, body: c.body } : null;
  }
  async createComment(repo: RepoRef, issue: number, body: string): Promise<IssueComment> {
    const c = { id: this.nextId++, body, repo: fullName(repo), issue };
    this.comments.push(c);
    this.calls.push('createComment');
    return { id: c.id, body };
  }
  async updateComment(_repo: RepoRef, id: number, body: string): Promise<void> {
    const c = this.comments.find((c) => c.id === id);
    if (c) c.body = body;
    this.calls.push('updateComment');
  }
}
