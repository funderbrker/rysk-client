import { isAddressEqual } from 'viem';
import { CAP_SOFT_MARGIN_BPS, remainingCapacityE18 } from '../domain/caps.ts';
import { TRADED_PRODUCTS } from '../domain/constants.ts';
import { hypeAsset } from '../domain/inventory.ts';
import type { Asset, Listing, Side } from '../domain/types.ts';
import type { ExecutionConfig } from '../execution/checks.ts';
import type { FreshState } from '../execution/types.ts';
import type { WheelConfig } from '../strategy/wheel/config.ts';
import {
  ALL_LISTED_MAX_TENOR_DAYS,
  basisEligible,
  checkGates,
  deriveState,
  fallbackStrike,
  trancheQuantityE18,
} from '../strategy/wheel/index.ts';
import type { Snapshot } from '../strategy/wheel/types.ts';

// What `sellOption` reads from the strategy: the checklist's configuration for a side, and the side's state
// recomputed from a fresh snapshot (spec §7.1 PRECHECK, §7.2 C2 and later).

/** The instrument being executed: the fresh state sizes the tranche at its strike and lists its expiry's strikes. */
export type ExecutedInstrument = { side: Side; strikeE8: bigint; expirySec: number };

/**
 * The pre-sign checklist's configuration for `side`: the safety block, the side's limits, and the trade sizes and
 * strike precision of `asset` (the WHYPE asset). A call's fallback floor applies to calls only (C3 refuses a fallback
 * put); under `fallback.scope: 'all-listed'` a call's maximum tenor is the strategy's `ALL_LISTED_MAX_TENOR_DAYS` (or
 * the configured one, if longer), the bound the planner applies, so a far-dated listing above the basis that the
 * planner takes on the normal path passes C11; C10's listing check still applies.
 */
export function executionConfig(side: Side, c: WheelConfig, asset: Asset): ExecutionConfig {
  const limits = c[side];
  const { safety } = c;
  const allListed = side === 'call' && c.call.fallback.scope === 'all-listed';
  return {
    maxGasFee6: safety.maxGasFee6,
    maxGasFeeBps: safety.maxGasFeeBps,
    minNetPremium6: safety.minNetPremium6,
    minQuoteTtlSec: safety.minQuoteTtlSec,
    maxQuoteTtlSec: safety.maxQuoteTtlSec,
    maxPremiumFractionOfCollateral: safety.maxPremiumFractionOfCollateral,
    aprEchoTolerancePp: safety.aprEchoTolerancePp,
    aprEchoToleranceRelPct: safety.aprEchoToleranceRelPct,
    verifyMakerSig: safety.verifyMakerSig,
    maxDeploymentsPer24h: safety.maxDeploymentsPer24h,
    maxNotionalPer24h6: safety.maxNotionalPer24h6,
    minNativeHypeE18: safety.minNativeHypeE18,
    minApr: limits.minApr,
    minOtmPct: limits.minOtmPct,
    minStrikeOverBasisPct: c.call.minStrikeOverBasisPct,
    fallbackMinNetPremium6: c.call.fallback.minNetPremium6,
    minTradeSizeE18: asset.minTradeSizeE18,
    maxTradeSizeE18: asset.maxTradeSizeE18,
    maxContractsPerTradeE18: limits.maxContractsPerTradeE18,
    strikePrecisionE8: asset.strikePrecisionE8,
    minHoursToExpiry: limits.minHoursToExpiry,
    maxDaysToExpiry: allListed
      ? Math.max(ALL_LISTED_MAX_TENOR_DAYS, limits.maxDaysToExpiry)
      : limits.maxDaysToExpiry,
  };
}

/** What the fresh state reads besides the snapshot, at the same time. */
export type FreshReads = {
  /** The side's collateral allowance to the MarginPool. */
  allowance: bigint;
  /** Whether `data/STOP` exists now. */
  stopFile: boolean;
  /** The frontend version tripwire now. */
  frontendChanged: boolean;
};

/**
 * The side's state on a fresh snapshot, as `sellOption` checks it: the first holding gate, the tranche at the
 * executed strike under the caps headroom (the 0.95 soft margin applied once, here), the basis, the fallback's
 * fresh eligibility and strike, the free collateral (net of the reserve), and the strikes and expiries the side's
 * traded product lists. The gates see the calling execution excluded (`inFlight` false: the loop runs one
 * execution at a time) and STOP and the tripwire as `reads` has them now rather than as the last tick saw them.
 * Times are the snapshot's: `fetchedAtMs` its local clock once the reads were back, `listingsAtMs` when the
 * inventory arrived.
 */
export function freshStateOf(
  target: ExecutedInstrument,
  taken: Snapshot,
  c: WheelConfig,
  reads: FreshReads,
): FreshState {
  const memo = {
    ...taken.memo,
    inFlight: false,
    stopFile: reads.stopFile,
    frontendChanged: reads.frontendChanged,
  };
  const s: Snapshot = { ...taken, memo };
  const { side, strikeE8, expirySec } = target;
  const st = deriveState(s, c);
  const whype = hypeAsset(s.market.assets);
  const caps = { underlyingSymbol: 'HYPE', asset: whype.address, isPut: side === 'put' };
  const capacityE18 = remainingCapacityE18(s.market.caps, caps, s.market.spotE8, CAP_SOFT_MARGIN_BPS);
  const { basisE8, reliable } = st.basis;
  const traded = s.market.listings.filter((listing) => isTradedListing(listing, side));
  return {
    gateHold: checkGates(side, st, s, c).hold,
    trancheQuantityE18: trancheQuantityE18(side, st, strikeE8, s, c, capacityE18),
    basisE8,
    basisReliable: reliable,
    basisEligibleEmpty:
      side === 'call' && basisE8 !== null
        ? basisEligible(s.market.listings, basisE8, st, s, c).length === 0
        : false,
    freshFallbackStrikeE8:
      side === 'call' ? (fallbackStrike(s.market.listings, s.nowSec, c)?.listing.strikeE8 ?? null) : null,
    freeCollateral: st.capital[side].free,
    spotE8: s.market.spotE8,
    listedStrikesE8ForExpiry: traded
      .filter((listing) => listing.expirySec === expirySec)
      .map((listing) => listing.strikeE8),
    expiriesSec: [...new Set(traded.map((listing) => listing.expirySec))],
    deploymentsLast24h: st.deploymentsLast24h,
    notionalLast24h6: st.notionalLast24h6,
    nativeHypeE18: s.chain.nativeHypeE18,
    allowance: reads.allowance,
    fetchedAtMs: s.localNowMs,
    listingsAtMs: s.market.inventoryTs * 1000,
    capHeadroomE18: capacityE18,
  };
}

/** A listing of `side` that offers the product the wheel trades on that side. */
function isTradedListing(listing: Listing, side: Side): boolean {
  const traded = TRADED_PRODUCTS[side];
  return (
    listing.isPut === traded.isPut &&
    listing.products.some(
      (product) =>
        product.isPut === traded.isPut &&
        isAddressEqual(product.underlying, traded.underlying) &&
        isAddressEqual(product.strikeAsset, traded.strikeAsset) &&
        isAddressEqual(product.collateralAsset, traded.collateralAsset),
    )
  );
}
