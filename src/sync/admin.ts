import { loadChainConfig } from '../config/load';
import { formatIssues } from '../config/parse';
import type { HopId } from '../config/schema';
import { parseRepo } from '../github/port';
import type { Logger } from '../log';
import { isOwnerAllowed } from '../policy';
import { syncChainHop } from './chain';
import type { ChainDeps } from './chain';
import type { HopResult } from './hop';

export interface AdminSyncInput {
  chain: string; // midstream "owner/name"
  hop: HopId;
  dryRun: boolean;
}

export type AdminSyncResponse =
  | { ok: true; result: HopResult }
  | { ok: false; status: 400 | 403 | 404 | 422; error: string; details?: string };

/** "Run this hop now" for operators: the same code path as cron and webhooks, optionally dry-run. */
export async function runAdminSync(deps: ChainDeps, input: AdminSyncInput, logger: Logger): Promise<AdminSyncResponse> {
  let holder;
  try {
    holder = parseRepo(input.chain);
  } catch {
    return { ok: false, status: 400, error: 'chain must be "owner/name" of the midstream repo' };
  }
  if (!isOwnerAllowed(deps.allowedOwners, holder.owner)) {
    return { ok: false, status: 403, error: `${holder.owner} is not in ALLOWED_OWNERS` };
  }
  const midstreamPort = await deps.ports.forRepo(holder);
  if (!midstreamPort) return { ok: false, status: 404, error: `the app is not installed on ${input.chain}` };

  const loaded = await loadChainConfig(midstreamPort, holder);
  if (loaded.status === 'missing') return { ok: false, status: 404, error: `${input.chain} has no .github/chain.yml` };
  if (loaded.status === 'invalid') {
    return { ok: false, status: 422, error: 'chain.yml is invalid', details: formatIssues(loaded.errors) };
  }

  const result = await syncChainHop(
    deps,
    { holder, config: loaded.config, midstreamPort },
    input.hop,
    { trigger: 'admin', dryRun: input.dryRun },
    logger,
  );
  return { ok: true, result };
}
