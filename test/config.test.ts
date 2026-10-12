import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatIssues, formatIssuesMarkdown, parseChainConfig } from '../src/config/parse';
import type { ConfigIssue } from '../src/config/parse';
import { isValidBranchName } from '../src/config/schema';

const MIN = `
version: 1
upstream:   { repo: acme/widget }
midstream:  { repo: me/widget }
downstream: { repo: other-org/widget-deploy }
`;

function errors(yaml: string): ConfigIssue[] {
  const r = parseChainConfig(yaml);
  if (r.ok) throw new Error('expected validation errors but config was accepted');
  return r.errors;
}
const has = (issues: ConfigIssue[], path: string, re?: RegExp) =>
  issues.some((i) => i.path === path && (!re || re.test(i.message)));

describe('chain.yml: accepting good configs', () => {
  it('accepts the shipped example', () => {
    const r = parseChainConfig(readFileSync('examples/chain.yml', 'utf8'));
    expect(r.ok).toBe(true);
  });

  it('fills defaults for a minimal config', () => {
    const r = parseChainConfig(MIN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.config;
    expect(c.upstream.branch).toBe('main');
    expect(c.transport).toBe('fork');
    expect(c.hops.upstream_to_midstream).toMatchObject({
      merge_method: 'merge',
      sync_branch: 'chain/sync-upstream',
      poll_interval_minutes: 60,
      protected_paths: [],
    });
    expect(c.hops.midstream_to_downstream.sync_branch).toBe('chain/sync-midstream');
    expect(c.pull_requests).toMatchObject({ labels: ['sluice'], draft: false });
    expect(c.conflicts).toMatchObject({ label: 'sluice/conflict', comment: true, request_review: true });
    expect(c.workflows.branch).toBe('chain/workflows');
    expect(c.variables).toEqual([]);
    expect(c.secrets).toEqual([]);
  });

  it('defaults targets to both repos and normalises directory-style protected paths', () => {
    const r = parseChainConfig(`${MIN}
secrets: [{ name: NPM_TOKEN }]
hops:
  upstream_to_midstream:
    protected_paths: ["patches/", "docs/**/*.md"]
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.secrets[0]!.targets).toEqual(['midstream', 'downstream']);
    expect(r.config.hops.upstream_to_midstream.protected_paths).toEqual(['patches/**', 'docs/**/*.md']);
  });

  it('treats YAML 1.2 `on`/`yes` as strings (so workflow-ish values survive)', () => {
    const r = parseChainConfig(`${MIN}
workflows:
  values: { trigger: on, flag: yes }
`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.workflows.values).toEqual({ trigger: 'on', flag: 'yes' });
  });

  it('warns (does not fail) on transport: git-data', () => {
    const r = parseChainConfig(`${MIN}\ntransport: git-data\n`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.map((w) => w.path)).toEqual(['transport']);
  });
});

describe('chain.yml: rejecting bad configs', () => {
  it('rejects empty files, non-mappings and oversized files', () => {
    expect(errors('')[0]!.message).toMatch(/empty/);
    expect(errors('- a\n- b\n')[0]!.message).toMatch(/mapping/);
    expect(errors('just a string')[0]!.message).toMatch(/mapping/);
    expect(errors(`${MIN}\n# ${'x'.repeat(70_000)}`)[0]!.message).toMatch(/larger than/);
  });

  it('reports YAML syntax errors with a line number', () => {
    const e = errors('version: 1\nupstream: [unclosed\nmidstream: x\n');
    expect(e[0]!.message).toMatch(/YAML syntax/);
    // YAML reports the unclosed "[" where it notices (line 3), not where it opened.
    expect(e[0]!.line).toBeGreaterThanOrEqual(2);
    expect(e[0]!.line).toBeLessThanOrEqual(4);
  });

  it('rejects duplicate keys and multiple documents', () => {
    expect(errors(`${MIN}\nversion: 1\n`)[0]!.message).toMatch(/YAML syntax/);
    expect(errors(`${MIN}\n---\nversion: 1\n`)[0]!.message).toMatch(/YAML syntax/);
  });

  it('rejects an unsupported or missing version', () => {
    expect(has(errors(MIN.replace('version: 1', 'version: 2')), 'version', /must be 1/)).toBe(true);
    expect(has(errors(MIN.replace('version: 1', '')), 'version')).toBe(true);
  });

  it('requires all three repos, and says so', () => {
    const e = errors('version: 1\nupstream: { repo: a/b }\nmidstream: { repo: c/d }\n');
    expect(has(e, 'downstream', /required/)).toBe(true);
  });

  it('rejects malformed repo names', () => {
    for (const bad of ['widget', 'a/b/c', 'a b/c', '/c', 'a/', 'a/b.git']) {
      const e = errors(MIN.replace('acme/widget', bad));
      expect(has(e, 'upstream.repo'), `"${bad}" should be rejected`).toBe(true);
    }
  });

  it('rejects chains that reuse a repo (case-insensitively)', () => {
    const e = errors(MIN.replace('other-org/widget-deploy', 'ME/Widget'));
    expect(has(e, 'downstream.repo', /same repository as midstream/)).toBe(true);
  });

  it('suggests the right key for typos and flags unknown keys with their position', () => {
    const e = errors(`${MIN}\nvariabless: []\npull_request: {}\n`);
    expect(e.find((i) => i.path === 'variabless')?.message).toMatch(/did you mean "variables"/);
    expect(e.find((i) => i.path === 'pull_request')?.message).toMatch(/did you mean "pull_requests"/);
    expect(e.find((i) => i.path === 'variabless')?.line).toBe(7);
  });

  it('points protected_paths at its real home', () => {
    const e = errors(`${MIN}\nprotected_paths: [patches/**]\n`);
    expect(e.find((i) => i.path === 'protected_paths')?.message).toMatch(/hops\.upstream_to_midstream\.protected_paths/);
  });

  it('rejects unknown merge methods and out-of-range poll intervals', () => {
    const e = errors(`${MIN}
hops:
  upstream_to_midstream: { merge_method: fast-forward, poll_interval_minutes: 1 }
`);
    expect(has(e, 'hops.upstream_to_midstream.merge_method', /merge.*squash.*rebase/)).toBe(true);
    expect(has(e, 'hops.upstream_to_midstream.poll_interval_minutes', /at least 5/)).toBe(true);
  });

  it.each([
    ['absolute', '/etc/passwd', /no leading/],
    ['traversal', '../outside', /\.\./],
    ['negation', '!keep', /negation/],
    ['backslash', 'a\\\\b', /forward slashes/],
  ])('rejects %s protected paths', (_n, glob, re) => {
    const e = errors(`${MIN}\nhops:\n  upstream_to_midstream:\n    protected_paths: ["${glob}"]\n`);
    expect(e.some((i) => i.path.startsWith('hops.upstream_to_midstream.protected_paths') && re.test(i.message))).toBe(true);
  });

  it('refuses sync branches outside chain/ (never touch a real branch)', () => {
    const e = errors(`${MIN}
hops:
  upstream_to_midstream: { sync_branch: main }
  midstream_to_downstream: { sync_branch: release }
workflows: { branch: develop }
`);
    expect(has(e, 'hops.upstream_to_midstream.sync_branch', /must start with "chain\/"/)).toBe(true);
    expect(has(e, 'hops.midstream_to_downstream.sync_branch', /must start with "chain\/"/)).toBe(true);
    expect(has(e, 'workflows.branch', /must start with "chain\/"/)).toBe(true);
  });

  it('refuses tracked branches under chain/ and duplicate bot branches', () => {
    const tracked = errors(MIN.replace('{ repo: me/widget }', '{ repo: me/widget, branch: chain/sync-upstream }'));
    expect(has(tracked, 'midstream.branch', /reserved for bot branches/)).toBe(true);

    const dup = errors(`${MIN}
hops:
  upstream_to_midstream: { sync_branch: chain/x }
  midstream_to_downstream: { sync_branch: chain/x }
`);
    expect(has(dup, 'hops.midstream_to_downstream.sync_branch', /duplicates/)).toBe(true);
  });

  it('rejects invalid branch names', () => {
    for (const b of ['has space', 'a..b', 'x.lock', '-lead', 'trail/', 'a~b', 'a:b', '']) {
      expect(isValidBranchName(b), `"${b}"`).toBe(false);
    }
    for (const b of ['main', 'release/1.2', 'feat/x_y-z']) expect(isValidBranchName(b), b).toBe(true);
  });

  it('has nowhere to put a secret VALUE', () => {
    const e = errors(`${MIN}\nsecrets:\n  - name: NPM_TOKEN\n    value: hunter2\n`);
    expect(has(e, 'secrets[0].value', /unknown key/)).toBe(true);
  });

  it('validates secret and variable names', () => {
    const e = errors(`${MIN}
secrets: [{ name: npm_token }, { name: GITHUB_TOKEN }, { name: "1ABC" }, { name: "HAS SPACE" }]
variables: [{ name: lower, value: x }]
`);
    expect(has(e, 'secrets[0].name', /UPPER_SNAKE_CASE/)).toBe(true);
    expect(has(e, 'secrets[1].name', /GITHUB_/)).toBe(true);
    expect(has(e, 'secrets[2].name')).toBe(true);
    expect(has(e, 'secrets[3].name')).toBe(true);
    expect(has(e, 'variables[0].name')).toBe(true);
  });

  it('never allows upstream as a target', () => {
    const e = errors(`${MIN}\nsecrets: [{ name: NPM_TOKEN, targets: [upstream] }]\n`);
    expect(has(e, 'secrets[0].targets[0]', /upstream is third-party/)).toBe(true);
  });

  it('validates reconcile settings and secret max_age_days', () => {
    const ok = parseChainConfig(`${MIN}\nreconcile:\n  interval_hours: 6\n  report: none\n  stale_pr_days: 3\nsecrets:\n  - { name: A, max_age_days: 90 }\n`);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.reconcile).toMatchObject({ enabled: true, interval_hours: 6, report: 'none', stale_pr_days: 3, issue_label: 'sluice/drift' });
      expect(ok.config.secrets[0]!.max_age_days).toBe(90);
    }
    const bad = errors(`${MIN}\nreconcile: { interval_hours: 0, report: slack, stale_pr_days: 0 }\nsecrets: [{ name: A, max_age_days: 0 }]\n`);
    expect(has(bad, 'reconcile.interval_hours', /at least 1/)).toBe(true);
    expect(has(bad, 'reconcile.report', /"issue" or "none"/)).toBe(true);
    expect(has(bad, 'reconcile.stale_pr_days')).toBe(true);
    expect(has(bad, 'secrets[0].max_age_days', /at least 1/)).toBe(true);
  });

  it('defaults reconcile to daily, with an issue report', () => {
    const r = parseChainConfig(MIN);
    expect(r.ok && r.config.reconcile).toMatchObject({ enabled: true, interval_hours: 24, report: 'issue', stale_pr_days: 14 });
  });

  it('rejects duplicate declarations and empty/duplicate targets', () => {
    const dup = errors(`${MIN}
secrets: [{ name: A, targets: [midstream] }, { name: A, targets: [midstream, downstream] }]
`);
    expect(has(dup, 'secrets[1].name', /more than once for midstream/)).toBe(true);
    expect(has(errors(`${MIN}\nsecrets: [{ name: A, targets: [] }]\n`), 'secrets[0].targets', /at least one/)).toBe(true);
    expect(has(errors(`${MIN}\nsecrets: [{ name: A, targets: [midstream, midstream] }]\n`), 'secrets[0].targets', /repeat/)).toBe(true);
  });

  it('requires variable values to be strings', () => {
    const e = errors(`${MIN}\nvariables: [{ name: REGION, value: 42 }]\n`);
    expect(has(e, 'variables[0].value', /string/)).toBe(true);
  });

  it('confines workflow destinations to .github/workflows and rejects traversal in templates', () => {
    const e = errors(`${MIN}
workflows:
  files:
    - { template: ../secrets.yml, destination: .github/workflows/ci.yml }
    - { template: ci.yml, destination: src/evil.yml }
    - { template: ci.yml, destination: .github/workflows/../../evil.yml }
`);
    expect(has(e, 'workflows.files[0].template')).toBe(true);
    expect(has(e, 'workflows.files[1].destination', /under \.github\/workflows/)).toBe(true);
    expect(has(e, 'workflows.files[2].destination')).toBe(true);
  });

  it('rejects workflow values that shadow a built-in template variable', () => {
    const e = errors(`${MIN}\nworkflows:\n  values: { repo: x, branch: y, node_version: "22" }\n`);
    expect(has(e, 'workflows.values.repo', /built-in/)).toBe(true);
    expect(has(e, 'workflows.values.branch', /built-in/)).toBe(true);
    expect(has(e, 'workflows.values.node_version')).toBe(false);
  });

  it('rejects two templates writing the same destination', () => {
    const e = errors(`${MIN}
workflows:
  files:
    - { template: a.yml, destination: .github/workflows/ci.yml }
    - { template: b.yml, destination: .github/workflows/ci.yml, targets: [downstream] }
`);
    expect(has(e, 'workflows.files[1].destination', /written twice/)).toBe(true);
  });

  it('rejects invalid assignees/reviewers/labels', () => {
    const e = errors(`${MIN}
pull_requests: { assignees: ["bad user"], reviewers: ["-x"], labels: [""], team_reviewers: ["org/team"] }
`);
    expect(has(e, 'pull_requests.assignees[0]')).toBe(true);
    expect(has(e, 'pull_requests.reviewers[0]')).toBe(true);
    expect(has(e, 'pull_requests.labels[0]')).toBe(true);
    expect(has(e, 'pull_requests.team_reviewers[0]', /team slug/)).toBe(true);
  });

  it('reports every field error in one pass, each with line:col', () => {
    const e = errors(`version: 1
upstream: { repo: nope }
midstream: { repo: me/widget, branch: "bad branch" }
downstream: { repo: other/deploy }
hops:
  upstream_to_midstream: { merge_method: yolo }
`);
    expect(e.length).toBeGreaterThanOrEqual(3);
    expect(e.every((i) => i.line !== undefined && i.column !== undefined)).toBe(true);
    expect(e.find((i) => i.path === 'midstream.branch')?.line).toBe(3);
    expect(e.find((i) => i.path === 'hops.upstream_to_midstream.merge_method')?.line).toBe(6);
  });
});

describe('error rendering', () => {
  it('renders plain text with positions', () => {
    const text = formatIssues(errors(`${MIN}\nvariabless: []\n`));
    expect(text).toMatch(/^\.github\/chain\.yml: 1 error/);
    expect(text).toMatch(/7:1\s+variabless unknown key/);
  });

  it('renders markdown for PR comments', () => {
    const md = formatIssuesMarkdown(errors(`${MIN}\nvariabless: []\n`));
    expect(md).toContain('❌');
    expect(md).toContain('`.github/chain.yml:7:1`');
    expect(md).toContain('**`variabless`**');
  });
});
