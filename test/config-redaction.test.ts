import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { parseChainConfig, readReportingPreference } from '../src/config/parse';
import type { ConfigIssue } from '../src/config/parse';

/**
 * A chain.yml that fails validation is reported in an issue, a PR comment and the run log. A value pasted
 * into the wrong place (a token as a key, a secret where a branch name goes) must not come back out of
 * any of them. Everything here uses a marker that no log scrubber would recognise, so a pass cannot be
 * the scrubber's doing.
 */
const CANARY = 'xK9-CANARY-7f3a-not-a-token';

const MIN = `version: 1
upstream: { repo: acme/widget }
midstream: { repo: me/widget }
downstream: { repo: other/deploy }
`;

const issuesOf = (text: string): ConfigIssue[] => {
  const r = parseChainConfig(text);
  return r.ok ? [] : r.errors;
};
const everything = (text: string): string => {
  const r = parseChainConfig(text);
  return JSON.stringify(r.ok ? r.warnings : [...r.errors, ...r.warnings]);
};

describe('errors never echo user-typed text', () => {
  const example = parse(readFileSync(new URL('../examples/chain.yml', import.meta.url), 'utf8')) as Record<string, unknown>;

  it('the example file is itself valid (so the sweep below starts from a good config)', () => {
    expect(parseChainConfig(stringify(example)).ok).toBe(true);
  });

  /** Every place in the example where the user types a string, and every place they type a key. */
  const leaves: Array<(string | number)[]> = [];
  const keys: Array<(string | number)[]> = [];
  (function walk(v: unknown, path: (string | number)[]) {
    if (typeof v === 'string') leaves.push(path);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        keys.push([...path, k]);
        walk(x, [...path, k]);
      }
    }
  })(example, []);

  const withValueAt = (path: (string | number)[], value: unknown) => {
    const copy = structuredClone(example) as Record<string, any>;
    let cur: any = copy;
    for (const seg of path.slice(0, -1)) cur = cur[seg];
    cur[path.at(-1)!] = value;
    return stringify(copy);
  };
  const withKeyRenamed = (path: (string | number)[]) => {
    const copy = structuredClone(example) as Record<string, any>;
    let cur: any = copy;
    for (const seg of path.slice(0, -1)) cur = cur[seg];
    const key = path.at(-1) as string;
    const renamed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cur)) renamed[k === key ? CANARY : k] = v;
    // Replace in place so the canary key keeps the original's position.
    for (const k of Object.keys(cur)) delete cur[k];
    Object.assign(cur, renamed);
    return stringify(copy);
  };

  it('a canary typed into any string field is not echoed', () => {
    let rejected = 0;
    for (const path of leaves) {
      const text = withValueAt(path, CANARY);
      expect(everything(text), `value at ${path.join('.')}`).not.toContain(CANARY);
      if (!parseChainConfig(text).ok) rejected++;
    }
    expect(leaves.length).toBeGreaterThan(20);
    expect(rejected).toBeGreaterThan(10); // the sweep must actually be producing errors
  });

  it('a canary used as a key at any level is not echoed, and still has a position', () => {
    let rejected = 0;
    for (const path of keys) {
      const text = withKeyRenamed(path);
      const r = parseChainConfig(text);
      expect(JSON.stringify(r.ok ? [] : [...r.errors, ...r.warnings]), `key at ${path.join('.')}`).not.toContain(CANARY);
      if (!r.ok) {
        rejected++;
        expect(r.errors.some((e) => e.line !== undefined), `position for key at ${path.join('.')}`).toBe(true);
      }
    }
    expect(keys.length).toBeGreaterThan(30);
    expect(rejected).toBeGreaterThan(20);
  });

  it('a canary in a type-mismatched position is not echoed', () => {
    for (const path of leaves.slice(0, 40)) {
      for (const value of [{ [CANARY]: CANARY }, [CANARY], 12345]) {
        expect(everything(withValueAt(path, value)), `value at ${path.join('.')}`).not.toContain(CANARY);
      }
    }
  });

  describe('YAML syntax errors use fixed wording, not the library text', () => {
    // Each of these makes the yaml library quote the source in its own message.
    const broken: Record<string, string> = {
      'block scalar header': `${MIN}x: |${CANARY}\n  hi\n`,
      'bad escape': `${MIN}x: "a\\${CANARY}"\n`,
      'reserved start': `${MIN}x: @${CANARY}\n`,
      'unterminated quote': `${MIN}x: "${CANARY}\n`,
      'unbalanced flow': `${MIN}x: [${CANARY}, {\n`,
      'tab indent': `${MIN}x:\n\t${CANARY}: 1\n`,
      'duplicate key': `${MIN}${CANARY}: 1\n${CANARY}: 2\n`,
      'second document': `${MIN}---\n${CANARY}: 1\n`,
    };
    for (const [name, text] of Object.entries(broken)) {
      it(name, () => {
        const r = parseChainConfig(text);
        expect(r.ok).toBe(false);
        expect(everything(text)).not.toContain(CANARY);
        if (!r.ok) expect(r.errors[0]!.message).toMatch(/^YAML syntax: /);
      });
    }

    it('an unknown tag is not echoed either', () => {
      expect(everything(`${MIN}x: !${CANARY} a\n`)).not.toContain(CANARY);
    });
  });

  it('an unresolved alias is a reported error, not a throw, and does not echo the anchor name', () => {
    const text = `${MIN}x: *${CANARY}\n`;
    expect(() => parseChainConfig(text)).not.toThrow();
    const r = parseChainConfig(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/alias/);
    expect(everything(text)).not.toContain(CANARY);
  });

  it('an alias bomb is a reported error, not a throw', () => {
    const refs = Array.from({ length: 30 }, () => '*a').join(', ');
    const r = parseChainConfig(`${MIN}a: &a [1, 2, 3]\nb: [${refs}]\n`);
    expect(r.ok).toBe(false);
  });
});

