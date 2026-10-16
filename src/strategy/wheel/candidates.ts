import { isAddressEqual } from 'viem';
import { collateral6For } from '../../domain/apr.ts';
import { CAP_SOFT_MARGIN_BPS, remainingCapacityE18 } from '../../domain/caps.ts';
import {
  CHAIN_ID,
  STRIKE_BAND_MAX_BPS,
  STRIKE_BAND_MIN_BPS,
  TOKENS,
  TRADED_PRODUCTS,
} from '../../domain/constants.ts';
import { hypeAsset } from '../../domain/inventory.ts';
import type { Listing, Product, QuoteRequest, Side } from '../../domain/types.ts';
import { ceilDiv, collateralForCall, collateralForPut, fractionToBps } from '../../domain/units.ts';
import type { SideConfig, WheelConfig } from './config.ts';
import { checkGates } from './gates.ts';
import { trancheQuantityE18 } from './tranche.ts';
import type {
  Candidate,
  Exclusion,
  ExclusionReason,
  GateResult,
  HoldReason,
  SidePlan,
  Snapshot,
  WheelState,
} from './types.ts';

/** The custom fallback strike's grid: 0.5 USD in 8-decimal strike units. */
export const CUSTOM_STRIKE_PRECISION_E8 = 50_000_000n;
/**
 * Under `fallback.scope: 'all-listed'` a call's tenor may reach `max(this, maxDaysToExpiry)` days: the planner's bound
 * and the one check C11 applies to such a call (the daemon's `executionConfig` reads it from here).
 */
export const ALL_LISTED_MAX_TENOR_DAYS = 366;

const BPS = 10_000n;
const HOUR_SEC = 3_600;
const DAY_SEC = 86_400;
/** The third slot of a diversified plan goes to the best listing with `|delta|` at most this. */
const LOW_ABS_DELTA = 0.25;
/** The custom strike's cap, 1.4 × 0.995 of spot, in thousandths: just inside C10's band (`STRIKE_BAND_MAX_BPS`). */
const CUSTOM_SPOT_CAP_PER_MILLE = 1_393n;
const PER_MILLE = 1_000n;

/**
 * The RFQ `assetName` is the Rysk asset entry's symbol, not the collateral's (spike capture: WHYPE for a USDC put
 * and a WHYPE call, kHYPE for a kHYPE call): WHYPE for both traded products.
 */
const ASSET_NAME = TOKENS.WHYPE.symbol;

type Mode = Candidate['mode'];
/** What a plan past the gates builds from. */
type Context = { side: Side; st: WheelState; s: Snapshot; c: WheelConfig; gates: GateResult[] };
type Screened = { listing: Listing; failed: ExclusionReason | null };

/** The candidate filters of one side (spec §8.6), resolved once per plan. */
type Filters = {
  side: Side;
  nowSec: number;
  minTenorSec: number;
  /** The window's upper bound; for calls under `fallback.scope: 'all-listed'`, `allListedMaxTenorSec`. */
  maxTenorSec: number;
  spotE8: bigint;
  otmBps: bigint;
  /** The call basis rule; `null` for puts. */
  basis: { basisE8: bigint; overBps: bigint } | null;
  minAbsDelta: number;
  maxAbsDelta: number;
  lotE18: bigint;
  quantityE18: (strikeE8: bigint) => bigint;
  /** Live only (C16): the 24 h notional so far and its limit, USD 6 dp; `null` in dry-run. */
  dailyLimit: { notionalLast24h6: bigint; maxNotionalPer24h6: bigint } | null;
};

