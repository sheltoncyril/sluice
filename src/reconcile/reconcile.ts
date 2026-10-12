import { applyVariables } from '../secrets/variables';
import type { VariableChange } from '../secrets/variables';
import { fullName } from '../github/port';
import type { ActionsSecretInfo } from '../github/port';
import { RateLimitExceededError } from '../github/resilient';
import { errorFields, scrubString } from '../log';
import type { Logger } from '../log';
import { buildHopSpec, syncChainHop } from '../sync/chain';
import type { ChainDeps, ChainHandle } from '../sync/chain';
import type { HopResult } from '../sync/hop';
import { resolveTarget } from '../sync/targets';
import type { Role } from '../sync/targets';
import { syncWorkflows } from '../workflows/sync';
import type { WorkflowTargetResult } from '../workflows/sync';
import { publishReport } from './report';
import type { DriftFinding, ReportStatus } from './report';

/**
 * The scheduled reconcile: re-check everything sluice is responsible for and act on drift the way the
 * brief prescribes.
 *
 *   workflow files vs templates  -> a PR (the same machinery as step 6)
 *   variables vs chain.yml       -> fixed directly
 *   secrets                      -> REPORTED, never fixed (GitHub never reveals a value, so only names and
 *                                   timestamps can be compared, and a value can only be set by you)
 *   hop state                    -> re-run midstream -> downstream (heals a missed webhook), and flag
 *                                   conflicted, errored or long-open sync PRs
 *
 * Only things a person must look at become findings; what sluice fixed or opened a PR for does not.
 */

export interface ReconcileOptions {
  trigger: string;
  /** Read-only: report what is wrong, change nothing (no fixes, no PRs, no issue). */
  dryRun: boolean;
}

export interface ReconcileResult {
  chain: string;
  findings: DriftFinding[];
  hops: HopResult[];
  workflows: WorkflowTargetResult[];
  variables: VariableChange[];
  report: ReportStatus;
  reportUrl?: string;
  reportError?: string;
  /** True if a GitHub rate limit cut the run short. */
  partial: boolean;
}

