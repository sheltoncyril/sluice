import { loadChainConfig } from '../config/load';
import { applyVariables } from '../secrets/variables';
import type { VariablesResult } from '../secrets/variables';
import { reconcileChain } from '../reconcile/reconcile';
import type { ReconcileResult } from '../reconcile/reconcile';
import { syncWorkflows } from '../workflows/sync';
import type { WorkflowsResult } from '../workflows/sync';
import { formatIssues } from '../config/parse';
import type { HopId } from '../config/schema';
import { parseRepo } from '../github/port';
import type { Logger } from '../log';
import { isOwnerAllowed } from '../policy';
import { syncChainHop } from './chain';
import type { ChainDeps, ChainHandle } from './chain';
import type { HopResult } from './hop';

export interface AdminSyncInput {
  chain: string; // midstream "owner/name"
  hop: HopId;
  dryRun: boolean;
}

export type AdminError = { ok: false; status: 400 | 403 | 404 | 422; error: string; details?: string };
export type AdminSyncResponse = { ok: true; result: HopResult } | AdminError;

/** Shared by every admin operation: parse, allowlist, installation, config. */
export async function loadChainHandle(
  deps: ChainDeps,
  chain: string,
): Promise<{ ok: true; handle: ChainHandle } | AdminError> {
  let holder;
  try {
    holder = parseRepo(chain);
  } catch {
    return { ok: false, status: 400, error: 'chain must be "owner/name" of the midstream repo' };
  }
  if (!isOwnerAllowed(deps.allowedOwners, holder.owner)) {
    return { ok: false, status: 403, error: `${holder.owner} is not in ALLOWED_OWNERS` };
  }
  const midstreamPort = await deps.ports.forRepo(holder);
  if (!midstreamPort) return { ok: false, status: 404, error: `the app is not installed on ${chain}` };

  const loaded = await loadChainConfig(midstreamPort, holder);
  if (loaded.status === 'missing') return { ok: false, status: 404, error: `${chain} has no .github/chain.yml` };
  if (loaded.status === 'invalid') {
    return { ok: false, status: 422, error: 'chain.yml is invalid', details: formatIssues(loaded.errors) };
  }
  return { ok: true, handle: { holder, config: loaded.config, midstreamPort } };
}

/** "Run this hop now" for operators: the same code path as cron and webhooks, optionally dry-run. */
export async function runAdminSync(deps: ChainDeps, input: AdminSyncInput, logger: Logger): Promise<AdminSyncResponse> {
  const loaded = await loadChainHandle(deps, input.chain);
  if (!loaded.ok) return loaded;
  const result = await syncChainHop(deps, loaded.handle, input.hop, { trigger: 'admin', dryRun: input.dryRun }, logger);
  return { ok: true, result };
}

export interface AdminVariablesInput {
  chain: string;
  dryRun: boolean;
}

export type AdminVariablesResponse = { ok: true; result: VariablesResult } | AdminError;

/** Apply (or preview) the variables: block of chain.yml. */
export async function runAdminVariables(
  deps: ChainDeps,
  input: AdminVariablesInput,
  logger: Logger,
): Promise<AdminVariablesResponse> {
  const loaded = await loadChainHandle(deps, input.chain);
  if (!loaded.ok) return loaded;
  const result = await applyVariables(deps, loaded.handle, { dryRun: input.dryRun, trigger: 'admin' }, logger);
  return { ok: true, result };
}

export type AdminWorkflowsResponse = { ok: true; result: WorkflowsResult } | AdminError;

/** Render the templates and open/refresh the workflow PRs now (or preview with dry_run). */
export async function runAdminWorkflows(
  deps: ChainDeps,
  input: AdminVariablesInput,
  logger: Logger,
): Promise<AdminWorkflowsResponse> {
  const loaded = await loadChainHandle(deps, input.chain);
  if (!loaded.ok) return loaded;
  const result = await syncWorkflows(deps, loaded.handle, { trigger: 'admin', dryRun: input.dryRun }, logger);
  return { ok: true, result };
}

export type AdminReconcileResponse = { ok: true; result: ReconcileResult } | AdminError;

/** Run the full reconcile now. `dry_run` reports drift and changes nothing (no fixes, no PRs, no issue). */
export async function runAdminReconcile(
  deps: ChainDeps,
  input: AdminVariablesInput,
  logger: Logger,
): Promise<AdminReconcileResponse> {
  const loaded = await loadChainHandle(deps, input.chain);
  if (!loaded.ok) return loaded;
  const result = await reconcileChain(deps, loaded.handle, { trigger: 'admin', dryRun: input.dryRun }, logger);
  return { ok: true, result };
}
