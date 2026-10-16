import { createHash } from 'node:crypto';
import type { Address } from 'viem';
import { parseCaps } from '../domain/caps.ts';
import { CHAIN_ID, TOKENS, TRADED_PRODUCTS, tokenByAddress, ZERO_ADDRESS } from '../domain/constants.ts';
import { isObject } from '../domain/parse.ts';
import type { Cap, Listing, Quote, QuoteRequest } from '../domain/types.ts';
import { strikeE8FromNumber, UnitError } from '../domain/units.ts';
import type { Clock, sleep } from '../lib/time.ts';
import { makerSignatureOk } from '../rysk/eip712.ts';
import type { RyskRest } from '../rysk/rest.ts';
import type { RyskTaker } from '../rysk/taker.ts';
import type { TokenBucket } from './bucket.ts';
import type { SamplerConfig } from './config.ts';
import type { Log } from './logger.ts';
import type { Recorder, RecordStream } from './recorder.ts';
import { type SampleContext, type SampleOutcome, sampleQuoteRecord } from './records.ts';

export type SamplerDeps = {
  /** The sampler's own taker, on its own socket (spec §9.2); never asked to confirm. */
  taker: Pick<RyskTaker, 'requestQuote'>;
  rest: Pick<RyskRest, 'caps' | 'publicHistory'>;
  recorder: Pick<Recorder, 'append'>;
  /** The sampler's RFQ rate limit (spec §8.7); every sampler RFQ takes a token first. */
  bucket: Pick<TokenBucket, 'take' | 'waitMs'>;
  clock: Clock;
  sleep: typeof sleep;
  signal: AbortSignal;
  /** The latest HYPE listings the daemon parsed. */
  listings: () => Listing[];
  /** True while a trade executes: no RFQ is sent until it is false again. */
  isExecuting: () => boolean;
  /** The trading wallet, the taker of the taker pair's first leg. */
  self: Address;
  /** Recovers a quote's signer (`recoverQuoteSigner`); without it `makerSigOk` is `null`. */
  recoverMaker?: (quote: Quote) => Promise<Address>;
  /**
   * HYPE spot as the loop defines it (the latest snapshot's WHYPE asset price); `null` before the first. Without it,
   * or while it is `null`, the records take spot from the latest listings' index price.
   */
  spotE8?: () => bigint | null;
  /** Shuffles the sweep; `Math.random` by default. */
  random?: () => number;
  log?: Pick<Log, 'warn' | 'error'>;
};

/** Every sampler RFQ is for 25 contracts, WHYPE's minimum trade size (spec §9.2). */
export const SAMPLE_QUANTITY_E18 = 25n * 10n ** 18n;

type Purpose = SampleContext['purpose'];

/** A sampler stream: a run, then `delayMs` of sleep, until aborted. */
type Stream = { name: string; delayMs: number; needsListings: boolean; run: (run: number) => Promise<void> };

/** What the streams share across runs. */
type Sampler = {
  deps: SamplerDeps;
  cfg: SamplerConfig;
  random: () => number;
  /** Settles when the last queued RFQ group is done: groups reach the socket one at a time, in order. */
  rfqTail: Promise<void>;
  /** Chosen on the first run that needs them, kept until they expire. */
  pinned: Listing[];
  /** The cap names (lowercase) the inventory stream records: GLOBAL, HYPE and the sampled tokens'. */
  hypeCapNames: Set<string>;
  /** The last inventory record's content hash and when it was taken. */
  inventory: { contentHash: string; recordedAtMs: number } | null;
  /** The end of the last public-fills window read (startup at first), and the fill hashes recorded (oldest first). */
  fills: { lastToSec: number; seen: Set<string> };
};

const MINUTE_MS = 60_000;
/** The Rysk symbol of the underlying, which names its caps. */
const HYPE_SYMBOL = 'HYPE';
/** The ~0.10 and ~0.25 delta strikes of the pinned series, in pick order. */
const PINNED_ABS_DELTAS = [0.1, 0.25] as const;
/** How often an RFQ paused for an execution, or a stream waiting for its first listings, looks again. */
const POLL_MS = 1_000;
/** How often the inventory stream checks the listings and caps for a change of content. */
const INVENTORY_CHECK_MS = MINUTE_MS;
/** Each public-fills window starts this long before the previous one ended, for fills the API lists late. */
const FILLS_OVERLAP_SEC = 300;
/** The public fills remembered for de-duplication; the oldest are forgotten past this many. */
const MAX_SEEN_FILLS = 10_000;

