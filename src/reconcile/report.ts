import { formatIssuesMarkdown } from '../config/parse';
import type { ConfigIssue } from '../config/parse';
import { CONFIG_PATH } from '../config/schema';
import type { GitHubPort, IssueRef, RepoRef } from '../github/port';
import { RateLimitExceededError } from '../github/resilient';
import { errorFields, scrubString } from '../log';
import type { Logger } from '../log';

/** Hidden marker: the report is ONE issue, found by label + marker, edited in place, closed when clear. */
export const DRIFT_MARKER = '<!-- sluice:drift-report -->';

/**
 * Present only in the body written for an unreadable chain.yml. Recovery closes a report carrying it and
 * never a drift report, whose findings only a reconcile can judge.
 */
export const CONFIG_INVALID_MARKER = '<!-- sluice:config-invalid -->';

export type FindingKind =
  | 'secret_missing'
  | 'secret_stale'
  | 'secret_skew'
  | 'secret_check_error'
  | 'hop_error'
  | 'hop_conflict'
  | 'hop_stale_pr'
  | 'workflow_error'
  | 'workflow_conflict'
  | 'variable_error';

/** Something a person has to look at. (Things sluice fixes itself, or opens a PR for, are not findings.) */
export interface DriftFinding {
  kind: FindingKind;
  /** The repo the finding is about. */
  repo: string;
  /** What it is about: a secret name, a file, a branch. */
  subject: string;
  detail: string;
  url?: string;
}

const GROUPS: Array<{ title: string; kinds: FindingKind[]; note?: string }> = [
  {
    title: 'Secrets',
    kinds: ['secret_missing', 'secret_stale', 'secret_skew', 'secret_check_error'],
    note:
      'Secrets are write-only on GitHub: sluice can check names and timestamps but never values, and it never ' +
      'fixes one for you. To set or rotate a secret, submit it again with `POST /admin/secrets`.',
  },
  { title: 'Sync PRs', kinds: ['hop_error', 'hop_conflict', 'hop_stale_pr'] },
  { title: 'Workflow files', kinds: ['workflow_error', 'workflow_conflict'] },
  { title: 'Variables', kinds: ['variable_error'] },
];

const order = (k: FindingKind) => GROUPS.flatMap((g) => g.kinds).indexOf(k);

export function sortFindings(findings: readonly DriftFinding[]): DriftFinding[] {
  return [...findings].sort(
    (a, b) => order(a.kind) - order(b.kind) || a.repo.localeCompare(b.repo) || a.subject.localeCompare(b.subject),
  );
}

/** Deterministic: the same findings render the same body, so an unchanged report causes no edit. */
export function renderReport(chain: string, findings: readonly DriftFinding[]): string {
  const sorted = sortFindings(findings);
  const lines = [
    DRIFT_MARKER,
    `## sluice drift report for \`${chain}\``,
    '',
    `${sorted.length} item${sorted.length === 1 ? '' : 's'} need${sorted.length === 1 ? 's' : ''} attention. ` +
      'This issue updates itself and closes when they are resolved.',
  ];
  for (const group of GROUPS) {
    const items = sorted.filter((f) => group.kinds.includes(f.kind));
    if (items.length === 0) continue;
    lines.push('', `### ${group.title}`);
    if (group.note) lines.push(group.note, '');
    for (const f of items) {
      lines.push(`- ⚠️ \`${f.subject}\` in \`${f.repo}\`: ${f.detail}${f.url ? ` ([link](${f.url}))` : ''}`);
    }
  }
  lines.push('', '---', '_Reported by sluice. Fix the items above; sluice re-checks on its next reconcile._');
  return lines.join('\n');
}

export type ReportStatus = 'created' | 'updated' | 'closed' | 'unchanged' | 'none' | 'skipped' | 'failed';

export interface ReportOutcome {
  status: ReportStatus;
  url?: string;
  /** Why it failed (typically a missing Issues permission). */
  error?: string;
}

const normalise = (s: string) => s.replace(/\r\n/g, '\n').trim();

export interface ReportPolicy {
  label: string;
  assignees: readonly string[];
}

/** Make the one report issue carry `body`: create it, edit it in place, or leave it alone if it already does. */
async function upsertReportIssue(
  port: GitHubPort,
  holder: RepoRef,
  chain: string,
  existing: IssueRef | null,
  body: string,
  policy: ReportPolicy,
  logger: Logger,
): Promise<ReportOutcome> {
  if (!existing) {
    const created = await port.createIssue(holder, {
      title: `sluice: drift report for ${chain}`,
      body,
      labels: [policy.label],
    });
    if (policy.assignees.length > 0) {
      await port.addAssignees(holder, created.number, [...policy.assignees]).catch((e) => {
        if (e instanceof RateLimitExceededError) throw e;
        logger.warn('could not assign the drift report', errorFields(e)); // a bad login must not lose the report
      });
    }
    return { status: 'created', url: created.htmlUrl };
  }
  if (normalise(existing.body) !== normalise(body)) {
    await port.updateIssue(holder, existing.number, { body });
    return { status: 'updated', url: existing.htmlUrl };
  }
  return { status: 'unchanged', url: existing.htmlUrl };
}

