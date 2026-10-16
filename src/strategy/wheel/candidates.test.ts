import { describe, expect, it } from 'vitest';
import {
  type ConfigPatch,
  fixtureAssets,
  fixtureCaps,
  fixtureListings,
  fixturePositions,
  NOW_SEC,
  snapshotFromFixtures,
  wheelConfig,
} from '../../../test/helpers/wheelSnapshot.ts';
import { TOKENS } from '../../domain/constants.ts';
import type { Listing, Position, Quote, Side } from '../../domain/types.ts';
import {
  ALL_LISTED_MAX_TENOR_DAYS,
  basisEligible,
  CUSTOM_STRIKE_PRECISION_E8,
  customFallbackStrikeE8,
  fallbackStrike,
  planSide,
} from './candidates.ts';
import type { CallFallbackConfig, SideConfig } from './config.ts';
import { evaluate } from './evaluate.ts';
import { deriveState } from './state.ts';
import type { Candidate, QuoteOutcome, SidePlan, Snapshot, WheelState } from './types.ts';

const E18 = 10n ** 18n;
const HOUR_SEC = 3600;
const DAY_SEC = 86_400;
const SPOT_E8 = 8148032044n;
/** The fixture's expiries 6.9 and 13.9 days out; the other two (20.9 and 41.9 days) are past the 16-day window. */
const E1 = 1792742400;
const E2 = 1793347200;
const E4 = 1795766400;
const LOT_E18 = 25n * E18;

const LIMITS: Partial<SideConfig> = {
  minHoursToExpiry: 36,
  maxDaysToExpiry: 16,
  minAbsDelta: 0.05,
  maxAbsDelta: 0.45,
  minOtmPct: 0.01,
  minApr: 0.1,
};

type Case = {
  basisE8?: bigint;
  state?: Partial<WheelState>;
  config?: ConfigPatch;
  /** Extra listings beside the fixture's. */
  listings?: Listing[];
  mode?: Snapshot['mode'];
};

/** The fixture rows with the open put deployed two days back, so the put's 24 h interval has passed. */
function happyPositions(): Position[] {
  return fixturePositions().map((p) =>
    p.isPut && p.status === 'open' ? { ...p, createdAtSec: NOW_SEC - 2 * DAY_SEC } : p,
  );
}

/** The fixture tick at spot 81.48 with every gate passing; one lot fits on each side. */
function tick(test: Case = {}) {
  const s = snapshotFromFixtures({
    mode: test.mode ?? 'live',
    positions: happyPositions(),
    market: {
      assets: fixtureAssets(),
      listings: [...fixtureListings(), ...(test.listings ?? [])],
      caps: fixtureCaps(),
      spotE8: SPOT_E8,
    },
    memo: { lastNoPendingSeenSec: NOW_SEC - HOUR_SEC },
  });
  const { put, call, ...rest } = test.config ?? {};
  const c = wheelConfig({
    ...rest,
    put: { ...LIMITS, ...put },
    call: { ...LIMITS, ...call },
  });
  const derived = deriveState(s, c);
  const basis = test.basisE8 === undefined ? derived.basis : { ...derived.basis, basisE8: test.basisE8 };
  const st: WheelState = { ...derived, basis, ...test.state };
  return { st, s, c };
}

function plan(side: Side, test: Case = {}): SidePlan {
  const { st, s, c } = tick(test);
  return planSide(side, st, s, c);
}

function quoted(side: Side, test: Case = {}): Extract<SidePlan, { kind: 'quote' }> {
  const result = plan(side, test);
  if (result.kind !== 'quote') throw new Error(`expected a quote plan, got hold '${result.reason}'`);
  return result;
}

function fallback(patch: Partial<CallFallbackConfig>): CallFallbackConfig {
  return { ...wheelConfig().call.fallback, ...patch };
}

const terms = (candidates: Candidate[]) =>
  candidates.map(({ strikeE8, expirySec, mode }) => ({ strikeE8, expirySec, mode }));