/**
 * The sweep's RFQs (spec §9.2): the listings in a random order (Fisher–Yates on `random`), each as one leg per
 * configured product, back to back: a put in each of `putStables` (as its strike and collateral asset), a call in
 * each of `callCollaterals` paid in USDC. All from the zero address, for `quantityE18`.
 */
export function buildSweep(
  listings: Listing[],
  cfg: SamplerConfig,
  quantityE18: bigint,
  random: () => number,
): QuoteRequest[] {
  return shuffled(listings, random).flatMap((listing) =>
    listing.isPut
      ? cfg.putStables.map((stable) => sampleRequest(listing, stable, stable, ZERO_ADDRESS, quantityE18))
      : cfg.callCollaterals.map((collateral) =>
          sampleRequest(listing, TOKENS.USDC.address, collateral, ZERO_ADDRESS, quantityE18),
        ),
  );
}

/**
 * The pinned series (spec §9.2): of the nearest expiry, the listing whose `|delta|` is nearest 0.10 on each side,
 * then the one nearest 0.25 (the next nearest when that is the same listing); at most `n`.
 */
export function pickPinned(listings: Listing[], n = 4): Listing[] {
  const nearestSec = Math.min(...listings.map((l) => l.expirySec));
  const front = listings.filter((l) => l.expirySec === nearestSec);
  const chosen: Listing[] = [];
  for (const target of PINNED_ABS_DELTAS) {
    for (const isPut of [true, false]) {
      const open = front.filter((l) => l.isPut === isPut && !chosen.includes(l));
      const nearest = nearestAbsDelta(open, target);
      if (nearest !== undefined) chosen.push(nearest);
    }
  }
  return chosen.slice(0, n);
}

/**
 * The research sampler (spec §9.2): one fixed-delay loop per stream whose `*EveryMin` is not 0, until `signal`
 * aborts. The RFQ streams (sweep, pinned, taker pair) and the inventory snapshot first wait for listings.
 *
 * - sweep: `buildSweep` over the live listings, every `sweepEveryMin` after the last sweep ended;
 * - pinned: `pickPinned`'s instruments in the traded products, kept for their lifetime (quoted as custom strikes once
 *   de-listed) and re-picked once they expire;
 * - taker pair: the first pinned instrument from `self` and from the zero address, back to back;
 * - inventory: the latest listings and the HYPE caps as parsed, first, when what is listed or a cap limit changes
 *   (checked every minute) and otherwise every `inventoryEveryMin`;
 * - public fills: `publicHistory` since the last window (overlapping it; the first since startup), one record per fill
 *   new to this run.
 *
 * Every RFQ waits while a trade executes, then for a bucket token, and is recorded in `quotes` whatever its outcome.
 * RFQ groups (a listing's legs, the taker pair) are sent back to back, one group at a time across the streams. The
 * sampler never confirms. A failed run is logged and the stream carries on.
 */
export async function runSampler(deps: SamplerDeps, cfg: SamplerConfig): Promise<void> {
  if (!cfg.enabled) return;
  const sampler: Sampler = {
    deps,
    cfg,
    random: deps.random ?? Math.random,
    rfqTail: Promise.resolve(),
    pinned: [],
    hypeCapNames: hypeCapNames([TOKENS.WHYPE.address, ...cfg.putStables, ...cfg.callCollaterals]),
    inventory: null,
    fills: { lastToSec: nowSecOf(deps.clock), seen: new Set() },
  };
  const inventoryMs = cfg.inventoryEveryMin * MINUTE_MS;
  const streams: (Stream & { everyMin: number })[] = [
    rfqStream('sweep', cfg.sweepEveryMin, (run) => sweep(sampler, run)),
    rfqStream('pinned', cfg.pinnedEveryMin, (run) => pinnedRun(sampler, run)),
    rfqStream('taker-pair', cfg.takerPairEveryMin, (run) => takerPair(sampler, run)),
    {
      name: 'inventory',
      everyMin: cfg.inventoryEveryMin,
      delayMs: Math.min(INVENTORY_CHECK_MS, inventoryMs),
      needsListings: true,
      run: () => inventoryCheck(sampler, inventoryMs),
    },
    {
      name: 'public-fills',
      everyMin: cfg.publicFillsEveryMin,
      delayMs: cfg.publicFillsEveryMin * MINUTE_MS,
      needsListings: false,
      run: () => publicFills(sampler),
    },
  ];
  await Promise.all(streams.filter((s) => s.everyMin > 0).map((s) => schedule(sampler, s)));
}

