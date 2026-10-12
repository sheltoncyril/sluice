import { isMap, isNode, isScalar, LineCounter, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { z } from 'zod';
import { BUILTIN_VARS } from '../workflows/render';
import { chainConfigSchema, CONFIG_PATH, LOGIN_RE } from './schema';
import type { ChainConfig } from './schema';

export interface ConfigIssue {
  severity: 'error' | 'warning';
  /** Dotted path into the config, e.g. `secrets[0].name`. Empty for whole-file problems. */
  path: string;
  message: string;
  line?: number;
  column?: number;
}

export type ParseResult =
  | { ok: true; config: ChainConfig; warnings: ConfigIssue[] }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

/** chain.yml is a few KB; anything this large is not a config file. */
export const MAX_CONFIG_BYTES = 64 * 1024;

type PathKey = string | number;

/**
 * Wording for YAML syntax errors, by the library's error code. The library's own text is never shown:
 * several of its messages quote the source (`Unresolved tag: <tag>`, `Block scalar header includes
 * extra characters: <text>`), and these errors end up in an issue, a PR comment and the run log, so a
 * value pasted into the wrong place must not come back out of them.
 */
const YAML_ERROR_TEXT: Record<string, string> = {
  ALIAS_PROPS: 'an alias cannot carry an anchor or a tag',
  BAD_ALIAS: 'invalid alias',
  BAD_COLLECTION_TYPE: 'a tag does not match the kind of value it is on',
  BAD_DIRECTIVE: 'invalid YAML directive',
  BAD_DQ_ESCAPE: 'invalid escape sequence in a double-quoted string',
  BAD_INDENT: 'bad indentation',
  BAD_PROP_ORDER: 'anchors and tags must come after the indicator',
  BAD_SCALAR_START: 'a plain value cannot start with a reserved character (quote it)',
  BLOCK_AS_IMPLICIT_KEY: 'nested mappings are not allowed in compact mappings',
  BLOCK_IN_FLOW: 'a block collection is not allowed inside a flow collection',
  DUPLICATE_KEY: 'map keys must be unique',
  IMPOSSIBLE: 'the file could not be parsed',
  KEY_OVER_1024_CHARS: 'a map key is longer than 1024 characters',
  MISSING_CHAR: 'a closing or separating character is missing (quote, bracket, brace or comma)',
  MULTILINE_IMPLICIT_KEY: 'an implicit map key must be on one line',
  MULTIPLE_ANCHORS: 'a node can only have one anchor',
  MULTIPLE_DOCS: 'the file holds more than one YAML document',
  MULTIPLE_TAGS: 'a node can only have one tag',
  NON_STRING_KEY: 'map keys must be strings',
  RESOURCE_EXHAUSTION: 'aliases expand too far',
  TAB_AS_INDENT: 'tabs cannot be used for indentation',
  TAG_RESOLVE_FAILED: 'an unknown or unsupported YAML tag',
  UNEXPECTED_TOKEN: 'unexpected content',
};

/** Same, for what `toJS` throws (an alias to an anchor that does not exist, or alias expansion past our cap). */
function conversionProblem(e: unknown): string {
  const text = e instanceof Error ? e.message : '';
  if (/^Unresolved alias/.test(text)) return 'YAML syntax: an alias refers to an anchor that is not defined above it';
  if (/alias count/i.test(text)) return 'YAML syntax: aliases expand too far';
  return 'YAML syntax: the file could not be converted to data';
}

export function parseChainConfig(source: string): ParseResult {
  const fileProblem = (message: string): ParseResult => ({
    ok: false,
    errors: [{ severity: 'error', path: '', message }],
    warnings: [],
  });

  if (new TextEncoder().encode(source).byteLength > MAX_CONFIG_BYTES) {
    return fileProblem(`file is larger than ${MAX_CONFIG_BYTES / 1024} KiB`);
  }
  if (source.trim() === '') return fileProblem('file is empty');

  const lineCounter = new LineCounter();
  // YAML 1.2 "core" schema: no implicit timestamps/binary, and `on`/`yes` stay strings.
  const doc = parseDocument(source, {
    lineCounter,
    schema: 'core',
    version: '1.2',
    uniqueKeys: true,
    prettyErrors: false,
  });

  if (doc.errors.length > 0) {
    return {
      ok: false,
      warnings: [],
      errors: doc.errors.map((e) => {
        const at = e.pos?.[0] !== undefined ? lineCounter.linePos(e.pos[0]) : undefined;
        return {
          severity: 'error' as const,
          path: '',
          message: `YAML syntax: ${YAML_ERROR_TEXT[e.code] ?? 'invalid YAML'}`,
          ...(at ? { line: at.line, column: at.col } : {}),
        };
      }),
    };
  }

  // `toJS` throws (it does not report through doc.errors) for an unresolved alias or an alias bomb.
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 20 });
  } catch (e) {
    return fileProblem(conversionProblem(e));
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return fileProblem('top level must be a mapping of keys (version, upstream, midstream, ...)');
  }

  const parsed = chainConfigSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, warnings: [], errors: parsed.error.issues.flatMap((i) => translateIssue(i, doc, lineCounter)) };
  }

  return { ok: true, config: parsed.data, warnings: collectWarnings(parsed.data) };
}

