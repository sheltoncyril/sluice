import { SYNC_BRANCH_PREFIX } from '../config/schema';
import { ProtectedBranchWriteError } from './errors';
import type { GitHubPort } from './port';

/**
 * "Never push directly to a default branch", enforced at the lowest level we control.
 *
 * Config validation already forces sync branches under chain/, but a bug in the engine (or a future
 * step) must not be able to move any other ref. Every method that moves a ref, or opens a PR from a
 * head branch, is checked here; reads and comments pass through untouched.
 */
export const isBotBranch = (branch: string): boolean =>
  branch.startsWith(SYNC_BRANCH_PREFIX) && branch.length > SYNC_BRANCH_PREFIX.length;

function assertBot(operation: string, branch: unknown): void {
  if (typeof branch !== 'string' || !isBotBranch(branch)) {
    throw new ProtectedBranchWriteError(operation, String(branch));
  }
}

type Guard = (args: unknown[]) => void;

const GUARDS: Partial<Record<keyof GitHubPort, Guard>> = {
  createBranch: ([, branch]) => assertBot('createBranch', branch),
  setBranchSha: ([, branch]) => assertBot('setBranchSha', branch),
  mergeIntoBranch: ([, branch]) => assertBot('mergeIntoBranch', branch),
  createPullRequest: ([, input]) => assertBot('createPullRequest(head)', (input as { head?: unknown } | undefined)?.head),
};

export function guardBotBranches(port: GitHubPort): GitHubPort {
  return new Proxy(port, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const guard = GUARDS[prop as keyof GitHubPort];
      // Port methods return promises, so a violation must be a rejection, never a sync throw.
      return (...args: unknown[]) => {
        try {
          guard?.(args);
        } catch (e) {
          return Promise.reject(e);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
