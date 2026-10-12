import type { GitHubPort, RepoRef } from '../github/port';
import { fullName, sameRepo } from '../github/port';
import { parseChainConfig, readReportingPreference } from './parse';
import type { ConfigIssue, ReportingPreference } from './parse';
import { CONFIG_PATH } from './schema';
import type { ChainConfig } from './schema';
import { parseRepo } from '../github/port';

export type LoadResult =
  | { status: 'ok'; config: ChainConfig; warnings: ConfigIssue[]; sha: string }
  /** The repo has no .github/chain.yml: it is simply not a midstream. Not an error. */
  | { status: 'missing' }
  | {
      status: 'invalid';
      errors: ConfigIssue[];
      warnings: ConfigIssue[];
      sha: string;
      /** What can still be trusted of the file's reporting settings (see readReportingPreference). */
      reporting: ReportingPreference;
    };

/**
 * Parse + validate config text for the repo it was found in. chain.yml belongs to the MIDSTREAM
 * repo, so `midstream.repo` must name the repo that holds the file; this stops a file copied into
 * the wrong repo from making the app act on a chain it does not describe.
 */
export function checkConfigText(text: string, holder: RepoRef): ReturnType<typeof parseChainConfig> {
  const parsed = parseChainConfig(text);
  if (!parsed.ok) return parsed;
  if (!sameRepo(parseRepo(parsed.config.midstream.repo), holder)) {
    return {
      ok: false,
      warnings: parsed.warnings,
      errors: [
        {
          severity: 'error',
          path: 'midstream.repo',
          // The configured value is not echoed: it passed the repo-name pattern, but it is still user-typed text.
          message: `does not name this repository (the file lives in ${fullName(holder)}); chain.yml must be in the midstream repo`,
        },
      ],
    };
  }
  return parsed;
}

/** Read `.github/chain.yml` from a repo's default branch (or `ref`) through the API. Never cached. */
export async function loadChainConfig(port: GitHubPort, holder: RepoRef, ref?: string): Promise<LoadResult> {
  const file = await port.readFile(holder, CONFIG_PATH, ref);
  if (!file) return { status: 'missing' };
  const checked = checkConfigText(file.text, holder);
  return checked.ok
    ? { status: 'ok', config: checked.config, warnings: checked.warnings, sha: file.sha }
    : {
        status: 'invalid',
        errors: checked.errors,
        warnings: checked.warnings,
        sha: file.sha,
        reporting: readReportingPreference(file.text),
      };
}
