/**
 * Structured JSON logger with defence-in-depth redaction.
 *
 * Rules this codebase follows (and the tests enforce):
 *  - request bodies are never passed to the logger;
 *  - secret *values* are never passed to the logger;
 *  - anything that slips through anyway is scrubbed here, by key name and by token-shaped string.
 *
 * Workers Logs persists console output, so this is the last line of defence, not the first.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

export const REDACTED = '[redacted]';

/** Keys whose values are always dropped, whatever they contain. */
const SENSITIVE_KEY =
  /secret|token|password|passwd|passphrase|authorization|auth(?!or)|private[_-]?key|api[_-]?key|credential|signature|cookie|session|body|payload|value|ciphertext|encrypted|plaintext|sealed/i;

/** Token-shaped substrings scrubbed from any string value. */
const SENSITIVE_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub classic / OAuth / app / refresh tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // fine-grained PATs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsha256=[0-9a-f]{64}\b/gi, // webhook signatures
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWTs (app JWT, Access JWT)
];

const MAX_DEPTH = 6;
const MAX_STRING = 2000;

export function scrubString(input: string): string {
  let out = input;
  for (const re of SENSITIVE_PATTERNS) out = out.replace(re, REDACTED);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated]` : out;
}

/** Deep-copy `value` with sensitive keys dropped and token-shaped strings scrubbed. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return errorFields(value);
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return `[binary ${(value as ArrayBufferView).byteLength ?? (value as ArrayBuffer).byteLength} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * The only way errors enter logs: name, message, HTTP status. Octokit's RequestError carries the
 * whole request (including headers) so we never serialise the object itself.
 */
export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    return {
      name: err.name,
      message: scrubString(err.message),
      ...(typeof status === 'number' ? { status } : {}),
    };
  }
  return { message: scrubString(String(err)) };
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  base?: Record<string, unknown>;
  now?: () => Date;
}

export function parseLogLevel(raw: string | undefined): LogLevel {
  const v = (raw ?? '').toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info';
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const sink: LogSink = opts.sink ?? ((line) => console.log(line));
  const now = opts.now ?? (() => new Date());
  const base = opts.base ?? {};

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const record = {
      ts: now().toISOString(),
      level: lvl,
      msg: scrubString(msg),
      ...(redact({ ...base, ...fields }) as Record<string, unknown>),
    };
    sink(JSON.stringify(record));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}

/** A logger that discards everything; handy default for tests. */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};
