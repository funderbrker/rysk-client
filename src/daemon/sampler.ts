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
import { backoffKeyOf } from './memo.ts';
import type { Recorder, RecordStream } from './recorder.ts';
import { type SampleContext, type SampleOutcome, sampleQuoteRecord } from './records.ts';

export type SamplerDeps = {
  /**
   * The sampler's own takers, one socket each (spec §9.2), never asked to confirm. A socket carries one RFQ at a
   * time, so each RFQ group goes to the first free taker: `takers.length` is the sampler's parallelism.
   */
  takers: [Pick<RyskTaker, 'requestQuote'>, ...Pick<RyskTaker, 'requestQuote'>[]];
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

/** A sampler stream: a run every `periodMs` from the start of the previous one (at once after a longer run), until aborted. */
type Stream = { name: string; periodMs: number; needsListings: boolean; run: (run: number) => Promise<void> };

/** One taker (one socket) and whether a group is in flight on it. */
type Lane = { taker: Pick<RyskTaker, 'requestQuote'>; busy: boolean };

/** An RFQ group waiting for a free lane, and the promise its stream awaits. */
type QueuedGroup = {
  purpose: Purpose;
  run: number;
  requests: QuoteRequest[];
  tally: SweepTally | undefined;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/** What the inventory stream compares: each listing's products by instrument key, each cap's limit by name and type. */
type InventoryContent = {
  hash: string;
  listed: Map<string, string>;
  limits: Map<string, Pick<Cap, 'name' | 'type' | 'capE18'>>;
};

/** The last inventory record's content, and when the last full one (`first` or `interval`) was written. */
type InventoryState = { content: InventoryContent; fullAtMs: number };

/** How one RFQ of a group went: sent (whatever its outcome), skipped as de-listed, or stopped by the abort. */
type Sent = 'sent' | 'unlisted' | 'aborted';

/** A sweep's legs so far: RFQs sent, and legs skipped because their instrument was no longer listed. */
type SweepTally = { sent: number; skippedUnlisted: number };

/** What the streams share across runs. */
type Sampler = {
  deps: SamplerDeps;
  cfg: SamplerConfig;
  random: () => number;
  /** One lane per taker, and the groups waiting for a free one (FIFO across the streams). */
  lanes: Lane[];
  queue: QueuedGroup[];
  /** Chosen on the first run that needs them, kept until they expire. */
  pinned: Listing[];
  /** The cap names (lowercase) the inventory stream records: GLOBAL, HYPE and the sampled tokens'. */
  hypeCapNames: Set<string>;
  /** The last inventory record's content; `null` before the first. */
  inventory: InventoryState | null;
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
 * The research sampler (spec §9.2): one fixed-rate loop per stream whose `*EveryMin` is not 0, until `signal`
 * aborts: a run starts every `*EveryMin` from the start of the previous one, or at once after a run that took
 * longer, and runs of one stream never overlap. The RFQ streams (sweep, pinned, taker pair) and the inventory
 * snapshot first wait for listings.
 *
 * - sweep: `buildSweep` over the live listings, all its groups queued at once; a leg whose instrument is no longer
 *   listed when its turn comes is skipped (no RFQ, no token), and a finished sweep writes one `sweep-summary` record
 *   to `quotes` with its legs, the RFQs sent and the legs skipped;
 * - pinned: `pickPinned`'s instruments in the traded products, kept for their lifetime (quoted as custom strikes once
 *   de-listed) and re-picked once they expire;
 * - taker pair: the first pinned instrument from `self` and from the zero address, back to back;
 * - inventory: the latest listings and the HYPE caps as parsed, first and every `inventoryEveryMin` after the last
 *   full record; in between, checked every minute, a `changed` record with only the difference (instrument keys
 *   added and removed, products changed, cap limits changed) when what is listed or a cap limit changes;
 * - public fills: `publicHistory` since the last window (overlapping it; the first since startup), one record per fill
 *   new to this run.
 *
 * Every RFQ waits while a trade executes, then for a bucket token (the rate limit holds across the lanes), and is
 * recorded in `quotes` whatever its outcome, unless shutdown cut it off. RFQ groups (a listing's legs, the taker
 * pair) go to the first free lane and are sent back to back on it, one group at a time per lane, across the
 * streams. The sampler never confirms. A failed run is logged and the stream carries on.
 */
export async function runSampler(deps: SamplerDeps, cfg: SamplerConfig): Promise<void> {
  if (!cfg.enabled) return;
  const sampler: Sampler = {
    deps,
    cfg,
    random: deps.random ?? Math.random,
    lanes: deps.takers.map((taker) => ({ taker, busy: false })),
    queue: [],
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
      periodMs: Math.min(INVENTORY_CHECK_MS, inventoryMs),
      needsListings: true,
      run: () => inventoryCheck(sampler, inventoryMs),
    },
    {
      name: 'public-fills',
      everyMin: cfg.publicFillsEveryMin,
      periodMs: cfg.publicFillsEveryMin * MINUTE_MS,
      needsListings: false,
      run: () => publicFills(sampler),
    },
  ];
  await Promise.all(streams.filter((s) => s.everyMin > 0).map((s) => schedule(sampler, s)));
}

function rfqStream(name: Purpose, everyMin: number, run: (run: number) => Promise<void>) {
  return { name, everyMin, periodMs: everyMin * MINUTE_MS, needsListings: true, run };
}

/** Runs the stream at a fixed rate: the next run starts `periodMs` after the previous one started, or at once. */
async function schedule(sampler: Sampler, stream: Stream): Promise<void> {
  const { deps } = sampler;
  if (stream.needsListings && !(await untilListed(deps))) return;
  for (let run = 1; !deps.signal.aborted; run++) {
    const startedAtMs = deps.clock.nowMs();
    try {
      await stream.run(run);
    } catch (error) {
      if (!deps.signal.aborted) {
        deps.log?.warn({ err: error, stream: stream.name, run }, 'sampler run failed');
      }
    }
    const elapsedMs = Math.max(0, deps.clock.nowMs() - startedAtMs);
    if (elapsedMs < stream.periodMs) await pause(deps, stream.periodMs - elapsedMs);
  }
}

/**
 * One sweep, built from the listings at its start and queued whole, so it runs as fast as the lanes and the bucket
 * allow. The listed strikes change about every minute, so each leg is sent only while its instrument is still
 * listed: an unlisted one is a custom strike, which the server refuses for the zero taker. Every group is waited for,
 * so two sweeps never overlap; then a group that threw fails the run (logged), else the tally is recorded.
 */
async function sweep(sampler: Sampler, run: number): Promise<void> {
  const { deps, cfg, random } = sampler;
  const listings = liveListings(deps);
  const requests = buildSweep(listings, cfg, SAMPLE_QUANTITY_E18, random);
  const tally: SweepTally = { sent: 0, skippedUnlisted: 0 };
  const groups = byInstrument(requests).map((group) => quoteGroup(sampler, 'sweep', run, group, tally));
  const failed = (await Promise.allSettled(groups)).find((g) => g.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
  if (deps.signal.aborted) return;
  record(deps, 'quotes', { purpose: 'sweep-summary', run, legs: requests.length, ...tally });
}

/** The pinned instruments, listed or not (a de-listed one is quoted as a custom strike). */
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

/**
 * Queues `requests` for the first lane to come free (FIFO across the streams); on it they are sent back to back, so a
 * group never splits across sockets and a socket never carries two RFQs at once. Settles when they are done. With a
 * `tally` (the sweep), a request whose instrument is no longer listed is skipped and counted there.
 */
function quoteGroup(
  sampler: Sampler,
  purpose: Purpose,
  run: number,
  requests: QuoteRequest[],
  tally?: SweepTally,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sampler.queue.push({ purpose, run, requests, tally, resolve, reject });
    drain(sampler);
  });
}

