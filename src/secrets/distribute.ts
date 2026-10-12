import { loadChainConfig } from '../config/load';
import { formatIssues } from '../config/parse';
import { fullName, parseRepo } from '../github/port';
import { RateLimitExceededError } from '../github/resilient';
import type { Logger } from '../log';
import { errorFields, scrubString } from '../log';
import { isOwnerAllowed } from '../policy';
import type { ChainDeps } from '../sync/chain';
import { resolveTarget } from '../sync/targets';
import type { Role } from '../sync/targets';
import type { SecretSealer } from './sealer';

/** GitHub rejects secrets larger than 48 KB. */
export const MAX_SECRET_BYTES = 48 * 1024;

export interface SecretDeps extends ChainDeps {
  sealer: SecretSealer;
}

export interface SecretInput {
  chain: string; // midstream "owner/name"
  name: string;
  /** The plaintext. Exists only inside this call: never stored, never logged, never returned. */
  value: string;
}

export type TargetStatus = 'created' | 'updated' | 'error' | 'skipped';

export interface TargetResult {
  target: Role;
  repo: string;
  status: TargetStatus;
  /** A sanitised reason; never contains the secret value. */
  error?: string;
}

export type SecretResponse =
  | { ok: true; name: string; results: TargetResult[] }
  | { ok: false; status: 207 | 400 | 403 | 404 | 422 | 502; error: string; results?: TargetResult[]; details?: string };

/** What we are willing to say about a failure: status and a hint, never request or response bodies. */
function describeFailure(e: unknown, secrets: readonly string[]): string {
  const status = (e as { status?: unknown } | null)?.status;
  const hint =
    status === 403 || status === 404
      ? ' (does the GitHub App have the "Secrets: Read & write" permission on this repo?)'
      : status === 422
        ? ' (GitHub rejected the request; the repo key may have rotated, try again)'
        : '';
  const message = e instanceof Error ? e.message : 'unknown error';
  return scrubString(`${message}${hint}`, secrets).slice(0, 300);
}

/**
 * Pass-through secret distribution.
 *
 *   value --(this function, in memory only)--> sealed box --> PUT to each target's Actions secrets
 *
 * The plaintext is never persisted anywhere: not D1, not KV, not a Worker secret, not a log line. It is
 * only ever (1) in this request's memory and (2) inside the sealed box GitHub decrypts server-side.
 * The logger is wrapped so that even an accidental mention of the exact value would be stripped, and
 * the run log records only names, targets and outcomes.
 */
export async function distributeSecret(deps: SecretDeps, input: SecretInput, baseLogger: Logger): Promise<SecretResponse> {
  const logger = baseLogger.withSecrets([input.value]);
  const secrets = [input.value];

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

  // Only names declared in chain.yml can be distributed, and only to the targets declared for them.
  const declared = loaded.config.secrets.find((s) => s.name === input.name);
  if (!declared) {
    return { ok: false, status: 404, error: `"${input.name}" is not declared under secrets: in .github/chain.yml` };
  }

  const handle = { holder, config: loaded.config, midstreamPort };
  const results: TargetResult[] = [];
  let stopped = false;

  for (const role of declared.targets) {
    const resolved = await resolveTarget(deps, handle, role);
    if (!resolved.ok) {
      results.push({ target: role, repo: fullName(resolved.repo), status: 'error', error: resolved.error });
      continue;
    }
    const { repo, port } = resolved.target;
    if (stopped) {
      results.push({ target: role, repo: fullName(repo), status: 'skipped', error: 'skipped after a GitHub rate limit' });
      continue;
    }
    try {
      const key = await port.getActionsPublicKey(repo);
      const sealed = await deps.sealer.seal(input.value, key.key);
      const outcome = await port.putActionsSecret(repo, input.name, sealed, key.keyId);
      results.push({ target: role, repo: fullName(repo), status: outcome });
      logger.info('secret written', { chain: input.chain, name: input.name, repo: fullName(repo), status: outcome });
    } catch (e) {
      if (e instanceof RateLimitExceededError) stopped = true;
      logger.warn('secret write failed', { chain: input.chain, name: input.name, repo: fullName(repo), ...errorFields(e) });
      results.push({ target: role, repo: fullName(repo), status: 'error', error: describeFailure(e, secrets) });
    }
  }

  const failed = results.filter((r) => r.status === 'error' || r.status === 'skipped').length;
  const outcome = failed === 0 ? 'secret_distributed' : failed === results.length ? 'secret_failed' : 'secret_partial';

  // The run log gets names and outcomes only.
  const at = deps.now().toISOString();
  await deps.store
    .recordRun({
      startedAt: at,
      finishedAt: at,
      trigger: 'admin',
      chain: input.chain,
      hop: 'secrets',
      outcome,
      detail: { name: input.name, targets: results.map((r) => ({ repo: r.repo, status: r.status })) },
    })
    .catch((e) => logger.error('could not write run log', errorFields(e)));

  if (failed === 0) return { ok: true, name: input.name, results };
  return {
    ok: false,
    status: failed === results.length ? 502 : 207,
    error:
      failed === results.length
        ? 'the secret was not written to any target'
        : 'the secret was written to some targets but not all; fix the cause and submit it again',
    results,
  };
}
