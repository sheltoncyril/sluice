import { guardBotBranches } from '../github/guard';
import { NoCommitsBetweenError } from '../github/errors';
import type { PullRequest } from '../github/port';
import { fullName } from '../github/port';
import { RateLimitExceededError } from '../github/resilient';
import type { Logger } from '../log';
import { errorFields, scrubString } from '../log';
import type { ChainDeps, ChainHandle } from '../sync/chain';
import { conflictPolicyOf, prMetaOf } from '../sync/chain';
import { awaitMergeable, reconcileConflict } from '../sync/conflict';
import type { MergeabilityPolling } from '../sync/conflict';
import { decoratePullRequest } from '../sync/pr-meta';
import { resolveTarget } from '../sync/targets';
import type { Role } from '../sync/targets';
import {
  digestOf,
  finishFile,
  managedHeader,
  parseWorkflowsMarker,
  renderTemplate,
  renderWorkflowsMarker,
  validateWorkflowYaml,
} from './render';

/**
 * Workflow template PRs.
 *
 * Templates live in midstream (`workflows.templates_path`). For each target repo they are rendered with
 * that repo's values and committed to a bot branch (`workflows.branch`, always chain/*), and a PR opens
 * from it. Nothing reaches a tracked branch without your merge.
 *
 * Idempotent in the same structural way as hop sync: compare the desired files with what the target
 * has; write only what differs; an existing PR is refreshed in place; a PR you closed unmerged is not
 * reopened until the rendered content changes (the PR body carries a digest of the content).
 */

export type WorkflowOutcome =
  | 'up_to_date'
  | 'pr_opened'
  | 'pr_updated'
  | 'pr_unchanged'
  | 'stale_pr_closed'
  | 'skipped_rejected'
  | 'conflict'
  | 'rate_limited'
  | 'error'
  | 'dry_run';

export interface WorkflowTargetResult {
  target: Role;
  repo: string;
  outcome: WorkflowOutcome;
  /** Managed files whose content in the target differs from the rendered template. */
  drift: string[];
  prNumber?: number;
  prUrl?: string;
  conflicted?: boolean;
  message?: string;
}

export interface WorkflowsResult {
  targets: WorkflowTargetResult[];
}

export interface WorkflowsOptions {
  trigger: string;
  dryRun: boolean;
  polling?: MergeabilityPolling;
}

const TITLE = 'Update managed workflows (sluice)';

export async function syncWorkflows(
  deps: ChainDeps,
  handle: ChainHandle,
  opts: WorkflowsOptions,
  logger: Logger,
): Promise<WorkflowsResult> {
  const files = handle.config.workflows.files;
  const targets: WorkflowTargetResult[] = [];
  if (files.length === 0) return { targets };

  for (const role of ['midstream', 'downstream'] as const) {
    if (!files.some((f) => f.targets.includes(role))) continue;
    const startedAt = deps.now().toISOString();

    let result: WorkflowTargetResult;
    try {
      result = await syncTarget(deps, handle, role, opts, logger);
    } catch (e) {
      const limited = e instanceof RateLimitExceededError;
      logger.error(limited ? 'workflow sync stopped: rate limited' : 'workflow sync failed', { role, ...errorFields(e) });
      result = {
        target: role,
        repo: role === 'midstream' ? fullName(handle.holder) : handle.config.downstream.repo,
        outcome: limited ? 'rate_limited' : 'error',
        drift: [],
        message: scrubString(e instanceof Error ? e.message : String(e)).slice(0, 400),
      };
    }
    targets.push(result);

    if (!opts.dryRun) {
      await deps.store
        .recordRun({
          startedAt,
          finishedAt: deps.now().toISOString(),
          trigger: opts.trigger,
          chain: fullName(handle.holder),
          hop: 'workflows',
          outcome: result.outcome,
          ...(result.prNumber !== undefined ? { prNumber: result.prNumber } : {}),
          detail: { target: result.target, repo: result.repo, files: result.drift, ...(result.message ? { message: result.message } : {}) },
        })
        .catch((e) => logger.error('could not write run log', errorFields(e)));
    }
    if (result.outcome === 'rate_limited') break;
  }
  return { targets };
}

/** GitHub refuses workflow-file writes from an app that lacks the Workflows permission; say so plainly. */
function withWorkflowsHint(e: unknown): unknown {
  const status = (e as { status?: number } | null)?.status;
  const message = e instanceof Error ? e.message : '';
  if ((status === 403 || status === 404 || status === 422) && /workflow/i.test(message)) {
    return new Error(
      'GitHub refused to write under .github/workflows/. The GitHub App needs the "Workflows: Read & write" ' +
        'repository permission (and the installation must have accepted it). GitHub said: ' +
        scrubString(message).slice(0, 200),
    );
  }
  return e;
}