/** Hands queued groups to idle lanes; a lane takes the next group as soon as its current one is done. */
function drain(sampler: Sampler): void {
  for (const lane of sampler.lanes) {
    if (lane.busy) continue;
    const next = sampler.queue.shift();
    if (next === undefined) return;
    lane.busy = true;
    sendEach(sampler, lane.taker, next.purpose, next.run, next.requests, next.tally)
      .then(next.resolve, next.reject)
      .finally(() => {
        lane.busy = false;
        drain(sampler);
      });
  }
}

async function sendEach(
  sampler: Sampler,
  taker: Pick<RyskTaker, 'requestQuote'>,
  purpose: Purpose,
  run: number,
  requests: QuoteRequest[],
  tally: SweepTally | undefined,
): Promise<void> {
  for (const request of requests) {
    const sent = await sendOne(sampler, taker, purpose, run, request, tally !== undefined);
    if (sent === 'aborted') return;
    if (tally !== undefined) {
      if (sent === 'sent') tally.sent += 1;
      else tally.skippedUnlisted += 1;
    }
  }
}

/**
 * Waits until no trade is executing and the bucket grants a token, then sends one RFQ and records it with the market
 * as the latest listings show it. With `onlyListed`, a request whose instrument the latest listings no longer hold
 * is skipped before it takes a token. `aborted` once aborted: an RFQ in flight at shutdown is not recorded, since
 * closing the sockets answers it `socket-closed`, which says nothing about the market.
 */