/** A copy of the fixture's listing of `side` at `strikeE8` and `expirySec`, moved to `patch`'s strike or expiry. */
function moved(side: Side, strikeE8: bigint, expirySec: number, patch: Partial<Listing>): Listing {
  const listing = fixtureListings().find(
    (l) => l.isPut === (side === 'put') && l.strikeE8 === strikeE8 && l.expirySec === expirySec,
  );
  if (listing === undefined) throw new Error(`no fixture ${side} ${strikeE8} at ${expirySec}`);
  return { ...listing, ...patch };
}

const movedCall = (strikeE8: bigint, expirySec: number, patch: Partial<Listing>) =>
  moved('call', strikeE8, expirySec, patch);

function held(result: SidePlan): Extract<SidePlan, { kind: 'hold' }> {
  if (result.kind !== 'hold') throw new Error(`expected a hold, got ${result.candidates.length} candidates`);
  return result;
}

/** An answered quote for `k` at `priceE18` with no gas fee. */
function answered(k: Candidate, priceE18: bigint): QuoteOutcome {
  const quote: Quote = {
    assetAddress: k.request.asset,
    chainId: k.request.chainId,
    expiry: k.expirySec,
    isPut: k.request.isPut,
    isTakerBuy: false,
    quantity: k.request.quantity,
    strike: k.request.strike,
    maker: '0x0000000000000000000000000000000000000Bad',
    nonce: '1',
    price: priceE18.toString(),
    validUntil: NOW_SEC + 60,
    signature: '0x00',
    usd: k.request.usd,
    collateralAsset: k.request.collateralAsset,
    apy: 5,
  };
  return {
    ok: true,
    quote,
    requestedAtMs: 0,
    respondedAtMs: 1,
    makerSigOk: true,
    gas: { ok: true, gasFee6: 0n },
  };
}

/** A 36 h to 7 d window: only the 6.9-day expiry E1, whose highest call strike (K*) is 88.5. */
const E1_ONLY: Partial<SideConfig> = { maxDaysToExpiry: 7 };

