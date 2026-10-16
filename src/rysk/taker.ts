import { type Address, type Hex, isAddressEqual, isHex } from 'viem';
import { addressOf, isObject, UINT, uintOf } from '../domain/parse.ts';
import type { ConfirmParams, Quote, QuoteRequest } from '../domain/types.ts';
import { sleep } from '../lib/time.ts';
import { CallTimeoutError, RyskRpcError, SocketClosedError } from './errors.ts';
import type { JsonRpcSocket } from './socket.ts';

export type RpcCaller = Pick<JsonRpcSocket, 'call'>;

export type QuoteResult =
  | { ok: true; quote: Quote; requestedAtMs: number; respondedAtMs: number }
  | {
      ok: false;
      error: 'timeout' | 'rpc-error' | 'mismatch' | 'socket-closed';
      message: string;
      requestedAtMs: number;
    };

/** `no-reply.sent`: whether the frame reached the socket (false means the server never saw it). */
export type ConfirmReply =
  | { kind: 'hash'; txHash: Hex }
  | { kind: 'rejected'; code: number; message: string }
  | { kind: 'bad-result'; raw: unknown }
  | { kind: 'no-reply'; reason: 'timeout' | 'socket-closed'; sent: boolean };

export type RyskTakerOptions = {
  /** Server-aligned epoch seconds; bounds a quote's `validUntil`. */
  nowSec: () => number;
  nowMs: () => number;
  /** Minimum spacing between quote requests, counted from the previous one's start and its reply. */
  minGapMs?: number;
};

const TX_HASH = /^0x[0-9a-f]{64}$/i;
const MAX_QUOTE_TTL_SEC = 3600;

function sameAddress(wire: unknown, expected: Address): boolean {
  const address = addressOf(wire);
  return address !== undefined && isAddressEqual(address, expected);
}

function sameUint(wire: unknown, expected: string): boolean {
  return uintOf(wire) === BigInt(expected);
}

/** Whether `result` quotes `req`. Never throws: garbage is simply not a reply to this request. */
function quotesRequest(req: QuoteRequest, result: unknown): boolean {
  try {
    return (
      isObject(result) &&
      sameAddress(result.assetAddress, req.asset) &&
      sameAddress(result.usd, req.usd) &&
      sameAddress(result.collateralAsset, req.collateralAsset) &&
      result.chainId === req.chainId &&
      result.expiry === req.expiry &&
      result.isPut === req.isPut &&
      sameUint(result.quantity, req.quantity) &&
      sameUint(result.strike, req.strike)
    );
  } catch {
    return false;
  }
}

/**
 * The tradable quote in a reply `accept` matched, keeping the wire strings, or why it is a mismatch. The
 * fields `accept` checked are taken as they are.
 */
function parseQuote(result: unknown, nowSec: number): Quote | string {
  if (!isObject(result)) return 'the reply is not an object';
  const { isTakerBuy, validUntil, maker, nonce, price, signature, apy } = result;
  if (isTakerBuy !== false) return `isTakerBuy is ${String(isTakerBuy)}, not false`;
  if (typeof validUntil !== 'number' || !(nowSec < validUntil && validUntil <= nowSec + MAX_QUOTE_TTL_SEC)) {
    return `validUntil ${String(validUntil)} is not within (${nowSec}, ${nowSec + MAX_QUOTE_TTL_SEC}]`;
  }
  if (addressOf(maker) === undefined) return `maker ${String(maker)} is not an address`;
  if (typeof nonce !== 'string' || !UINT.test(nonce)) return `nonce ${String(nonce)} is not a uint string`;
  if (typeof price !== 'string' || !UINT.test(price)) return `price ${String(price)} is not a uint string`;
  if (typeof signature !== 'string' || !isHex(signature)) return 'signature is not hex';
  if (typeof apy !== 'number' || !Number.isFinite(apy)) return `apy ${String(apy)} is not a number`;
  return {
    assetAddress: result.assetAddress as Address,
    chainId: result.chainId as number,
    expiry: result.expiry as number,
    isPut: result.isPut as boolean,
    isTakerBuy,
    quantity: result.quantity as string,
    strike: result.strike as string,
    maker: maker as Address,
    nonce,
    price,
    validUntil,
    signature,
    usd: result.usd as Address,
    collateralAsset: result.collateralAsset as Address,
    apy,
  };
}