/**
 * The quote plan for one side (spec §8.6). The gates run first and a failing gate holds with its reason. Otherwise
 * the side's listings are screened: the traded product, the tenor window (`minHoursToExpiry` to
 * `maxDaysToExpiry`), moneyness against spot (OTM by `minOtmPct` and inside C10's `0.6 S ≤ K ≤ 1.4 S`), for calls
 * the basis rule `K ≥ basis × (1 + minStrikeOverBasisPct)`, at least one lot from `trancheQuantityE18` at the
 * listing's strike, the `|delta|` band and, in live, C16's 24 h notional limit with the trade included. The
 * survivors are ranked by indicative APR, then shorter tenor, then lower `|delta|`; the APR prefilter `minApr ×
 * prefilterRatio` trims them unless it would remove all of them, in which case it is bypassed (indicative APRs
 * understate real quotes and the floor applies to those). Up to `quotesPerSide` are chosen: the best, the best at
 * another expiry, the best with `|delta| ≤ 0.25`, then by rank. A plan emptied by the notional limit alone holds
 * `daily-limit`.
 *
 * The call fallback answers a basis problem only: it fires when some call listing passes the product, tenor,
 * moneyness and size filters but none of them clears the basis (an empty window holds `no-candidates`). It sells
 * the highest listed strike K* at the shortest expiry at least `minHoursToExpiry` out (`fallbackStrike`), preceded
 * by a custom strike (`customFallbackStrikeE8`) when `customStrikeFirst` is on and that strike is above K*; it
 * skips the APR prefilter, the delta band and the tenor window's upper bound and keeps moneyness, size and the
 * notional limit. Fallback mode only sells below the basis threshold: a K* that clears it is planned on the normal
 * path instead (`kStarOnNormalPath`). Pure; throws `UnitError` for a fraction outside 0 to 1, which config
 * validation rejects.
 */
export function planSide(side: Side, st: WheelState, s: Snapshot, c: WheelConfig): SidePlan {
  const { hold, results: gates } = checkGates(side, st, s, c);
  if (hold !== null) {
    const failed = gates.find((gate) => !gate.pass);
    return holdPlan(side, gates, [], hold, `${failed?.id}: ${failed?.detail}`);
  }
  const ctx: Context = { side, st, s, c, gates };
  if (side === 'put') {
    const f = filters('put', null, st, s, c);
    return normalPlan(ctx, f, screen(s.market.listings, f));
  }

  const { basisE8, reliable } = st.basis;
  // Gate S4 holds first; this narrows the type and keeps the plan consistent with it.
  if (!reliable || basisE8 === null) {
    return holdPlan(side, gates, [], 'basis-unreliable', 'the HYPE basis is unreliable or undefined');
  }
  const f = filters('call', basisE8, st, s, c);
  const screened = screen(s.market.listings, f);
  if (screened.some(isBasisEligible)) return normalPlan(ctx, f, screened);
  const excluded = screened.flatMap(exclusion);
  // Nothing in the window to fall back from: the trigger is the basis, never an empty window.
  if (!screened.some(({ listing }) => passesAllButBasis(listing, f))) {
    const detail = 'no call listing passes the product, tenor, moneyness and size filters';
    return holdPlan(side, gates, excluded, 'no-candidates', detail);
  }
  if (!c.call.fallback.enabled) {
    return holdPlan(
      side,
      gates,
      excluded,
      'no-candidates',
      `no call strike clears the basis ${basisE8} (e8)`,
    );
  }
  return fallbackPlan(ctx, f, basisE8, excluded);
}

/**
 * The call listings that clear the basis rule (`K ≥ basisE8 × (1 + minStrikeOverBasisPct)`) and pass the traded
 * product, tenor, moneyness and size filters, ignoring the delta band and the APR prefilter (spec §8.6). Under
 * `fallback.scope: 'all-listed'` the tenor window's upper bound is ignored; `minHoursToExpiry` always applies.
 */
export function basisEligible(
  listings: Listing[],
  basisE8: bigint,
  st: WheelState,
  s: Snapshot,
  c: WheelConfig,
): Listing[] {
  return screen(listings, filters('call', basisE8, st, s, c))
    .filter(isBasisEligible)
    .map(({ listing }) => listing);
}

/**
 * The call fallback strike (spec §8.6): among the call listings of the traded product at least
 * `minHoursToExpiry` out, the highest strike at the shortest expiry; `null` when there is none.
 */
