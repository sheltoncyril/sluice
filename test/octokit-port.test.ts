import { describe, expect, it } from 'vitest';
import { ResilientOctokit } from '../src/github/client';
import { CommitNotReachableError, NoCommitsBetweenError, TreeTooLargeError } from '../src/github/errors';
import { OctokitPort } from '../src/github/octokit-port';

const repo = { owner: 'me', repo: 'widget' };

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** An Octokit whose HTTP layer is a script of (method, path-regex) -> response. */
function port(routes: Array<[string, RegExp, Reply | ((s: Seen) => Reply)]>) {
  const seen: Seen[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const s: Seen = {
      method,
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(s);
    const hit = routes.find(([m, re]) => m === method && re.test(s.path));
    if (!hit) return new Response(JSON.stringify({ message: `unmocked ${method} ${s.path}` }), { status: 599 });
    const reply = typeof hit[2] === 'function' ? hit[2](s) : hit[2];
    const res = new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
    // Real fetch responses carry their absolute URL (the paginate plugin reads it); synthetic ones do not.
    Object.defineProperty(res, 'url', { value: String(input) });
    return res;
  };
  const client = new ResilientOctokit({ request: { fetch }, resilience: { maxServerRetries: 0 } } as never);
  return { port: new OctokitPort(client), seen };
}

const pr = (over: Record<string, unknown> = {}) => ({
  number: 7,
  state: 'open',
  merged_at: null,
  title: 'Sync',
  body: 'body',
  head: { ref: 'chain/sync-upstream', sha: 'h'.repeat(40) },
  base: { ref: 'main' },
  html_url: 'https://github.com/me/widget/pull/7',
  ...over,
});

describe('OctokitPort: refs', () => {
  it('getBranchSha reads the exact ref and returns null on 404', async () => {
    const t = port([
      ['GET', /git\/ref\/heads\/chain\/x$/, { status: 200, body: { object: { sha: 'abc' } } }],
      ['GET', /git\/ref\/heads\/nope$/, { status: 404, body: { message: 'Not Found' } }],
    ]);
    expect(await t.port.getBranchSha(repo, 'chain/x')).toBe('abc');
    expect(await t.port.getBranchSha(repo, 'nope')).toBeNull();
  });

  it('createBranch POSTs refs/heads/<branch> and maps GitHub\'s 422s', async () => {
    const ok = port([['POST', /git\/refs$/, { status: 201, body: {} }]]);
    expect(await ok.port.createBranch(repo, 'chain/x', 'a'.repeat(40))).toBe('created');
    expect(ok.seen[0]!.body).toEqual({ ref: 'refs/heads/chain/x', sha: 'a'.repeat(40) });

    const exists = port([['POST', /git\/refs$/, { status: 422, body: { message: 'Reference already exists' } }]]);
    expect(await exists.port.createBranch(repo, 'chain/x', 'a'.repeat(40))).toBe('exists');

    const unreachable = port([['POST', /git\/refs$/, { status: 422, body: { message: 'Object does not exist' } }]]);
    await expect(unreachable.port.createBranch(repo, 'chain/x', 'b'.repeat(40))).rejects.toBeInstanceOf(CommitNotReachableError);

    const other = port([['POST', /git\/refs$/, { status: 403, body: { message: 'Resource not accessible by integration' } }]]);
    await expect(other.port.createBranch(repo, 'chain/x', 'a'.repeat(40))).rejects.toMatchObject({ status: 403 });
  });

  it('setBranchSha PATCHes with the force flag', async () => {
    const t = port([['PATCH', /git\/refs\/heads\/chain\/x$/, { status: 200, body: {} }]]);
    await t.port.setBranchSha(repo, 'chain/x', 'c'.repeat(40), true);
    expect(t.seen[0]!.body).toEqual({ sha: 'c'.repeat(40), force: true });
  });
});

describe('OctokitPort: compare and merge', () => {
  it('compare maps counts and commit subjects, using base...head', async () => {
    const t = port([
      [
        'GET',
        /compare\/main\.\.\.abc$/,
        {
          status: 200,
          body: {
            status: 'diverged',
            ahead_by: 3,
            behind_by: 1,
            html_url: 'https://github.com/me/widget/compare/main...abc',
            commits: [
              { sha: 's1', commit: { message: 'feat: one\n\nlong body', author: { name: 'Ann' } }, author: { login: 'ann' } },
              { sha: 's2', commit: { message: 'fix: two', author: { name: 'Bob' } }, author: null },
            ],
          },
        },
      ],
    ]);
    expect(await t.port.compare(repo, 'main', 'abc')).toEqual({
      status: 'diverged',
      aheadBy: 3,
      behindBy: 1,
      htmlUrl: 'https://github.com/me/widget/compare/main...abc',
      commits: [
        { sha: 's1', subject: 'feat: one', author: 'ann' },
        { sha: 's2', subject: 'fix: two', author: 'Bob' },
      ],
    });
  });

  it('compare turns a 404 into CommitNotReachableError (the "not a fork" signal)', async () => {
    const t = port([['GET', /compare\//, { status: 404, body: { message: 'Not Found' } }]]);
    await expect(t.port.compare(repo, 'main', 'f'.repeat(40))).rejects.toBeInstanceOf(CommitNotReachableError);
  });

  it('mergeIntoBranch distinguishes 201 merged / 204 nothing-to-merge / 409 conflict', async () => {
    const merged = port([['POST', /\/merges$/, { status: 201, body: { sha: 'm'.repeat(40) } }]]);
    expect(await merged.port.mergeIntoBranch(repo, 'chain/x', 'abc', 'msg')).toEqual({ result: 'merged', sha: 'm'.repeat(40) });
    expect(merged.seen[0]!.body).toEqual({ base: 'chain/x', head: 'abc', commit_message: 'msg' });

    const nothing = port([['POST', /\/merges$/, { status: 204 }]]);
    expect(await nothing.port.mergeIntoBranch(repo, 'chain/x', 'abc', 'msg')).toEqual({ result: 'up_to_date' });

    const conflict = port([['POST', /\/merges$/, { status: 409, body: { message: 'Merge conflict' } }]]);
    expect(await conflict.port.mergeIntoBranch(repo, 'chain/x', 'abc', 'msg')).toEqual({ result: 'conflict' });
  });

  it('mergeIntoBranch lets real failures through (e.g. 403)', async () => {
    const t = port([['POST', /\/merges$/, { status: 403, body: { message: 'Resource not accessible by integration' } }]]);
    await expect(t.port.mergeIntoBranch(repo, 'chain/x', 'abc', 'm')).rejects.toMatchObject({ status: 403 });
  });
});

describe('OctokitPort: pull requests', () => {
  it('findOpenPullRequest filters by owner:branch head and base', async () => {
    const t = port([['GET', /\/pulls$/, { status: 200, body: [pr()] }]]);
    const found = await t.port.findOpenPullRequest(repo, 'chain/sync-upstream', 'main');
    expect(found).toMatchObject({ number: 7, state: 'open', merged: false, headRef: 'chain/sync-upstream' });
    const q = t.seen[0]!.query;
    expect(q.get('state')).toBe('open');
    expect(q.get('head')).toBe('me:chain/sync-upstream');
    expect(q.get('base')).toBe('main');
  });

  it('findOpenPullRequest returns null when none match', async () => {
    const t = port([['GET', /\/pulls$/, { status: 200, body: [] }]]);
    expect(await t.port.findOpenPullRequest(repo, 'chain/x', 'main')).toBeNull();
  });

  it('listClosedPullRequests derives merged from merged_at, newest-updated first', async () => {
    const t = port([
      ['GET', /\/pulls$/, { status: 200, body: [pr({ number: 9, state: 'closed', merged_at: '2026-01-01T00:00:00Z' }), pr({ number: 8, state: 'closed' })] }],
    ]);
    const closed = await t.port.listClosedPullRequests(repo, 'chain/sync-upstream', 'main', 5);
    expect(closed.map((p) => [p.number, p.merged])).toEqual([[9, true], [8, false]]);
    expect(t.seen[0]!.query.get('sort')).toBe('updated');
    expect(t.seen[0]!.query.get('direction')).toBe('desc');
  });

  it('createPullRequest opens a same-repo PR', async () => {
    const t = port([['POST', /\/pulls$/, { status: 201, body: pr() }]]);
    const out = await t.port.createPullRequest(repo, { title: 'T', body: 'B', head: 'chain/sync-upstream', base: 'main', draft: true });
    expect(out.created).toBe(true);
    expect(t.seen[0]!.body).toMatchObject({ head: 'chain/sync-upstream', base: 'main', draft: true, maintainer_can_modify: false });
  });

  it('createPullRequest recovers from "a pull request already exists" (lost a race) by returning the existing one', async () => {
    const t = port([
      [
        'POST',
        /\/pulls$/,
        { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for me:chain/sync-upstream.' }] } },
      ],
      ['GET', /\/pulls$/, { status: 200, body: [pr({ number: 3 })] }],
    ]);
    const out = await t.port.createPullRequest(repo, { title: 'T', body: 'B', head: 'chain/sync-upstream', base: 'main', draft: false });
    expect(out).toMatchObject({ created: false, pr: { number: 3 } });
  });

  it('createPullRequest raises NoCommitsBetweenError when head adds nothing', async () => {
    const t = port([
      ['POST', /\/pulls$/, { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'No commits between main and chain/sync-upstream' }] } }],
    ]);
    await expect(
      t.port.createPullRequest(repo, { title: 'T', body: 'B', head: 'chain/sync-upstream', base: 'main', draft: false }),
    ).rejects.toBeInstanceOf(NoCommitsBetweenError);
  });

  it('updatePullRequest can close without merging', async () => {
    const t = port([['PATCH', /\/pulls\/7$/, { status: 200, body: pr() }]]);
    await t.port.updatePullRequest(repo, 7, { state: 'closed' });
    expect(t.seen[0]!.body).toEqual({ state: 'closed' });
  });

  it('labels / assignees / reviewers: skip the call for empty lists, POST otherwise', async () => {
    const t = port([
      ['POST', /\/issues\/7\/labels$/, { status: 200, body: [] }],
      ['POST', /\/issues\/7\/assignees$/, { status: 201, body: {} }],
      ['POST', /\/pulls\/7\/requested_reviewers$/, { status: 201, body: {} }],
    ]);
    await t.port.addLabels(repo, 7, []);
    await t.port.addAssignees(repo, 7, []);
    await t.port.requestReviewers(repo, 7, [], []);
    expect(t.seen).toHaveLength(0);

    await t.port.addLabels(repo, 7, ['sluice']);
    await t.port.addAssignees(repo, 7, ['octocat']);
    await t.port.requestReviewers(repo, 7, ['octocat'], ['core']);
    expect(t.seen.map((s) => s.body)).toEqual([{ labels: ['sluice'] }, { assignees: ['octocat'] }, { reviewers: ['octocat'], team_reviewers: ['core'] }]);
  });
});

describe('OctokitPort: files and comments', () => {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

  it('readFile decodes UTF-8 base64 (with line breaks) and passes the ref', async () => {
    const text = 'name: café ☕\n';
    const wrapped = b64(text).replace(/(.{10})/g, '$1\n');
    const t = port([['GET', /contents\/\.github\/chain\.yml$/, { status: 200, body: { type: 'file', encoding: 'base64', content: wrapped, sha: 'blob1' } }]]);
    expect(await t.port.readFile(repo, '.github/chain.yml', 'abc')).toEqual({ text, sha: 'blob1' });
    expect(t.seen[0]!.query.get('ref')).toBe('abc');
  });

  it('readFile returns null for 404 and for directories', async () => {
    const t = port([
      ['GET', /contents\/missing$/, { status: 404, body: { message: 'Not Found' } }],
      ['GET', /contents\/dir$/, { status: 200, body: [{ type: 'file' }] }],
    ]);
    expect(await t.port.readFile(repo, 'missing')).toBeNull();
    expect(await t.port.readFile(repo, 'dir')).toBeNull();
  });

  it('readFile explains files over the 1 MB contents-API limit', async () => {
    const t = port([['GET', /contents\/big$/, { status: 200, body: { type: 'file', encoding: 'none', content: '', sha: 'x' } }]]);
    await expect(t.port.readFile(repo, 'big')).rejects.toThrow(/too large/);
  });

  it('listPullRequestFiles skips removed files', async () => {
    const t = port([['GET', /pulls\/7\/files$/, { status: 200, body: [{ filename: 'a', status: 'modified' }, { filename: 'b', status: 'removed' }] }]]);
    expect(await t.port.listPullRequestFiles(repo, 7)).toEqual(['a']);
  });

  it('findCommentByMarker stops paginating once it finds the marker', async () => {
    let pages = 0;
    const t = port([
      [
        'GET',
        /issues\/7\/comments$/,
        (s) => {
          pages++;
          const page = Number(s.query.get('page') ?? 1);
          const body = page === 1 ? [{ id: 1, body: 'hello' }] : [{ id: 2, body: 'x <!-- marker --> y' }];
          return { status: 200, body, headers: { link: `<https://api.github.com/repos/me/widget/issues/7/comments?page=${page + 1}>; rel="next"` } };
        },
      ],
    ]);
    expect(await t.port.findCommentByMarker(repo, 7, '<!-- marker -->')).toEqual({ id: 2, body: 'x <!-- marker --> y' });
    expect(pages).toBe(2);
  });
});

describe('OctokitPort: git data (protected paths)', () => {
  it('getCommitInfo returns the tree and committer date; unknown commits are "not reachable"', async () => {
    const t = port([
      ['GET', /git\/commits\/abc$/, { status: 200, body: { tree: { sha: 'tree1' }, committer: { date: '2026-01-02T03:04:05Z' } } }],
      ['GET', /git\/commits\/nope$/, { status: 404, body: { message: 'Not Found' } }],
    ]);
    expect(await t.port.getCommitInfo(repo, 'abc')).toEqual({ treeSha: 'tree1', committerDate: '2026-01-02T03:04:05Z' });
    await expect(t.port.getCommitInfo(repo, 'nope')).rejects.toBeInstanceOf(CommitNotReachableError);
  });

  it('getTreeEntries lists recursively, keeps files and submodules, drops directories', async () => {
    const t = port([
      [
        'GET',
        /git\/trees\/t1$/,
        {
          status: 200,
          body: {
            truncated: false,
            tree: [
              { path: 'src', mode: '040000', type: 'tree', sha: 'd1' },
              { path: 'src/a.ts', mode: '100644', type: 'blob', sha: 'b1' },
              { path: 'vendor/lib', mode: '160000', type: 'commit', sha: 'c1' },
            ],
          },
        },
      ],
    ]);
    expect(await t.port.getTreeEntries(repo, 't1')).toEqual([
      { path: 'src/a.ts', mode: '100644', type: 'blob', sha: 'b1' },
      { path: 'vendor/lib', mode: '160000', type: 'commit', sha: 'c1' },
    ]);
    expect(t.seen[0]!.query.get('recursive')).toBe('1');
  });

  it('getTreeEntries refuses a truncated listing rather than guessing', async () => {
    const t = port([['GET', /git\/trees\/big$/, { status: 200, body: { truncated: true, tree: [] } }]]);
    await expect(t.port.getTreeEntries(repo, 'big')).rejects.toBeInstanceOf(TreeTooLargeError);
  });

  it('createTree sends base_tree, and null shas to delete paths', async () => {
    const t = port([['POST', /git\/trees$/, { status: 201, body: { sha: 'newtree' } }]]);
    const sha = await t.port.createTree(repo, 'base1', [
      { path: 'patches/x', mode: '100644', type: 'blob', sha: 'blob1' },
      { path: 'patches/new', mode: '100644', type: 'blob', sha: null },
    ]);
    expect(sha).toBe('newtree');
    expect(t.seen[0]!.body).toEqual({
      base_tree: 'base1',
      tree: [
        { path: 'patches/x', mode: '100644', type: 'blob', sha: 'blob1' },
        { path: 'patches/new', mode: '100644', type: 'blob', sha: null },
      ],
    });
  });

  it('createCommit uses ONE identity for author and committer (so the hash is deterministic)', async () => {
    const t = port([['POST', /git\/commits$/, { status: 201, body: { sha: 'newcommit' } }]]);
    const identity = { name: 'sluice', email: 'sluice@users.noreply.github.com', date: '2026-01-02T03:04:05Z' };
    expect(await t.port.createCommit(repo, { message: 'm', treeSha: 'tree1', parents: ['p1'], identity })).toBe('newcommit');
    expect(t.seen[0]!.body).toEqual({ message: 'm', tree: 'tree1', parents: ['p1'], author: identity, committer: identity });
  });
});

describe('OctokitPort: mergeability and labels', () => {
  it('getMergeability passes GitHub\'s three answers through: true, false, and "not computed yet"', async () => {
    const answers = [
      { mergeable: true, mergeable_state: 'clean' },
      { mergeable: false, mergeable_state: 'dirty' },
      { mergeable: null, mergeable_state: 'unknown' },
    ];
    let i = 0;
    const t = port([['GET', /pulls\/7$/, () => ({ status: 200, body: answers[i++] })]]);
    expect(await t.port.getMergeability(repo, 7)).toEqual({ mergeable: true, state: 'clean' });
    expect(await t.port.getMergeability(repo, 7)).toEqual({ mergeable: false, state: 'dirty' });
    expect(await t.port.getMergeability(repo, 7)).toEqual({ mergeable: null, state: 'unknown' });
  });

  it('removeLabel encodes names with slashes, and treats an already-missing label as done', async () => {
    const t = port([
      ['DELETE', /issues\/7\/labels\/sluice\/conflict$/, { status: 200, body: [] }],
      ['DELETE', /issues\/7\/labels\/gone$/, { status: 404, body: { message: 'Label does not exist' } }],
      ['DELETE', /issues\/7\/labels\/locked$/, { status: 403, body: { message: 'Resource not accessible by integration' } }],
    ]);
    await t.port.removeLabel(repo, 7, 'sluice/conflict');
    await t.port.removeLabel(repo, 7, 'gone');
    await expect(t.port.removeLabel(repo, 7, 'locked')).rejects.toMatchObject({ status: 403 });
  });

  it('pull request views carry their label names', async () => {
    const t = port([['GET', /\/pulls$/, { status: 200, body: [pr({ labels: [{ name: 'sluice' }, { name: 'sluice/conflict' }] })] }]]);
    expect((await t.port.findOpenPullRequest(repo, 'chain/sync-upstream', 'main'))?.labels).toEqual(['sluice', 'sluice/conflict']);
  });
});

describe('OctokitPort: Actions secrets and variables', () => {
  it('getActionsPublicKey maps key_id and key', async () => {
    const t = port([['GET', /actions\/secrets\/public-key$/, { status: 200, body: { key_id: '012345', key: 'base64key==' } }]]);
    expect(await t.port.getActionsPublicKey(repo)).toEqual({ keyId: '012345', key: 'base64key==' });
  });

  it('putActionsSecret sends ONLY ciphertext and key_id, and maps 201 / 204', async () => {
    const created = port([['PUT', /actions\/secrets\/NPM_TOKEN$/, { status: 201, body: {} }]]);
    expect(await created.port.putActionsSecret(repo, 'NPM_TOKEN', 'Y2lwaGVydGV4dA==', 'k1')).toBe('created');
    expect(created.seen[0]!.body).toEqual({ encrypted_value: 'Y2lwaGVydGV4dA==', key_id: 'k1' });

    const updated = port([['PUT', /actions\/secrets\/NPM_TOKEN$/, { status: 204 }]]);
    expect(await updated.port.putActionsSecret(repo, 'NPM_TOKEN', 'x', 'k1')).toBe('updated');
  });

  it('listActionsSecrets returns names and timestamps (GitHub never returns values)', async () => {
    const t = port([
      ['GET', /actions\/secrets$/, { status: 200, body: { total_count: 1, secrets: [{ name: 'NPM_TOKEN', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' }] } }],
    ]);
    expect(await t.port.listActionsSecrets(repo)).toEqual([{ name: 'NPM_TOKEN', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' }]);
  });

  it('listActionsVariables returns values and asks for GitHub\'s maximum page size', async () => {
    const t = port([
      ['GET', /actions\/variables$/, { status: 200, body: { total_count: 1, variables: [{ name: 'REGION', value: 'eu', created_at: 'c', updated_at: 'u' }] } }],
    ]);
    expect(await t.port.listActionsVariables(repo)).toEqual([{ name: 'REGION', value: 'eu', createdAt: 'c', updatedAt: 'u' }]);
    expect(t.seen[0]!.query.get('per_page')).toBe('30');
  });

  it('createActionsVariable POSTs name and value, and falls back to PATCH if it lost a race', async () => {
    const ok = port([['POST', /actions\/variables$/, { status: 201, body: {} }]]);
    await ok.port.createActionsVariable(repo, 'REGION', 'eu');
    expect(ok.seen[0]!.body).toEqual({ name: 'REGION', value: 'eu' });

    const raced = port([
      ['POST', /actions\/variables$/, { status: 409, body: { message: 'Already exists' } }],
      ['PATCH', /actions\/variables\/REGION$/, { status: 204 }],
    ]);
    await raced.port.createActionsVariable(repo, 'REGION', 'eu');
    expect(raced.seen.map((s) => s.method)).toEqual(['POST', 'PATCH']);
  });

  it('updateActionsVariable PATCHes the named variable', async () => {
    const t = port([['PATCH', /actions\/variables\/REGION$/, { status: 204 }]]);
    await t.port.updateActionsVariable(repo, 'REGION', 'us');
    expect(t.seen[0]!.body).toEqual({ value: 'us' }); // `name` is the URL path parameter, not a body field
  });
});