describe('planSide: puts', () => {
  it('quotes three diversified OTM puts inside the tenor window, best first', () => {
    const { st, s, c } = tick();
    const result = planSide('put', st, s, c);
    if (result.kind !== 'quote') throw new Error(`expected a quote plan, got hold '${result.reason}'`);
    const { candidates } = result;

    expect(candidates.length).toBeLessThanOrEqual(3);
    // Best overall, the best at another expiry, the best with |delta| ≤ 0.25.
    expect(terms(candidates)).toEqual([
      { strikeE8: 8050000000n, expirySec: E1, mode: 'normal' },
      { strikeE8: 8000000000n, expirySec: E2, mode: 'normal' },
      { strikeE8: 7850000000n, expirySec: E1, mode: 'normal' },
    ]);
    for (const candidate of candidates) {
      expect(candidate.side).toBe('put');
      expect(candidate.request.isPut).toBe(true);
      expect(candidate.listing?.isPut).toBe(true);
      expect([E1, E2]).toContain(candidate.expirySec);
      expect(candidate.request.taker).toBe(c.self);
      expect(candidate.request.usd).toBe(TOKENS.USDC.address);
    }
    const aprs = candidates.map((candidate) => candidate.indicativeApr ?? Number.NaN);
    expect(aprs[0]).toBe(Math.max(...aprs));
    expect(new Set(candidates.map((candidate) => candidate.expirySec)).size).toBeGreaterThanOrEqual(2);
    expect(result.prefilterBypassed).toBe(false);
    expect(result.gates.every((gate) => gate.pass)).toBe(true);
  });

  it('sizes each candidate with the tranche at its strike and builds the wire request', () => {
    const [best] = quoted('put').candidates;
    expect(best).toMatchObject({
      quantityE18: LOT_E18,
      // 25 × 80.5 USDC.
      collateralAmount: 2012_500000n,
      product: {
        underlying: TOKENS.WHYPE.address,
        strikeAsset: TOKENS.USDC.address,
        collateralAsset: TOKENS.USDC.address,
        isPut: true,
      },
      rank: 1,
    });
    // The spike capture's request format: e8 strike and e18 quantity as decimal strings, assetName WHYPE.
    expect(best?.request).toEqual({
      asset: TOKENS.WHYPE.address,
      assetName: 'WHYPE',
      chainId: 999,
      expiry: E1,
      isPut: true,
      quantity: '25000000000000000000',
      strike: '8050000000',
      taker: wheelConfig().self,
      usd: TOKENS.USDC.address,
      collateralAsset: TOKENS.USDC.address,
      isEIP1271: false,
    });
  });

  it('records the listings it filters out with the first filter they fail', () => {
    const { excluded } = quoted('put');
    expect(excluded).toHaveLength(12);
    expect(excluded.every((e) => e.reason === 'tenor' && e.expirySec > E2)).toBe(true);
  });

  it('trims listings below minApr × prefilterRatio and records them', () => {
    // minApr 0.4 → prefilter 0.2: four in-window puts fall below it.
    const result = quoted('put', { config: { put: { minApr: 0.4 } } });
    expect(result.prefilterBypassed).toBe(false);
    expect(result.excluded.filter((e) => e.reason === 'apr-prefilter').map((e) => e.strikeE8)).toEqual(
      expect.arrayContaining([7450000000n, 7550000000n, 7050000000n, 7250000000n]),
    );
    expect(result.candidates.map((candidate) => candidate.strikeE8)).toEqual([
      8050000000n,
      8000000000n,
      7850000000n,
    ]);
  });

  it('holds with the gate results when a gate fails', () => {
    const result = plan('put', { state: { anomalies: ['boom'] } });
    expect(result).toMatchObject({ kind: 'hold', side: 'put', reason: 'anomaly', excluded: [] });
    expect(result.gates.find((gate) => gate.id === 'G1')?.pass).toBe(false);
    expect(result.kind === 'hold' && result.detail).toContain('G1');
  });

  it('holds no-candidates when no put passes the filters', () => {
    expect(plan('put', { config: { put: { minOtmPct: 0.5 } } })).toMatchObject({
      kind: 'hold',
      reason: 'no-candidates',
    });
  });
});

