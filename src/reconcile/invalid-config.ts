import type { LoadResult } from '../config/load';
import type { ChainConfig } from '../config/schema';
import type { GitHubPort, RepoRef } from '../github/port';
import { fullName } from '../github/port';
import { errorFields } from '../log';
import type { Logger } from '../log';
import type { Store } from '../store/types';
import { clearConfigInvalid, publishConfigInvalid } from './report';
import type { ReportOutcome } from './report';

export type InvalidConfigLoad = Extract<LoadResult, { status: 'invalid' }>;

/**
 * A chain.yml that no longer validates, however it got that way (a direct push, a hand edit, a schema
 * change after an upgrade), is shown in the same self-updating issue as drift. Without this the only
 * trace is a log line and a `config_invalid` run row, so nobody would notice the chain had stopped.
 *
 * An unreadable file cannot say `reconcile.report: none`, so the opt-out is taken from whatever of it can
 * still be read (see readReportingPreference); a file that is not even YAML reports.
 *
 * Idempotent: an unchanged report is a read and no write, so calling this every scan is safe.
 */
export async function reportInvalidConfig(
  port: GitHubPort,
  holder: RepoRef,
  loaded: InvalidConfigLoad,
  logger: Logger,
): Promise<ReportOutcome> {
  if (loaded.reporting.report === 'none') return { status: 'none' };
  return publishConfigInvalid(
    port,
    holder,
    fullName(holder),
    loaded.errors,
    { label: loaded.reporting.label, assignees: loaded.reporting.assignees },
    logger,
  );
}

/**
 * Called once a chain's config is valid: closes the report written while it was not. Only reads (and
 * does nothing) when no such report exists, and only runs for chains that did not opt out of issues.
 */
export async function clearInvalidConfigReport(
  port: GitHubPort,
  store: Store,
  holder: RepoRef,
  config: ChainConfig,
  logger: Logger,
): Promise<void> {
  if (config.reconcile.report !== 'issue') return;
  const out = await clearConfigInvalid(port, holder, config.reconcile.issue_label, logger);
  if (out.status !== 'closed') return;

  const chain = fullName(holder);
  logger.info('closed the invalid-config report', { chain, ...(out.url ? { url: out.url } : {}) });
  // The report replaced the drift findings while the file was unreadable, so do not wait out the
  // reconcile interval to restore them: make the next reconcile due.
  await store.putHopState(chain, 'reconcile', {}).catch((e) => logger.error('could not reset the reconcile schedule', errorFields(e)));
}

/** The part of a `config_invalid` run row that says what was reported. */
export function reportDetail(report: ReportOutcome | undefined): Record<string, unknown> {
  return report ? { report: report.status, ...(report.error ? { reportError: report.error } : {}) } : {};
}