export function fallbackStrike(
  listings: Listing[],
  nowSec: number,
  c: WheelConfig,
): { listing: Listing; expirySec: number } | null {
  const minTenorSec = c.call.minHoursToExpiry * HOUR_SEC;
  let best: Listing | null = null;
  for (const listing of listings) {
    if (listing.isPut || !hasTradedProduct(listing, 'call')) continue;
    if (!(listing.expirySec - nowSec >= minTenorSec)) continue;
    const better =
      best === null ||
      listing.expirySec < best.expirySec ||
      (listing.expirySec === best.expirySec && listing.strikeE8 > best.strikeE8);
    if (better) best = listing;
  }
  return best === null ? null : { listing: best, expirySec: best.expirySec };
}

/**
 * The custom fallback strike: `min(basis, 1.4 × 0.995 × spot)` rounded up to a multiple of `precisionE8`, or rounded
 * down when rounding up would leave C10's band (`K × 10 000 > spot × STRIKE_BAND_MAX_BPS`), so it never exceeds
 * 1.4 × spot. Exact in bigint. Throws `UnitError` for a negative price or a non-positive precision.
 */
export function customFallbackStrikeE8(basisE8: bigint, spotE8: bigint, precisionE8: bigint): bigint {
  const capE8 = (spotE8 * CUSTOM_SPOT_CAP_PER_MILLE) / PER_MILLE;
  const targetE8 = basisE8 < capE8 ? basisE8 : capE8;
  const upE8 = ceilDiv(targetE8, precisionE8) * precisionE8;
  if (upE8 * BPS <= spotE8 * STRIKE_BAND_MAX_BPS) return upE8;
  return (targetE8 / precisionE8) * precisionE8;
}

/** The longest tenor a call may have under `fallback.scope: 'all-listed'`, as C11 bounds it (seconds). */
function allListedMaxTenorSec(limits: SideConfig): number {
  return Math.max(ALL_LISTED_MAX_TENOR_DAYS, limits.maxDaysToExpiry) * DAY_SEC;
}

function filters(side: Side, basisE8: bigint | null, st: WheelState, s: Snapshot, c: WheelConfig): Filters {
  const limits = c[side];
  const whype = hypeAsset(s.market.assets);
  // The caps headroom as gate S3 computes it: the soft margin applied, NOTIONAL caps priced at spot.
  const target = { underlyingSymbol: 'HYPE', asset: whype.address, isPut: side === 'put' };
  const capacityE18 = remainingCapacityE18(s.market.caps, target, s.market.spotE8, CAP_SOFT_MARGIN_BPS);
  const relaxMaxTenor = side === 'call' && c.call.fallback.scope === 'all-listed';
  return {
    side,
    nowSec: s.nowSec,
    minTenorSec: limits.minHoursToExpiry * HOUR_SEC,
    maxTenorSec: relaxMaxTenor ? allListedMaxTenorSec(limits) : limits.maxDaysToExpiry * DAY_SEC,
    spotE8: s.market.spotE8,
    otmBps: fractionToBps(limits.minOtmPct),
    basis: basisE8 === null ? null : { basisE8, overBps: fractionToBps(c.call.minStrikeOverBasisPct) },
    minAbsDelta: limits.minAbsDelta,
    maxAbsDelta: limits.maxAbsDelta,
    lotE18: whype.minTradeSizeE18,
    quantityE18: (strikeE8) => trancheQuantityE18(side, st, strikeE8, s, c, capacityE18),
    dailyLimit:
      s.mode === 'live'
        ? { notionalLast24h6: st.notionalLast24h6, maxNotionalPer24h6: c.safety.maxNotionalPer24h6 }
        : null,
  };
}

/** The side's listings, each with the first filter it fails. */
function screen(listings: Listing[], f: Filters): Screened[] {
  return listings
    .filter((listing) => listing.isPut === (f.side === 'put'))
    .map((listing) => ({ listing, failed: firstFailure(listing, f) }));
}

/**
 * The eligibility filters in order, then the delta band and the notional limit last so that `basisEligible` can
 * ignore them.
 */