describe('what is still said, so the errors stay useful', () => {
  it('names a near-miss key and says what it should be', () => {
    const e = issuesOf(`${MIN}variabless: []\n`)[0]!;
    expect(e).toMatchObject({ path: 'variabless', message: 'unknown key (did you mean "variables"?)' });
    expect(e.line).toBe(5);
  });

  it('names a key that is one of the schema’s own words, even in the wrong place', () => {
    const e = issuesOf(`${MIN}secrets:\n  - name: NPM_TOKEN\n    value: ${CANARY}\n`);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ path: 'secrets[0].value', message: 'unknown key' });
    expect(JSON.stringify(e)).not.toContain(CANARY);
  });

  it('keeps the moved-key hint for a schema word at the top level', () => {
    const e = issuesOf(`${MIN}protected_paths: []\n`)[0]!;
    expect(e.path).toBe('protected_paths');
    expect(e.message).toMatch(/hops\.upstream_to_midstream\.protected_paths/);
  });

  it('withholds the name of a key that is neither, and points at the position instead', () => {
    const e = issuesOf(`${MIN}${CANARY}: 1\n`)[0]!;
    expect(e.path).toBe('');
    expect(e.message).toMatch(/name is not shown/);
    expect(e.line).toBe(5);
    expect(e.column).toBe(1);
  });

  it('keeps the parent path for a withheld key', () => {
    const e = issuesOf(`${MIN}pull_requests:\n  ${CANARY}: 1\n`)[0]!;
    expect(e.path).toBe('pull_requests');
    expect(e.line).toBe(6);
  });

  it('shows a record key as <key> but still says what is wrong with it', () => {
    const e = issuesOf(`${MIN}workflows:\n  values:\n    "${CANARY}": x\n`)[0]!;
    expect(e.path).toBe('workflows.values.<key>');
    expect(e.message).toBe('template variable names must be identifiers');
    expect(e.line).toBe(7);
  });

  it('still names the built-in a template value would shadow', () => {
    const e = issuesOf(`${MIN}workflows:\n  values: { repo: x }\n`)[0]!;
    expect(e).toMatchObject({ path: 'workflows.values.repo' });
    expect(e.message).toMatch(/built-in/);
  });

  it('names every built-in a template value would shadow, including those that are not schema keys', () => {
    const e = issuesOf(`${MIN}workflows:\n  values: { role: x, upstream_repo: y, downstream_repo: z }\n`);
    expect(e.map((i) => i.path).sort()).toEqual([
      'workflows.values.downstream_repo',
      'workflows.values.role',
      'workflows.values.upstream_repo',
    ]);
  });

  it('does not repeat the configured repo name when chain.yml names another repository', async () => {
    const { checkConfigText } = await import('../src/config/load');
    const text = MIN.replace('midstream: { repo: me/widget }', 'midstream: { repo: someone/else }');
    expect(text).not.toBe(MIN);
    const r = checkConfigText(text, { owner: 'me', repo: 'widget' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.message).not.toContain('someone/else');
      expect(r.errors[0]!.message).toContain('me/widget'); // the real repo, from the API
    }
  });

  it('cross-field messages name the path, not the value', () => {
    const dup = issuesOf(`${MIN}secrets:\n  - name: AAA_${'X'.repeat(8)}\n  - name: AAA_${'X'.repeat(8)}\n`)[0]!;
    expect(dup.path).toBe('secrets[1].name');
    expect(dup.message).toBe('is declared more than once for midstream');
  });
});

