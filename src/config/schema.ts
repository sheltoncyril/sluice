import picomatch from 'picomatch';
import { z } from 'zod';

/**
 * Schema for `.github/chain.yml` (lives in the midstream repo, read at runtime via the API).
 *
 * Design rules baked in here, because they are what make "everything goes through a PR" true:
 *  - unknown keys are errors (a typo like `protected_path:` must not silently disable protection);
 *  - sync/workflow branches must live under `chain/` and can never equal a tracked branch;
 *  - secrets are declared by NAME only; there is nowhere in this file to put a secret value.
 */

export const CONFIG_PATH = '.github/chain.yml';
export const CONFIG_VERSION = 1;
export const SYNC_BRANCH_PREFIX = 'chain/';

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TEAM_SLUG_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const ACTIONS_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export const repoSchema = z
  .string({ error: 'must be a string like "owner/name"' })
  .regex(REPO_RE, 'must look like "owner/name" (letters, digits, "-", "_", ".")')
  .refine((r) => !r.endsWith('.git'), 'must not end in ".git"');

/** Conservative subset of `git check-ref-format` for branch names. */
export function isValidBranchName(b: string): boolean {
  if (b.length === 0 || b.length > 255) return false;
  if (b === '@' || b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.')) return false;
  if (b.includes('..') || b.includes('//') || b.includes('@{')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(b)) return false;
  return !b.split('/').some((seg) => seg.startsWith('.') || seg.endsWith('.lock'));
}

const branchSchema = z
  .string({ error: 'must be a branch name' })
  .refine(isValidBranchName, 'is not a valid git branch name');

const syncBranchSchema = branchSchema.refine(
  (b) => b.startsWith(SYNC_BRANCH_PREFIX) && b.length > SYNC_BRANCH_PREFIX.length,
  `must start with "${SYNC_BRANCH_PREFIX}" so bot branches can never collide with real ones`,
);

const loginSchema = z.string().regex(LOGIN_RE, 'must be a GitHub username');
const teamSchema = z.string().regex(TEAM_SLUG_RE, 'must be a team slug (not "org/team")');
const labelSchema = z.string().min(1, 'must not be empty').max(50, 'must be 50 characters or fewer');

/** Relative, forward-slash, no traversal. */
function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 255) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return !p.split('/').some((seg) => seg === '..' || seg === '');
}

const relativePathSchema = z.string().refine(isSafeRelativePath, 'must be a relative path with no "..", "//" or backslashes');

/** A picomatch glob. Trailing "/" is shorthand for "everything under". */
const protectedPathSchema = z
  .string({ error: 'must be a glob string' })
  .min(1, 'must not be empty')
  .max(200, 'is too long')
  .refine((p) => !p.startsWith('/'), 'must be relative to the repo root (no leading "/")')
  .refine((p) => !p.startsWith('!'), 'negation ("!") is not supported; list what you want to protect')
  .refine((p) => !p.includes('\\') && !p.includes('\0'), 'must use forward slashes')
  .refine((p) => !p.split('/').includes('..'), 'must not contain ".."')
  .refine((p) => {
    try {
      picomatch.makeRe(p);
      return true;
    } catch {
      return false;
    }
  }, 'is not a valid glob')
  .transform((p) => (p.endsWith('/') ? `${p}**` : p));

const actionsNameSchema = z
  .string()
  .regex(ACTIONS_NAME_RE, 'must be UPPER_SNAKE_CASE (GitHub stores Actions names upper-case; no spaces, no leading digit)')
  .refine((n) => !n.startsWith('GITHUB_'), 'must not start with "GITHUB_" (reserved by GitHub)')
  .max(100);

const targetSchema = z.enum(['midstream', 'downstream'], {
  error: 'must be "midstream" or "downstream" (upstream is third-party; nothing is ever written there)',
});

const targetsSchema = z
  .array(targetSchema)
  .min(1, 'must name at least one target')
  .refine((t) => new Set(t).size === t.length, 'must not repeat a target')
  .default(['midstream', 'downstream']);

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

const trackedRef = z.strictObject({
  repo: repoSchema,
  branch: branchSchema.default('main'),
});

const mergeMethodSchema = z.enum(['merge', 'squash', 'rebase'], {
  error: 'must be "merge", "squash" or "rebase"',
});

const hopBase = {
  /** How YOU will merge sync PRs on this hop. Drives how "already synced" is detected. */
  merge_method: mergeMethodSchema.default('merge'),
  /** Paths whose content on the target must survive a sync (target-only patches). */
  protected_paths: z.array(protectedPathSchema).default([]),
};

const upstreamHop = z.strictObject({
  ...hopBase,
  sync_branch: syncBranchSchema.default('chain/sync-upstream'),
  poll_interval_minutes: z
    .number({ error: 'must be a number of minutes' })
    .int('must be a whole number of minutes')
    .min(5, 'must be at least 5')
    .max(10_080, 'must be at most 10080 (one week)')
    .default(60),
});

const downstreamHop = z.strictObject({
  ...hopBase,
  sync_branch: syncBranchSchema.default('chain/sync-midstream'),
});

const pullRequestsSchema = z.strictObject({
  labels: z.array(labelSchema).default(['chain-sync']),
  assignees: z.array(loginSchema).default([]),
  reviewers: z.array(loginSchema).default([]),
  team_reviewers: z.array(teamSchema).default([]),
  draft: z.boolean().default(false),
});

