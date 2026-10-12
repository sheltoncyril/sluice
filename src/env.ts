import type { LogLevel } from './log';
import { parseLogLevel } from './log';

/** Cloudflare bindings. Secrets are set with `wrangler secret put`; vars live in wrangler.jsonc. */
export interface Env {
  DB: D1Database;

  // Worker secrets (unavoidable, per the threat model in the README)
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string; // PKCS#8 PEM
  GITHUB_WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;

  // Plain vars
  ALLOWED_OWNERS?: string;
  LOG_LEVEL?: string;
}

export interface RuntimeConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  adminToken: string;
  /** Lower-cased account logins this Worker may act on. */
  allowedOwners: ReadonlySet<string>;
  logLevel: LogLevel;
}

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid Worker configuration: ${problems.join('; ')}`);
    this.name = 'EnvError';
  }
}

/**
 * Validate bindings once per isolate. Error messages name the *variables* that are wrong, never
 * their values.
 */
export function parseEnv(env: Partial<Env>): RuntimeConfig {
  const problems: string[] = [];
  const need = (name: keyof Env): string => {
    const v = env[name];
    if (typeof v !== 'string' || v.trim() === '') {
      problems.push(`${name} is not set`);
      return '';
    }
    return v;
  };

  const appId = need('GITHUB_APP_ID');
  const privateKey = need('GITHUB_APP_PRIVATE_KEY');
  const webhookSecret = need('GITHUB_WEBHOOK_SECRET');
  const adminToken = need('ADMIN_TOKEN');

  const allowedOwners = new Set(
    (env.ALLOWED_OWNERS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowedOwners.size === 0) {
    problems.push('ALLOWED_OWNERS is empty (refusing to act on any installation; see README)');
  }

  if (appId && !/^\d+$/.test(appId.trim())) problems.push('GITHUB_APP_ID must be numeric');
  if (adminToken && adminToken.length < 24) problems.push('ADMIN_TOKEN must be at least 24 characters');

  if (problems.length > 0) throw new EnvError(problems);

  return {
    appId: appId.trim(),
    privateKey,
    webhookSecret,
    adminToken,
    allowedOwners,
    logLevel: parseLogLevel(env.LOG_LEVEL),
  };
}