describe('readReportingPreference', () => {
  const base = `${MIN}pull_requests:\n  assignees: [alice, bob]\n  reviewers: [carol]\n`;

  it('defaults to reporting under the default label', () => {
    expect(readReportingPreference(MIN)).toEqual({ report: 'issue', label: 'sluice/drift', assignees: [] });
  });

  it('honours report: none even when something else in the file is wrong', () => {
    expect(readReportingPreference(`${base}reconcile:\n  report: none\nvariabless: []\n`).report).toBe('none');
  });

  it('does not treat reconcile.enabled: false as an opt-out of reports', () => {
    expect(readReportingPreference(`${MIN}reconcile:\n  enabled: false\n`).report).toBe('issue');
  });

  it('a file that is not valid YAML cannot opt out, even if it says none', () => {
    expect(readReportingPreference(`${MIN}reconcile:\n  report: none\nx: [\n`).report).toBe('issue');
  });

  it.each([['NONE'], ['no'], ['false'], ['[none]'], ['{ a: 1 }'], ['""'], ['1']])('only the exact string "none" opts out (%s)', (v) => {
    expect(readReportingPreference(`${MIN}reconcile:\n  report: ${v}\n`).report).toBe('issue');
  });

  it('uses a valid custom label, ignores an unusable one', () => {
    expect(readReportingPreference(`${MIN}reconcile:\n  issue_label: ops/drift\n`).label).toBe('ops/drift');
    expect(readReportingPreference(`${MIN}reconcile:\n  issue_label: ""\n`).label).toBe('sluice/drift');
    expect(readReportingPreference(`${MIN}reconcile:\n  issue_label: ${'x'.repeat(51)}\n`).label).toBe('sluice/drift');
    expect(readReportingPreference(`${MIN}reconcile:\n  issue_label: 7\n`).label).toBe('sluice/drift');
  });

  it('takes assignees, falling back to reviewers, and drops anything that is not a login', () => {
    expect(readReportingPreference(base).assignees).toEqual(['alice', 'bob']);
    expect(readReportingPreference(`${MIN}pull_requests:\n  reviewers: [carol]\n`).assignees).toEqual(['carol']);
    expect(readReportingPreference(`${MIN}pull_requests:\n  assignees: [alice, "not a login!", 5]\n`).assignees).toEqual(['alice']);
  });

  it.each([['an alias bomb', `${MIN}a: &a [1]\nb: [${Array.from({ length: 30 }, () => '*a').join(', ')}]\n`], ['an unresolved alias', `${MIN}x: *nope\n`], ['an array', '- 1\n- 2\n'], ['a scalar', 'hello\n'], ['nothing', '']])(
    'never throws, and falls back to the defaults (%s)',
    (_name, text) => {
      expect(() => readReportingPreference(text)).not.toThrow();
      expect(readReportingPreference(text)).toEqual({ report: 'issue', label: 'sluice/drift', assignees: [] });
    },
  );
});
