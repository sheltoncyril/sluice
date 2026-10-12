import type { GitHubApp } from './client';
import { OctokitPort } from './octokit-port';
import type { GitHubPort, RepoRef } from './port';

/** Hands out installation-scoped ports. The seam that lets tests swap GitHub for a fake. */
export interface PortFactory {
  forInstallation(installationId: number): Promise<GitHubPort>;
  /** Port for whichever installation covers `repo`, or null when the app is not installed there. */
  forRepo(repo: RepoRef): Promise<GitHubPort | null>;
}

export function octokitPortFactory(app: GitHubApp): PortFactory {
  return {
    async forInstallation(id) {
      return new OctokitPort(await app.forInstallation(id));
    },
    async forRepo(repo) {
      const client = await app.forRepo(repo.owner, repo.repo);
      return client ? new OctokitPort(client) : null;
    },
  };
}