/** How an unreadable chain.yml should be reported: whatever of the reporting settings can still be trusted. */
export interface ReportingPreference {
  /** `none` only when the file says so. An unparseable file cannot opt out, so it reports. */
  report: 'issue' | 'none';
  label: string;
  assignees: string[];
}

const RECONCILE_DEFAULTS = chainConfigSchema.shape.reconcile.parse(undefined);

/**
 * Best-effort read of `reconcile.report`, `reconcile.issue_label` and the assignees from a file that
 * failed validation, so an owner who opted out of issues is not sent one about their broken file.
 *
 * Only a file that is valid YAML is read (a half-parsed document is not evidence of what the owner
 * meant), and only a value that would itself be valid is used; anything else falls back to the default.
 * Never throws.
 */
export function readReportingPreference(source: string): ReportingPreference {
  const pref: ReportingPreference = { report: RECONCILE_DEFAULTS.report, label: RECONCILE_DEFAULTS.issue_label, assignees: [] };
  try {
    if (new TextEncoder().encode(source).byteLength > MAX_CONFIG_BYTES) return pref;
    const doc = parseDocument(source, { schema: 'core', version: '1.2', uniqueKeys: true, prettyErrors: false });
    if (doc.errors.length > 0) return pref;
    const root: unknown = doc.toJS({ maxAliasCount: 20 });

    const child = (from: unknown, key: string): unknown =>
      from !== null && typeof from === 'object' && !Array.isArray(from) ? (from as Record<string, unknown>)[key] : undefined;

    const reconcile = child(root, 'reconcile');
    if (child(reconcile, 'report') === 'none') pref.report = 'none';
    const label = child(reconcile, 'issue_label');
    if (typeof label === 'string' && label.length >= 1 && label.length <= 50) pref.label = label;

    const logins = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((l): l is string => typeof l === 'string' && LOGIN_RE.test(l)) : [];
    const pr = child(root, 'pull_requests');
    const assignees = logins(child(pr, 'assignees'));
    pref.assignees = assignees.length > 0 ? assignees : logins(child(pr, 'reviewers'));
  } catch {
    /* defaults */
  }
  return pref;
}

// ---------------------------------------------------------------------------------------------
// Issue translation
// ---------------------------------------------------------------------------------------------

function pathToString(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out;
}

function locate(doc: Document, lc: LineCounter, path: readonly PathKey[]): { line: number; col: number } | undefined {
  // Point at the deepest node that exists: a missing key is reported at its parent mapping.
  for (let n = path.length; n >= 0; n--) {
    const node = n === 0 ? doc.contents : doc.getIn(path.slice(0, n) as PathKey[], true);
    if (isNode(node) && node.range) return lc.linePos(node.range[0]);
  }
  return undefined;
}

