import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { CommitNotReachableError, NoCommitsBetweenError, TreeTooLargeError } from '../../src/github/errors';
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
} from '../../src/github/port';
import { fullName } from '../../src/github/port';

/**
 * An in-memory GitHub, faithful in the ways the sync engine depends on:
 *  - commits form a DAG with file contents; objects are shared across a fork NETWORK, so a branch in
 *    a fork can point at a commit made in its parent, but an unrelated repo cannot see it;
 *  - the Merges API fast-forwards, creates merge commits, answers "nothing to merge", or conflicts
 *    (file-level three-way merge);
 *  - PRs: one open PR per head/base, "no commits between" refusal, merge / squash / rebase landing.
 * It records every call so tests can assert that an idempotent re-run performs no writes.
 */

interface Commit {
  sha: string;
  seq: number;
  parents: string[];
  files: Record<string, string>;
  treeSha: string;
  date: string;
  message: string;
  author: string;
  network: string;
}

interface FakePr {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  frozenHeadSha?: string;
  labels: Set<string>;
  assignees: Set<string>;
  reviewers: Set<string>;
  draft: boolean;
  createdAt: string;
}

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: Set<string>;
  state: 'open' | 'closed';
}

interface FakeRepo {
  key: string;
  ref: RepoRef;
  network: string;
  defaultBranch: string;
  branches: Map<string, string>;
  prs: FakePr[];
  issues: FakeIssue[];
  /** Actions secrets: only ciphertext and timestamps are kept, like GitHub. */
  secrets: Map<string, { createdAt: string; updatedAt: string; sealed: string; keyId: string }>;
  variables: Map<string, { value: string; createdAt: string; updatedAt: string }>;
  keys: { keyId: string; publicKey: Uint8Array; secretKey: Uint8Array };
  comments: Array<IssueComment & { issue: number }>;
}

export const WRITE_OPS = [
  'createBranch',
  'setBranchSha',
  'mergeIntoBranch',
  'createPullRequest',
  'updatePullRequest',
  'addLabels',
  'removeLabel',
  'createTree',
  'createCommit',
  'createIssue',
  'updateIssue',
  'putActionsSecret',
  'createActionsVariable',
  'updateActionsVariable',
  'addAssignees',
  'requestReviewers',
  'createComment',
  'updateComment',
] as const;

export interface CallRecord {
  op: string;
  repo: string;
  detail?: unknown;
}

export class FakeGitHub implements GitHubPort {
  private commits = new Map<string, Commit>();
  private repos = new Map<string, FakeRepo>();
  private seq = 0;
  private nextPr = 1;
  private nextComment = 1;
  calls: CallRecord[] = [];
  private failures = new Map<string, Error[]>();
  private trees = new Map<string, Record<string, string>>();
  private blobs = new Map<string, string>();
  private mergeableCalls = new Map<string, number>();
  /** GitHub computes mergeability lazily: answer `null` this many times per PR before the real answer. */
  mergeableLag = 0;
  /** Simulate GitHub truncating a recursive tree listing. */
  treesTruncated = false;

  // ---- test scaffolding -------------------------------------------------------------------

  /** Create a repo with an initial commit on `main`. */
  createRepo(name: string, files: Record<string, string> = { 'README.md': 'hello\n' }, network = name): this {
    const [owner, repo] = name.split('/') as [string, string];
    const root = this.makeCommit([], files, 'initial commit', 'owner', network);
    this.repos.set(name.toLowerCase(), {
      key: name.toLowerCase(),
      ref: { owner, repo },
      network,
      defaultBranch: 'main',
      branches: new Map([['main', root.sha]]),
      prs: [],
      comments: [],
      ...this.freshActionsState(),
    });
    return this;
  }

  /** A GitHub fork: same network (shared objects), branches copied. */
  fork(parent: string, child: string): this {
    const p = this.repoByKey(parent);
    const [owner, repo] = child.split('/') as [string, string];
    this.repos.set(child.toLowerCase(), {
      key: child.toLowerCase(),
      ref: { owner, repo },
      network: p.network,
      defaultBranch: p.defaultBranch,
      branches: new Map(p.branches),
      prs: [],
      comments: [],
      ...this.freshActionsState(),
    });
    return this;
  }

