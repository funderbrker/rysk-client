import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmParams, QuoteRequest } from '../domain/index.ts';
import { sleep } from '../lib/time.ts';
import { CallTimeoutError, RyskRpcError, SocketClosedError } from './errors.ts';
import type { CallOptions } from './socket.ts';
import { type RpcCaller, RyskTaker } from './taker.ts';

type Captured = { request: QuoteRequest; reply: { result: Record<string, unknown> } };
const capture = JSON.parse(
  readFileSync(new URL('../../test/fixtures/spike-capture.json', import.meta.url), 'utf8'),
) as { requests: [Captured, Captured, ...Captured[]] };
const [put, call] = capture.requests;
const putQuote = put.reply.result;
const callQuote = call.reply.result;

const NOW_SEC = 1792146510;
const SENT_MS = 1792146507103;
const LATENCY_MS = 2416;
const OPTS = { timeoutMs: 15_000 };

type Frame = { result: unknown } | { error: Error };

/** A `vi.fn` mock loses `call`'s type parameter; the taker only ever reads `unknown` results. */
function asCaller(call: (method: string, params: unknown, opts: CallOptions) => Promise<unknown>): RpcCaller {
  return { call: call as RpcCaller['call'] };
}

/**
 * Answers each `call` like the socket: a frame whose `result` fails `accept` is skipped and waiting
 * continues; with no frame left the call times out. Every call advances the clock by `LATENCY_MS`.
 */
function setup(...calls: Frame[][]) {
  const clock = { ms: SENT_MS };
  const socketCall = vi.fn(async (method: string, _params: unknown, opts: CallOptions): Promise<unknown> => {
    clock.ms += LATENCY_MS;
    const frames = calls.shift();
    if (frames === undefined) throw new Error('unexpected call');
    for (const frame of frames) {
      if ('error' in frame) throw frame.error;
      if (opts.accept === undefined || opts.accept(frame.result)) return frame.result;
    }
    throw new CallTimeoutError(`${method} got no reply within ${opts.timeoutMs} ms`, true);
  });
  const taker = new RyskTaker(asCaller(socketCall), { nowSec: () => NOW_SEC, nowMs: () => clock.ms });
  return { taker, socketCall };
}

/** The `accept` predicate `requestQuote(put.request)` hands to the socket. */
async function putAccept(): Promise<(result: unknown) => boolean> {
  const { taker, socketCall } = setup([{ result: putQuote }]);
  await taker.requestQuote(put.request, OPTS);
  const accept = socketCall.mock.calls[0]?.[2].accept;
  if (accept === undefined) throw new Error('requestQuote passed no accept');
  return accept;
}