/** The result for a failed `request` call; undefined for an error that is not a call failure. */
function quoteFailure(
  error: unknown,
): { error: 'timeout' | 'rpc-error' | 'socket-closed'; message: string } | undefined {
  if (error instanceof CallTimeoutError) return { error: 'timeout', message: error.message };
  if (error instanceof RyskRpcError) return { error: 'rpc-error', message: error.message };
  if (error instanceof SocketClosedError) return { error: 'socket-closed', message: error.message };
  return undefined;
}

/** Rysk taker JSON-RPC: quote requests and trade confirmations over a `JsonRpcSocket`. Never retries. */
export class RyskTaker {
  readonly #socket: RpcCaller;
  readonly #nowSec: () => number;
  readonly #nowMs: () => number;
  readonly #minGapMs: number;
  /** `nowMs()` before which no quote request is handed to the socket. */
  #nextRequestAtMs = Number.NEGATIVE_INFINITY;

  constructor(socket: RpcCaller, opts: RyskTakerOptions) {
    this.#socket = socket;
    this.#nowSec = opts.nowSec;
    this.#nowMs = opts.nowMs;
    this.#minGapMs = opts.minGapMs ?? 250;
  }

  /**
   * Requests a quote for `req`. Rejects only with an error that is not a call failure (such as the signal's
   * abort reason); timeouts, RPC errors, socket closes and unusable replies are results.
   */
  async requestQuote(
    req: QuoteRequest,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<QuoteResult> {
    const waitMs = this.#reserveRequestSlot();
    if (waitMs > 0) await sleep(waitMs, opts.signal);
    const requestedAtMs = this.#nowMs();
    let result: unknown;
    try {
      result = await this.#socket.call<unknown>('request', req, {
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        accept: (reply) => quotesRequest(req, reply),
      });
    } catch (error) {
      const failure = quoteFailure(error);
      if (failure === undefined) throw error;
      return { ok: false, ...failure, requestedAtMs };
    } finally {
      this.#nextRequestAtMs = Math.max(this.#nextRequestAtMs, this.#nowMs() + this.#minGapMs);
    }
    const respondedAtMs = this.#nowMs();
    const quote = parseQuote(result, this.#nowSec());
    if (typeof quote === 'string') return { ok: false, error: 'mismatch', message: quote, requestedAtMs };
    return { ok: true, quote, requestedAtMs, respondedAtMs };
  }

  /**
   * Sends signed confirmation `params`. Never retried and sent without `accept`, so the socket keeps it off
   * a connection that may still deliver a stale confirm reply. `onSent` fires once the frame is written.
   */
  async confirm(
    params: ConfirmParams,
    opts: { timeoutMs: number; onSent?: () => void },
  ): Promise<ConfirmReply> {
    let result: unknown;
    try {
      result = await this.#socket.call<unknown>('confirm', params, {
        timeoutMs: opts.timeoutMs,
        onSent: opts.onSent,
      });
    } catch (error) {
      if (error instanceof RyskRpcError) {
        return { kind: 'rejected', code: error.code, message: error.message };
      }
      if (error instanceof CallTimeoutError) {
        return { kind: 'no-reply', reason: 'timeout', sent: error.sent };
      }
      if (error instanceof SocketClosedError) {
        return { kind: 'no-reply', reason: 'socket-closed', sent: error.sent };
      }
      throw error;
    }
    if (typeof result === 'string' && TX_HASH.test(result)) {
      return { kind: 'hash', txHash: result.toLowerCase() as Hex };
    }
    return { kind: 'bad-result', raw: result };
  }

  /** Claims the next request slot, `minGapMs` after the previous one; returns how long to wait for it. */
  #reserveRequestSlot(): number {
    const nowMs = this.#nowMs();
    const slotMs = Math.max(nowMs, this.#nextRequestAtMs);
    this.#nextRequestAtMs = slotMs + this.#minGapMs;
    return slotMs - nowMs;
  }
}