function rfqStream(name: Purpose, everyMin: number, run: (run: number) => Promise<void>) {
  return { name, everyMin, delayMs: everyMin * MINUTE_MS, needsListings: true, run };
}

async function schedule(sampler: Sampler, stream: Stream): Promise<void> {
  const { deps } = sampler;
  if (stream.needsListings && !(await untilListed(deps))) return;
  for (let run = 1; !deps.signal.aborted; run++) {
    try {
      await stream.run(run);
    } catch (error) {
      if (!deps.signal.aborted) {
        deps.log?.warn({ err: error, stream: stream.name, run }, 'sampler run failed');
      }
    }
    await pause(deps, stream.delayMs);
  }
}

async function sweep(sampler: Sampler, run: number): Promise<void> {
  const { deps, cfg, random } = sampler;
  const listings = liveListings(deps);
  const requests = buildSweep(listings, cfg, SAMPLE_QUANTITY_E18, random);
  for (const group of byInstrument(requests)) {
    if (deps.signal.aborted) return;
    await quoteGroup(sampler, 'sweep', run, group);
  }
}

async function pinnedRun(sampler: Sampler, run: number): Promise<void> {
  for (const listing of currentPinned(sampler)) {
    if (sampler.deps.signal.aborted) return;
    await quoteGroup(sampler, 'pinned', run, [tradedRequest(listing, ZERO_ADDRESS)]);
  }
}

async function takerPair(sampler: Sampler, run: number): Promise<void> {
  const [first] = currentPinned(sampler);
  if (first === undefined) return;
  const pair = [tradedRequest(first, sampler.deps.self), tradedRequest(first, ZERO_ADDRESS)];
  await quoteGroup(sampler, 'taker-pair', run, pair);
}

/** The pinned instruments that have not expired, re-picked from the live listings once none is left. */
function currentPinned(sampler: Sampler): Listing[] {
  const nowSec = nowSecOf(sampler.deps.clock);
  sampler.pinned = sampler.pinned.filter((l) => l.expirySec > nowSec);
  if (sampler.pinned.length === 0) {
    sampler.pinned = pickPinned(liveListings(sampler.deps), sampler.cfg.pinned);
  }
  return sampler.pinned;
}

/** Queues `requests` to be sent back to back after every group queued before; settles when they are done. */
function quoteGroup(
  sampler: Sampler,
  purpose: Purpose,
  run: number,
  requests: QuoteRequest[],
): Promise<void> {
  const done = sampler.rfqTail.then(() => sendEach(sampler, purpose, run, requests));
  sampler.rfqTail = done.catch(() => {});
  return done;
}

async function sendEach(
  sampler: Sampler,
  purpose: Purpose,
  run: number,
  requests: QuoteRequest[],
): Promise<void> {
  for (const request of requests) {
    if (!(await sendOne(sampler, purpose, run, request))) return;
  }
}

/**
 * Waits until no trade is executing and the bucket grants a token, then sends one RFQ and records it with the market
 * as the latest listings show it. False once aborted (an RFQ aborted in flight is not recorded).
 */
async function sendOne(
  sampler: Sampler,
  purpose: Purpose,
  run: number,
  request: QuoteRequest,
): Promise<boolean> {
  const { deps, cfg } = sampler;
  for (;;) {
    if (deps.signal.aborted) return false;
    if (deps.isExecuting()) await pause(deps, POLL_MS);
    else if (deps.bucket.take()) break;
    else await pause(deps, Math.max(1, deps.bucket.waitMs()));
  }
  // No await from the last `isExecuting()` and the token to `requestQuote`, so no execution can start between.
  const sentAtMs = deps.clock.nowMs();
  const listings = deps.listings();
  const [latest] = listings;
  const assetSpotE8 = deps.spotE8?.() ?? null;
  const ctx: SampleContext = {
    purpose,
    run,
    nowSec: Math.floor(sentAtMs / 1000),
    spotE8: assetSpotE8 ?? (latest === undefined ? null : indexSpotE8Of(latest)),
    spotSource: assetSpotE8 === null ? 'index' : 'asset',
    inventoryTs: latest?.observedAtSec ?? null,
    listing: listings.find((l) => sameInstrument(l, request)),
  };
  let outcome: SampleOutcome;
  try {
    const result = await deps.taker.requestQuote(request, {
      timeoutMs: cfg.requestTimeoutMs,
      signal: deps.signal,
    });
    outcome = result.ok
      ? { ...result, makerSigOk: await makerSignatureOk(result.quote, deps.recoverMaker) }
      : result;
  } catch (error) {
    if (deps.signal.aborted) return false;
    outcome = { ok: false, error: 'rpc-error', message: messageOf(error), requestedAtMs: sentAtMs };
  }
  record(deps, 'quotes', sampleQuoteRecord(request, outcome, ctx));
  return true;
}