describe('RyskTaker.requestQuote', () => {
  it('sends a request frame and returns the captured put quote with its wire strings', async () => {
    const { taker, socketCall } = setup([{ result: putQuote }]);
    const signal = new AbortController().signal;

    const result = await taker.requestQuote(put.request, { timeoutMs: 15_000, signal });

    const { premiumAsset: _, ...quoteFields } = putQuote;
    expect(result).toEqual({
      ok: true,
      quote: quoteFields,
      requestedAtMs: SENT_MS,
      respondedAtMs: SENT_MS + LATENCY_MS,
    });
    if (!result.ok) throw new Error('expected a quote');
    expect(result.quote.price).toBe('1109494507915005812');
    expect(result.quote.validUntil).toBe(1792146573);
    expect(result.quote.nonce).toBe('1792146507232583277');
    expect(result.quote.apy).toBe(75.3299527524557);
    expect(socketCall).toHaveBeenCalledExactlyOnceWith('request', put.request, {
      timeoutMs: 15_000,
      signal,
      accept: expect.any(Function),
    });
  });

  it('accept rejects the call quote for the put request, so waiting continues to the put quote', async () => {
    const accept = await putAccept();
    expect(accept(callQuote)).toBe(false);
    expect(accept(putQuote)).toBe(true);

    const { taker } = setup([{ result: callQuote }, { result: putQuote }]);
    const result = await taker.requestQuote(put.request, OPTS);
    expect(result.ok && result.quote.strike).toBe('7800000000');
  });

  it('accept matches addresses in any case and numerics by value, and the quote keeps the wire form', async () => {
    const reply = {
      ...putQuote,
      assetAddress: getAddress(String(putQuote.assetAddress)),
      usd: String(putQuote.usd).toUpperCase().replace('0X', '0x'),
      collateralAsset: getAddress(String(putQuote.collateralAsset)),
      strike: '07800000000',
    };
    const { taker } = setup([{ result: reply }]);

    const result = await taker.requestQuote(put.request, OPTS);

    if (!result.ok) throw new Error(`expected a quote, got ${result.error}`);
    expect(result.quote.assetAddress).toBe(reply.assetAddress);
    expect(result.quote.usd).toBe(reply.usd);
    expect(result.quote.strike).toBe('07800000000');
  });

  it.each([
    ['null', null],
    ['a string', 'garbage'],
    ['an array', [putQuote]],
    ['an empty object', {}],
    ['an invalid assetAddress', { ...putQuote, assetAddress: 'nope' }],
    ['a different usd', { ...putQuote, usd: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb' }],
    ['a different collateralAsset', { ...putQuote, collateralAsset: putQuote.assetAddress }],
    ['chainId as a string', { ...putQuote, chainId: '999' }],
    ['a different expiry', { ...putQuote, expiry: 1793347200 }],
    ['expiry as a string', { ...putQuote, expiry: '1792742400' }],
    ['isPut false', { ...putQuote, isPut: false }],
    ['a different quantity', { ...putQuote, quantity: '50000000000000000000' }],
    ['quantity in exponent form', { ...putQuote, quantity: '25e18' }],
    ['quantity as a number', { ...putQuote, quantity: 25e18 }],
    ['strike missing', { ...putQuote, strike: undefined }],
  ])('accept returns false without throwing for %s', async (_name, result) => {
    const accept = await putAccept();
    expect(accept(result)).toBe(false);
  });

  it.each([
    ['isTakerBuy true', { isTakerBuy: true }],
    ['isTakerBuy missing', { isTakerBuy: undefined }],
    ['validUntil in milliseconds', { validUntil: 1792146573000 }],
    ['validUntil equal to now', { validUntil: NOW_SEC }],
    ['validUntil more than an hour ahead', { validUntil: NOW_SEC + 3601 }],
    ['validUntil as a string', { validUntil: '1792146573' }],
    ['price not a decimal string', { price: 1.1 }],
    ['nonce missing', { nonce: undefined }],
    ['maker not an address', { maker: '0x1234' }],
    ['signature not hex', { signature: 'sig' }],
    ['apy not a number', { apy: '75.3' }],
  ])('a matching reply with %s is a mismatch', async (_name, change) => {
    const { taker } = setup([{ result: { ...putQuote, ...change } }]);

    const result = await taker.requestQuote(put.request, OPTS);

    expect(result).toEqual({
      ok: false,
      error: 'mismatch',
      message: expect.any(String),
      requestedAtMs: SENT_MS,
    });
  });

  it('accepts validUntil exactly an hour ahead', async () => {
    const { taker } = setup([{ result: { ...putQuote, validUntil: NOW_SEC + 3600 } }]);
    const result = await taker.requestQuote(put.request, OPTS);
    expect(result.ok && result.quote.validUntil).toBe(NOW_SEC + 3600);
  });

  it.each([
    ['CallTimeoutError', new CallTimeoutError('request got no reply within 15000 ms', true), 'timeout'],
    ['RyskRpcError', new RyskRpcError(-32601, 'Method not found'), 'rpc-error'],
    [
      'SocketClosedError',
      new SocketClosedError('request: socket closed before the reply', true),
      'socket-closed',
    ],
  ])('maps %s to %s with its message', async (_name, error, kind) => {
    const { taker } = setup([{ error }]);

    const result = await taker.requestQuote(put.request, OPTS);

    expect(result).toEqual({ ok: false, error: kind, message: error.message, requestedAtMs: SENT_MS });
  });

  it('rethrows any other error, such as the abort reason', async () => {
    const reason = new DOMException('stopped', 'AbortError');
    const { taker } = setup([{ error: reason }]);
    await expect(taker.requestQuote(put.request, OPTS)).rejects.toBe(reason);
  });
});

describe('RyskTaker.requestQuote spacing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A `call` that records when it is invoked and answers the put quote after `replyMs`. */
  function timedTaker(replyMs: number, minGapMs?: number) {
    vi.useFakeTimers({ now: SENT_MS });
    const calledAtMs: number[] = [];
    const socketCall = vi.fn(async (): Promise<unknown> => {
      calledAtMs.push(Date.now());
      if (replyMs > 0) await sleep(replyMs);
      return putQuote;
    });
    const taker = new RyskTaker(asCaller(socketCall), {
      nowSec: () => NOW_SEC,
      nowMs: () => Date.now(),
      minGapMs,
    });
    return { taker, calledAtMs };
  }

  it('sends back-to-back requests at least 250 ms apart', async () => {
    const { taker, calledAtMs } = timedTaker(0);

    const first = taker.requestQuote(put.request, OPTS);
    const second = taker.requestQuote(put.request, OPTS);
    await vi.advanceTimersByTimeAsync(249);
    expect(calledAtMs).toEqual([SENT_MS]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calledAtMs).toEqual([SENT_MS, SENT_MS + 250]);

    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
  });

  it('counts the gap from the previous reply', async () => {
    const { taker, calledAtMs } = timedTaker(1_000, 400);

    const first = taker.requestQuote(put.request, OPTS);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await first).ok).toBe(true);
    const second = taker.requestQuote(put.request, OPTS);
    await vi.advanceTimersByTimeAsync(399);
    expect(calledAtMs).toEqual([SENT_MS]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calledAtMs).toEqual([SENT_MS, SENT_MS + 1_400]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect((await second).ok).toBe(true);
  });
});