/** Secrets for one declaration should be written together; further apart than this suggests a partial rotation. */
export const SECRET_SKEW_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function reconcileChain(
  deps: ChainDeps,
  handle: ChainHandle,
  opts: ReconcileOptions,
  logger: Logger,
): Promise<ReconcileResult> {
  const chain = fullName(handle.holder);
  const cfg = handle.config;
  const startedAt = deps.now().toISOString();
  const result: ReconcileResult = { chain, findings: [], hops: [], workflows: [], variables: [], report: 'skipped', partial: false };
  const finding = (f: DriftFinding) => result.findings.push(f);

  /** Run one stage; a rate limit ends the whole run, any other failure becomes a finding and the rest continue. */
  const stage = async (name: string, fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (e) {
      if (e instanceof RateLimitExceededError) {
        result.partial = true;
        logger.warn('reconcile stopped: rate limited', { stage: name, retryAfterMs: e.retryAfterMs });
        return false;
      }
      logger.error('reconcile stage failed', { stage: name, ...errorFields(e) });
      finding({ kind: 'hop_error', repo: chain, subject: name, detail: scrubString(e instanceof Error ? e.message : String(e)).slice(0, 200) });
      return true;
    }
  };

  // ---- 1. Variables: fix directly -------------------------------------------------------------
  let go = await stage('variables', async () => {
    const r = await applyVariables(deps, handle, { dryRun: opts.dryRun, trigger: opts.trigger }, logger);
    result.variables = r.changes;
    for (const c of r.changes.filter((c) => c.action === 'error')) {
      finding({ kind: 'variable_error', repo: c.repo, subject: c.name, detail: c.error ?? 'could not be applied' });
    }
  });

  // ---- 2. Workflow files: a PR ------------------------------------------------------------------
  if (go) {
    go = await stage('workflows', async () => {
      const r = await syncWorkflows(deps, handle, { trigger: opts.trigger, dryRun: opts.dryRun }, logger);
      result.workflows = r.targets;
      for (const t of r.targets) {
        if (t.outcome === 'error') {
          finding({ kind: 'workflow_error', repo: t.repo, subject: 'workflow templates', detail: t.message ?? 'could not be synced' });
        } else if (t.outcome === 'conflict') {
          finding({ kind: 'workflow_conflict', repo: t.repo, subject: 'workflow PR', detail: 'cannot be merged cleanly', ...(t.prUrl ? { url: t.prUrl } : {}) });
        }
      }
    });
  }

  // ---- 3. Hop state: heal a missed webhook, flag what needs a human --------------------------------
  if (go) {
    go = await stage('hops', async () => {
      // upstream -> midstream is polled by cron; midstream -> downstream is webhook-driven, so this is
      // its safety net. Both are idempotent.
      const down = await syncChainHop(deps, handle, 'midstream_to_downstream', { trigger: opts.trigger, dryRun: opts.dryRun }, logger);
      result.hops.push(down);
      for (const h of result.hops) {
        const spec = buildHopSpec(handle, h.hop);
        if (h.outcome === 'error') {
          finding({ kind: 'hop_error', repo: fullName(spec.target.repo), subject: h.hop, detail: h.message ?? 'the hop failed' });
        } else if (h.outcome === 'conflict') {
          finding({ kind: 'hop_conflict', repo: fullName(spec.target.repo), subject: h.hop, detail: 'the sync PR cannot be merged cleanly', ...(h.prUrl ? { url: h.prUrl } : {}) });
        }
      }

      // Long-open sync PRs (either hop): somebody is meant to review these.
      const staleMs = cfg.reconcile.stale_pr_days * DAY_MS;
      for (const hop of ['upstream_to_midstream', 'midstream_to_downstream'] as const) {
        const spec = buildHopSpec(handle, hop);
        const t = await resolveTarget(deps, handle, hop === 'upstream_to_midstream' ? 'midstream' : 'downstream');
        if (!t.ok) continue; // already reported by the hop itself
        const open = await t.target.port.findOpenPullRequest(spec.target.repo, spec.syncBranch, spec.target.branch);
        if (open && deps.now().getTime() - Date.parse(open.createdAt) > staleMs) {
          finding({
            kind: 'hop_stale_pr',
            repo: fullName(spec.target.repo),
            subject: `#${open.number} (${hop})`,
            detail: `open for more than ${cfg.reconcile.stale_pr_days} days`,
            url: open.htmlUrl,
          });
        }
      }
    });
  }

  // ---- 4. Secrets: report only -----------------------------------------------------------------------
  if (go) {
    go = await stage('secrets', async () => {
      for (const f of await checkSecrets(deps, handle)) finding(f);
    });
  }

  // ---- 5. Report --------------------------------------------------------------------------------------
  if (!opts.dryRun && cfg.reconcile.report === 'issue' && !result.partial) {
    const who = cfg.pull_requests.assignees.length > 0 ? cfg.pull_requests.assignees : cfg.pull_requests.reviewers;
    const out = await publishReport(handle.midstreamPort, handle.holder, chain, result.findings, { label: cfg.reconcile.issue_label, assignees: who }, logger);
    result.report = out.status;
    if (out.url) result.reportUrl = out.url;
    if (out.error) result.reportError = out.error;
  } else if (!opts.dryRun && cfg.reconcile.report === 'none') {
    result.report = 'none';
  }

  if (!opts.dryRun) {
    const counts: Record<string, number> = {};
    for (const f of result.findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    await deps.store
      .recordRun({
        startedAt,
        finishedAt: deps.now().toISOString(),
        trigger: opts.trigger,
        chain,
        hop: 'reconcile',
        outcome: result.partial ? 'reconcile_partial' : result.findings.length === 0 ? 'reconcile_clean' : 'reconcile_findings',
        detail: { findings: counts, report: result.report, ...(result.reportError ? { reportError: result.reportError } : {}) },
      })
      .catch((e) => logger.error('could not write run log', errorFields(e)));
  }
  return result;
}

/**
 * Compare declared secrets with what GitHub reports. GitHub returns names and timestamps only, so this
 * can find a MISSING secret, one OLDER than its rotation policy, or one whose targets were written far
 * apart (a rotation that only half succeeded). It can never say whether a value is right.
 */
async function checkSecrets(deps: ChainDeps, handle: ChainHandle): Promise<DriftFinding[]> {
  const declared = handle.config.secrets;
  if (declared.length === 0) return [];
  const findings: DriftFinding[] = [];
  const now = deps.now().getTime();

  const roles = [...new Set(declared.flatMap((s) => s.targets))] as Role[];
  const known = new Map<Role, { repo: string; secrets: Map<string, ActionsSecretInfo> }>();
  for (const role of roles) {
    const t = await resolveTarget(deps, handle, role);
    if (!t.ok) {
      findings.push({ kind: 'secret_check_error', repo: fullName(t.repo), subject: 'secrets', detail: t.error });
      continue;
    }
    try {
      const list = await t.target.port.listActionsSecrets(t.target.repo);
      known.set(role, { repo: fullName(t.target.repo), secrets: new Map(list.map((s) => [s.name, s])) });
    } catch (e) {
      if (e instanceof RateLimitExceededError) throw e;
      findings.push({
        kind: 'secret_check_error',
        repo: fullName(t.target.repo),
        subject: 'secrets',
        detail: `could not list secrets: ${scrubString(e instanceof Error ? e.message : 'unknown error').slice(0, 150)} (does the app have "Secrets: Read & write"?)`,
      });
    }
  }

  for (const decl of declared) {
    const present: Array<{ repo: string; updatedAt: string }> = [];
    for (const role of decl.targets) {
      const k = known.get(role);
      if (!k) continue; // the listing failed; already reported
      const info = k.secrets.get(decl.name);
      if (!info) {
        findings.push({ kind: 'secret_missing', repo: k.repo, subject: decl.name, detail: 'is declared in chain.yml but does not exist in this repo' });
        continue;
      }
      present.push({ repo: k.repo, updatedAt: info.updatedAt });
      if (decl.max_age_days !== undefined) {
        const ageDays = Math.floor((now - Date.parse(info.updatedAt)) / DAY_MS);
        if (ageDays > decl.max_age_days) {
          findings.push({
            kind: 'secret_stale',
            repo: k.repo,
            subject: decl.name,
            detail: `was last updated ${info.updatedAt} (${ageDays} days ago), older than the ${decl.max_age_days}-day rotation policy`,
          });
        }
      }
    }
    if (present.length >= 2) {
      const times = present.map((p) => Date.parse(p.updatedAt));
      if (Math.max(...times) - Math.min(...times) > SECRET_SKEW_MS) {
        findings.push({
          kind: 'secret_skew',
          repo: present.map((p) => p.repo).join(', '),
          subject: decl.name,
          detail: `was written at different times (${present.map((p) => `${p.repo}: ${p.updatedAt}`).join('; ')}); a rotation may have only partly succeeded, so submit it again`,
        });
      }
    }
  }
  return findings;
}
