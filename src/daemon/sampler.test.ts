import { readFileSync } from 'node:fs';
import { type Address, isAddressEqual, zeroAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureCaps, fixtureListings, NOW_SEC } from '../../test/helpers/wheelSnapshot.ts';
import { TOKENS } from '../domain/constants.ts';
import type { Cap, Listing, Quote, QuoteRequest } from '../domain/types.ts';
import { sleep } from '../lib/time.ts';
import type { QuoteResult } from '../rysk/taker.ts';
import { TokenBucket } from './bucket.ts';
import type { SamplerConfig } from './config.ts';
import type { RecordStream } from './recorder.ts';
import { buildSweep, pickPinned, runSampler, type SamplerDeps } from './sampler.ts';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8'));
}

const E18 = 10n ** 18n;
const QTY_E18 = 25n * E18;
const MINUTE_MS = 60_000;
const SELF: Address = '0x2222222222222222222222222222222222222222';
const MAKER: Address = '0x3333333333333333333333333333333333333333';
/** The fixture's nearest expiry, 6.9 days after `NOW_SEC`, and the one a week later. */
const NEAREST_EXPIRY = 1792742400;
const NEXT_EXPIRY = 1793347200;
/** 2 USD a contract: 50 USD of premium on 25 contracts. */
const PRICE_E18 = 2n * E18;
const CAPS_JSON = fixture('caps.json');
const HISTORY_ROWS = fixture('history.json') as { txHash: string }[];
/** The pinned instruments the fixture's nearest expiry gives: ~0.10 delta on each side, then ~0.25. */
const PINNED_KEYS = [
  `put|7550000000|${NEAREST_EXPIRY}`,
  `call|8700000000|${NEAREST_EXPIRY}`,
  `put|7850000000|${NEAREST_EXPIRY}`,
  `call|8450000000|${NEAREST_EXPIRY}`,
];

const { USDC, USDT0, WHYPE, KHYPE, LHYPE, WSTHYPE } = TOKENS;
const SYMBOLS = new Map<Address, string>(Object.values(TOKENS).map((t) => [t.address, t.symbol]));
const OFF: SamplerConfig = {
  enabled: true,
  sweepEveryMin: 0,
  pinned: 4,
  pinnedEveryMin: 0,
  takerPairEveryMin: 0,
  inventoryEveryMin: 0,
  publicFillsEveryMin: 0,
  requestTimeoutMs: 6000,
  putStables: [USDC.address, USDT0.address],
  callCollaterals: [WHYPE.address, KHYPE.address, LHYPE.address, WSTHYPE.address],
};
const DEFAULTS: SamplerConfig = {
  ...OFF,
  sweepEveryMin: 60,
  pinnedEveryMin: 5,
  takerPairEveryMin: 60,
  inventoryEveryMin: 5,
  publicFillsEveryMin: 60,
};

type Rec = Record<string, unknown> & {
  purpose?: string;
  run?: number;
  instrument?: Record<string, unknown> & { key: string };
  context?: Record<string, unknown>;
};

function quoteFor(req: QuoteRequest, nowMs: number): Quote {
  return {
    assetAddress: req.asset,
    chainId: req.chainId,
    expiry: req.expiry,
    isPut: req.isPut,
    isTakerBuy: false,
    quantity: req.quantity,
    strike: req.strike,
    maker: MAKER,
    nonce: '1',
    price: PRICE_E18.toString(),
    validUntil: Math.floor(nowMs / 1000) + 60,
    signature: `0x${'ab'.repeat(65)}`,
    usd: req.usd,
    collateralAsset: req.collateralAsset,
    apy: 50,
  };
}