/** A failed attempt is an outcome, not an exception: a missing permission must never take a run down. */
function failedOutcome(e: unknown, logger: Logger, what: string): ReportOutcome {
  const status = (e as { status?: number } | null)?.status;
  logger.warn(`could not ${what}`, errorFields(e));
  return {
    status: 'failed',
    error:
      status === 403 || status === 404
        ? 'GitHub refused: the app needs the "Issues: Read & write" permission to keep a drift report (or set reconcile.report to "none")'
        : scrubString(e instanceof Error ? e.message : 'unknown error').slice(0, 200),
  };
}

/** Create, refresh, or close the single drift-report issue so that it mirrors `findings`. */
export async function publishReport(
  port: GitHubPort,
  holder: RepoRef,
  chain: string,
  findings: readonly DriftFinding[],
  policy: ReportPolicy,
  logger: Logger,
): Promise<ReportOutcome> {
  try {
    const existing = await port.findOpenIssueByLabelMarker(holder, policy.label, DRIFT_MARKER);

    if (findings.length === 0) {
      if (!existing) return { status: 'unchanged' };
      await port.createComment(holder, existing.number, 'sluice: everything it checks is in order again, so this report is closed. It reopens as a new issue if something drifts.');
      await port.updateIssue(holder, existing.number, { state: 'closed' });
      return { status: 'closed', url: existing.htmlUrl };
    }

    return await upsertReportIssue(port, holder, chain, existing, renderReport(chain, findings), policy, logger);
  } catch (e) {
    if (e instanceof RateLimitExceededError) throw e;
    return failedOutcome(e, logger, 'publish the drift report');
  }
}

// ---------------------------------------------------------------------------------------------
// An unreadable chain.yml
// ---------------------------------------------------------------------------------------------

const MAX_CONFIG_ERRORS_LISTED = 20;

/**
 * The body when chain.yml cannot be read. It replaces whatever drift findings the issue held: they were
 * judged against a configuration sluice can no longer see, and the next reconcile restores them.
 * Deterministic (no timestamps), and built only from ConfigIssue text, which parse.ts guarantees carries
 * no user-typed value.
 */
export function renderConfigReport(chain: string, errors: readonly ConfigIssue[]): string {
  const shown = errors.slice(0, MAX_CONFIG_ERRORS_LISTED);
  const lines = [
    DRIFT_MARKER,
    CONFIG_INVALID_MARKER,
    `## sluice drift report for \`${chain}\``,
    '',
    `### ❌ \`${CONFIG_PATH}\` is invalid`,
    '',
    'sluice cannot read this chain\'s configuration, so the chain is **paused**: no upstream or downstream sync, ' +
      'no variable or workflow apply, and no drift check, until the file is valid again. Fix these on the default branch:',
    '',
    formatIssuesMarkdown(shown),
  ];
  if (errors.length > shown.length) lines.push(`- … and ${errors.length - shown.length} more`);
  lines.push('', '---', '_Reported by sluice. This issue closes itself once the file is valid again._');
  return lines.join('\n');
}

/** Create or refresh the report for an unreadable chain.yml. Never throws except on a rate limit. */
export async function publishConfigInvalid(
  port: GitHubPort,
  holder: RepoRef,
  chain: string,
  errors: readonly ConfigIssue[],
  policy: ReportPolicy,
  logger: Logger,
): Promise<ReportOutcome> {
  try {
    const existing = await port.findOpenIssueByLabelMarker(holder, policy.label, DRIFT_MARKER);
    return await upsertReportIssue(port, holder, chain, existing, renderConfigReport(chain, errors), policy, logger);
  } catch (e) {
    if (e instanceof RateLimitExceededError) throw e;
    return failedOutcome(e, logger, 'report the invalid chain.yml');
  }
}

/**
 * chain.yml is readable again: close the report written for it, and only that report.
 *
 * Quiet on failure (debug, not warn): this runs for every valid chain on every scan, and without the
 * Issues permission it would fail every time.
 */
export async function clearConfigInvalid(
  port: GitHubPort,
  holder: RepoRef,
  label: string,
  logger: Logger,
): Promise<ReportOutcome> {
  try {
    const existing = await port.findOpenIssueByLabelMarker(holder, label, DRIFT_MARKER);
    if (!existing || !existing.body.includes(CONFIG_INVALID_MARKER)) return { status: 'unchanged' };
    await port.createComment(
      holder,
      existing.number,
      'sluice: chain.yml is valid again, so this chain is back in service. Drift is re-checked on the next ' +
        'reconcile (and reopens as a new issue if anything has drifted); this report is closed.',
    );
    await port.updateIssue(holder, existing.number, { state: 'closed' });
    return { status: 'closed', url: existing.htmlUrl };
  } catch (e) {
    if (e instanceof RateLimitExceededError) throw e;
    logger.debug('could not check for a stale invalid-config report', errorFields(e));
    return { status: 'failed', error: scrubString(e instanceof Error ? e.message : 'unknown error').slice(0, 200) };
  }
}
