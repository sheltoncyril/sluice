import { App } from '@octokit/app';
import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import type { Logger } from '../log';
import { errorFields } from '../log';
import { assertKeyImports, normalizePrivateKey } from './key';
import { resiliencePlugin } from './resilient';
import type { ResilienceOptions, RetryInfo } from './resilient';

/** Octokit with pagination + our retry/rate-limit handling. Installation clients inherit it. */
export const ResilientOctokit = Octokit.plugin(paginateRest, resiliencePlugin);
export type Client = InstanceType<typeof ResilientOctokit>;

export interface GitHubAppOptions {
  appId: string;
  privateKey: string;
  logger: Logger;
  resilience?: ResilienceOptions;
}

export interface InstallationSummary {
  id: number;
  login: string;
  accountType: string;
  repositorySelection: string;
  suspended: boolean;
}

const INSTALLATION_CACHE_MS = 10 * 60 * 1000;

/**
 * Thin wrapper over @octokit/app: App JWT (RS256 via WebCrypto, PKCS#8 key) and per-installation
 * tokens. Tokens are minted and cached in-memory by @octokit/auth-app (they live ~1h and are never
 * written anywhere); we only hold on to installation *ids*.
 */
export class GitHubApp {
  private readonly app: App;
  private readonly privateKey: string;
  private readonly installationIds = new Map<string, { id: number | null; at: number }>();
  private keyChecked: Promise<void> | undefined;

  constructor(private readonly opts: GitHubAppOptions) {
    const privateKey = normalizePrivateKey(opts.privateKey);
    this.privateKey = privateKey;
    const { logger, resilience } = opts;
    const Resilient = ResilientOctokit.defaults({
      userAgent: 'chain-sync',
      resilience: {
        ...resilience,
        onRetry: (info: RetryInfo) => {
          logger.warn('github request retry', { ...info });
          resilience?.onRetry?.(info);
        },
      },
    });
    this.app = new App({
      appId: opts.appId,
      privateKey,
      Octokit: Resilient as unknown as typeof Octokit,
    });
  }

  /** Fail early, with an actionable message, if the key is PKCS#1 or otherwise unusable. */
  ensureKeyUsable(): Promise<void> {
    this.keyChecked ??= assertKeyImports(this.privateKey).catch((e) => {
      this.keyChecked = undefined; // allow a retry after the operator fixes the secret
      throw e;
    });
    return this.keyChecked;
  }

  /** Octokit authenticated as the App itself (JWT). Only /app/* and installation lookups work. */
  get asApp(): Client {
    return this.app.octokit as unknown as Client;
  }

  /** Octokit authenticated as one installation. Token minting/caching is handled by auth-app. */
  async forInstallation(installationId: number): Promise<Client> {
    await this.ensureKeyUsable();
    return (await this.app.getInstallationOctokit(installationId)) as unknown as Client;
  }

  /**
   * Find the installation that covers `owner/repo`. Returns null when the app is not installed there
   * (or the repo does not exist). Results are cached briefly; installations rarely change.
   */
  async installationIdForRepo(owner: string, repo: string): Promise<number | null> {
    const key = `${owner}/${repo}`.toLowerCase();
    const hit = this.installationIds.get(key);
    if (hit && Date.now() - hit.at < INSTALLATION_CACHE_MS) return hit.id;

    await this.ensureKeyUsable();
    let id: number | null = null;
    try {
      const res = await this.asApp.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
      id = res.data.id;
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
    this.installationIds.set(key, { id, at: Date.now() });
    return id;
  }

  /** Octokit for the installation that covers `owner/repo`, or null if the app is not installed. */
  async forRepo(owner: string, repo: string): Promise<Client | null> {
    const id = await this.installationIdForRepo(owner, repo);
    return id === null ? null : this.forInstallation(id);
  }

  async listInstallations(): Promise<InstallationSummary[]> {
    await this.ensureKeyUsable();
    const rows = await this.asApp.paginate('GET /app/installations', { per_page: 100 });
    return rows.map((i) => {
      const account = i.account as { login?: string; slug?: string } | null;
      return {
      id: i.id,
      login: account?.login ?? account?.slug ?? 'unknown',
      accountType: i.target_type,
      repositorySelection: i.repository_selection,
      suspended: i.suspended_at !== null,
      };
    });
  }

  /** Repos an installation can see (archived and disabled ones excluded: nothing to sync there). */
  async listInstallationRepos(installationId: number): Promise<Array<{ owner: string; repo: string }>> {
    const client = await this.forInstallation(installationId);
    const repos = await client.paginate('GET /installation/repositories', { per_page: 100 });
    return repos.filter((r) => !r.archived && !r.disabled).map((r) => ({ owner: r.owner.login, repo: r.name }));
  }

  /** Who am I? Used by /admin/whoami to prove the JWT + key conversion work in the deployed Worker. */
  async describe(): Promise<{
    app: { id: number; slug: string | null; name: string; permissions: Record<string, string>; events: string[] };
    installations: InstallationSummary[];
  }> {
    await this.ensureKeyUsable();
    try {
      const { data } = await this.asApp.request('GET /app');
      if (!data) throw new Error('GET /app returned no data; is this client authenticated as the App?');
      const installations = await this.listInstallations();
      return {
        app: {
          id: data.id,
          slug: data.slug ?? null,
          name: data.name,
          permissions: (data.permissions ?? {}) as Record<string, string>,
          events: data.events ?? [],
        },
        installations,
      };
    } catch (e) {
      this.opts.logger.error('describe app failed', errorFields(e));
      throw e;
    }
  }
}