function locateKey(doc: Document, lc: LineCounter, parent: readonly PathKey[], key: string) {
  const node = parent.length === 0 ? doc.contents : doc.getIn(parent as PathKey[], true);
  if (isMap(node)) {
    for (const pair of node.items) {
      if (isScalar(pair.key) && pair.key.value === key && pair.key.range) return lc.linePos(pair.key.range[0]);
    }
  }
  return locate(doc, lc, parent);
}

/**
 * What a path may say about user-authored text. A key the user typed is only echoed when it is one of
 * the schema's own words (or, for an unknown key, a near-miss of one): anything else might be a value
 * pasted in the wrong place, and these paths end up in an issue, a PR comment and the run log. Record
 * keys (template variable names) are user-chosen, so they are never echoed. Positions come from the
 * real path, so the line:col still points at the offending text.
 */
function safeSegments(path: readonly PathKey[]): PathKey[] {
  return path.map((seg, i) => {
    if (typeof seg === 'number') return seg;
    return knownKeysAt(path.slice(0, i)).includes(seg) || schemaVocabulary().has(seg) ? seg : '<key>';
  });
}

function translateIssue(issue: z.core.$ZodIssue, doc: Document, lc: LineCounter): ConfigIssue[] {
  const path = issue.path.filter((p): p is PathKey => typeof p === 'string' || typeof p === 'number');
  const shownParent = safeSegments(path);

  if (issue.code === 'unrecognized_keys') {
    const known = knownKeysAt(path);
    return issue.keys.map((key) => {
      const pos = locateKey(doc, lc, path, key);
      const guess = closest(key, known);
      // A near-miss of a word that is valid somewhere else in the file (a nested key typed at the top
      // level, say). Still safe to echo: it is within a couple of edits of a schema word.
      const elsewhere = guess === undefined && !schemaVocabulary().has(key) ? closest(key, [...schemaVocabulary()]) : undefined;
      const echo = guess !== undefined || elsewhere !== undefined || schemaVocabulary().has(key);
      const moved = path.length === 0 && echo ? MOVED_KEYS[key] : undefined;
      const movedGuess = path.length === 0 && elsewhere ? MOVED_KEYS[elsewhere] : undefined;
      return {
        severity: 'error' as const,
        path: pathToString(echo ? [...shownParent, key] : shownParent),
        message: moved
          ? `unknown key (${moved})`
          : guess
            ? `unknown key (did you mean "${guess}"?)`
            : elsewhere
              ? `unknown key (did you mean "${elsewhere}"?${movedGuess ? ` ${movedGuess}` : ` It is a valid key, but not here.`})`
              : echo
                ? 'unknown key'
                : 'unknown key (its name is not shown; see the position)',
        ...(pos ? { line: pos.line, column: pos.col } : {}),
      };
    });
  }

  const pos = locate(doc, lc, path);
  const missing = issue.code === 'invalid_type' && /received undefined/.test(issue.message);
  // A bad record key is reported by zod with the generic "Invalid key in record"; the schema's own
  // wording for it is on the nested issue.
  const nested = issue.code === 'invalid_key' ? issue.issues?.[0]?.message : undefined;
  return [
    {
      severity: 'error',
      path: pathToString(shownParent),
      message: missing ? 'is required' : (nested ?? issue.message),
      ...(pos ? { line: pos.line, column: pos.col } : {}),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// "Did you mean" support: walk the zod schema to find which keys are legal at a path.
// ---------------------------------------------------------------------------------------------

interface ZodLike {
  _zod?: {
    def?: {
      type?: string;
      shape?: Record<string, ZodLike>;
      innerType?: ZodLike;
      element?: ZodLike;
      in?: ZodLike;
      options?: ZodLike[];
    };
  };
}

let vocabulary: Set<string> | undefined;

/**
 * Every word the schema owns: each key name at any depth, plus the built-in template variables (which
 * a `workflows.values` entry may shadow, and is told so by name). Derived from the schema, so it cannot
 * drift from it.
 */
function schemaVocabulary(): Set<string> {
  if (vocabulary) return vocabulary;
  const words = new Set<string>(BUILTIN_VARS);
  const seen = new Set<unknown>();
  const visit = (s: ZodLike | undefined): void => {
    const def = s?._zod?.def;
    if (!s || !def || seen.has(s)) return;
    seen.add(s);
    for (const [key, child] of Object.entries(def.shape ?? {})) {
      words.add(key);
      visit(child);
    }
    visit(def.element);
    visit(def.innerType);
    visit(def.in);
    for (const option of def.options ?? []) visit(option);
  };
  try {
    visit(chainConfigSchema as unknown as ZodLike);
  } catch {
    /* an unreadable schema falls back to near-miss echo only */
  }
  return (vocabulary = words);
}

function unwrap(s: ZodLike | undefined): ZodLike | undefined {
  let cur = s;
  for (let i = 0; i < 8 && cur?._zod?.def; i++) {
    const def = cur._zod.def;
    if (def.type === 'object' || def.type === 'array') return cur;
    const next = def.innerType ?? def.in;
    if (!next) return cur;
    cur = next;
  }
  return cur;
}

/** Keys people reasonably expect at the top level but that live elsewhere. */
const MOVED_KEYS: Record<string, string> = {
  protected_paths: 'protected paths are per hop: use hops.upstream_to_midstream.protected_paths',
  merge_method: 'merge method is per hop: use hops.upstream_to_midstream.merge_method',
  sync_branch: 'sync branches are per hop: use hops.<hop>.sync_branch',
};

function knownKeysAt(path: readonly PathKey[]): string[] {
  try {
    let cur = unwrap(chainConfigSchema as unknown as ZodLike);
    for (const seg of path) {
      const def = cur?._zod?.def;
      if (!def) return [];
      if (def.type === 'object' && typeof seg === 'string') cur = unwrap(def.shape?.[seg]);
      else if (def.type === 'array' && typeof seg === 'number') cur = unwrap(def.element);
      else return [];
    }
    const def = cur?._zod?.def;
    return def?.type === 'object' ? Object.keys(def.shape ?? {}) : [];
  } catch {
    return [];
  }
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]![b.length]!;
}

function closest(key: string, candidates: string[]): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const c of candidates) {
    const d = distance(key.toLowerCase(), c.toLowerCase());
    if (!best || d < best.d) best = { name: c, d };
  }
  return best && best.d <= Math.max(2, Math.floor(best.name.length / 3)) ? best.name : undefined;
}