function harness(patch: Partial<SamplerDeps> = {}) {
  const controller = new AbortController();
  const records: { stream: RecordStream; record: Rec }[] = [];
  const clock = { nowMs: () => Date.now() };
  let listings = fixtureListings();
  let capsJson: unknown = CAPS_JSON;
  const requestQuote = vi.fn(
    async (req: QuoteRequest, _opts: { timeoutMs: number; signal?: AbortSignal }): Promise<QuoteResult> => {
      const atMs = clock.nowMs();
      return { ok: true, quote: quoteFor(req, atMs), requestedAtMs: atMs, respondedAtMs: atMs };
    },
  );
  const deps: SamplerDeps = {
    taker: { requestQuote },
    rest: {
      caps: vi.fn(async () => capsJson),
      publicHistory: vi.fn(async (_fromSec: number, _toSec: number): Promise<unknown> => []),
    },
    recorder: {
      append: vi.fn(
        (stream: RecordStream, record: object) => void records.push({ stream, record: record as Rec }),
      ),
    },
    bucket: new TokenBucket(6, clock),
    clock,
    sleep,
    signal: controller.signal,
    listings: () => listings,
    isExecuting: () => false,
    self: SELF,
    random: () => 0.5,
    log: { warn: vi.fn(), error: vi.fn() },
    ...patch,
  };
  const of = (stream: RecordStream): Rec[] =>
    records.filter((entry) => entry.stream === stream).map((entry) => entry.record);
  const setListings = (next: Listing[]): void => {
    listings = next;
  };
  const setCaps = (next: unknown): void => {
    capsJson = next;
  };
  return { deps, controller, requestQuote, of, setListings, setCaps };
}

/** Runs the sampler for `ms` of fake time, then aborts it and waits for it to end. */
async function runFor(h: ReturnType<typeof harness>, cfg: SamplerConfig, ms: number): Promise<void> {
  const done = runSampler(h.deps, cfg);
  await vi.advanceTimersByTimeAsync(ms);
  h.controller.abort();
  await done;
}

type RawCap = { name: string; type: string; cap: string; usage: string };

/** The fixture caps with `patch` applied to the row named `name` of `type`. */
function capsWith(name: string, type: string, patch: Partial<RawCap>): RawCap[] {
  return (CAPS_JSON as RawCap[]).map((row) =>
    row.name === name && row.type === type ? { ...row, ...patch } : row,
  );
}

/** GLOBAL, HYPE and the caps named after a sampled token (`<address>` or `<address>-<isPut>`). */
function isHypeCapName(name: string): boolean {
  const sampled = [WHYPE, KHYPE, LHYPE, WSTHYPE, USDC, USDT0].map((t) => t.address.toLowerCase());
  const [address, isPut] = name.toLowerCase().split('-');
  return (
    name === 'GLOBAL' ||
    name === 'HYPE' ||
    (sampled.includes(address ?? '') && (isPut === undefined || isPut === 'true' || isPut === 'false'))
  );
}

function keyOf(r: QuoteRequest): string {
  return `${r.isPut ? 'put' : 'call'}|${r.strike}|${r.expiry}`;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW_SEC * 1000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildSweep', () => {
  const listings = fixtureListings();
  const sweep = buildSweep(listings, DEFAULTS, QTY_E18, () => 0.5);

  it('quotes every listing from the zero address: puts in each stable, calls in each collateral', () => {
    expect(listings.filter((l) => l.isPut)).toHaveLength(24);
    expect(listings.filter((l) => !l.isPut)).toHaveLength(24);
    expect(sweep).toHaveLength(144);
    expect(sweep.every((r) => isAddressEqual(r.taker, zeroAddress))).toBe(true);
    for (const r of sweep) {
      expect(r).toMatchObject({
        asset: WHYPE.address,
        chainId: 999,
        quantity: '25000000000000000000',
        isEIP1271: false,
      });
    }
    const puts = sweep.filter((r) => r.isPut);
    expect(puts).toHaveLength(48);
    expect(puts.every((r) => r.usd === r.collateralAsset && r.assetName === 'WHYPE')).toBe(true);
    const calls = sweep.filter((r) => !r.isPut);
    expect(calls).toHaveLength(96);
    expect(calls.every((r) => r.usd === USDC.address)).toBe(true);
    expect(calls.map((r) => [r.collateralAsset, r.assetName])).toEqual(
      expect.arrayContaining([
        [WHYPE.address, 'WHYPE'],
        [KHYPE.address, 'kHYPE'],
        [LHYPE.address, 'LHYPE'],
        [WSTHYPE.address, 'wstHYPE'],
      ]),
    );
  });

  it("sends each listing's legs back to back in the configured order, each listing once", () => {
    for (const listing of listings.filter((l) => l.isPut)) {
      const usdc = sweep.findIndex(
        (r) =>
          r.isPut &&
          r.strike === listing.strikeE8.toString() &&
          r.expiry === listing.expirySec &&
          r.collateralAsset === USDC.address,
      );
      expect(usdc).toBeGreaterThanOrEqual(0);
      expect(sweep[usdc + 1]).toMatchObject({
        isPut: true,
        strike: listing.strikeE8.toString(),
        expiry: listing.expirySec,
        usd: USDT0.address,
        collateralAsset: USDT0.address,
      });
    }
    const groups: { key: string; legs: Address[] }[] = [];
    for (const r of sweep) {
      const last = groups.at(-1);
      if (last?.key === keyOf(r)) last.legs.push(r.collateralAsset);
      else groups.push({ key: keyOf(r), legs: [r.collateralAsset] });
    }
    expect(groups).toHaveLength(48);
    expect(new Set(groups.map((g) => g.key)).size).toBe(48);
    for (const { key, legs } of groups) {
      expect(legs).toEqual(key.startsWith('put') ? DEFAULTS.putStables : DEFAULTS.callCollaterals);
    }
  });

  it('shuffles the listings with the injected random', () => {
    const order = (random: () => number) => buildSweep(listings, DEFAULTS, QTY_E18, random).map(keyOf);
    expect(order(() => 0.5)).toEqual(sweep.map(keyOf));
    // Fisher–Yates with 0 always swaps with the front; 0.999 leaves every listing in place.
    expect(order(() => 0.999)).toEqual(
      listings.flatMap((l) =>
        Array.from(
          { length: l.isPut ? 2 : 4 },
          () => `${l.isPut ? 'put' : 'call'}|${l.strikeE8}|${l.expirySec}`,
        ),
      ),
    );
    expect(order(() => 0)).not.toEqual(order(() => 0.999));
  });
});