async function syncTarget(
  deps: ChainDeps,
  handle: ChainHandle,
  role: Role,
  opts: WorkflowsOptions,
  logger: Logger,
): Promise<WorkflowTargetResult> {
  const resolved = await resolveTarget(deps, handle, role);
  if (!resolved.ok) {
    return { target: role, repo: fullName(resolved.repo), outcome: 'error', drift: [], message: resolved.error };
  }
  const { repo, port, branch: base } = resolved.target;
  const repoName = fullName(repo);
  const cfg = handle.config;
  const wf = cfg.workflows;
  const out = guardBotBranches(port);
  const base_ = { target: role, repo: repoName } as const;
  const fail = (message: string): WorkflowTargetResult => ({ ...base_, outcome: 'error', drift: [], message });

  // ---- 1. What should the files contain? ----------------------------------------------------
  const vars: Record<string, string> = {
    ...Object.fromEntries(Object.entries(wf.values).map(([k, v]) => [k, String(v)])),
    // Built-ins last, so a template can always trust them (the schema also forbids redefining them).
    repo: repoName,
    owner: repo.owner,
    name: repo.repo,
    branch: base,
    role,
    upstream_repo: cfg.upstream.repo,
    midstream_repo: cfg.midstream.repo,
    downstream_repo: cfg.downstream.repo,
  };

  const desired = new Map<string, string>();
  const sources = new Map<string, string>();
  const problems: string[] = [];
  for (const f of wf.files.filter((f) => f.targets.includes(role))) {
    const templatePath = `${wf.templates_path}/${f.template}`;
    // Templates and chain.yml are both read from midstream's default branch.
    const template = await handle.midstreamPort.readFile(handle.holder, templatePath);
    if (!template) {
      problems.push(`template ${templatePath} was not found in ${fullName(handle.holder)}`);
      continue;
    }
    const rendered = renderTemplate(template.text, vars, f.template);
    if (!rendered.ok) {
      problems.push(rendered.error);
      continue;
    }
    const text = finishFile(managedHeader(fullName(handle.holder), templatePath), rendered.text);
    const invalid = validateWorkflowYaml(text, f.template);
    if (invalid) {
      problems.push(invalid);
      continue;
    }
    desired.set(f.destination, text);
    sources.set(f.destination, templatePath);
  }
  if (problems.length > 0) return fail(problems.join('; '));

  // ---- 2. What does the target have? -----------------------------------------------------------
  const baseSha = await out.getBranchSha(repo, base);
  if (!baseSha) return fail(`target branch ${base} does not exist in ${repoName}`);

  const status = new Map<string, 'new' | 'modified'>();
  for (const [dest, text] of desired) {
    const current = await out.readFile(repo, dest, base);
    if (!current) status.set(dest, 'new');
    else if (current.text !== text) status.set(dest, 'modified');
  }
  const drift = [...status.keys()].sort();

  const open = await out.findOpenPullRequest(repo, wf.branch, base);
  let closedCache: PullRequest[] | undefined;
  const closed = async () => (closedCache ??= await out.listClosedPullRequests(repo, wf.branch, base, 10));

  // ---- 3. Nothing to do ---------------------------------------------------------------------------
  if (drift.length === 0) {
    if (opts.dryRun) return { ...base_, outcome: open ? 'dry_run' : 'up_to_date', drift };
    if (open) {
      await out.createComment(
        repo,
        open.number,
        `sluice: the managed workflow files in \`${base}\` already match their templates, so this PR is no longer needed. Closing it.`,
      );
      await out.updatePullRequest(repo, open.number, { state: 'closed' });
      return { ...base_, outcome: 'stale_pr_closed', drift, prNumber: open.number, prUrl: open.htmlUrl };
    }
    return { ...base_, outcome: 'up_to_date', drift };
  }

  const digest = await digestOf([...desired].map(([path, content]) => ({ path, content })));
  const latestClosed = !open ? (await closed())[0] : undefined;
  // You closed a PR for exactly this content: wait until the templates or values change.
  const rejected = !!latestClosed && !latestClosed.merged && parseWorkflowsMarker(latestClosed.body) === digest;

  if (opts.dryRun) return { ...base_, outcome: rejected ? 'skipped_rejected' : 'dry_run', drift };
  if (rejected) {
    return {
      ...base_,
      outcome: 'skipped_rejected',
      drift,
      prNumber: latestClosed!.number,
      prUrl: latestClosed!.htmlUrl,
      message: `PR #${latestClosed!.number} for this exact content was closed without merging; waiting for the templates or values to change`,
    };
  }

  // ---- 4. Put the desired files on the bot branch ----------------------------------------------
  let branchSha = await out.getBranchSha(repo, wf.branch);
  let branchChanged = false;

  if (branchSha && !open) {
    // Leftover from a PR that already landed or was abandoned: reset only when that cannot lose work.
    const latest = (await closed())[0];
    const exactlyMerged = latest?.merged === true && latest.headSha === branchSha;
    const addsNothing = !exactlyMerged && (await out.compare(repo, base, wf.branch)).aheadBy === 0;
    if (exactlyMerged || addsNothing) {
      await out.setBranchSha(repo, wf.branch, baseSha, true);
      branchSha = baseSha;
      branchChanged = true;
    }
  }
  if (!branchSha) {
    const created = await out.createBranch(repo, wf.branch, baseSha);
    branchSha = created === 'created' ? baseSha : await out.getBranchSha(repo, wf.branch);
    branchChanged = branchChanged || created === 'created';
    if (!branchSha) return fail(`could not create branch ${wf.branch} in ${repoName}`);
  }

  const toWrite: string[] = [];
  for (const [dest, text] of desired) {
    const onBranch = await out.readFile(repo, dest, wf.branch);
    if (onBranch?.text !== text) toWrite.push(dest);
  }
  if (toWrite.length > 0) {
    try {
      const info = await out.getCommitInfo(repo, branchSha);
      const treeSha = await out.createTree(
        repo,
        info.treeSha,
        toWrite.map((dest) => ({ path: dest, mode: '100644', type: 'blob' as const, sha: null, content: desired.get(dest)! })),
      );
      // No identity: GitHub attributes the commit to the app and signs it.
      const commit = await out.createCommit(repo, {
        treeSha,
        parents: [branchSha],
        message: `sluice: update managed workflow${toWrite.length === 1 ? '' : 's'}\n\n${toWrite.map((d) => `- ${d}`).join('\n')}`,
      });
      await out.setBranchSha(repo, wf.branch, commit, false);
      branchChanged = true;
    } catch (e) {
      throw withWorkflowsHint(e);
    }
  }

  // ---- 5. Open or refresh the PR -----------------------------------------------------------------------
  const hadConflictLabel = open?.labels.includes(conflictPolicyOf(cfg).label) ?? false;
  const body = (conflicted: boolean) =>
    renderBody({ holder: fullName(handle.holder), repoName, base, branch: wf.branch, digest, status, sources, conflicted });

  let rendered = hadConflictLabel;
  let prBody = body(rendered);
  let pr: { number: number; htmlUrl: string; labels: string[] };
  let created = false;
  let edited = false;

  if (open) {
    if (open.body.replace(/\r\n/g, '\n').trim() !== prBody.trim() || open.title !== TITLE) {
      await out.updatePullRequest(repo, open.number, { title: TITLE, body: prBody });
      edited = true;
    }
    pr = open;
  } else {
    try {
      const res = await out.createPullRequest(repo, { title: TITLE, body: prBody, head: wf.branch, base, draft: cfg.pull_requests.draft });
      pr = res.pr;
      created = res.created;
      if (created) await decoratePullRequest(out, repo, pr.number, prMetaOf(cfg), logger);
    } catch (e) {
      if (e instanceof NoCommitsBetweenError) {
        return { ...base_, outcome: 'up_to_date', drift, message: 'the workflow branch adds nothing over the target branch' };
      }
      throw e;
    }
  }

  const mergeable = await awaitMergeable(out, repo, pr.number, opts.polling, deps.sleep);
  const conflicted = mergeable === null ? hadConflictLabel : !mergeable;
  if (conflicted !== rendered) {
    rendered = conflicted;
    prBody = body(conflicted);
    await out.updatePullRequest(repo, pr.number, { title: TITLE, body: prBody });
    edited = true;
  }
  await reconcileConflict(
    out,
    {
      repo,
      pr: { number: pr.number, labels: pr.labels },
      policy: conflictPolicyOf(cfg),
      syncBranch: wf.branch,
      targetBranch: base,
      sourceName: 'the rendered workflow templates',
      logger,
    },
    conflicted,
  );

  const outcome: WorkflowOutcome = conflicted
    ? 'conflict'
    : created
      ? 'pr_opened'
      : open && (branchChanged || edited)
        ? 'pr_updated'
        : 'pr_unchanged';
  if (outcome !== 'pr_unchanged') logger.info('workflow PR', { repo: repoName, pr: pr.number, outcome });
  return { ...base_, outcome, drift, prNumber: pr.number, prUrl: pr.htmlUrl, conflicted };
}