function firstFailure(listing: Listing, f: Filters): ExclusionReason | null {
  if (!hasTradedProduct(listing, f.side)) return 'product';
  if (!inTenor(listing.expirySec, f)) return 'tenor';
  if (!inMoneyness(listing.strikeE8, f)) return 'moneyness';
  if (f.basis !== null && !clearsBasis(listing.strikeE8, f.basis)) return 'basis';
  if (!fillsALot(listing.strikeE8, f)) return 'size';
  const absDelta = Math.abs(listing.delta);
  if (!(absDelta >= f.minAbsDelta && absDelta <= f.maxAbsDelta)) return 'delta';
  if (!fitsDailyLimit(listing.strikeE8, f)) return 'daily-limit';
  return null;
}

function isBasisEligible({ failed }: Screened): boolean {
  return failed === null || failed === 'delta' || failed === 'daily-limit';
}

/** The filters the call fallback is measured against (spec §8.6): product, tenor, moneyness and size. */
function passesAllButBasis(listing: Listing, f: Filters): boolean {
  return (
    hasTradedProduct(listing, f.side) &&
    inTenor(listing.expirySec, f) &&
    inMoneyness(listing.strikeE8, f) &&
    fillsALot(listing.strikeE8, f)
  );
}

function hasTradedProduct(listing: Listing, side: Side): boolean {
  const traded = TRADED_PRODUCTS[side];
  return listing.products.some(
    (product) =>
      product.isPut === traded.isPut &&
      isAddressEqual(product.underlying, traded.underlying) &&
      isAddressEqual(product.strikeAsset, traded.strikeAsset) &&
      isAddressEqual(product.collateralAsset, traded.collateralAsset),
  );
}

function inTenor(expirySec: number, f: Filters): boolean {
  const tenorSec = expirySec - f.nowSec;
  return tenorSec >= f.minTenorSec && tenorSec <= f.maxTenorSec;
}

/**
 * Put `K ≤ S × (1 − minOtmPct)`, call `K ≥ S × (1 + minOtmPct)`, and either inside C10's band `0.6 S ≤ K ≤ 1.4 S`,
 * in basis points.
 */
function inMoneyness(strikeE8: bigint, f: Filters): boolean {
  const k = strikeE8 * BPS;
  if (k < f.spotE8 * STRIKE_BAND_MIN_BPS || k > f.spotE8 * STRIKE_BAND_MAX_BPS) return false;
  return f.side === 'put' ? k <= f.spotE8 * (BPS - f.otmBps) : k >= f.spotE8 * (BPS + f.otmBps);
}

function clearsBasis(strikeE8: bigint, basis: { basisE8: bigint; overBps: bigint }): boolean {
  return strikeE8 * BPS >= basis.basisE8 * (BPS + basis.overBps);
}

function fillsALot(strikeE8: bigint, f: Filters): boolean {
  return f.quantityE18(strikeE8) >= f.lotE18;
}

/**
 * C16's notional clause, live only: the 24 h notional with this trade (strike × quantity for a put, spot × quantity
 * for a call, USD 6 dp) stays below `maxNotionalPer24h6`, as C16 requires.
 */
function fitsDailyLimit(strikeE8: bigint, f: Filters): boolean {
  if (f.dailyLimit === null) return true;
  const notional6 = collateral6For(f.side, f.quantityE18(strikeE8), strikeE8, f.spotE8);
  return f.dailyLimit.notionalLast24h6 + notional6 < f.dailyLimit.maxNotionalPer24h6;
}