/**
 * Reads the caps and records them (the HYPE ones) with the latest listings on the first check, when the content
 * changed since the last record, or once `intervalMs` has passed since it. The content is what is listed (each
 * listing's side, strike, expiry and products) and each cap's limit: delta, APR, index and cap usage move all the time
 * and are recorded but not compared. A failed caps read throws, so the check is skipped (and logged) and the next one
 * tries again.
 */
async function inventoryCheck(sampler: Sampler, intervalMs: number): Promise<void> {
  const { deps } = sampler;
  const listings = deps.listings();
  const parsed = parseCaps(await deps.rest.caps());
  const caps = parsed.caps.filter((cap) => sampler.hypeCapNames.has(cap.name.toLowerCase()));
  const contentHash = inventoryHash(listings, caps);
  const nowMs = deps.clock.nowMs();
  const last = sampler.inventory;
  let trigger: 'first' | 'changed' | 'interval';
  if (last === null) trigger = 'first';
  else if (last.contentHash !== contentHash) trigger = 'changed';
  else if (nowMs - last.recordedAtMs >= intervalMs) trigger = 'interval';
  else return;
  const inventoryTs = listings[0]?.observedAtSec ?? null;
  const body = { trigger, contentHash, inventoryTs, listings, caps, droppedCaps: parsed.dropped };
  record(deps, 'inventory', body);
  sampler.inventory = { contentHash, recordedAtMs: nowMs };
}

/**
 * Reads the public fills since the last window (since startup for the first), reaching `FILLS_OVERLAP_SEC` further
 * back, and records each fill whose `txHash` this run has not recorded, as the API returned it. A row without a
 * `txHash` cannot be de-duplicated and is skipped. Runs overlap across restarts too, so offline readers must still
 * de-duplicate by `txHash` across files.
 */
async function publicFills(sampler: Sampler): Promise<void> {
  const { deps, fills } = sampler;
  const toSec = nowSecOf(deps.clock);
  const fromSec = fills.lastToSec - FILLS_OVERLAP_SEC;
  const rows = await deps.rest.publicHistory(fromSec, toSec);
  if (!Array.isArray(rows)) throw new Error('public history: top level is not an array');
  let skipped = 0;
  for (const row of rows) {
    const txHash = isObject(row) && typeof row.txHash === 'string' ? row.txHash.toLowerCase() : undefined;
    if (txHash === undefined) skipped += 1;
    else if (!fills.seen.has(txHash)) {
      remember(fills.seen, txHash);
      record(deps, 'public-fills', { fromSec, toSec, fill: row });
    }
  }
  if (skipped > 0) deps.log?.warn({ skipped, fromSec, toSec }, 'public fills without a txHash skipped');
  fills.lastToSec = toSec;
}

function remember(seen: Set<string>, txHash: string): void {
  seen.add(txHash);
  for (const oldest of seen) {
    if (seen.size <= MAX_SEEN_FILLS) break;
    seen.delete(oldest);
  }
}

/** Appends a record; a failed write is logged and never stops the sampler. */
function record(deps: SamplerDeps, stream: RecordStream, body: object): void {
  try {
    deps.recorder.append(stream, body);
  } catch (error) {
    deps.log?.error({ err: error, stream }, 'could not append a sampler record');
  }
}

/** An RFQ for the listing's instrument in one product, in the wire format of the strategy's candidates. */
function sampleRequest(
  listing: Listing,
  usd: Address,
  collateralAsset: Address,
  taker: Address,
  quantityE18: bigint,
): QuoteRequest {
  return {
    asset: TOKENS.WHYPE.address,
    assetName: listing.isPut ? TOKENS.WHYPE.symbol : collateralSymbol(collateralAsset),
    chainId: CHAIN_ID,
    expiry: listing.expirySec,
    isPut: listing.isPut,
    quantity: quantityE18.toString(),
    strike: listing.strikeE8.toString(),
    taker,
    usd,
    collateralAsset,
    isEIP1271: false,
  };
}

