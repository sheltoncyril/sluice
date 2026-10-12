import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from '../src/github/signature';

const secret = 'It\'s a Secret to Everybody';
const body = 'Hello, World!';
const bytes = (s: string) => new TextEncoder().encode(s);

describe('verifyWebhookSignature', () => {
  it('accepts GitHub\'s documented test vector', async () => {
    // From GitHub docs: "Validating webhook deliveries"
    const header = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    expect(await verifyWebhookSignature(secret, bytes(body), header)).toBe(true);
  });

  it('accepts a signature we produced, and uppercase hex digits', async () => {
    const header = await signWebhookPayload('s3cret', '{"a":1}');
    expect(await verifyWebhookSignature('s3cret', bytes('{"a":1}'), header)).toBe(true);
    const upper = 'sha256=' + header.slice('sha256='.length).toUpperCase();
    expect(await verifyWebhookSignature('s3cret', bytes('{"a":1}'), upper)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const header = await signWebhookPayload('s3cret', '{"a":1}');
    expect(await verifyWebhookSignature('s3cret', bytes('{"a":2}'), header)).toBe(false);
  });

  it('rejects a signature made with a different secret', async () => {
    const header = await signWebhookPayload('other', '{"a":1}');
    expect(await verifyWebhookSignature('s3cret', bytes('{"a":1}'), header)).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['no prefix', '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'],
    ['sha1 prefix', 'sha1=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'],
    ['too short', 'sha256=757107ea'],
    ['too long', 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17aa'],
    ['non-hex', 'sha256=zz7107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'],
  ])('rejects a %s header', async (_name, header) => {
    expect(await verifyWebhookSignature(secret, bytes(body), header as string | null | undefined)).toBe(false);
  });

  it('rejects everything when the configured secret is empty', async () => {
    const header = await signWebhookPayload('', 'x').catch(() => 'sha256=' + '0'.repeat(64));
    expect(await verifyWebhookSignature('', bytes('x'), header)).toBe(false);
  });

  it('verifies the exact bytes, not a re-serialisation', async () => {
    const pretty = '{\n  "a": 1\n}';
    const compact = '{"a":1}';
    const header = await signWebhookPayload('s3cret', pretty);
    expect(await verifyWebhookSignature('s3cret', bytes(pretty), header)).toBe(true);
    expect(await verifyWebhookSignature('s3cret', bytes(compact), header)).toBe(false);
  });
});
