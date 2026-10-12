import { RateLimitExceededError } from '../github/resilient';
import { fullName } from '../github/port';
import type { Logger } from '../log';
import { errorFields, scrubString } from '../log';
import type { ChainDeps, ChainHandle } from '../sync/chain';
import { resolveTarget } from '../sync/targets';
import type { Role } from '../sync/targets';

export type VariableAction = 'created' | 'updated' | 'unchanged' | 'error';

export interface VariableChange {
  target: Role;
  repo: string;
  name: string;
  action: VariableAction;
  error?: string;
}

export interface VariablesResult {
  changes: VariableChange[];
  /** True if anything differed from chain.yml (before fixing it, or in a dry run). */
  drifted: boolean;
}

/**
 * Make each target repo's Actions variables match `variables:` in chain.yml. Variables are not secret,
 * so this is applied directly through the API (no PR): chain.yml on midstream's default branch is the
 * thing you reviewed and merged. Only the declared names are touched; other variables are left alone.
 * Idempotent: a variable that already has the right value costs one list call and no writes.
 */
export async function applyVariables(
  deps: ChainDeps,
  handle: ChainHandle,
  opts: { dryRun: boolean; trigger: string },
  logger: Logger,
): Promise<VariablesResult> {
  const declared = handle.config.variables;
  const changes: VariableChange[] = [];
  if (declared.length === 0) return { changes, drifted: false };

  const startedAt = deps.now().toISOString();
  let rateLimited = false;

  for (const role of ['midstream', 'downstream'] as const) {
    const wanted = declared.filter((v) => v.targets.includes(role));
    if (wanted.length === 0) continue;

    const resolved = await resolveTarget(deps, handle, role);
    if (!resolved.ok) {
      for (const v of wanted) {
        changes.push({ target: role, repo: fullName(resolved.repo), name: v.name, action: 'error', error: resolved.error });
      }
      continue;
    }
    const { repo, port } = resolved.target;
    const repoName = fullName(repo);

    try {
      if (rateLimited) throw new Error('skipped after a GitHub rate limit');
      const existing = new Map((await port.listActionsVariables(repo)).map((v) => [v.name, v.value]));
      for (const v of wanted) {
        const current = existing.get(v.name);
        if (current === v.value) {
          changes.push({ target: role, repo: repoName, name: v.name, action: 'unchanged' });
          continue;
        }
        const action = current === undefined ? 'created' : 'updated';
        if (!opts.dryRun) {
          if (current === undefined) await port.createActionsVariable(repo, v.name, v.value);
          else await port.updateActionsVariable(repo, v.name, v.value);
          logger.info('variable applied', { chain: fullName(handle.holder), repo: repoName, name: v.name, action });
        }
        changes.push({ target: role, repo: repoName, name: v.name, action });
      }
    } catch (e) {
      if (e instanceof RateLimitExceededError) rateLimited = true;
      logger.warn('could not apply variables', { repo: repoName, ...errorFields(e) });
      const message = scrubString(e instanceof Error ? e.message : 'unknown error').slice(0, 300);
      for (const v of wanted.filter((v) => !changes.some((c) => c.repo === repoName && c.name === v.name))) {
        changes.push({ target: role, repo: repoName, name: v.name, action: 'error', error: message });
      }
    }
  }

  const drifted = changes.some((c) => c.action === 'created' || c.action === 'updated');
  if (!opts.dryRun) {
    const errors = changes.filter((c) => c.action === 'error').length;
    await deps.store
      .recordRun({
        startedAt,
        finishedAt: deps.now().toISOString(),
        trigger: opts.trigger,
        chain: fullName(handle.holder),
        hop: 'variables',
        outcome: errors > 0 ? 'variables_error' : drifted ? 'variables_applied' : 'variables_unchanged',
        // Names and actions only.
        detail: { changes: changes.filter((c) => c.action !== 'unchanged').map((c) => ({ repo: c.repo, name: c.name, action: c.action })) },
      })
      .catch((e) => logger.error('could not write run log', errorFields(e)));
  }
  return { changes, drifted };
}