/** Rank, ranking, prefilter and diversified choice for the listings that passed every filter. */
function normalPlan(ctx: Context, f: Filters, screened: Screened[]): SidePlan {
  const { side, c, gates } = ctx;
  const excluded = screened.flatMap(exclusion);
  const ranked = screened.filter(({ failed }) => failed === null).map(({ listing }) => listing);
  ranked.sort(byRank);
  const floor = c[side].minApr * c.quoting.prefilterRatio;
  const aboveFloor = ranked.filter((listing) => listing.indicativeApr >= floor);
  const prefilterBypassed = aboveFloor.length === 0 && ranked.length > 0;
  if (!prefilterBypassed) {
    for (const listing of ranked) {
      if (!(listing.indicativeApr >= floor)) excluded.push(excludedAs(listing, 'apr-prefilter'));
    }
  }
  const pool = prefilterBypassed ? ranked : aboveFloor;
  const chosen = diversify(pool, c.quoting.quotesPerSide);
  if (chosen.length === 0) {
    if (excluded.some((e) => e.reason === 'daily-limit')) {
      return holdPlan(
        side,
        gates,
        excluded,
        'daily-limit',
        `no ${side} listing fits the 24 h notional limit`,
      );
    }
    return holdPlan(side, gates, excluded, 'no-candidates', `no ${side} listing passes the filters`);
  }
  const candidates = chosen.map((listing) =>
    candidate(ctx, listing, listing.strikeE8, listing.expirySec, 'normal', pool.indexOf(listing) + 1, f),
  );
  return { kind: 'quote', side, candidates, gates, excluded, prefilterBypassed };
}

/**
 * The call fallback: the custom strike first when configured and above K*, then K* (the fallback listing). A K*
 * that clears the basis threshold is no fallback and takes the normal path.
 */
function fallbackPlan(ctx: Context, f: Filters, basisE8: bigint, excluded: Exclusion[]): SidePlan {
  const { side, s, c, gates } = ctx;
  const found = fallbackStrike(s.market.listings, s.nowSec, c);
  if (found === null) {
    return holdPlan(side, gates, excluded, 'no-candidates', 'no call listing for the basis fallback');
  }
  const { listing, expirySec } = found;
  if (f.basis !== null && clearsBasis(listing.strikeE8, f.basis)) {
    return kStarOnNormalPath(ctx, f, listing, excluded);
  }
  const { maxDiscountToBasisPct, customStrikeFirst } = c.call.fallback;
  if (maxDiscountToBasisPct !== undefined) {
    const discountBps = fractionToBps(maxDiscountToBasisPct);
    if (listing.strikeE8 * BPS < basisE8 * (BPS - discountBps)) {
      const detail = `strike ${listing.strikeE8} is below the basis ${basisE8} × (1 − ${maxDiscountToBasisPct})`;
      return holdPlan(side, gates, excluded, 'fallback-too-far-below-basis', detail);
    }
  }
  const strikes: { strikeE8: bigint; listing: Listing | null; mode: Mode }[] = [];
  if (customStrikeFirst) {
    const strikeE8 = customFallbackStrikeE8(basisE8, s.market.spotE8, CUSTOM_STRIKE_PRECISION_E8);
    // Never a worse strike than the highest listed one (C18 requires the custom strike above the fresh K*).
    if (strikeE8 > listing.strikeE8) strikes.push({ strikeE8, listing: null, mode: 'basis-fallback-custom' });
  }
  strikes.push({ strikeE8: listing.strikeE8, listing, mode: 'basis-fallback' });

  // The fallback keeps every check but the APR floor, the delta band and the window's upper bound.
  const kept = strikes.filter(({ strikeE8 }) => inMoneyness(strikeE8, f) && fillsALot(strikeE8, f));
  if (kept.length === 0) {
    return holdPlan(side, gates, excluded, 'no-candidates', 'the fallback strikes fail moneyness or size');
  }
  const fitting = kept.filter(({ strikeE8 }) => fitsDailyLimit(strikeE8, f));
  if (fitting.length === 0) {
    return holdPlan(
      side,
      gates,
      excluded,
      'daily-limit',
      'the fallback strikes would reach the 24 h notional limit',
    );
  }
  const candidates = fitting.map((k, index) =>
    candidate(ctx, k.listing, k.strikeE8, expirySec, k.mode, index + 1, f),
  );
  return { kind: 'quote', side, candidates, gates, excluded, prefilterBypassed: false };
}

/**
 * K* clears the basis threshold, so selling it is no fallback: it is planned as a normal candidate (the APR floor
 * applies at evaluation and in C8) under every normal filter, with only the tenor window's upper bound relaxed as
 * under `fallback.scope: 'all-listed'`; failing one of them holds. The plan's `detail` records why.
 */