describe('pickPinned', () => {
  it('picks the ~0.10 and ~0.25 delta listings of the nearest expiry on each side', () => {
    const pinned = pickPinned(fixtureListings(), 4);
    expect(pinned).toHaveLength(4);
    expect(pinned.every((l) => l.expirySec === NEAREST_EXPIRY)).toBe(true);
    expect(pinned.map((l) => `${l.isPut ? 'put' : 'call'}|${l.strikeE8}|${l.expirySec}`)).toEqual(
      PINNED_KEYS,
    );
  });

  it('returns at most n, the ~0.10 deltas first', () => {
    expect(pickPinned(fixtureListings(), 2).map((l) => l.strikeE8)).toEqual([7550000000n, 8700000000n]);
    expect(pickPinned(fixtureListings(), 0)).toEqual([]);
    expect(pickPinned([], 4)).toEqual([]);
  });

  it('takes the next nearest when one listing is nearest both targets', () => {
    const [base] = fixtureListings().filter((l) => l.isPut && l.expirySec === NEAREST_EXPIRY);
    if (base === undefined) throw new Error('no fixture put');
    const near = { ...base, strikeE8: 7000000000n, delta: -0.16 };
    const far = { ...base, strikeE8: 7900000000n, delta: -0.45 };
    const later = { ...base, expirySec: NEXT_EXPIRY, delta: -0.25 };
    expect(pickPinned([far, near, later], 4)).toEqual([near, far]);
  });
});

