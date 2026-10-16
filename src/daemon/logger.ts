import pino, { type DestinationStream, type Logger } from 'pino';

/** Pino's level names plus `silent`: the values `logLevel` may take. */
export const LOG_LEVELS: readonly string[] = [...Object.keys(pino.levels.values), 'silent'];

const REDACTED = '<rpc>';
/** An API key in a provider URL path (Alchemy and others: `/v2/<key>`). */
const RPC_KEY_SEGMENT = /\/v2\/[A-Za-z0-9_-]{16,}/g;
/** A credential-like run in a URL's path or query: 16 or more of `[A-Za-z0-9_-]` (a key or token). */
const CREDENTIAL_RUN = /[A-Za-z0-9_-]{16,}/;

/** The levels the daemon logs at: what its modules take, so a test can pass plain spies. */
export type Log = Pick<Logger, 'debug' | 'info' | 'warn' | 'error' | 'fatal'>;

export type LoggerOptions = {
  level: string;
  /** The configured RPC URL, redacted wherever it appears. */
  rpcUrl: string;
  /** Where the JSON lines go; stdout when omitted. */
  destination?: DestinationStream;
};

/**
 * A pino JSON logger (spec §9.5). Every `bigint` is written as its decimal string (pino would otherwise emit
 * an unquoted number that JSON readers round). Every string, the message and errors included, has the
 * configured RPC URL (as configured and as `new URL()` normalizes it), its path and query on their own when they
 * carry a credential-like run of 16 or more `[A-Za-z0-9_-]` (a provider key in `/v3/<key>` or `/<token>/` form;
 * a plain path such as the public RPC's `/evm` is no secret) and any `/v2/<key>` segment replaced by `<rpc>`. An error
 * anywhere in a record is serialized as pino's standard `{ type, message, stack, … }`, causes folded in, before
 * it is redacted.
 * Child loggers inherit all of this for their records; their bindings (`log.child({ … })`) are written as
 * pino writes them, so bind strings, not bigints or secrets.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const redact = redactor(opts.rpcUrl);
  const clean = (value: unknown): unknown => sanitized(value, redact, new Set());
  const options: pino.LoggerOptions = {
    level: opts.level,
    // Pino writes the record's own entries (never its `toJSON`), so the record stays an object here.
    formatters: {
      log: (record) => Object.fromEntries(Object.entries(record).map(([k, v]) => [k, clean(v)])),
    },
    serializers: {
      // `log` has already serialized the error; this replaces pino's default, which would re-wrap it.
      err: clean,
      // `log.error(err)` copies the raw `err.message` into `msg`.
      msg: clean,
    },
  };
  return opts.destination === undefined ? pino(options) : pino(options, opts.destination);
}

/**
 * A record body redacted the way the logger redacts: every string at any depth with the RPC URL (and its forms
 * above) and any `/v2/<key>` segment replaced by `<rpc>`, bigints as decimal strings, errors serialized. The
 * research records (spec §9.3) carry error text from RPC and REST failures, so they get the same treatment as the
 * logs.
 */
export function redactRecord(record: object, rpcUrl: string): object {
  const clean = sanitized(record, redactor(rpcUrl), new Set());
  return typeof clean === 'object' && clean !== null ? clean : {};
}

function hasToJson(value: object): value is { toJSON(): unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

function redactor(rpcUrl: string): (text: string) => string {
  const secrets = rpcSecrets(rpcUrl);
  return (text) =>
    secrets
      .reduce((out, secret) => out.replaceAll(secret, REDACTED), text)
      .replace(RPC_KEY_SEGMENT, REDACTED);
}

/**
 * The strings that give the RPC URL away, longest first: the configured URL, its `href` (which may differ by a
 * trailing slash or the host's case) and, when it carries a credential-like run (`CREDENTIAL_RUN`), its path and
 * query, which then hold a provider key whatever the host in front of them. A path without one (`/evm`) is left
 * alone elsewhere in the text.
 */
function rpcSecrets(rpcUrl: string): string[] {
  if (rpcUrl === '') return [];
  const secrets = new Set([rpcUrl]);
  try {
    const url = new URL(rpcUrl);
    secrets.add(url.href);
    const pathAndQuery = `${url.pathname}${url.search}`;
    if (CREDENTIAL_RUN.test(pathAndQuery)) secrets.add(pathAndQuery);
  } catch {
    // Not a URL: only the string itself is known.
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

/**
 * `value` with bigints as decimal strings, strings redacted and errors serialized, at any depth. Other objects
 * become what `JSON.stringify` writes: their `toJSON()` result (a `URL` or `Date` becomes its string), itself
 * sanitized, or else their own enumerable entries. `ancestors` holds the objects on the current path, so a
 * cycle is cut rather than followed.
 */
function sanitized(value: unknown, redact: (text: string) => string, ancestors: Set<object>): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return redact(value);
  if (typeof value !== 'object' || value === null) return value;
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitized(item, redact, ancestors));
    if (!(value instanceof Error) && hasToJson(value)) {
      const json = value.toJSON();
      if (json !== value) return sanitized(json, redact, ancestors);
    }
    const source: object = value instanceof Error ? pino.stdSerializers.err(value) : value;
    return Object.fromEntries(
      Object.entries(source).map(([key, item]) => [key, sanitized(item, redact, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}