function kStarOnNormalPath(ctx: Context, f: Filters, kStar: Listing, excluded: Exclusion[]): SidePlan {
  const { side, c, gates } = ctx;
  const relaxed: Filters = { ...f, maxTenorSec: allListedMaxTenorSec(c.call) };
  const failed = firstFailure(kStar, relaxed);
  const clears = `the fallback strike ${kStar.strikeE8} clears the basis, so it takes the normal path`;
  if (failed !== null) {
    const reason: HoldReason = failed === 'daily-limit' ? 'daily-limit' : 'no-candidates';
    return holdPlan(side, gates, excluded, reason, `${clears} but fails the ${failed} filter`);
  }
  const floor = c.call.minApr * c.quoting.prefilterRatio;
  return {
    kind: 'quote',
    side,
    candidates: [candidate(ctx, kStar, kStar.strikeE8, kStar.expirySec, 'normal', 1, f)],
    gates,
    excluded,
    prefilterBypassed: !(kStar.indicativeApr >= floor),
    detail: clears,
  };
}

/** Indicative APR descending, then shorter tenor, then lower `|delta|`. */
function byRank(a: Listing, b: Listing): number {
  return (
    b.indicativeApr - a.indicativeApr || a.expirySec - b.expirySec || Math.abs(a.delta) - Math.abs(b.delta)
  );
}

/** Up to `slots` of the ranked listings: the best, the best at another expiry, the best low-delta one, then by rank. */
function diversify(ranked: Listing[], slots: number): Listing[] {
  const best = ranked[0];
  if (best === undefined) return [];
  const preferences: ((listing: Listing) => boolean)[] = [
    () => true,
    (listing) => listing.expirySec !== best.expirySec,
    (listing) => Math.abs(listing.delta) <= LOW_ABS_DELTA,
  ];
  const chosen: Listing[] = [];
  for (const prefer of preferences) {
    if (chosen.length >= slots) return chosen;
    const pick = ranked.find((listing) => !chosen.includes(listing) && prefer(listing));
    if (pick !== undefined) chosen.push(pick);
  }
  for (const listing of ranked) {
    if (chosen.length >= slots) break;
    if (!chosen.includes(listing)) chosen.push(listing);
  }
  return chosen;
}

/** A candidate sized by the tranche at its strike, with its RFQ in the wire format (e8 strike, e18 quantity). */
function candidate(
  ctx: Context,
  listing: Listing | null,
  strikeE8: bigint,
  expirySec: number,
  mode: Mode,
  rank: number,
  f: Filters,
): Candidate {
  const { side, c } = ctx;
  const product: Product = TRADED_PRODUCTS[side];
  const quantityE18 = f.quantityE18(strikeE8);
  const collateralAmount =
    side === 'put'
      ? collateralForPut(quantityE18, strikeE8)
      : collateralForCall(quantityE18, TOKENS.WHYPE.decimals);
  const request: QuoteRequest = {
    asset: product.underlying,
    assetName: ASSET_NAME,
    chainId: CHAIN_ID,
    expiry: expirySec,
    isPut: product.isPut,
    quantity: quantityE18.toString(),
    strike: strikeE8.toString(),
    taker: c.self,
    usd: product.strikeAsset,
    collateralAsset: product.collateralAsset,
    isEIP1271: false,
  };
  return {
    side,
    listing,
    product,
    strikeE8,
    expirySec,
    quantityE18,
    collateralAmount,
    request,
    mode,
    rank,
    indicativeApr: listing?.indicativeApr ?? null,
    delta: listing?.delta ?? null,
  };
}

function exclusion({ listing, failed }: Screened): Exclusion[] {
  return failed === null ? [] : [excludedAs(listing, failed)];
}

function excludedAs(listing: Listing, reason: ExclusionReason): Exclusion {
  return { strikeE8: listing.strikeE8, expirySec: listing.expirySec, reason };
}

function holdPlan(
  side: Side,
  gates: GateResult[],
  excluded: Exclusion[],
  reason: HoldReason,
  detail: string,
): SidePlan {
  return { kind: 'hold', side, reason, detail, gates, excluded };
}