// ---------------------------------------------------------------------------------------------
// Warnings and formatting
// ---------------------------------------------------------------------------------------------

function collectWarnings(cfg: ChainConfig): ConfigIssue[] {
  const warnings: ConfigIssue[] = [];
  if (cfg.transport === 'git-data') {
    warnings.push({
      severity: 'warning',
      path: 'transport',
      message: '"git-data" (non-fork repos) is not implemented yet; hops will be skipped and logged until it is',
    });
  }
  return warnings;
}

/** Plain-text rendering for logs and CLI output. */
export function formatIssues(issues: readonly ConfigIssue[], file: string = CONFIG_PATH): string {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const head = errors > 0 ? `${file}: ${errors} error${errors === 1 ? '' : 's'}` : `${file}: ${issues.length} warning(s)`;
  const lines = issues.map((i) => {
    const where = i.line !== undefined ? `${i.line}:${i.column ?? 1}` : '-';
    const mark = i.severity === 'error' ? 'error' : 'warn ';
    return `  ${mark}  ${where.padEnd(7)} ${i.path ? `${i.path} ` : ''}${i.message}`;
  });
  return [head, ...lines].join('\n');
}

/** Markdown rendering for the PR comment. */
export function formatIssuesMarkdown(issues: readonly ConfigIssue[], file: string = CONFIG_PATH): string {
  return issues
    .map((i) => {
      const where = i.line !== undefined ? `\`${file}:${i.line}:${i.column ?? 1}\`` : `\`${file}\``;
      const icon = i.severity === 'error' ? '❌' : '⚠️';
      return `- ${icon} ${where} ${i.path ? `**\`${i.path}\`** ` : ''}${i.message}`;
    })
    .join('\n');
}
