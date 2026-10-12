import { isMap, isNode, isScalar, LineCounter, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { z } from 'zod';
import { chainConfigSchema, CONFIG_PATH } from './schema';
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
          message: `YAML syntax: ${e.message.split('\n')[0]}`,
          ...(at ? { line: at.line, column: at.col } : {}),
        };
      }),
    };
  }

  const data: unknown = doc.toJS({ maxAliasCount: 20 });
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return fileProblem('top level must be a mapping of keys (version, upstream, midstream, ...)');
  }

  const parsed = chainConfigSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, warnings: [], errors: parsed.error.issues.flatMap((i) => translateIssue(i, doc, lineCounter)) };
  }

  return { ok: true, config: parsed.data, warnings: collectWarnings(parsed.data) };
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

function translateIssue(issue: z.core.$ZodIssue, doc: Document, lc: LineCounter): ConfigIssue[] {
  const path = issue.path.filter((p): p is PathKey => typeof p === 'string' || typeof p === 'number');

  if (issue.code === 'unrecognized_keys') {
    const known = knownKeysAt(path);
    return issue.keys.map((key) => {
      const pos = locateKey(doc, lc, path, key);
      const guess = closest(key, known);
      const moved = path.length === 0 ? MOVED_KEYS[key] : undefined;
      return {
        severity: 'error' as const,
        path: pathToString([...path, key]),
        message: moved
          ? `unknown key (${moved})`
          : guess
            ? `unknown key (did you mean "${guess}"?)`
            : 'unknown key',
        ...(pos ? { line: pos.line, column: pos.col } : {}),
      };
    });
  }

  const pos = locate(doc, lc, path);
  const missing = issue.code === 'invalid_type' && /received undefined/.test(issue.message);
  return [
    {
      severity: 'error',
      path: pathToString(path),
      message: missing ? 'is required' : issue.message,
      ...(pos ? { line: pos.line, column: pos.col } : {}),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// "Did you mean" support: walk the zod schema to find which keys are legal at a path.
// ---------------------------------------------------------------------------------------------

interface ZodLike {
  _zod?: { def?: { type?: string; shape?: Record<string, ZodLike>; innerType?: ZodLike; element?: ZodLike; in?: ZodLike } };
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