async function sendOne(
  sampler: Sampler,
  taker: Pick<RyskTaker, 'requestQuote'>,
  purpose: Purpose,
  run: number,
  request: QuoteRequest,
  onlyListed: boolean,
): Promise<Sent> {
  const { deps, cfg } = sampler;
  for (;;) {
    if (deps.signal.aborted) return 'aborted';
    if (deps.isExecuting()) await pause(deps, POLL_MS);
    else if (onlyListed && !deps.listings().some((l) => sameInstrument(l, request))) return 'unlisted';
    else if (deps.bucket.take()) break;
    else await pause(deps, Math.max(1, deps.bucket.waitMs()));
  }
  // No await between the last `isExecuting()`, the token and the call into `requestQuote`: no RFQ is decided while a
  // trade executes (the frame itself may leave a moment later, after the taker's pacing gap or a reconnect).
  const sentAtMs = deps.clock.nowMs();
  const listings = deps.listings();
  const [latest] = listings;
  const assetSpotE8 = deps.spotE8?.() ?? null;
  const indexSpotE8 = latest === undefined ? null : indexSpotE8Of(latest);
  const ctx: SampleContext = {
    purpose,
    run,
    nowSec: Math.floor(sentAtMs / 1000),
    spotE8: assetSpotE8 ?? indexSpotE8,
    spotSource: assetSpotE8 !== null ? 'asset' : indexSpotE8 !== null ? 'index' : 'none',
    inventoryTs: latest?.observedAtSec ?? null,
    listing: listings.find((l) => sameInstrument(l, request)),
  };
  let outcome: SampleOutcome;
  try {
    const result = await taker.requestQuote(request, {
      timeoutMs: cfg.requestTimeoutMs,
      signal: deps.signal,
    });
    outcome = result.ok
      ? { ...result, makerSigOk: await makerSignatureOk(result.quote, deps.recoverMaker) }
      : result;
  } catch (error) {
    if (deps.signal.aborted) return 'aborted';
    outcome = { ok: false, error: 'rpc-error', message: messageOf(error), requestedAtMs: sentAtMs };
  }
  if (deps.signal.aborted) return 'aborted';
  record(deps, 'quotes', sampleQuoteRecord(request, outcome, ctx));
  return 'sent';
}

/**
 * Reads the caps (the HYPE ones) and compares them and the latest listings with the last record. A full record (the
 * listings and caps as parsed) is written on the first check and once `intervalMs` has passed since the last full
 * one; in between, a change of content writes a `changed` record with only the difference from the last record. The
 * content is what is listed (each listing's side, strike, expiry and products) and each cap's limit: delta, APR,
 * index and cap usage move all the time and are recorded in full records but never compared. A failed caps read
 * throws, so the check is skipped (and logged) and the next one tries again.
 */