  /** Create `name` pointing at the current tip of `from` (test scaffolding; not an API call). */
  branchFrom(repo: string, name: string, from = 'main'): this {
    const r = this.repoByKey(repo);
    r.branches.set(name, r.branches.get(from)!);
    return this;
  }

  /** Add a commit on top of `branch`. A `null` file value deletes the path. */
  commit(repo: string, branch: string, changes: Record<string, string | null>, message = 'change', author = 'dev'): string {
    const r = this.repoByKey(repo);
    const parent = r.branches.get(branch);
    if (!parent) throw new Error(`fake: no branch ${branch} in ${repo}`);
    const files = { ...this.commitOf(parent).files };
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) delete files[path];
      else files[path] = content;
    }
    const c = this.makeCommit([parent], files, message, author, r.network);
    r.branches.set(branch, c.sha);
    return c.sha;
  }

  tip(repo: string, branch: string): string {
    const sha = this.repoByKey(repo).branches.get(branch);
    if (!sha) throw new Error(`fake: no branch ${branch} in ${repo}`);
    return sha;
  }

  hasBranch(repo: string, branch: string): boolean {
    return this.repoByKey(repo).branches.has(branch);
  }

  filesAt(repo: string, branch: string): Record<string, string> {
    return { ...this.commitOf(this.tip(repo, branch)).files };
  }

  /** Is `ancestor` reachable from `branch`'s tip? */
  contains(repo: string, branch: string, ancestor: string): boolean {
    return this.ancestors(this.tip(repo, branch)).has(ancestor);
  }

  prs(repo: string): FakePr[] {
    return this.repoByKey(repo).prs;
  }

  comments(repo: string, issue: number): string[] {
    return this.repoByKey(repo)
      .comments.filter((c) => c.issue === issue)
      .map((c) => c.body);
  }

  /** Land an open PR the way a human would. */
  mergePr(repo: string, number: number, method: 'merge' | 'squash' | 'rebase'): void {
    const r = this.repoByKey(repo);
    const pr = r.prs.find((p) => p.number === number);
    if (!pr || pr.state !== 'open') throw new Error(`fake: PR ${number} is not open`);
    const baseTip = r.branches.get(pr.baseRef)!;
    const headTip = r.branches.get(pr.headRef)!;
    const merged = this.threeWay(baseTip, headTip);
    if (!merged) throw new Error('fake: cannot merge a conflicting PR');
    let sha: string;
    if (method === 'merge') {
      sha = this.ancestors(baseTip).has(headTip)
        ? baseTip
        : this.makeCommit([baseTip, headTip], merged, `Merge PR #${number}`, 'human', r.network).sha;
    } else {
      sha = this.makeCommit([baseTip], merged, `${method} PR #${number}`, 'human', r.network).sha;
    }
    r.branches.set(pr.baseRef, sha);
    pr.frozenHeadSha = headTip;
    pr.state = 'closed';
    pr.merged = true;
  }

  closePrUnmerged(repo: string, number: number): void {
    const pr = this.repoByKey(repo).prs.find((p) => p.number === number)!;
    pr.frozenHeadSha = this.repoByKey(repo).branches.get(pr.headRef) ?? pr.frozenHeadSha;
    pr.state = 'closed';
  }

  /** Make the next call to `op` throw `error` (e.g. a 502, or a race loss). */
  failNext(op: string, error: Error): void {
    this.failures.set(op, [...(this.failures.get(op) ?? []), error]);
  }

  writes(): CallRecord[] {
    return this.calls.filter((c) => (WRITE_OPS as readonly string[]).includes(c.op));
  }

  resetCalls(): void {
    this.calls = [];
  }

  // ---- GitHubPort ---------------------------------------------------------------------------

  async readFile(repo: RepoRef, path: string, ref?: string): Promise<RepoFile | null> {
    const r = this.repo(repo);
    this.record('readFile', r, { path, ref });
    const sha = ref ? (r.branches.get(ref) ?? (this.visible(r, ref) ? ref : undefined)) : r.branches.get(r.defaultBranch);
    if (!sha) return null;
    const text = this.commitOf(sha).files[path];
    return text === undefined ? null : { text, sha: `blob:${text.length}` };
  }

  async listPullRequestFiles(repo: RepoRef, pullNumber: number): Promise<string[]> {
    const r = this.repo(repo);
    const pr = r.prs.find((p) => p.number === pullNumber);
    if (!pr) return [];
    const base = this.commitOf(r.branches.get(pr.baseRef)!).files;
    const head = this.commitOf(r.branches.get(pr.headRef)!).files;
    return Object.keys(head).filter((p) => head[p] !== base[p]);
  }

  async findCommentByMarker(repo: RepoRef, issue: number, marker: string): Promise<IssueComment | null> {
    const c = this.repo(repo).comments.find((c) => c.issue === issue && c.body.includes(marker));
    return c ? { id: c.id, body: c.body } : null;
  }

  async createComment(repo: RepoRef, issue: number, body: string): Promise<IssueComment> {
    const r = this.repo(repo);
    this.record('createComment', r, { issue });
    this.maybeFail('createComment');
    const c = { id: this.nextComment++, body, issue };
    r.comments.push(c);
    return { id: c.id, body };
  }

  async updateComment(repo: RepoRef, id: number, body: string): Promise<void> {
    const r = this.repo(repo);
    this.record('updateComment', r, { id });
    const c = r.comments.find((c) => c.id === id);
    if (c) c.body = body;
  }

  async getBranchSha(repo: RepoRef, branch: string): Promise<string | null> {
    const r = this.repo(repo);
    this.record('getBranchSha', r, { branch });
    this.maybeFail('getBranchSha');
    return r.branches.get(branch) ?? null;
  }

  async createBranch(repo: RepoRef, branch: string, sha: string): Promise<'created' | 'exists'> {
    const r = this.repo(repo);
    this.record('createBranch', r, { branch, sha });
    this.maybeFail('createBranch');
    if (!this.visible(r, sha)) throw new CommitNotReachableError(fullName(repo), sha);
    if (r.branches.has(branch)) return 'exists';
    r.branches.set(branch, sha);
    return 'created';
  }

  async setBranchSha(repo: RepoRef, branch: string, sha: string, force: boolean): Promise<void> {
    const r = this.repo(repo);
    this.record('setBranchSha', r, { branch, sha, force });
    this.maybeFail('setBranchSha');
    if (!this.visible(r, sha)) throw new CommitNotReachableError(fullName(repo), sha);
    const current = r.branches.get(branch);
    if (current && !force && !this.ancestors(sha).has(current)) throw new Error('fake: non-fast-forward without force');
    r.branches.set(branch, sha);
  }

  async compare(repo: RepoRef, base: string, head: string): Promise<CompareResult> {
    const r = this.repo(repo);
    this.record('compare', r, { base, head });
    this.maybeFail('compare');
    const b = this.resolve(r, base);
    const h = this.resolve(r, head);
    const ancB = this.ancestors(b);
    const ancH = this.ancestors(h);
    const headOnly = [...ancH].filter((s) => !ancB.has(s));
    const baseOnly = [...ancB].filter((s) => !ancH.has(s));
    const status = headOnly.length === 0 ? (baseOnly.length === 0 ? 'identical' : 'behind') : baseOnly.length === 0 ? 'ahead' : 'diverged';
    return {
      status,
      aheadBy: headOnly.length,
      behindBy: baseOnly.length,
      htmlUrl: `https://github.com/${fullName(repo)}/compare/${base}...${head}`,
      commits: headOnly
        .map((s) => this.commitOf(s))
        .sort((x, y) => x.seq - y.seq)
        .slice(0, 30)
        .map((c) => ({ sha: c.sha, subject: c.message, author: c.author })),
    };
  }

  async mergeIntoBranch(repo: RepoRef, branch: string, head: string, _message: string): Promise<MergeIntoResult> {
    const r = this.repo(repo);
    this.record('mergeIntoBranch', r, { branch, head });
    this.maybeFail('mergeIntoBranch');
    const baseTip = r.branches.get(branch);
    if (!baseTip) throw new Error(`fake: no branch ${branch}`);
    const headSha = this.resolve(r, head);
    const ancBase = this.ancestors(baseTip);
    if (ancBase.has(headSha)) return { result: 'up_to_date' };
    if (this.ancestors(headSha).has(baseTip)) {
      r.branches.set(branch, headSha); // fast-forward
      return { result: 'merged', sha: headSha };
    }
    const merged = this.threeWay(baseTip, headSha);
    if (!merged) return { result: 'conflict' };
    const c = this.makeCommit([baseTip, headSha], merged, `Merge ${head} into ${branch}`, 'github', r.network);
    r.branches.set(branch, c.sha);
    return { result: 'merged', sha: c.sha };
  }

  async findOpenPullRequest(repo: RepoRef, headBranch: string, baseBranch: string): Promise<PullRequest | null> {
    const r = this.repo(repo);
    this.record('findOpenPullRequest', r, { headBranch, baseBranch });
    const pr = r.prs.find((p) => p.state === 'open' && p.headRef === headBranch && p.baseRef === baseBranch);
    return pr ? this.view(r, pr) : null;
  }

  async listClosedPullRequests(repo: RepoRef, headBranch: string, baseBranch: string, limit: number): Promise<PullRequest[]> {
    const r = this.repo(repo);
    this.record('listClosedPullRequests', r, { headBranch, baseBranch });
    return r.prs
      .filter((p) => p.state === 'closed' && p.headRef === headBranch && p.baseRef === baseBranch)
      .slice()
      .reverse() // most recently closed first (numbers ascend with time in tests)
      .slice(0, limit)
      .map((p) => this.view(r, p));
  }

  async createPullRequest(repo: RepoRef, input: NewPullRequest): Promise<{ pr: PullRequest; created: boolean }> {
    const r = this.repo(repo);
    this.record('createPullRequest', r, { head: input.head, base: input.base });
    this.maybeFail('createPullRequest');
    const existing = r.prs.find((p) => p.state === 'open' && p.headRef === input.head && p.baseRef === input.base);
    if (existing) return { pr: this.view(r, existing), created: false };
    const headSha = r.branches.get(input.head);
    const baseSha = r.branches.get(input.base);
    if (!headSha || !baseSha) throw new Error('fake: head or base branch missing');
    if (this.ancestors(baseSha).has(headSha)) throw new NoCommitsBetweenError(input.head, input.base);
    const pr: FakePr = {
      number: this.nextPr++,
      state: 'open',
      merged: false,
      title: input.title,
      body: input.body,
      headRef: input.head,
      baseRef: input.base,
      labels: new Set(),
      assignees: new Set(),
      reviewers: new Set(),
      draft: input.draft,
      createdAt: this.now(),
    };
    r.prs.push(pr);
    return { pr: this.view(r, pr), created: true };
  }

  async updatePullRequest(repo: RepoRef, number: number, patch: { title?: string; body?: string; state?: 'closed' }): Promise<void> {
    const r = this.repo(repo);
    this.record('updatePullRequest', r, { number, ...patch });
    const pr = r.prs.find((p) => p.number === number);
    if (!pr) throw new Error('fake: no such PR');
    if (patch.title !== undefined) pr.title = patch.title;
    if (patch.body !== undefined) pr.body = patch.body;
    if (patch.state === 'closed') {
      pr.frozenHeadSha = r.branches.get(pr.headRef);
      pr.state = 'closed';
    }
  }

  async addLabels(repo: RepoRef, number: number, labels: string[]): Promise<void> {
    const r = this.repo(repo);
    this.record('addLabels', r, { number, labels });
    this.maybeFail('addLabels');
    labels.forEach((l) => r.prs.find((p) => p.number === number)?.labels.add(l));
  }

  async addAssignees(repo: RepoRef, number: number, logins: string[]): Promise<void> {
    const r = this.repo(repo);
    this.record('addAssignees', r, { number, logins });
    this.maybeFail('addAssignees');
    logins.forEach((l) => r.prs.find((p) => p.number === number)?.assignees.add(l));
  }

  async requestReviewers(repo: RepoRef, number: number, reviewers: string[], _teams: string[]): Promise<void> {
    const r = this.repo(repo);
    this.record('requestReviewers', r, { number, reviewers });
    this.maybeFail('requestReviewers');
    reviewers.forEach((l) => r.prs.find((p) => p.number === number)?.reviewers.add(l));
  }

  async getCommitInfo(repo: RepoRef, sha: string): Promise<CommitInfo> {
    const r = this.repo(repo);
    this.record('getCommitInfo', r, { sha });
    if (!this.visible(r, sha)) throw new CommitNotReachableError(fullName(repo), sha);
    const c = this.commitOf(sha);
    return { treeSha: c.treeSha, committerDate: c.date };
  }

  async getTreeEntries(repo: RepoRef, treeSha: string): Promise<TreeEntry[]> {
    const r = this.repo(repo);
    this.record('getTreeEntries', r, { treeSha });
    if (this.treesTruncated) throw new TreeTooLargeError(fullName(repo));
    const files = this.trees.get(treeSha);
    if (!files) throw new Error(`fake: unknown tree ${treeSha}`);
    return Object.keys(files)
      .sort()
      .map((path) => ({ path, mode: '100644', type: 'blob' as const, sha: this.blobSha(files[path]!) }));
  }

  async createTree(repo: RepoRef, baseTreeSha: string, changes: TreeChange[]): Promise<string> {
    const r = this.repo(repo);
    this.maybeFail('createTree');
    this.record('createTree', r, { baseTreeSha, changes: changes.map((c) => [c.path, c.sha === null ? 'delete' : 'set']) });
    const base = this.trees.get(baseTreeSha);
    if (!base) throw new Error(`fake: unknown base tree ${baseTreeSha}`);
    const files = { ...base };
    for (const c of changes) {
      if (c.content !== undefined) files[c.path] = c.content;
      else if (c.sha === null) delete files[c.path];
      else {
        const content = this.blobs.get(c.sha);
        if (content === undefined) throw new Error(`fake: unknown blob ${c.sha}`);
        files[c.path] = content;
      }
    }
    return this.registerTree(files);
  }

  /** Content-addressed, like git: identical inputs return the identical commit. */
  async createCommit(repo: RepoRef, commit: NewCommit): Promise<string> {
    const r = this.repo(repo);
    this.record('createCommit', r, { parents: commit.parents });
    this.maybeFail('createCommit');
    const sha = this.sha1(`commit:${JSON.stringify([commit.treeSha, commit.parents, commit.message, commit.identity ?? null])}`);
    if (!this.commits.has(sha)) {
      const files = this.trees.get(commit.treeSha);
      if (!files) throw new Error(`fake: unknown tree ${commit.treeSha}`);
      this.commits.set(sha, {
        sha,
        seq: ++this.seq,
        parents: commit.parents,
        files,
        treeSha: commit.treeSha,
        date: commit.identity?.date ?? new Date(Date.UTC(2026, 0, 1) + this.seq * 1000).toISOString(),
        message: commit.message,
        author: commit.identity?.name ?? 'github-app',
        network: r.network,
      });
    }
    return sha;
  }

  async getMergeability(repo: RepoRef, number: number): Promise<PullMergeability> {
    const r = this.repo(repo);
    this.record('getMergeability', r, { number });
    this.maybeFail('getMergeability');
    const key = `${r.key}#${number}`;
    const seen = (this.mergeableCalls.get(key) ?? 0) + 1;
    this.mergeableCalls.set(key, seen);
    if (seen <= this.mergeableLag) return { mergeable: null, state: 'unknown' };
    const pr = r.prs.find((p) => p.number === number);
    if (!pr) throw new Error('fake: no such PR');
    const ok = this.threeWay(r.branches.get(pr.baseRef)!, r.branches.get(pr.headRef)!) !== null;
    return { mergeable: ok, state: ok ? 'clean' : 'dirty' };
  }

  async removeLabel(repo: RepoRef, number: number, label: string): Promise<void> {
    const r = this.repo(repo);
    this.record('removeLabel', r, { number, label });
    r.prs.find((p) => p.number === number)?.labels.delete(label);
  }

  async getActionsPublicKey(repo: RepoRef): Promise<ActionsPublicKey> {
    const r = this.repo(repo);
    this.record('getActionsPublicKey', r);
    this.maybeFail('getActionsPublicKey');
    return { keyId: r.keys.keyId, key: Buffer.from(r.keys.publicKey).toString('base64') };
  }

  async putActionsSecret(repo: RepoRef, name: string, encryptedValue: string, keyId: string): Promise<'created' | 'updated'> {
    const r = this.repo(repo);
    // Deliberately NOT recording the value: only that a write happened (like a log line would).
    this.record('putActionsSecret', r, { name, keyId });
    this.maybeFail('putActionsSecret');
    if (keyId !== r.keys.keyId) throw Object.assign(new Error('key_id does not match'), { status: 422 });
    const now = this.now();
    const existing = r.secrets.get(name);
    r.secrets.set(name, { createdAt: existing?.createdAt ?? now, updatedAt: now, sealed: encryptedValue, keyId });
    return existing ? 'updated' : 'created';
  }

  async listActionsSecrets(repo: RepoRef): Promise<ActionsSecretInfo[]> {
    const r = this.repo(repo);
    this.record('listActionsSecrets', r);
    this.maybeFail('listActionsSecrets');
    return [...r.secrets].map(([name, s]) => ({ name, createdAt: s.createdAt, updatedAt: s.updatedAt }));
  }

  async listActionsVariables(repo: RepoRef): Promise<ActionsVariable[]> {
    const r = this.repo(repo);
    this.record('listActionsVariables', r);
    this.maybeFail('listActionsVariables');
    return [...r.variables].map(([name, v]) => ({ name, ...v }));
  }

  async createActionsVariable(repo: RepoRef, name: string, value: string): Promise<void> {
    const r = this.repo(repo);
    this.record('createActionsVariable', r, { name });
    this.maybeFail('createActionsVariable');
    const now = this.now();
    r.variables.set(name, { value, createdAt: now, updatedAt: now });
  }

  async updateActionsVariable(repo: RepoRef, name: string, value: string): Promise<void> {
    const r = this.repo(repo);
    this.record('updateActionsVariable', r, { name });
    this.maybeFail('updateActionsVariable');
    const existing = r.variables.get(name);
    r.variables.set(name, { value, createdAt: existing?.createdAt ?? this.now(), updatedAt: this.now() });
  }

  async findOpenIssueByLabelMarker(repo: RepoRef, label: string, marker: string): Promise<IssueRef | null> {
    const r = this.repo(repo);
    this.record('findOpenIssueByLabelMarker', r, { label });
    const i = r.issues.find((i) => i.state === 'open' && i.labels.has(label) && i.body.includes(marker));
    return i ? { number: i.number, htmlUrl: `https://github.com/${r.key}/issues/${i.number}`, body: i.body } : null;
  }

  async createIssue(repo: RepoRef, issue: NewIssue): Promise<IssueRef> {
    const r = this.repo(repo);
    this.record('createIssue', r, { title: issue.title });
    this.maybeFail('createIssue');
    const created: FakeIssue = { number: this.nextPr++, title: issue.title, body: issue.body, labels: new Set(issue.labels), state: 'open' };
    r.issues.push(created);
    return { number: created.number, htmlUrl: `https://github.com/${r.key}/issues/${created.number}`, body: created.body };
  }

  async updateIssue(repo: RepoRef, number: number, patch: { title?: string; body?: string; state?: 'closed' }): Promise<void> {
    const r = this.repo(repo);
    this.record('updateIssue', r, { number, ...patch });
    this.maybeFail('updateIssue');
    const i = r.issues.find((i) => i.number === number);
    if (!i) throw new Error('fake: no such issue');
    if (patch.title !== undefined) i.title = patch.title;
    if (patch.body !== undefined) i.body = patch.body;
    if (patch.state) i.state = patch.state;
  }

  issues(repo: string): FakeIssue[] {
    return this.repoByKey(repo).issues;
  }

  /** Forget all issues in a repo (test scaffolding: start a scenario without the history of setting it up). */
  clearIssues(repo: string): void {
    this.repoByKey(repo).issues.length = 0;
  }

  /** Make a PR look old (for stale-PR checks). */
  setPrCreatedAt(repo: string, number: number, iso: string): void {
    const pr = this.repoByKey(repo).prs.find((p) => p.number === number);
    if (pr) pr.createdAt = iso;
  }

  // ---- Actions test scaffolding -------------------------------------------------------------

  /** Settable clock for secret/variable timestamps (ISO strings). */
  nowIso: () => string = (() => {
    let t = Date.UTC(2026, 9, 1);
    return () => new Date((t += 60_000)).toISOString();
  })();

  private now(): string {
    return this.nowIso();
  }

  /** The repo's Actions key pair, so tests can open what the app sealed (with an independent oracle). */
  actionsKeys(repo: string): { publicKey: Uint8Array; secretKey: Uint8Array } {
    const k = this.repoByKey(repo).keys;
    return { publicKey: k.publicKey, secretKey: k.secretKey };
  }

  sealedSecret(repo: string, name: string): string | undefined {
    return this.repoByKey(repo).secrets.get(name)?.sealed;
  }

  secretNames(repo: string): string[] {
    return [...this.repoByKey(repo).secrets.keys()].sort();
  }

  setSecretUpdatedAt(repo: string, name: string, iso: string): void {
    const s = this.repoByKey(repo).secrets.get(name);
    if (s) s.updatedAt = iso;
  }

  variablesOf(repo: string): Record<string, string> {
    return Object.fromEntries([...this.repoByKey(repo).variables].map(([n, v]) => [n, v.value]));
  }

  private freshActionsState() {
    const kp = nacl.box.keyPair();
    return {
      issues: [] as FakeIssue[],
      secrets: new Map(),
      variables: new Map(),
      keys: { keyId: `key-${++this.seq}`, publicKey: kp.publicKey, secretKey: kp.secretKey },
    };
  }

  // ---- internals ------------------------------------------------------------------------------

  private repoByKey(name: string): FakeRepo {
    const r = this.repos.get(name.toLowerCase());
    if (!r) throw new Error(`fake: no repo ${name}`);
    return r;
  }

  private repo(ref: RepoRef): FakeRepo {
    return this.repoByKey(fullName(ref));
  }

  private commitOf(sha: string): Commit {
    const c = this.commits.get(sha);
    if (!c) throw new Error(`fake: unknown commit ${sha}`);
    return c;
  }

  private sha1(text: string): string {
    return createHash('sha1').update(text).digest('hex');
  }

  private registerTree(files: Record<string, string>): string {
    const entries = Object.keys(files)
      .sort()
      .map((p) => [p, this.blobSha(files[p]!)]);
    const sha = this.sha1(`tree:${JSON.stringify(entries)}`);
    this.trees.set(sha, { ...files });
    return sha;
  }

  private blobSha(content: string): string {
    const sha = this.sha1(`blob:${content}`);
    this.blobs.set(sha, content);
    return sha;
  }

  private makeCommit(parents: string[], files: Record<string, string>, message: string, author: string, network: string): Commit {
    const seq = ++this.seq;
    const sha = seq.toString(16).padStart(40, '0');
    const date = new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString();
    const c: Commit = { sha, seq, parents, files, treeSha: this.registerTree(files), date, message, author, network };
    this.commits.set(sha, c);
    return c;
  }

  private visible(r: FakeRepo, sha: string): boolean {
    const c = this.commits.get(sha);
    return !!c && c.network === r.network;
  }

  private resolve(r: FakeRepo, refOrSha: string): string {
    const byBranch = r.branches.get(refOrSha);
    if (byBranch) return byBranch;
    if (this.visible(r, refOrSha)) return refOrSha;
    throw new CommitNotReachableError(fullName(r.ref), refOrSha);
  }

  private ancestors(sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...this.commitOf(s).parents);
    }
    return seen;
  }

  /** File-level three-way merge. Returns the merged tree, or null on conflict. */
  private threeWay(baseTip: string, headTip: string): Record<string, string> | null {
    const ancB = this.ancestors(baseTip);
    const common = [...this.ancestors(headTip)].filter((s) => ancB.has(s));
    if (common.length === 0) return null;
    const mergeBase = common.sort((a, b) => this.ancestors(b).size - this.ancestors(a).size)[0]!;
    const m = this.commitOf(mergeBase).files;
    const b = this.commitOf(baseTip).files;
    const h = this.commitOf(headTip).files;
    const out: Record<string, string> = {};
    for (const path of new Set([...Object.keys(m), ...Object.keys(b), ...Object.keys(h)])) {
      const [mv, bv, hv] = [m[path], b[path], h[path]];
      let v: string | undefined;
      if (bv === hv) v = bv;
      else if (mv === bv) v = hv;
      else if (mv === hv) v = bv;
      else return null; // both sides changed the file differently
      if (v !== undefined) out[path] = v;
    }
    return out;
  }

  private view(r: FakeRepo, p: FakePr): PullRequest {
    return {
      number: p.number,
      state: p.state,
      merged: p.merged,
      title: p.title,
      body: p.body,
      labels: [...p.labels],
      createdAt: p.createdAt,
      headRef: p.headRef,
      headSha: p.frozenHeadSha ?? r.branches.get(p.headRef) ?? '',
      baseRef: p.baseRef,
      htmlUrl: `https://github.com/${r.key}/pull/${p.number}`,
    };
  }

  private record(op: string, r: FakeRepo, detail?: unknown): void {
    this.calls.push({ op, repo: r.key, detail });
  }

  private maybeFail(op: string): void {
    const queue = this.failures.get(op);
    const next = queue?.shift();
    if (next) throw next;
  }
}
