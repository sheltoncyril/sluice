import type { RepoRef } from './github/port';

/**
 * The app is public (it has to be, to be installed in two orgs), so anyone can install it and their
 * webhooks arrive signed with our secret. ALLOWED_OWNERS is the only thing that stops a stranger's
 * installation from driving this Worker. Every entry point checks it.
 */
export function isOwnerAllowed(allowed: ReadonlySet<string>, owner: string | undefined | null): boolean {
  return !!owner && allowed.has(owner.toLowerCase());
}

export function isRepoAllowed(allowed: ReadonlySet<string>, repo: RepoRef): boolean {
  return isOwnerAllowed(allowed, repo.owner);
}