describe('runSampler', () => {
  it('records one scheduled sweep of 144 RFQs at the bucket rate and stops on abort', async () => {
    const h = harness();
    await runFor(h, { ...OFF, sweepEveryMin: 60 }, 30 * MINUTE_MS);

    const quotes = h.of('quotes');
    expect(quotes).toHaveLength(144);
    expect(quotes.every((q) => q.purpose === 'sweep' && q.run === 1 && q.takerKind === 'zero')).toBe(true);
    expect(quotes.every((q) => q.outcome === 'quote')).toBe(true);
    const legs = new Set(
      quotes.map((q) => `${q.side} ${q.instrument?.usdSymbol}/${q.instrument?.collateralSymbol}`),
    );
    expect(legs).toEqual(
      new Set([
        'put USDC/USDC',
        'put USDT0/USDT0',
        'call USDC/WHYPE',
        'call USDC/kHYPE',
        'call USDC/LHYPE',
        'call USDC/wstHYPE',
      ]),
    );
    expect(h.requestQuote).toHaveBeenCalledTimes(144);
    expect(h.requestQuote.mock.calls[0]?.[1]).toEqual({ timeoutMs: 6000, signal: h.deps.signal });
    // 6 RFQs at once from the full bucket, then one every 10 s.
    const sentAtMs = quotes.map((q) => q.requestedAtMs as number);
    expect((sentAtMs[5] ?? 0) - NOW_SEC * 1000).toBe(0);
    expect((sentAtMs[143] ?? 0) - NOW_SEC * 1000).toBe(138 * 10_000);

    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE_MS);
    expect(h.requestQuote).toHaveBeenCalledTimes(144);
  });

  it('records the instrument, the market context, the quote and its gross premium and APR', async () => {
    const h = harness({ recoverMaker: vi.fn(async () => MAKER) });
    await runFor(h, { ...OFF, sweepEveryMin: 60 }, 1_000);

    const [first] = h.of('quotes');
    const [request] = h.requestQuote.mock.calls[0] ?? [];
    if (first === undefined || request === undefined) throw new Error('no RFQ');
    const listing = fixtureListings().find(
      (l) => keyOf(request) === `${l.isPut ? 'put' : 'call'}|${l.strikeE8}|${l.expirySec}`,
    );
    expect(first).toMatchObject({
      purpose: 'sweep',
      side: request.isPut ? 'put' : 'call',
      instrument: {
        key: keyOf(request),
        isPut: request.isPut,
        strikeE8: BigInt(request.strike),
        expirySec: request.expiry,
        quantityE18: QTY_E18,
        usd: request.usd,
        collateralAsset: request.collateralAsset,
        listed: true,
      },
      takerKind: 'zero',
      context: {
        spotE8: 8147056124n,
        spotSource: 'index',
        inventoryTs: NOW_SEC,
        indicativeApr: listing?.indicativeApr,
        delta: listing?.delta,
        tenorSec: request.expiry - NOW_SEC,
      },
      requestedAtMs: NOW_SEC * 1000,
      outcome: 'quote',
      respondedAtMs: NOW_SEC * 1000,
      quote: {
        maker: MAKER,
        priceE18: PRICE_E18.toString(),
        validUntil: NOW_SEC + 60,
        ttlSec: 60,
        nonce: '1',
        apy: 50,
      },
      makerSigOk: true,
      premium6: 50_000000n,
    });
    expect(first.aprGross).toBeGreaterThan(0);
    expect(first.aprGrossOverIndicative).toBeCloseTo(
      (first.aprGross as number) / (listing?.indicativeApr ?? 1),
    );
    expect(first).not.toHaveProperty('gas');
    expect(first).not.toHaveProperty('aprNet');
    expect(first.instrument).toMatchObject({
      usdSymbol: SYMBOLS.get(request.usd),
      collateralSymbol: SYMBOLS.get(request.collateralAsset),
    });
  });

  it("takes spot from the daemon's asset price when given one, else from the listings' index", async () => {
    const asset = harness({ spotE8: () => 8000000000n });
    await runFor(asset, { ...OFF, pinnedEveryMin: 5 }, 1_000);
    const [fromAsset] = asset.of('quotes');
    expect(fromAsset?.context).toMatchObject({ spotE8: 8000000000n, spotSource: 'asset' });
    // A call's APR is priced on that spot: 50 USD on 25 × 80 USD of WHYPE for 6.9 days.
    const call = asset.of('quotes').find((q) => q.side === 'call');
    expect(call?.aprGross).toBeCloseTo((50 / 2000) * (31_557_600 / (NEAREST_EXPIRY - NOW_SEC)), 6);

    const none = harness({ spotE8: () => null });
    await runFor(none, { ...OFF, pinnedEveryMin: 5 }, 1_000);
    expect(none.of('quotes')[0]?.context).toMatchObject({ spotE8: 8147056124n, spotSource: 'index' });
  });

  it('pauses a sweep mid-way while a trade executes and resumes it where it stopped', async () => {
    let executing = false;
    const h = harness({ isExecuting: () => executing });
    const sent = (): QuoteRequest[] => h.requestQuote.mock.calls.map(([r]) => r);
    h.requestQuote.mockImplementation(async (req) => {
      const atMs = Date.now();
      if (sent().length === 3) executing = true; // a trade starts after the third RFQ
      return { ok: true, quote: quoteFor(req, atMs), requestedAtMs: atMs, respondedAtMs: atMs };
    });
    const done = runSampler(h.deps, { ...OFF, sweepEveryMin: 60 });
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    expect(sent()).toHaveLength(3);

    executing = false;
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    h.controller.abort();
    await done;
    // The whole sweep in its one order, each RFQ once: nothing skipped or repeated across the pause.
    const sweep = buildSweep(fixtureListings(), OFF, QTY_E18, () => 0.5);
    expect(sent()).toEqual(sweep);
    expect(h.of('quotes').filter((q) => q.purpose === 'sweep')).toHaveLength(144);
  });

  it('waits for the first listings before sweeping', async () => {
    const h = harness();
    h.setListings([]);
    const done = runSampler(h.deps, { ...OFF, sweepEveryMin: 60 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.requestQuote).not.toHaveBeenCalled();
    h.setListings(fixtureListings());
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    h.controller.abort();
    await done;
    expect(h.of('quotes')).toHaveLength(144);
  });

  it('stops mid-sweep on abort', async () => {
    const h = harness();
    const done = runSampler(h.deps, { ...OFF, sweepEveryMin: 60 });
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
    h.controller.abort();
    await done;
    const sent = h.requestQuote.mock.calls.length;
    expect(sent).toBe(6 + 12);
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(h.requestQuote).toHaveBeenCalledTimes(sent);
  });

  it('sends no RFQ while a trade executes, and resumes once it is done', async () => {
    let executing = true;
    const h = harness({ isExecuting: () => executing });
    const done = runSampler(h.deps, DEFAULTS);
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
    expect(h.requestQuote).not.toHaveBeenCalled();
    expect(h.of('quotes')).toEqual([]);

    executing = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.requestQuote).toHaveBeenCalled();
    h.controller.abort();
    await done;
  });

  it('ends promptly on abort while paused for an execution', async () => {
    const h = harness({ isExecuting: () => true });
    const done = runSampler(h.deps, DEFAULTS);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    h.controller.abort();
    await done;
    expect(h.requestQuote).not.toHaveBeenCalled();
  });

  it('sends one RFQ at a time across the streams and never splits a group', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const h = harness();
    h.requestQuote.mockImplementation(async (req) => {
      const atMs = Date.now();
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(2_000); // the auction
      inFlight -= 1;
      return { ok: true, quote: quoteFor(req, atMs), requestedAtMs: atMs, respondedAtMs: Date.now() };
    });
    await runFor(h, DEFAULTS, 40 * MINUTE_MS);

    expect(maxInFlight).toBe(1);
    const quotes = h.of('quotes');
    const purposes = new Set(quotes.map((q) => q.purpose));
    expect(purposes).toEqual(new Set(['sweep', 'pinned', 'taker-pair']));
    expect(quotes.filter((q) => q.purpose === 'sweep')).toHaveLength(144);
    // Each group's RFQs are consecutive: a new group never starts while one of its instrument is open.
    const runs: string[] = [];
    for (const q of quotes) {
      const group = `${q.purpose} ${q.run} ${q.instrument?.key}`;
      if (runs.at(-1) !== group) runs.push(group);
    }
    expect(new Set(runs).size).toBe(runs.length);
  });

  it('quotes the pinned instruments each interval and the taker pair back to back', async () => {
    const h = harness();
    await runFor(h, { ...OFF, pinnedEveryMin: 5, takerPairEveryMin: 60 }, 6 * MINUTE_MS);

    const quotes = h.of('quotes');
    const pinned = quotes.filter((q) => q.purpose === 'pinned');
    expect(pinned.map((q) => q.run)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(pinned.map((q) => q.instrument?.key)).toEqual([...PINNED_KEYS, ...PINNED_KEYS]);
    // The traded products: USDC/USDC puts and WHYPE calls paid in USDC.
    for (const q of pinned) {
      const collateral = q.side === 'put' ? USDC.address : WHYPE.address;
      expect(q.instrument).toMatchObject({ usd: USDC.address, collateralAsset: collateral, listed: true });
    }
    const pairAt = quotes.findIndex((q) => q.purpose === 'taker-pair');
    const pair = quotes.slice(pairAt, pairAt + 2);
    expect(pair.map((q) => [q.purpose, q.takerKind, q.instrument?.key])).toEqual([
      ['taker-pair', 'self', PINNED_KEYS[0]],
      ['taker-pair', 'zero', PINNED_KEYS[0]],
    ]);
    const takers = h.requestQuote.mock.calls.map(([r]) => r.taker);
    expect(takers.filter((t) => t === SELF)).toHaveLength(1);
  });

  it('keeps quoting a pinned instrument after it is de-listed, as a custom strike', async () => {
    const h = harness();
    const done = runSampler(h.deps, { ...OFF, pinnedEveryMin: 5 });
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    h.setListings(fixtureListings().filter((l) => !(l.isPut && l.strikeE8 === 7550000000n)));
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    h.controller.abort();
    await done;

    const second = h.of('quotes').filter((q) => q.run === 2);
    expect(second.map((q) => q.instrument?.key)).toEqual(PINNED_KEYS);
    expect(second[0]?.instrument?.listed).toBe(false);
    expect(second[0]?.context).toMatchObject({ indicativeApr: null, delta: null, spotE8: 8147056124n });
    expect(second[1]?.instrument?.listed).toBe(true);
  });

  it('re-picks the pinned instruments once they expire', async () => {
    vi.setSystemTime((NEAREST_EXPIRY - 240) * 1000);
    const h = harness();
    await runFor(h, { ...OFF, pinnedEveryMin: 5 }, 6 * MINUTE_MS);

    const quotes = h.of('quotes');
    expect(quotes.filter((q) => q.run === 1).map((q) => q.instrument?.expirySec)).toEqual(
      Array(4).fill(NEAREST_EXPIRY),
    );
    expect(quotes.filter((q) => q.run === 2).map((q) => q.instrument?.expirySec)).toEqual(
      Array(4).fill(NEXT_EXPIRY),
    );
  });

  it('records failed RFQs with their outcome and keeps sampling', async () => {
    const h = harness();
    h.requestQuote
      .mockResolvedValueOnce({
        ok: false,
        error: 'timeout',
        message: 'no reply',
        requestedAtMs: NOW_SEC * 1000,
      })
      .mockRejectedValueOnce(new Error('boom'));
    await runFor(h, { ...OFF, pinnedEveryMin: 5 }, MINUTE_MS);

    const quotes = h.of('quotes');
    expect(quotes.map((q) => q.outcome)).toEqual(['timeout', 'error', 'quote', 'quote']);
    expect(quotes[0]).toMatchObject({ error: 'timeout', message: 'no reply' });
    expect(quotes[1]).toMatchObject({ error: 'rpc-error', message: 'boom', requestedAtMs: NOW_SEC * 1000 });
    expect(quotes[0]).not.toHaveProperty('quote');
  });

  it('checks the maker signature only with a recoverMaker', async () => {
    const recoverMaker = vi
      .fn<(q: Quote) => Promise<Address>>()
      .mockResolvedValueOnce(MAKER)
      .mockResolvedValueOnce(SELF)
      .mockRejectedValueOnce(new Error('bad signature'))
      .mockResolvedValue(MAKER);
    const checked = harness({ recoverMaker });
    await runFor(checked, { ...OFF, pinnedEveryMin: 5 }, MINUTE_MS);
    expect(checked.of('quotes').map((q) => q.makerSigOk)).toEqual([true, false, false, true]);

    const unchecked = harness();
    await runFor(unchecked, { ...OFF, pinnedEveryMin: 5 }, MINUTE_MS);
    expect(unchecked.of('quotes').map((q) => q.makerSigOk)).toEqual([null, null, null, null]);
  });

  it('records the listings and the HYPE caps first, then on a content change or once per interval', async () => {
    const h = harness();
    const done = runSampler(h.deps, { ...OFF, inventoryEveryMin: 5 });
    await vi.advanceTimersByTimeAsync(1_000);
    const [first] = h.of('inventory');
    expect(first).toMatchObject({ trigger: 'first', inventoryTs: NOW_SEC, droppedCaps: 0 });
    expect(first?.listings).toEqual(fixtureListings());
    const hypeCaps = fixtureCaps().filter((c) => isHypeCapName(c.name));
    expect(hypeCaps).toHaveLength(21);
    expect(first?.caps).toEqual(hypeCaps);
    const triggers = (): unknown[] => h.of('inventory').map((r) => r.trigger);

    // Re-observed in another order with moved quotes and new usage: not a change (check at 1 min).
    h.setListings(
      fixtureListings()
        .reverse()
        .map((l) => ({
          ...l,
          products: [...l.products].reverse(),
          observedAtSec: NOW_SEC + 60,
          delta: l.delta * 1.01,
          indicativeApr: l.indicativeApr + 0.01,
          indexUsd: l.indexUsd + 0.5,
        })),
    );
    h.setCaps(capsWith('HYPE', 'CONTRACTS', { usage: '123000000000000000000' }));
    await vi.advanceTimersByTimeAsync(1.5 * MINUTE_MS);
    expect(triggers()).toEqual(['first']);

    // A cap outside HYPE changes: not ours (2 min).
    h.setCaps(capsWith('BTC', 'CONTRACTS', { cap: '1' }));
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(triggers()).toEqual(['first']);

    // The HYPE cap is raised: recorded at the next check (3 min).
    h.setCaps(capsWith('HYPE', 'CONTRACTS', { cap: '999000000000000000000000' }));
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(triggers()).toEqual(['first', 'changed']);
    const raisedCaps = (h.of('inventory')[1]?.caps ?? []) as Cap[];
    const raised = raisedCaps.find((c) => c.name === 'HYPE' && c.type === 'CONTRACTS');
    expect(raised?.capE18).toBe(999000000000000000000000n);

    // Regenerated without one listing (4 min).
    h.setListings(fixtureListings().slice(1));
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(triggers()).toEqual(['first', 'changed', 'changed']);
    expect(h.of('inventory')[2]?.listings).toHaveLength(47);

    // Unchanged since: recorded again 5 min after the last record (9 min).
    await vi.advanceTimersByTimeAsync(4 * MINUTE_MS);
    expect(triggers()).toEqual(['first', 'changed', 'changed']);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(triggers()).toEqual(['first', 'changed', 'changed', 'interval']);
    h.controller.abort();
    await done;
    // The caps are read at every check (0 to 9 min).
    expect(h.deps.rest.caps).toHaveBeenCalledTimes(10);
    expect(h.requestQuote).not.toHaveBeenCalled();
  });

  it('retries an inventory snapshot whose caps read failed at the next check', async () => {
    const caps = vi.fn(async () => CAPS_JSON).mockRejectedValueOnce(new Error('503'));
    const h = harness();
    h.deps.rest.caps = caps;
    await runFor(h, { ...OFF, inventoryEveryMin: 5 }, 1.5 * MINUTE_MS);
    expect(h.of('inventory').map((r) => r.trigger)).toEqual(['first']);
    expect(h.deps.log?.warn).toHaveBeenCalledTimes(1);
  });

  it('records each public fill once by txHash over overlapping windows from startup', async () => {
    const h = harness();
    const publicHistory = vi
      .fn(async (_fromSec: number, _toSec: number): Promise<unknown> => [])
      .mockResolvedValueOnce([...HISTORY_ROWS.slice(0, 20), HISTORY_ROWS[3]])
      .mockResolvedValueOnce(HISTORY_ROWS.slice(10));
    h.deps.rest.publicHistory = publicHistory;
    await runFor(h, { ...OFF, publicFillsEveryMin: 60 }, 61 * MINUTE_MS);

    // Each window starts 5 min before the previous one ended, the first 5 min before startup.
    expect(publicHistory.mock.calls).toEqual([
      [NOW_SEC - 300, NOW_SEC],
      [NOW_SEC - 300, NOW_SEC + 3600],
    ]);
    const fills = h.of('public-fills');
    expect(fills.map((r) => (r.fill as { txHash: string }).txHash)).toEqual(
      HISTORY_ROWS.map((r) => r.txHash),
    );
    expect(fills[0]).toEqual({ fromSec: NOW_SEC - 300, toSec: NOW_SEC, fill: HISTORY_ROWS[0] });
    expect(h.requestQuote).not.toHaveBeenCalled();
  });

  it('starts no stream that is off, and nothing when disabled', async () => {
    const off = harness();
    await runSampler(off.deps, OFF);
    const disabled = harness();
    await runSampler(disabled.deps, { ...DEFAULTS, enabled: false });
    for (const h of [off, disabled]) {
      expect(h.requestQuote).not.toHaveBeenCalled();
      expect(h.deps.rest.caps).not.toHaveBeenCalled();
      expect(h.deps.rest.publicHistory).not.toHaveBeenCalled();
      expect(h.deps.recorder.append).not.toHaveBeenCalled();
    }
  });
});
