import { isAddressEqual } from 'viem';
import { CAP_SOFT_MARGIN_BPS, remainingCapacityE18 } from '../../domain/caps.ts';
import { CHAIN_ID, TOKENS, TRADED_PRODUCTS } from '../../domain/constants.ts';
import { hypeAsset } from '../../domain/inventory.ts';
import type { Listing, Product, QuoteRequest, Side } from '../../domain/types.ts';
import { ceilDiv, collateralForCall, collateralForPut, fractionToBps } from '../../domain/units.ts';
import type { WheelConfig } from './config.ts';
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

const BPS = 10_000n;
const HOUR_SEC = 3_600;
const DAY_SEC = 86_400;
/** The third slot of a diversified plan goes to the best listing with `|delta|` at most this. */
const LOW_ABS_DELTA = 0.25;
/** The custom strike's cap, 1.4 × 0.995 of spot, in thousandths: just inside the 1.4 × spot band of C10. */
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
  /** `undefined` when the upper bound is relaxed: calls under `fallback.scope: 'all-listed'`. */
  maxTenorSec: number | undefined;
  spotE8: bigint;
  otmBps: bigint;
  /** The call basis rule; `null` for puts. */
  basis: { basisE8: bigint; overBps: bigint } | null;
  minAbsDelta: number;
  maxAbsDelta: number;
  lotE18: bigint;
  quantityE18: (strikeE8: bigint) => bigint;
};

/**
 * The quote plan for one side (spec §8.6). The gates run first and a failing gate holds with its reason. Otherwise
 * the side's listings are screened: the traded product, the tenor window (`minHoursToExpiry` to
 * `maxDaysToExpiry`), moneyness against spot, for calls the basis rule `K ≥ basis × (1 + minStrikeOverBasisPct)`,
 * at least one lot from `trancheQuantityE18` at the listing's strike, and the `|delta|` band. The survivors are
 * ranked by indicative APR, then shorter tenor, then lower `|delta|`; the APR prefilter `minApr × prefilterRatio`
 * trims them unless it would remove all of them, in which case it is bypassed (indicative APRs understate real
 * quotes and the floor applies to those). Up to `quotesPerSide` are chosen: the best, the best at another expiry,
 * the best with `|delta| ≤ 0.25`, then by rank.
 *
 * A call side with no `basisEligible` listing falls back, when enabled, to the highest listed strike at the
 * shortest expiry at least `minHoursToExpiry` out (`fallbackStrike`), preceded by a custom strike
 * (`customFallbackStrikeE8`) when `customStrikeFirst` is on; the fallback skips the APR prefilter, the delta band
 * and the tenor window's upper bound and keeps moneyness and size. Pure; throws `UnitError` for a fraction outside
 * 0 to 1, which config validation rejects.
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
 * The custom fallback strike: `min(basis, 1.4 × 0.995 × spot)` rounded up to a multiple of `precisionE8`, exact in
 * bigint. Throws `UnitError` for a negative price or a non-positive precision.
 */
export function customFallbackStrikeE8(basisE8: bigint, spotE8: bigint, precisionE8: bigint): bigint {
  const basisMilli = basisE8 * PER_MILLE;
  const capMilli = spotE8 * CUSTOM_SPOT_CAP_PER_MILLE;
  const strikeMilli = basisMilli < capMilli ? basisMilli : capMilli;
  return ceilDiv(strikeMilli, precisionE8 * PER_MILLE) * precisionE8;
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
    maxTenorSec: relaxMaxTenor ? undefined : limits.maxDaysToExpiry * DAY_SEC,
    spotE8: s.market.spotE8,
    otmBps: fractionToBps(limits.minOtmPct),
    basis: basisE8 === null ? null : { basisE8, overBps: fractionToBps(c.call.minStrikeOverBasisPct) },
    minAbsDelta: limits.minAbsDelta,
    maxAbsDelta: limits.maxAbsDelta,
    lotE18: whype.minTradeSizeE18,
    quantityE18: (strikeE8) => trancheQuantityE18(side, st, strikeE8, s, c, capacityE18),
  };
}