async function inventoryCheck(sampler: Sampler, intervalMs: number): Promise<void> {
  const { deps } = sampler;
  // The check's time is its start: checks run on a fixed grid, so a slow caps read must not push a full record
  // past its interval onto the next check.
  const nowMs = deps.clock.nowMs();
  const listings = deps.listings();
  const parsed = parseCaps(await deps.rest.caps());
  const caps = parsed.caps.filter((cap) => sampler.hypeCapNames.has(cap.name.toLowerCase()));
  const content = inventoryContent(listings, caps);
  const last = sampler.inventory;
  const inventoryTs = listings[0]?.observedAtSec ?? null;
  const contentHash = content.hash;
  if (last === null || nowMs - last.fullAtMs >= intervalMs) {
    const trigger = last === null ? 'first' : 'interval';
    record(deps, 'inventory', {
      trigger,
      contentHash,
      inventoryTs,
      listings,
      caps,
      droppedCaps: parsed.dropped,
    });
    sampler.inventory = { content, fullAtMs: nowMs };
  } else if (last.content.hash !== contentHash) {
    record(deps, 'inventory', {
      trigger: 'changed',
      contentHash,
      inventoryTs,
      ...inventoryDiff(last.content, content),
    });
    sampler.inventory = { content, fullAtMs: last.fullAtMs };
  }
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
 * What is listed and the cap limits, independent of order and casing, and a hash of it: each listing's products by
 * its instrument key (`side|strikeE8|expirySec`), and each cap's limit by its name and type. Delta, APR, index,
 * observation time and cap usage are left out.
 */
function inventoryContent(listings: Listing[], caps: Cap[]): InventoryContent {
  const listed = new Map<string, string>();
  for (const l of listings) {
    const products = l.products
      .map((p) => [p.underlying, p.strikeAsset, p.collateralAsset, p.isPut].join('/').toLowerCase())
      .sort();
    listed.set(backoffKeyOf(l.isPut ? 'put' : 'call', l.strikeE8, l.expirySec), JSON.stringify(products));
  }
  const limits = new Map<string, Pick<Cap, 'name' | 'type' | 'capE18'>>();
  for (const { name, type, capE18 } of caps)
    limits.set(`${name.toLowerCase()}|${type}`, { name, type, capE18 });
  const lines = [
    ...[...listed].map(([key, products]) => `${key} ${products}`).sort(),
    '--',
    ...[...limits].map(([id, cap]) => `${id} ${cap.capE18}`).sort(),
  ];
  return { hash: createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16), listed, limits };
}

/**
 * What changed from `before` to `after`: the instrument keys added and removed, the keys still listed whose products
 * changed, and each cap whose limit changed (`capE18` `null` when it went away, `previousCapE18` `null` when new).
 */
function inventoryDiff(before: InventoryContent, after: InventoryContent) {
  const sorted = (keys: Iterable<string>): string[] => [...keys].sort();
  const added = sorted([...after.listed.keys()].filter((key) => !before.listed.has(key)));
  const removed = sorted([...before.listed.keys()].filter((key) => !after.listed.has(key)));
  const productsChanged = sorted(
    [...after.listed]
      .filter(([key, p]) => before.listed.has(key) && before.listed.get(key) !== p)
      .map(([key]) => key),
  );
  const capsChanged = sorted(new Set([...before.limits.keys(), ...after.limits.keys()])).flatMap((id) => {
    const previous = before.limits.get(id);
    const current = after.limits.get(id);
    const cap = current ?? previous;
    if (cap === undefined || previous?.capE18 === current?.capE18) return [];
    const { name, type } = cap;
    return [{ name, type, capE18: current?.capE18 ?? null, previousCapE18: previous?.capE18 ?? null }];
  });
  return { added, removed, productsChanged, capsChanged };
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
