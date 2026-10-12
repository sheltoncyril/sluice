import { describe, expect, it } from 'vitest';
import { createLogger, errorFields, redact, scrubString } from '../src/log';

describe('redaction', () => {
  it('drops sensitive keys at any depth', () => {
    const out = redact({
      repo: 'o/r',
      secret: 'hunter2',
      nested: { token: 'abc', Authorization: 'Bearer xyz', value: 's3cr3t', ok: 1 },
      list: [{ password: 'p' }],
    }) as any;
    expect(out.repo).toBe('o/r');
    expect(out.secret).toBe('[redacted]');
    expect(out.nested.token).toBe('[redacted]');
    expect(out.nested.Authorization).toBe('[redacted]');
    expect(out.nested.value).toBe('[redacted]');
    expect(out.nested.ok).toBe(1);
    expect(out.list[0].password).toBe('[redacted]');
  });

  it('keeps ordinary fields such as author', () => {
    expect((redact({ author: 'octocat' }) as any).author).toBe('octocat');
  });

  it('scrubs token-shaped strings that appear in free text', () => {
    const ghp = 'ghp_' + 'A'.repeat(36);
    const s = scrubString(`failed with ${ghp} and Bearer abcdefghijklmnop and sha256=${'a'.repeat(64)}`);
    expect(s).not.toContain(ghp);
    expect(s).not.toContain('abcdefghijklmnop');
    expect(s).not.toMatch(/sha256=a{64}/);
  });

  it('scrubs PEM private keys', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----';
    expect(scrubString(`key=${pem}`)).not.toContain('MIIEvQ');
  });

  it('logs errors as name/message/status only, never the whole object', () => {
    const err = Object.assign(new Error('Bad credentials ghp_' + 'B'.repeat(36)), {
      status: 401,
      request: { headers: { authorization: 'token ghs_supersecret' } },
    });
    const f = errorFields(err);
    expect(Object.keys(f).sort()).toEqual(['message', 'name', 'status']);
    expect(JSON.stringify(f)).not.toContain('ghs_supersecret');
    expect(JSON.stringify(f)).not.toContain('B'.repeat(36));
  });

  it('applies redaction to every emitted line, including child fields', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) }).child({ apiKey: 'k-123' });
    log.info('hello ghs_' + 'C'.repeat(36), { body: 'RAW BODY', extra: { secret: 'x' } });
    const line = lines.join('');
    expect(line).not.toContain('k-123');
    expect(line).not.toContain('RAW BODY');
    expect(line).not.toContain('C'.repeat(36));
    expect(JSON.parse(line).level).toBe('info');
  });

  it('respects the level threshold', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
    log.info('no');
    log.warn('yes');
    expect(lines).toHaveLength(1);
  });
});
