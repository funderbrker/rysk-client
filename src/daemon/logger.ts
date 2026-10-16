import pino, { type DestinationStream, type Logger } from 'pino';

/** Pino's level names plus `silent`: the values `logLevel` may take. */
export const LOG_LEVELS: readonly string[] = [...Object.keys(pino.levels.values), 'silent'];

const REDACTED = '<rpc>';
/** An API key in a provider URL path (Alchemy and others: `/v2/<key>`). */
const RPC_KEY_SEGMENT = /\/v2\/[A-Za-z0-9_-]{16,}/g;

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
 * configured RPC URL and any `/v2/<key>` segment replaced by `<rpc>`. An error anywhere in a record is
 * serialized as pino's standard `{ type, message, stack, … }`, causes folded in, before it is redacted.
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
 * A record body redacted the way the logger redacts: every string at any depth with the RPC URL and any
 * `/v2/<key>` segment replaced by `<rpc>`, bigints as decimal strings, errors serialized. The research records
 * (spec §9.3) carry error text from RPC and REST failures, so they get the same treatment as the logs.
 */
export function redactRecord(record: object, rpcUrl: string): object {
  const clean = sanitized(record, redactor(rpcUrl), new Set());
  return typeof clean === 'object' && clean !== null ? clean : {};
}

function hasToJson(value: object): value is { toJSON(): unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

function redactor(rpcUrl: string): (text: string) => string {
  return (text) => {
    const withoutUrl = rpcUrl === '' ? text : text.replaceAll(rpcUrl, REDACTED);
    return withoutUrl.replace(RPC_KEY_SEGMENT, REDACTED);
  };
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