describe('planSide: calls', () => {
  it('quotes three diversified calls above a low basis', () => {
    const { st, s, c } = tick({ basisE8: 5000000000n });
    const result = planSide('call', st, s, c);
    if (result.kind !== 'quote') throw new Error(`expected a quote plan, got hold '${result.reason}'`);
    const { candidates } = result;

    expect(candidates.length).toBeLessThanOrEqual(3);
    expect(terms(candidates)).toEqual([
      { strikeE8: 8250000000n, expirySec: E1, mode: 'normal' },
      { strikeE8: 8350000000n, expirySec: E2, mode: 'normal' },
      { strikeE8: 8450000000n, expirySec: E1, mode: 'normal' },
    ]);
    for (const candidate of candidates) {
      expect(candidate.request.isPut).toBe(false);
      expect(candidate.listing?.isPut).toBe(false);
      expect([E1, E2]).toContain(candidate.expirySec);
      expect(candidate.request.taker).toBe(c.self);
      expect(candidate.request.usd).toBe(TOKENS.USDC.address);
      expect(candidate.request.collateralAsset).toBe(TOKENS.WHYPE.address);
      expect(candidate.request.assetName).toBe('WHYPE');
      // A call locks one WHYPE per contract.
      expect(candidate.collateralAmount).toBe(LOT_E18);
    }
    const aprs = candidates.map((candidate) => candidate.indicativeApr ?? Number.NaN);
    expect(aprs[0]).toBe(Math.max(...aprs));
    expect(new Set(candidates.map((candidate) => candidate.expirySec)).size).toBeGreaterThanOrEqual(2);
  });

  it('falls back to the highest listed strike at the shortest expiry when no strike clears the basis', () => {
    const { candidates } = quoted('call', { basisE8: 12000000000n });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      mode: 'basis-fallback',
      strikeE8: 8850000000n,
      expirySec: E1,
      quantityE18: LOT_E18,
      indicativeApr: expect.any(Number),
    });
    expect(candidates[0]?.request.strike).toBe('8850000000');
  });

  it('holds when the fallback strike is too far below the basis', () => {
    // 88.5 < 120 × 0.9.
    const config = { call: { fallback: fallback({ maxDiscountToBasisPct: 0.1 }) } };
    expect(plan('call', { basisE8: 12000000000n, config })).toMatchObject({
      kind: 'hold',
      reason: 'fallback-too-far-below-basis',
    });
  });

  it('puts the custom strike first when customStrikeFirst is on', () => {
    const config = { call: { fallback: fallback({ customStrikeFirst: true }) } };
    const { candidates } = quoted('call', { basisE8: 12000000000n, config });
    const customE8 = customFallbackStrikeE8(12000000000n, SPOT_E8, CUSTOM_STRIKE_PRECISION_E8);
    expect(terms(candidates)).toEqual([
      { strikeE8: customE8, expirySec: E1, mode: 'basis-fallback-custom' },
      { strikeE8: 8850000000n, expirySec: E1, mode: 'basis-fallback' },
    ]);
    expect(candidates[0]).toMatchObject({ listing: null, indicativeApr: null, delta: null, rank: 1 });
    expect(candidates[0]?.request.strike).toBe(customE8.toString());
  });

  it('holds no-candidates when no strike clears the basis and the fallback is off', () => {
    const config = { call: { fallback: fallback({ enabled: false }) } };
    expect(plan('call', { basisE8: 12000000000n, config })).toMatchObject({
      kind: 'hold',
      reason: 'no-candidates',
    });
  });

  it("routes far-dated strikes above the basis to the normal path under scope 'all-listed'", () => {
    const config = { call: { fallback: fallback({ scope: 'all-listed' }) } };
    const result = quoted('call', { basisE8: 10000000000n, config });
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.mode).toBe('normal');
      expect(candidate.strikeE8).toBeGreaterThanOrEqual(10000000000n);
    }
    // 105 at 41.9 days; 110 there is below the prefilter.
    expect(terms(result.candidates)).toEqual([{ strikeE8: 10500000000n, expirySec: E4, mode: 'normal' }]);
  });

  it('holds no-candidates instead of falling back when the tenor window holds no call', () => {
    // The review's probe: a 36 h to 5 d window has no expiry, and K* (88.5 at 6.9 days) clears an 86 basis. The old
    // planner sold it as a basis fallback, skipping the APR floor; at a 120 basis it would have sold it below basis.
    for (const basisE8 of [8600000000n, 12000000000n]) {
      const result = held(plan('call', { basisE8, config: { call: { maxDaysToExpiry: 5 } } }));
      expect(result.reason).toBe('no-candidates');
      expect(result.detail).toBe('no call listing passes the product, tenor, moneyness and size filters');
      expect(result.excluded.length).toBeGreaterThan(0);
      expect(result.excluded.every((e) => e.reason === 'tenor')).toBe(true);
    }
  });

  it('plans a K* that clears the basis as a normal candidate, held to the APR floor', () => {
    // Only E1 is in the window; at an 88 basis only K* (88.5) clears it.
    const test: Case = { basisE8: 8800000000n, config: { call: E1_ONLY } };
    const { st, s, c } = tick(test);
    const result = planSide('call', st, s, c);
    if (result.kind !== 'quote') throw new Error(`expected a quote plan, got hold '${result.reason}'`);
    expect(terms(result.candidates)).toEqual([{ strikeE8: 8850000000n, expirySec: E1, mode: 'normal' }]);

    // 2 USD on 25 calls (about 5 % APR) is below the 10 % floor: it holds, where a fallback would take it.
    const [k] = result.candidates;
    if (k === undefined) throw new Error('no candidate');
    const quotedAt = (candidate: Candidate) => [
      { candidate, outcome: answered(candidate, 80000000000000000n) },
    ];
    expect(evaluate('call', quotedAt(k), st, s, c)).toMatchObject({ kind: 'hold', reason: 'apr-floor' });
    const asFallback: Candidate = { ...k, mode: 'basis-fallback' };
    expect(evaluate('call', quotedAt(asFallback), st, s, c)).toMatchObject({ kind: 'trade' });
  });

  it('never sells a K* that clears the basis in fallback mode', () => {
    // K* at E1 is a listed 120, above 1.4 × spot; no strike that passes the filters clears a 100 basis.
    const listings = [movedCall(8850000000n, E1, { strikeE8: 12000000000n })];
    const config = { call: { fallback: fallback({ customStrikeFirst: true }) } };
    const result = held(plan('call', { basisE8: 10000000000n, listings, config }));
    expect(result.reason).toBe('no-candidates');
    expect(result.detail).toBe(
      'the fallback strike 12000000000 clears the basis, so it takes the normal path but fails the moneyness filter',
    );
  });

  it('falls back only below the basis threshold and drops a custom strike not above K*', () => {
    // A 1 % margin: an 88 or 88.5 basis puts the threshold above K* (88.5), and the custom strike (88, 88.5) is not
    // above it, so only K* is quoted.
    for (const basisE8 of [8800000000n, 8850000000n]) {
      const fb = fallback({ customStrikeFirst: true });
      const config = { call: { ...E1_ONLY, minStrikeOverBasisPct: 0.01, fallback: fb } };
      const { candidates } = quoted('call', { basisE8, config });
      expect(terms(candidates)).toEqual([{ strikeE8: 8850000000n, expirySec: E1, mode: 'basis-fallback' }]);
    }
    // At 89 the custom strike (89) is above K*, so it is quoted first.
    const config = { call: { ...E1_ONLY, fallback: fallback({ customStrikeFirst: true }) } };
    expect(terms(quoted('call', { basisE8: 8900000000n, config }).candidates)).toEqual([
      { strikeE8: 8900000000n, expirySec: E1, mode: 'basis-fallback-custom' },
      { strikeE8: 8850000000n, expirySec: E1, mode: 'basis-fallback' },
    ]);
  });

  it('quotes eligible strikes even when all are below the APR prefilter', () => {
    // Basis 90: only 91.5 and 93.5 at 13.9 days clear it, with indicative APRs 0.10 and 0.07 under minApr 0.4 × 0.5.
    const test: Case = { basisE8: 9000000000n, config: { call: { minApr: 0.4 } } };
    const { st, s, c } = tick(test);
    const eligible = basisEligible(s.market.listings, 9000000000n, st, s, c);
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible.every((listing) => listing.indicativeApr < 0.4 * 0.5)).toBe(true);

    const result = planSide('call', st, s, c);
    expect(result.kind).toBe('quote');
    if (result.kind !== 'quote') return;
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.prefilterBypassed).toBe(true);
    expect(terms(result.candidates)).toEqual([
      { strikeE8: 9150000000n, expirySec: E2, mode: 'normal' },
      { strikeE8: 9350000000n, expirySec: E2, mode: 'normal' },
    ]);
  });

  it('holds basis-unreliable when the basis is unreliable', () => {
    const { st } = tick();
    const state = { basis: { ...st.basis, reliable: false, reason: 'basis-negative' } };
    expect(plan('call', { state })).toMatchObject({ kind: 'hold', reason: 'basis-unreliable' });
  });
});

