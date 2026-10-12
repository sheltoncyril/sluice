import { parse } from 'yaml';

/**
 * Workflow templates are rendered with `{{ name }}` placeholders.
 *
 *  - `${{ github.sha }}` (a GitHub Actions expression) is NEVER touched: a `{{ … }}` preceded by `$` is
 *    left alone, so templates can be ordinary workflows.
 *  - `\{{ name }}` is an escape and renders as a literal `{{ name }}`.
 *  - An undefined name is an error (listing every one), never silently empty.
 *
 * Built-in names are provided per target repo; `workflows.values` in chain.yml adds the rest.
 */
export const BUILTIN_VARS = [
  'repo', // target "owner/name"
  'owner',
  'name', // target repo name
  'branch', // target's tracked branch
  'role', // "midstream" | "downstream"
  'upstream_repo',
  'midstream_repo',
  'downstream_repo',
] as const;

const PLACEHOLDER = /(?<![$\\])\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}|\\(\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\})/g;

export type RenderResult = { ok: true; text: string } | { ok: false; error: string };

export function renderTemplate(source: string, vars: Readonly<Record<string, string>>, templateName: string): RenderResult {
  const missing = new Set<string>();
  const text = source.replace(PLACEHOLDER, (_m, name: string | undefined, escaped: string | undefined) => {
    if (escaped !== undefined) return escaped; // `\{{ x }}` -> `{{ x }}`
    const value = vars[name!];
    if (value === undefined) {
      missing.add(name!);
      return '';
    }
    return value;
  });
  if (missing.size > 0) {
    return {
      ok: false,
      error:
        `template "${templateName}" uses ${[...missing].map((n) => `{{ ${n} }}`).join(', ')}, which ${missing.size === 1 ? 'is' : 'are'} not defined. ` +
        `Add ${missing.size === 1 ? 'it' : 'them'} under workflows.values in chain.yml, or use a built-in (${BUILTIN_VARS.join(', ')}).`,
    };
  }
  return { ok: true, text };
}

/** Rendered output must be a YAML mapping; anything else would push a broken workflow. */
export function validateWorkflowYaml(text: string, templateName: string): string | null {
  try {
    const doc: unknown = parse(text, { schema: 'core', version: '1.2' });
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return `template "${templateName}" does not render to a YAML mapping`;
    }
    return null;
  } catch (e) {
    const first = (e instanceof Error ? e.message : 'invalid YAML').split('\n')[0];
    return `template "${templateName}" renders to invalid YAML: ${first}`;
  }
}

/** Marks a file as managed so nobody edits it by hand and wonders why the edit vanishes. */
export function managedHeader(templateRepo: string, templatePath: string): string {
  return (
    `# This file is managed by sluice and rendered from ${templateRepo}:${templatePath}\n` +
    `# Local edits are overwritten by the next sync; change the template instead.\n`
  );
}

/** Header + rendered text, always ending in exactly one newline. */
export function finishFile(header: string, rendered: string): string {
  return `${header}${rendered.replace(/\s+$/, '')}\n`;
}

/** SHA-256 over the desired files, independent of order. Identifies "this exact set of content". */
export async function digestOf(files: ReadonlyArray<{ path: string; content: string }>): Promise<string> {
  const canonical = JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.content]));
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MARKER_RE = /<!--\s*sluice:workflows:v1\s+digest=([0-9a-f]{64})\s*-->/;
export const renderWorkflowsMarker = (digest: string): string => `<!-- sluice:workflows:v1 digest=${digest} -->`;
export const parseWorkflowsMarker = (body: string | null | undefined): string | null => MARKER_RE.exec(body ?? '')?.[1] ?? null;