/** The side's listings, each with the first filter it fails. */
function screen(listings: Listing[], f: Filters): Screened[] {
  return listings
    .filter((listing) => listing.isPut === (f.side === 'put'))
    .map((listing) => ({ listing, failed: firstFailure(listing, f) }));
}

/** The eligibility filters in order, then the delta band last so that `basisEligible` can ignore it. */
function firstFailure(listing: Listing, f: Filters): ExclusionReason | null {
  if (!hasTradedProduct(listing, f.side)) return 'product';
  if (!inTenor(listing.expirySec, f)) return 'tenor';
  if (!isOtm(listing.strikeE8, f)) return 'moneyness';
  if (f.basis !== null && !clearsBasis(listing.strikeE8, f.basis)) return 'basis';
  if (!fillsALot(listing.strikeE8, f)) return 'size';
  const absDelta = Math.abs(listing.delta);
  if (!(absDelta >= f.minAbsDelta && absDelta <= f.maxAbsDelta)) return 'delta';
  return null;
}

function isBasisEligible({ failed }: Screened): boolean {
  return failed === null || failed === 'delta';
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
  return tenorSec >= f.minTenorSec && (f.maxTenorSec === undefined || tenorSec <= f.maxTenorSec);
}

/** Put `K ≤ S × (1 − minOtmPct)`, call `K ≥ S × (1 + minOtmPct)`, in basis points. */
function isOtm(strikeE8: bigint, f: Filters): boolean {
  return f.side === 'put'
    ? strikeE8 * BPS <= f.spotE8 * (BPS - f.otmBps)
    : strikeE8 * BPS >= f.spotE8 * (BPS + f.otmBps);
}

function clearsBasis(strikeE8: bigint, basis: { basisE8: bigint; overBps: bigint }): boolean {
  return strikeE8 * BPS >= basis.basisE8 * (BPS + basis.overBps);
}

function fillsALot(strikeE8: bigint, f: Filters): boolean {
  return f.quantityE18(strikeE8) >= f.lotE18;
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
    return holdPlan(side, gates, excluded, 'no-candidates', `no ${side} listing passes the filters`);
  }
  const candidates = chosen.map((listing) =>
    candidate(ctx, listing, listing.strikeE8, listing.expirySec, 'normal', pool.indexOf(listing) + 1, f),
  );
  return { kind: 'quote', side, candidates, gates, excluded, prefilterBypassed };
}

/** The call fallback: the custom strike first when configured, then the fallback listing. */
function fallbackPlan(ctx: Context, f: Filters, basisE8: bigint, excluded: Exclusion[]): SidePlan {
  const { side, s, c, gates } = ctx;
  const found = fallbackStrike(s.market.listings, s.nowSec, c);
  if (found === null) {
    return holdPlan(side, gates, excluded, 'no-candidates', 'no call listing for the basis fallback');
  }
  const { listing, expirySec } = found;
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
    strikes.push({ strikeE8, listing: null, mode: 'basis-fallback-custom' });
  }
  strikes.push({ strikeE8: listing.strikeE8, listing, mode: 'basis-fallback' });

  // The fallback keeps every check but the APR floor, the delta band and the window's upper bound.
  const kept = strikes.filter(({ strikeE8 }) => isOtm(strikeE8, f) && fillsALot(strikeE8, f));
  if (kept.length === 0) {
    return holdPlan(side, gates, excluded, 'no-candidates', 'the fallback strikes fail moneyness or size');
  }
  const candidates = kept.map((k, index) =>
    candidate(ctx, k.listing, k.strikeE8, expirySec, k.mode, index + 1, f),
  );
  return { kind: 'quote', side, candidates, gates, excluded, prefilterBypassed: false };
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