describe('planSide: the checks it mirrors', () => {
  it("excludes strikes outside C10's 0.6 S to 1.4 S band as moneyness", () => {
    // 1.4 × 81.48 = 114.07 and 0.6 × 81.48 = 48.89.
    const call = movedCall(8850000000n, E1, { strikeE8: 11450000000n });
    const put = moved('put', 7450000000n, E1, { strikeE8: 4850000000n });
    const test: Case = { basisE8: 5000000000n, listings: [call, put] };
    for (const side of ['call', 'put'] as const) {
      const { excluded, candidates } = quoted(side, test);
      const strikeE8 = side === 'call' ? 11450000000n : 4850000000n;
      expect(excluded).toContainEqual({ strikeE8, expirySec: E1, reason: 'moneyness' });
      expect(candidates.map((candidate) => candidate.strikeE8)).not.toContain(strikeE8);
    }
    // 114 is inside the band.
    const inside = movedCall(8850000000n, E1, { strikeE8: 11400000000n });
    const { excluded } = quoted('call', { basisE8: 5000000000n, listings: [inside] });
    expect(excluded.find((e) => e.strikeE8 === 11400000000n)?.reason).not.toBe('moneyness');
  });

  it("caps the relaxed tenor under scope 'all-listed' at C11's year", () => {
    expect(ALL_LISTED_MAX_TENOR_DAYS).toBe(366);
    const far = movedCall(10500000000n, E4, { expirySec: NOW_SEC + 367 * DAY_SEC, indicativeApr: 0.9 });
    const allListed = fallback({ scope: 'all-listed' });
    const capped = quoted('call', {
      basisE8: 10000000000n,
      listings: [far],
      config: { call: { fallback: allListed } },
    });
    expect(capped.excluded).toContainEqual({
      strikeE8: 10500000000n,
      expirySec: far.expirySec,
      reason: 'tenor',
    });
    expect(capped.candidates.map((candidate) => candidate.expirySec)).not.toContain(far.expirySec);

    // A configured window longer than a year is the bound instead, as in `executionConfig`.
    const config = { call: { maxDaysToExpiry: 400, fallback: allListed } };
    const longer = quoted('call', { basisE8: 10000000000n, listings: [far], config });
    expect(longer.candidates[0]).toMatchObject({ strikeE8: 10500000000n, expirySec: far.expirySec });
  });

  describe("live: C16's 24 h notional with the trade included", () => {
    // 2 000 USD a day: a put lot at 80 or above (25 × 80 = 2 000) and a call lot at spot (2 037) reach it.
    const limit = { safety: { maxNotionalPer24h6: 2000_000000n } };

    it('excludes the listings that would reach the limit as daily-limit', () => {
      const result = quoted('put', { config: limit });
      expect(result.candidates.every((candidate) => candidate.strikeE8 < 8000000000n)).toBe(true);
      expect(result.candidates.length).toBeGreaterThan(0);
      const limited = result.excluded.filter((e) => e.reason === 'daily-limit').map((e) => e.strikeE8);
      expect(limited).toEqual(expect.arrayContaining([8050000000n, 8000000000n]));
      expect(limited.every((strikeE8) => strikeE8 >= 8000000000n)).toBe(true);
    });

    it('counts the notional of the last 24 h', () => {
      // 18 100 of 20 000 used: a put lot fits below 76.
      const state = { notionalLast24h6: 18_100_000000n };
      const { candidates } = quoted('put', { state });
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((candidate) => candidate.strikeE8 * 25n < 1900n * 10n ** 8n)).toBe(true);
    });

    it('holds daily-limit when no candidate fits, on the normal path and in the fallback', () => {
      expect(plan('call', { basisE8: 5000000000n, config: limit })).toMatchObject({
        kind: 'hold',
        reason: 'daily-limit',
      });
      expect(plan('call', { basisE8: 12000000000n, config: limit })).toMatchObject({
        kind: 'hold',
        reason: 'daily-limit',
        detail: 'the fallback strikes would reach the 24 h notional limit',
      });
    });

    it('does not apply in dry-run (gate G11 is live only)', () => {
      const result = quoted('call', { basisE8: 5000000000n, config: limit, mode: 'dry-run' });
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.excluded.some((e) => e.reason === 'daily-limit')).toBe(false);
    });
  });
});

