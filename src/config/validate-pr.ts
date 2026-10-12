import type { GitHubPort, RepoRef } from '../github/port';
import { fullName } from '../github/port';
import type { Logger } from '../log';
import type { Store } from '../store/types';
import { checkConfigText } from './load';
import { formatIssuesMarkdown } from './parse';
import { CONFIG_PATH } from './schema';

/** Hidden marker so we update our one comment instead of stacking new ones. */
export const CONFIG_COMMENT_MARKER = '<!-- chain-sync:config-validation -->';

export type PrValidationOutcome = 'not_affected' | 'deleted' | 'valid' | 'invalid';

export interface PrValidationInput {
  repo: RepoRef;
  pullNumber: number;
  headSha: string;
}

/**
 * If a PR touches .github/chain.yml, validate the proposed file and tell the author.
 *
 * Quiet by design: a valid file gets no comment, unless an earlier error comment exists, in which
 * case that comment is updated to say it is fixed.
 */
export async function validateConfigOnPullRequest(
  port: GitHubPort,
  store: Store,
  input: PrValidationInput,
  logger: Logger,
  now: () => Date,
): Promise<PrValidationOutcome> {
  const { repo, pullNumber, headSha } = input;

  const files = await port.listPullRequestFiles(repo, pullNumber);
  if (!files.includes(CONFIG_PATH)) return 'not_affected';

  // Read at the PR head SHA through the *base* repo path (works for same-repo and fork PRs).
  const file = await port.readFile(repo, CONFIG_PATH, headSha);
  if (!file) return 'deleted';

  const checked = checkConfigText(file.text, repo);
  const existing = await port.findCommentByMarker(repo, pullNumber, CONFIG_COMMENT_MARKER);
  const started = now().toISOString();

  const upsert = async (body: string) => {
    if (existing) {
      if (existing.body.trim() !== body.trim()) await port.updateComment(repo, existing.id, body);
    } else {
      await port.createComment(repo, pullNumber, body);
    }
  };

  if (!checked.ok) {
    const body = [
      CONFIG_COMMENT_MARKER,
      `### ❌ \`${CONFIG_PATH}\` is invalid`,
      '',
      `chain-sync cannot use this configuration (checked at \`${headSha.slice(0, 7)}\`). Fix these and push again:`,
      '',
      formatIssuesMarkdown([...checked.errors, ...checked.warnings]),
    ].join('\n');
    await upsert(body);
    logger.warn('chain.yml invalid in PR', { repo: fullName(repo), pr: pullNumber, errors: checked.errors.length });
    await store.recordRun({
      startedAt: started,
      finishedAt: now().toISOString(),
      trigger: 'webhook:pull_request',
      chain: fullName(repo),
      hop: 'config',
      outcome: 'config_invalid',
      prNumber: pullNumber,
      detail: { errors: checked.errors.map((e) => ({ path: e.path, line: e.line, message: e.message })) },
    });
    return 'invalid';
  }

  if (existing || checked.warnings.length > 0) {
    const body = [
      CONFIG_COMMENT_MARKER,
      `### ✅ \`${CONFIG_PATH}\` is valid`,
      ...(checked.warnings.length > 0 ? ['', formatIssuesMarkdown(checked.warnings)] : []),
    ].join('\n');
    await upsert(body);
  }
  await store.recordRun({
    startedAt: started,
    finishedAt: now().toISOString(),
    trigger: 'webhook:pull_request',
    chain: fullName(repo),
    hop: 'config',
    outcome: 'config_valid',
    prNumber: pullNumber,
  });
  return 'valid';
}
