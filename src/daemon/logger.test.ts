import { HttpRequestError } from 'viem';
import { describe, expect, it } from 'vitest';
import { createLogger, redactRecord } from './logger.ts';

const RPC_URL = 'https://rpc.example.org/evm/private-path';
const ALCHEMY_URL = 'https://x.g.alchemy.com/v2/abcdefghijklmnop1234';
const ALCHEMY_KEY = 'abcdefghijklmnop1234';

/** A logger writing to an in-memory destination, and the JSON lines it emitted. */
function capture(level = 'info') {
  const lines: string[] = [];
  const log = createLogger({
    level,
    rpcUrl: RPC_URL,
    destination: { write: (line) => void lines.push(line) },
  });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { log, lines, records };
}

describe('createLogger: bigint', () => {
  it('serializes a bigint as its decimal string', () => {
    const { log, lines } = capture();
    log.info({ q: 25n * 10n ** 18n }, 'sized');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"q":"25000000000000000000"');
  });

  it('serializes nested and array bigints as strings, in child loggers too', () => {
    const { log, records } = capture();
    log.child({ side: 'put' }).info({ trade: { premium6: 1_500000n }, legs: [1n, 2n] });
    expect(records()[0]).toMatchObject({ side: 'put', trade: { premium6: '1500000' }, legs: ['1', '2'] });
  });
});

describe('createLogger: error redaction', () => {
  it('redacts an RPC key segment from the message, stack and msg', () => {
    const { log, lines, records } = capture();
    log.error(new Error(`fetch failed: ${ALCHEMY_URL}`));
    expect(lines[0]).toContain('<rpc>');
    expect(lines[0]).not.toContain(ALCHEMY_KEY);
    const record = records()[0] as { msg: string; err: { type: string; message: string; stack: string } };
    expect(record.msg).toBe('fetch failed: https://x.g.alchemy.com<rpc>');
    expect(record.err.type).toBe('Error');
    expect(record.err.message).toBe('fetch failed: https://x.g.alchemy.com<rpc>');
    expect(record.err.stack).toContain('<rpc>');
  });

  it('redacts the configured RPC URL from every field of an error and its cause', () => {
    const { log, lines, records } = capture();
    const cause = new HttpRequestError({ url: RPC_URL, details: 'socket hang up' });
    log.error({ err: new Error('chain read failed', { cause }) }, 'snapshot failed');
    expect(lines[0]).not.toContain(RPC_URL);
    expect(lines[0]).not.toContain('private-path');
    expect(lines[0]).toContain('<rpc>');
    expect(records()[0]).toMatchObject({ msg: 'snapshot failed', err: { type: 'Error' } });
  });

  it('redacts an RPC URL in a viem error property and a plain message', () => {
    const { log, lines, records } = capture();
    log.warn({ err: new HttpRequestError({ url: ALCHEMY_URL, details: 'timeout' }) });
    log.warn(`retrying ${RPC_URL}`);
    expect(lines.join('')).not.toContain(ALCHEMY_KEY);
    expect(lines.join('')).not.toContain(RPC_URL);
    const [first, second] = records();
    expect(first).toMatchObject({ err: { type: 'HttpRequestError', url: 'https://x.g.alchemy.com<rpc>' } });
    expect(second).toMatchObject({ msg: 'retrying <rpc>' });
  });
});

describe('createLogger: toJSON values', () => {
  it('redacts a URL logged as a field, as the record and inside an error property', () => {
    const { log, lines, records } = capture();
    const endpoint = new URL(ALCHEMY_URL);
    log.info({ endpoint });
    log.info(endpoint);
    log.error({ err: Object.assign(new Error('boom'), { endpoint }) });
    expect(lines).toHaveLength(3);
    expect(lines.join('')).not.toContain(ALCHEMY_KEY);
    const [field, record = {}, nested] = records();
    expect(field).toMatchObject({ endpoint: 'https://x.g.alchemy.com<rpc>' });
    // Like plain pino, a record object contributes only its own entries (a URL has none).
    expect(Object.keys(record)).toEqual(['level', 'time', 'pid', 'hostname']);
    expect(nested).toMatchObject({ err: { type: 'Error', endpoint: 'https://x.g.alchemy.com<rpc>' } });
  });

  it('writes a Date and a Buffer as JSON.stringify does', () => {
    const { log, records } = capture();
    const at = new Date(Date.UTC(2026, 9, 16));
    log.info({ at, bytes: Buffer.from([1, 2]) });
    expect(records()[0]).toMatchObject({ at: at.toISOString(), bytes: { type: 'Buffer', data: [1, 2] } });
  });
});

describe('createLogger: level', () => {
  it('drops records below the configured level', () => {
    const { log, lines } = capture('warn');
    log.info('quiet');
    log.warn('loud');
    expect(lines).toHaveLength(1);
  });

  it('builds a stdout logger when no destination is given', () => {
    const log = createLogger({ level: 'silent', rpcUrl: RPC_URL });
    expect(log.level).toBe('silent');
    expect(() => log.info({ q: 1n }, 'not written at level silent')).not.toThrow();
  });
});

describe('redactRecord', () => {
  it('redacts the RPC URL and key segments at any depth and keeps the rest of the record', () => {
    const record = {
      step: 'result',
      thrown: `fetch ${ALCHEMY_URL} failed`,
      result: { message: `upstream ${RPC_URL} refused`, bookkeepingErrors: [`record: ${RPC_URL}`] },
      premium6: 1_500000n,
      ok: false,
    };
    const clean = redactRecord(record, RPC_URL);
    const text = JSON.stringify(clean);
    expect(text).not.toContain(ALCHEMY_KEY);
    expect(text).not.toContain('private-path');
    expect(clean).toEqual({
      step: 'result',
      thrown: 'fetch https://x.g.alchemy.com<rpc> failed',
      result: { message: 'upstream <rpc> refused', bookkeepingErrors: ['record: <rpc>'] },
      premium6: '1500000',
      ok: false,
    });
  });
});