const conflictsSchema = z.strictObject({
  label: labelSchema.default('chain-sync/conflict'),
  comment: z.boolean().default(true),
  /** Falls back to pull_requests.reviewers, then pull_requests.assignees, when empty. */
  assignees: z.array(loginSchema).default([]),
  request_review: z.boolean().default(true),
});

const workflowFileSchema = z.strictObject({
  template: relativePathSchema,
  destination: z
    .string()
    .regex(
      /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/,
      'must be a file directly under .github/workflows/ ending in .yml or .yaml',
    ),
  targets: targetsSchema,
});

const workflowsSchema = z.strictObject({
  templates_path: relativePathSchema.default('templates'),
  branch: syncBranchSchema.default('chain/workflows'),
  values: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'template variable names must be identifiers'),
      z.union([z.string(), z.number(), z.boolean()]),
    )
    .default({}),
  files: z.array(workflowFileSchema).default([]),
});

const variableSchema = z.strictObject({
  name: actionsNameSchema,
  value: z.string({ error: 'must be a string (variables are non-sensitive; put secrets under `secrets`, by name only)' }).max(48_000),
  targets: targetsSchema,
});

/** Secrets are declared by NAME. There is deliberately no `value` key: unknown keys are rejected. */
const secretSchema = z.strictObject({
  name: actionsNameSchema,
  targets: targetsSchema,
});

// ---------------------------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------------------------

export const chainConfigSchema = z
  .strictObject({
    version: z.literal(CONFIG_VERSION, { error: `must be ${CONFIG_VERSION}` }),

    upstream: trackedRef,
    midstream: trackedRef,
    downstream: trackedRef,

    /**
     * How sync branches are seeded in the target repo.
     *  - fork:     the target is a GitHub fork in the source's network; refs can point at source SHAs.
     *  - git-data: unrelated repos; copy objects via the git-data API (NOT IMPLEMENTED YET).
     */
    transport: z.enum(['fork', 'git-data'], { error: 'must be "fork" or "git-data"' }).default('fork'),

    hops: z
      .strictObject({
        upstream_to_midstream: upstreamHop.prefault({}),
        midstream_to_downstream: downstreamHop.prefault({}),
      })
      .prefault({}),

    pull_requests: pullRequestsSchema.prefault({}),
    conflicts: conflictsSchema.prefault({}),

    workflows: workflowsSchema.prefault({}),
    variables: z.array(variableSchema).default([]),
    secrets: z.array(secretSchema).default([]),
  })
  .superRefine((cfg, ctx) => {
    const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });

    // Three distinct repos.
    const repos: Array<['upstream' | 'midstream' | 'downstream', string]> = [
      ['upstream', cfg.upstream.repo.toLowerCase()],
      ['midstream', cfg.midstream.repo.toLowerCase()],
      ['downstream', cfg.downstream.repo.toLowerCase()],
    ];
    for (let i = 0; i < repos.length; i++) {
      for (let j = i + 1; j < repos.length; j++) {
        if (repos[i]![1] === repos[j]![1]) {
          add([repos[j]![0], 'repo'], `is the same repository as ${repos[i]![0]}.repo; a chain needs three distinct repos`);
        }
      }
    }

    // Bot branches must not be tracked branches, and must not clash with each other.
    for (const role of ['upstream', 'midstream', 'downstream'] as const) {
      if (cfg[role].branch.startsWith(SYNC_BRANCH_PREFIX)) {
        add([role, 'branch'], `must not start with "${SYNC_BRANCH_PREFIX}" (reserved for bot branches)`);
      }
    }
    const botBranches: Array<[string[], string]> = [
      [['hops', 'upstream_to_midstream', 'sync_branch'], cfg.hops.upstream_to_midstream.sync_branch],
      [['hops', 'midstream_to_downstream', 'sync_branch'], cfg.hops.midstream_to_downstream.sync_branch],
      [['workflows', 'branch'], cfg.workflows.branch],
    ];
    for (let i = 0; i < botBranches.length; i++) {
      for (let j = i + 1; j < botBranches.length; j++) {
        if (botBranches[i]![1] === botBranches[j]![1]) {
          add(botBranches[j]![0], `duplicates ${botBranches[i]![0].join('.')} ("${botBranches[i]![1]}"); bot branches must be distinct`);
        }
      }
    }

    // Unique names per target for variables and secrets.
    const seen = (items: Array<{ name: string; targets: string[] }>, key: 'variables' | 'secrets') => {
      const bucket = new Set<string>();
      items.forEach((item, idx) => {
        for (const t of item.targets) {
          const id = `${t}:${item.name}`;
          if (bucket.has(id)) add([key, idx, 'name'], `"${item.name}" is declared more than once for ${t}`);
          bucket.add(id);
        }
      });
    };
    seen(cfg.variables, 'variables');
    seen(cfg.secrets, 'secrets');

    // One workflow destination per target.
    const dest = new Set<string>();
    cfg.workflows.files.forEach((f, idx) => {
      for (const t of f.targets) {
        const id = `${t}:${f.destination}`;
        if (dest.has(id)) add(['workflows', 'files', idx, 'destination'], `"${f.destination}" is written twice for ${t}`);
        dest.add(id);
      }
    });
  });

export type ChainConfig = z.output<typeof chainConfigSchema>;
export type HopId = 'upstream_to_midstream' | 'midstream_to_downstream';
export type MergeMethod = z.output<typeof mergeMethodSchema>;