function renderBody(i: {
  holder: string;
  repoName: string;
  base: string;
  branch: string;
  digest: string;
  status: Map<string, 'new' | 'modified'>;
  sources: Map<string, string>;
  conflicted: boolean;
}): string {
  const rows = [...i.status.keys()].sort().map((dest) => `| \`${dest}\` | \`${i.sources.get(dest)}\` | ${i.status.get(dest)} |`);
  return [
    renderWorkflowsMarker(i.digest),
    '## Update managed workflows',
    '',
    `sluice renders these workflow files from the templates in \`${i.holder}\` for \`${i.repoName}\`:`,
    '',
    '| File | Template | Change |',
    '|---|---|---|',
    ...rows,
    '',
    'Values come from `workflows.values` in `.github/chain.yml`. Merging this PR applies them. A managed file edited directly ' +
      'is overwritten by the next PR, so change the template instead.',
    ...(i.conflicted
      ? [
          '',
          `> ⚠️ **Merge conflicts.** \`${i.branch}\` cannot be merged into \`${i.base}\` automatically. Resolve them by pushing to \`${i.branch}\`; sluice never overwrites commits you push there.`,
        ]
      : []),
    '',
    '---',
    '_Opened by sluice. Nothing here is applied until you merge it._',
  ].join('\n');
}