/** An RFQ for the listing's instrument in the product the wheel trades on its side. */
function tradedRequest(listing: Listing, taker: Address): QuoteRequest {
  const product = TRADED_PRODUCTS[listing.isPut ? 'put' : 'call'];
  return sampleRequest(listing, product.strikeAsset, product.collateralAsset, taker, SAMPLE_QUANTITY_E18);
}

/** A call's RFQ `assetName` is its collateral's symbol (`kHYPE`). */
function collateralSymbol(collateral: Address): string {
  const token = tokenByAddress(collateral);
  if (token === undefined) throw new Error(`sampler: unknown call collateral ${collateral}`);
  return token.symbol;
}

/** A Fisher–Yates shuffle of a copy of `items`, drawing from `random` (in [0, 1)). */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    const swap = out[i] as T;
    out[i] = out[j] as T;
    out[j] = swap;
  }
  return out;
}

/** Consecutive requests for the same instrument (a listing's legs), in order. */
function byInstrument(requests: QuoteRequest[]): QuoteRequest[][] {
  const groups: QuoteRequest[][] = [];
  for (const request of requests) {
    const last = groups.at(-1);
    const [head] = last ?? [];
    if (last !== undefined && head !== undefined && sameTerms(head, request)) last.push(request);
    else groups.push([request]);
  }
  return groups;
}

function sameTerms(a: QuoteRequest, b: QuoteRequest): boolean {
  return a.isPut === b.isPut && a.strike === b.strike && a.expiry === b.expiry;
}

function sameInstrument(listing: Listing, request: QuoteRequest): boolean {
  return (
    listing.isPut === request.isPut &&
    listing.expirySec === request.expiry &&
    listing.strikeE8.toString() === request.strike
  );
}

/** The listing nearest `target` in `|delta|`, the lower strike on a tie. */
function nearestAbsDelta(listings: Listing[], target: number): Listing | undefined {
  const distance = (l: Listing): number => Math.abs(Math.abs(l.delta) - target);
  return [...listings].sort((a, b) => distance(a) - distance(b) || (a.strikeE8 < b.strikeE8 ? -1 : 1))[0];
}

/** The latest listings that have not expired. */
function liveListings(deps: SamplerDeps): Listing[] {
  const nowSec = nowSecOf(deps.clock);
  return deps.listings().filter((l) => l.expirySec > nowSec);
}

/**
 * The lowercase cap names that concern HYPE: GLOBAL, the underlying's symbol, and each token's address alone or with
 * `-true`/`-false` (its puts or calls).
 */
function hypeCapNames(tokens: Address[]): Set<string> {
  const names = new Set(['global', HYPE_SYMBOL.toLowerCase()]);
  for (const token of tokens) {
    const address = token.toLowerCase();
    for (const name of [address, `${address}-true`, `${address}-false`]) names.add(name);
  }
  return names;
}

/**
 * A hash of what is listed and the cap limits, independent of order and casing: each listing's side, strike, expiry
 * and products, and each cap's name, type and limit. Delta, APR, index, observation time and cap usage are left out.
 */
function inventoryHash(listings: Listing[], caps: Cap[]): string {
  const listed = listings.map((l) => {
    const products = l.products
      .map((p) => [p.underlying, p.strikeAsset, p.collateralAsset, p.isPut].join('/').toLowerCase())
      .sort();
    return JSON.stringify([l.isPut, l.strikeE8.toString(), l.expirySec, products]);
  });
  const limits = caps.map((c) => JSON.stringify([c.name.toLowerCase(), c.type, c.capE18.toString()]));
  const content = [...listed.sort(), '--', ...limits.sort()].join('\n');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** HYPE spot from a listing's index price, through its 8-decimal string; `null` when it is not a positive price. */
function indexSpotE8Of(listing: Listing): bigint | null {
  try {
    return strikeE8FromNumber(listing.indexUsd);
  } catch (error) {
    if (error instanceof UnitError) return null;
    throw error;
  }
}

/** Waits until the daemon has listings; false once aborted. */
async function untilListed(deps: SamplerDeps): Promise<boolean> {
  while (!deps.signal.aborted) {
    if (deps.listings().length > 0) return true;
    await pause(deps, POLL_MS);
  }
  return false;
}

/** `deps.sleep`, which ends early on abort (a rejection then is the abort, not an error). */
async function pause(deps: SamplerDeps, ms: number): Promise<void> {
  try {
    await deps.sleep(ms, deps.signal);
  } catch (error) {
    if (!deps.signal.aborted) throw error;
  }
}

function nowSecOf(clock: Clock): number {
  return Math.floor(clock.nowMs() / 1000);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