describe('RyskTaker.confirm', () => {
  const params = { nonce: '1792146516346', signature: `0x${'cd'.repeat(65)}` } as unknown as ConfirmParams;
  const HASH = `0x${'ab'.repeat(32)}`;

  it('sends a confirm frame without accept and returns the tx hash', async () => {
    const { taker, socketCall } = setup([{ result: HASH }]);
    const onSent = vi.fn();

    await expect(taker.confirm(params, { timeoutMs: 60_000, onSent })).resolves.toEqual({
      kind: 'hash',
      txHash: HASH,
    });

    expect(socketCall).toHaveBeenCalledOnce();
    const [method, sentParams, opts] = socketCall.mock.calls[0] ?? [];
    expect(method).toBe('confirm');
    expect(sentParams).toBe(params);
    expect(opts).toEqual({ timeoutMs: 60_000, onSent });
    expect(opts?.accept).toBeUndefined();
  });

  it('lowercases an upper-case tx hash', async () => {
    const { taker } = setup([{ result: HASH.toUpperCase().replace('0X', '0x') }]);
    await expect(taker.confirm(params, { timeoutMs: 60_000 })).resolves.toEqual({
      kind: 'hash',
      txHash: HASH,
    });
  });

  it.each([
    ['ok', 'ok'],
    ['a short hex string', `0x${'ab'.repeat(31)}`],
    ['an object', { txHash: HASH }],
    ['null', null],
  ])('a %s result is a bad result carrying the raw value', async (_name, raw) => {
    const { taker } = setup([{ result: raw }]);
    await expect(taker.confirm(params, { timeoutMs: 60_000 })).resolves.toEqual({ kind: 'bad-result', raw });
  });

  it('an RPC error is a rejection with its code and message', async () => {
    const { taker } = setup([{ error: new RyskRpcError(-32000, 'quote expired') }]);
    await expect(taker.confirm(params, { timeoutMs: 60_000 })).resolves.toEqual({
      kind: 'rejected',
      code: -32000,
      message: 'quote expired',
    });
  });

  it.each([
    ['a timeout', new CallTimeoutError('confirm got no reply within 60000 ms', true), 'timeout', true],
    [
      'an unsent timeout',
      new CallTimeoutError('confirm was not sent within 60000 ms', false),
      'timeout',
      false,
    ],
    [
      'a socket close',
      new SocketClosedError('confirm: socket closed before the reply', true),
      'socket-closed',
      true,
    ],
  ])('%s is no reply, saying whether the frame was sent', async (_name, error, reason, sent) => {
    const { taker } = setup([{ error }]);
    await expect(taker.confirm(params, { timeoutMs: 60_000 })).resolves.toEqual({
      kind: 'no-reply',
      reason,
      sent,
    });
  });

  it('rethrows any other error', async () => {
    const error = new Error('boom');
    const { taker } = setup([{ error }]);
    await expect(taker.confirm(params, { timeoutMs: 60_000 })).rejects.toBe(error);
  });
});
