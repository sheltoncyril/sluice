import { describe, expect, it } from 'vitest';
import { ResilientOctokit } from '../src/github/client';
import { CommitNotReachableError, NoCommitsBetweenError } from '../src/github/errors';
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
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
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