describe('basisEligible', () => {
  it('keeps the calls that clear the basis, ignoring the delta band and the APR prefilter', () => {
    // 87 at E2 has |delta| 0.22 > 0.2; all but 87 at E2 are below the prefilter 0.4 × 0.5.
    const { st, s, c } = tick({ config: { call: { maxAbsDelta: 0.2, minApr: 0.4 } } });
    const eligible = basisEligible(s.market.listings, 8600000000n, st, s, c);
    // Inside the window: 87 and 88.5 at E1; 87, 91.5 and 93.5 at E2.
    expect(eligible.map(({ strikeE8, expirySec }) => ({ strikeE8, expirySec }))).toEqual(
      expect.arrayContaining([
        { strikeE8: 8700000000n, expirySec: E1 },
        { strikeE8: 8850000000n, expirySec: E1 },
        { strikeE8: 8700000000n, expirySec: E2 },
        { strikeE8: 9150000000n, expirySec: E2 },
        { strikeE8: 9350000000n, expirySec: E2 },
      ]),
    );
    expect(eligible).toHaveLength(5);
  });

  it('applies minStrikeOverBasisPct', () => {
    const { st, s, c } = tick({ config: { call: { minStrikeOverBasisPct: 0.1 } } });
    // 86 × 1.1 = 94.6: nothing inside the window clears it.
    expect(basisEligible(s.market.listings, 8600000000n, st, s, c)).toEqual([]);
  });
});

