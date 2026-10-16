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
import type { Position, Side } from '../../domain/types.ts';
import {
  basisEligible,
  CUSTOM_STRIKE_PRECISION_E8,
  customFallbackStrikeE8,
  fallbackStrike,
  planSide,
} from './candidates.ts';
import type { CallFallbackConfig, SideConfig } from './config.ts';
import { deriveState } from './state.ts';
import type { Candidate, SidePlan, WheelState } from './types.ts';

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

type Case = { basisE8?: bigint; state?: Partial<WheelState>; config?: ConfigPatch };

/** The fixture rows with the open put deployed two days back, so the put's 24 h interval has passed. */
function happyPositions(): Position[] {
  return fixturePositions().map((p) =>
    p.isPut && p.status === 'open' ? { ...p, createdAtSec: NOW_SEC - 2 * DAY_SEC } : p,
  );
}

/** The fixture tick at spot 81.48 with every gate passing; one lot fits on each side. */
function tick(test: Case = {}) {
  const s = snapshotFromFixtures({
    positions: happyPositions(),
    market: { assets: fixtureAssets(), listings: fixtureListings(), caps: fixtureCaps(), spotE8: SPOT_E8 },
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

  it('uses a 0.5 USD precision', () => {
    expect(CUSTOM_STRIKE_PRECISION_E8).toBe(50_000_000n);
  });
});
