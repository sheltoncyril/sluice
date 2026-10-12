import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseChainConfig } from '../src/config/parse';
import {
  BUILTIN_VARS,
  digestOf,
  finishFile,
  managedHeader,
  parseWorkflowsMarker,
  renderTemplate,
  renderWorkflowsMarker,
  validateWorkflowYaml,
} from '../src/workflows/render';

const vars = { repo: 'me/widget', node_version: '22', role: 'midstream' };
const ok = (src: string, v: Record<string, string> = vars) => {
  const r = renderTemplate(src, v, 't.yml');
  if (!r.ok) throw new Error(r.error);
  return r.text;
};

describe('renderTemplate', () => {
  it('substitutes {{ name }} with any amount of whitespace', () => {
    expect(ok('a={{ repo }} b={{repo}} c={{   node_version   }}')).toBe('a=me/widget b=me/widget c=22');
  });

  it('NEVER touches GitHub Actions expressions: ${{ ... }}', () => {
    const src = 'run: echo ${{ github.sha }} ${{ secrets.NPM_TOKEN }} ${{ matrix.os }} ${{ repo }}';
    expect(ok(src)).toBe(src); // even ${{ repo }}, because it follows a "$"
  });

  it('renders mixed templates: expressions kept, placeholders replaced', () => {
    expect(ok('name: {{ repo }}\nrun: echo ${{ github.sha }}\nenv: {{ role }}')).toBe('name: me/widget\nrun: echo ${{ github.sha }}\nenv: midstream');
  });

  it('supports \\{{ x }} as an escape for a literal placeholder', () => {
    expect(ok('literal: \\{{ repo }} real: {{ repo }}')).toBe('literal: {{ repo }} real: me/widget');
  });

  it('reports EVERY undefined name at once, and says how to fix it', () => {
    const r = renderTemplate('{{ nope }} {{ also_missing }} {{ repo }} {{ nope }}', vars, 'ci.yml');
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.error).toContain('{{ nope }}');
    expect(r.error).toContain('{{ also_missing }}');
    expect(r.error).toContain('workflows.values');
    expect(r.error).toContain('ci.yml');
    expect(r.error.match(/\{\{ nope \}\}/g)).toHaveLength(1); // listed once
  });

  it('never substitutes recursively (a value containing a placeholder stays literal)', () => {
    expect(ok('{{ x }}', { x: '{{ repo }}', repo: 'me/widget' })).toBe('{{ repo }}');
  });

  it('leaves non-identifier braces alone', () => {
    const src = 'json: {{"a": 1}} and {{ 1abc }} and { { repo } }';
    expect(ok(src)).toBe(src);
  });

  it('documents the built-ins it expects the engine to provide', () => {
    expect([...BUILTIN_VARS]).toEqual(['repo', 'owner', 'name', 'branch', 'role', 'upstream_repo', 'midstream_repo', 'downstream_repo']);
  });
});

describe('validateWorkflowYaml', () => {
  it('accepts a normal workflow, including the "on" key (YAML 1.2 keeps it a string)', () => {
    expect(validateWorkflowYaml('name: x\non: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n', 'ci.yml')).toBeNull();
  });
  it('rejects syntax errors, naming the template', () => {
    expect(validateWorkflowYaml('name: [unclosed\njobs: {}', 'ci.yml')).toMatch(/ci\.yml.*invalid YAML/);
  });
  it.each([['a list', '- a\n- b\n'], ['a scalar', 'just text\n'], ['empty', '']])('rejects %s', (_n, text) => {
    expect(validateWorkflowYaml(text, 'ci.yml')).toMatch(/does not render to a YAML mapping/);
  });
});

describe('file assembly and digest', () => {
  it('adds a managed-file header naming the source and always ends in one newline', () => {
    const header = managedHeader('me/widget', 'templates/ci.yml');
    expect(header).toContain('managed by sluice');
    expect(header).toContain('me/widget:templates/ci.yml');
    expect(finishFile(header, 'a: 1\n\n\n')).toBe(`${header}a: 1\n`);
    expect(finishFile(header, 'a: 1')).toBe(`${header}a: 1\n`);
  });

  it('the header keeps the file valid YAML', () => {
    expect(validateWorkflowYaml(finishFile(managedHeader('a/b', 't/ci.yml'), 'name: x\njobs: {}'), 'ci.yml')).toBeNull();
  });

  it('digest is stable, order-independent, and sensitive to path and content', async () => {
    const a = { path: '.github/workflows/a.yml', content: 'A' };
    const b = { path: '.github/workflows/b.yml', content: 'B' };
    expect(await digestOf([a, b])).toBe(await digestOf([b, a]));
    expect(await digestOf([a])).not.toBe(await digestOf([{ ...a, content: 'A2' }]));
    expect(await digestOf([a])).not.toBe(await digestOf([{ ...a, path: '.github/workflows/z.yml' }]));
    expect(await digestOf([a])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the PR marker round-trips and ignores junk', async () => {
    const d = await digestOf([{ path: 'p', content: 'c' }]);
    expect(parseWorkflowsMarker(`x\n${renderWorkflowsMarker(d)}\ny`)).toBe(d);
    expect(parseWorkflowsMarker('')).toBeNull();
    expect(parseWorkflowsMarker('<!-- sluice:workflows:v1 digest=short -->')).toBeNull();
  });
});

describe('the shipped example', () => {
  it('examples/templates/ci.yml renders with the built-ins and the example chain.yml values, and is valid YAML', () => {
    const parsed = parseChainConfig(readFileSync('examples/chain.yml', 'utf8'));
    if (!parsed.ok) throw new Error('example config invalid');
    const values = Object.fromEntries(Object.entries(parsed.config.workflows.values).map(([k, v]) => [k, String(v)]));
    const text = ok(readFileSync('examples/templates/ci.yml', 'utf8'), { ...values, role: 'midstream', branch: 'main', repo: 'my-org/widget' });
    expect(text).toContain('name: CI (midstream)');
    expect(text).toContain('branches: [main]');
    expect(text).toContain('node-version: "22"');
    expect(text).toContain('${{ secrets.NPM_TOKEN }}');
    expect(validateWorkflowYaml(text, 'ci.yml')).toBeNull();
  });
});