describe('fallbackStrike', () => {
  it('picks the highest listed call strike at the shortest expiry at least minHoursToExpiry out', () => {
    const c = wheelConfig({ call: LIMITS });
    const found = fallbackStrike(fixtureListings(), NOW_SEC, c);
    expect(found?.expirySec).toBe(E1);
    expect(found?.listing.strikeE8).toBe(8850000000n);
    expect(found?.listing.isPut).toBe(false);
  });

  it('skips expiries closer than minHoursToExpiry', () => {
    // E1 is 166.2 h out.
    const c = wheelConfig({ call: { ...LIMITS, minHoursToExpiry: 168 } });
    const found = fallbackStrike(fixtureListings(), NOW_SEC, c);
    expect(found?.expirySec).toBe(E2);
    expect(found?.listing.strikeE8).toBe(9350000000n);
  });

  it('returns null without a call listing', () => {
    const puts = fixtureListings().filter((listing) => listing.isPut);
    expect(fallbackStrike(puts, NOW_SEC, wheelConfig())).toBeNull();
  });
});

describe('customFallbackStrikeE8', () => {
  it('rounds min(basis, 1.393 × spot) up to the precision', () => {
    // 1.393 × 81.48032044 = 113.502…, rounded up to 114.
    expect(customFallbackStrikeE8(12000000000n, SPOT_E8, CUSTOM_STRIKE_PRECISION_E8)).toBe(11400000000n);
    expect(customFallbackStrikeE8(9010000000n, SPOT_E8, CUSTOM_STRIKE_PRECISION_E8)).toBe(9050000000n);
    expect(customFallbackStrikeE8(9000000000n, SPOT_E8, CUSTOM_STRIKE_PRECISION_E8)).toBe(9000000000n);
  });

  it("rounds down when rounding up would leave C10's 1.4 × spot band", () => {
    // 1.393 × 35.3 = 49.17…: 49.5 is above 1.4 × 35.3 = 49.42, so 49.
    expect(customFallbackStrikeE8(12000000000n, 3530000000n, CUSTOM_STRIKE_PRECISION_E8)).toBe(4900000000n);
  });

  it('stays on the grid and inside the band at any spot', () => {
    for (let spotE8 = 2000000000n; spotE8 <= 20000000000n; spotE8 += 37_000_000n) {
      const strikeE8 = customFallbackStrikeE8(10n ** 12n, spotE8, CUSTOM_STRIKE_PRECISION_E8);
      expect(strikeE8 % CUSTOM_STRIKE_PRECISION_E8).toBe(0n);
      expect(strikeE8 * 10n <= spotE8 * 14n).toBe(true);
      expect(strikeE8 + CUSTOM_STRIKE_PRECISION_E8 > (spotE8 * 1393n) / 1000n).toBe(true);
    }
  });

  it('uses a 0.5 USD precision', () => {
    expect(CUSTOM_STRIKE_PRECISION_E8).toBe(50_000_000n);
  });
});
