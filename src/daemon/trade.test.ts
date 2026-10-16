import { describe, expect, it } from 'vitest';
import {
  ANCHOR,
  fixtureAssets,
  fixtureCaps,
  fixtureListings,
  fixturePositions,
  NOW_SEC,
  snapshotFromFixtures,
  wheelConfig,
} from '../../test/helpers/wheelSnapshot.ts';
import { CAP_SOFT_MARGIN_BPS, remainingCapacityE18 } from '../domain/caps.ts';
import { TRADED_PRODUCTS } from '../domain/constants.ts';
import { hypeAsset } from '../domain/inventory.ts';
import type { Listing, Side } from '../domain/types.ts';
import {
  ALL_LISTED_MAX_TENOR_DAYS,
  checkGates,
  deriveState,
  fallbackStrike,
  trancheQuantityE18,
} from '../strategy/wheel/index.ts';
import type { Snapshot } from '../strategy/wheel/types.ts';
import { executionConfig, freshStateOf } from './trade.ts';

const E18 = 10n ** 18n;
const DAY_SEC = 86_400;
const SPOT_E8 = 8148032044n;
const INVENTORY_TS = NOW_SEC - 7;
const READS = { allowance: 123n, stopFile: false, frontendChanged: false };

/** The fixture wallet a fresh snapshot sees, every gate passing, with the open put deployed two days back. */
function freshSnapshot(mode: Snapshot['mode'], memo: Partial<Snapshot['memo']> = {}): Snapshot {
  const positions = fixturePositions().map((p) =>
    p.isPut && p.status === 'open' ? { ...p, createdAtSec: NOW_SEC - 2 * DAY_SEC } : p,
  );
  return snapshotFromFixtures({
    mode,
    positions,
    localNowMs: NOW_SEC * 1000 + 1500,
    market: {
      assets: fixtureAssets(),
      listings: fixtureListings(),
      caps: fixtureCaps(),
      spotE8: SPOT_E8,
      inventoryTs: INVENTORY_TS,
    },
    memo: { lastNoPendingSeenSec: NOW_SEC - 3600, ...memo },
  });
}

/** An OTM listing of `side` in the traded product, at least two days out. */
function tradedListing(side: Side): Listing {
  const listing = fixtureListings().find(
    (l) =>
      l.isPut === (side === 'put') &&
      l.expirySec - NOW_SEC > 2 * DAY_SEC &&
      (side === 'put' ? l.strikeE8 * 100n < SPOT_E8 * 95n : l.strikeE8 * 100n > SPOT_E8 * 105n) &&
      l.products.some((p) => p.collateralAsset === TRADED_PRODUCTS[side].collateralAsset),
  );
  if (listing === undefined) throw new Error(`no traded ${side} listing in the fixture`);
  return listing;
}

function instrument(listing: Listing) {
  const side: Side = listing.isPut ? 'put' : 'call';
  return { side, strikeE8: listing.strikeE8, expirySec: listing.expirySec };
}

describe('executionConfig', () => {
  const asset = hypeAsset(fixtureAssets());
  const c = wheelConfig({
    put: { minApr: 0.3, minHoursToExpiry: 24, maxDaysToExpiry: 10, minOtmPct: 0.02 },
    call: {
      minApr: 0.5,
      maxDaysToExpiry: 20,
      minStrikeOverBasisPct: 0.05,
      maxContractsPerTradeE18: 50n * E18,
      // A fallback floor apart from `safety.minNetPremium6` (1 USD), so the checklist mapping of each is pinned.
      fallback: { enabled: true, scope: 'window', customStrikeFirst: false, minNetPremium6: 2_000000n },
    },
  });

  it("maps the safety block, the side's limits and the WHYPE asset's sizes", () => {
    expect(executionConfig('put', c, asset)).toEqual({
      maxGasFee6: 500000n,
      maxGasFeeBps: 200,
      minNetPremium6: 1_000000n,
      minQuoteTtlSec: 15,
      maxQuoteTtlSec: 600,
      maxPremiumFractionOfCollateral: 0.15,
      aprEchoTolerancePp: 1,
      verifyMakerSig: 'warn',
      maxDeploymentsPer24h: 4,
      maxNotionalPer24h6: 20000_000000n,
      minNativeHypeE18: 5n * 10n ** 16n,
      minApr: 0.3,
      minOtmPct: 0.02,
      minStrikeOverBasisPct: 0.05,
      fallbackMinNetPremium6: 2_000000n,
      minTradeSizeE18: 25n * E18,
      maxTradeSizeE18: 5000n * E18,
      maxContractsPerTradeE18: 25n * E18,
      strikePrecisionE8: asset.strikePrecisionE8,
      minHoursToExpiry: 24,
      maxDaysToExpiry: 10,
    });
    expect(executionConfig('call', c, asset)).toMatchObject({
      minApr: 0.5,
      minOtmPct: 0.01,
      maxContractsPerTradeE18: 50n * E18,
      minHoursToExpiry: 36,
      maxDaysToExpiry: 20,
    });
  });

  it("lets a call's tenor reach a year under fallback scope 'all-listed', and leaves puts alone", () => {
    const allListed = wheelConfig({
      ...c,
      call: { ...c.call, fallback: { ...c.call.fallback, scope: 'all-listed' } },
    });
    expect(ALL_LISTED_MAX_TENOR_DAYS).toBe(366);
    expect(executionConfig('call', allListed, asset).maxDaysToExpiry).toBe(366);
    expect(executionConfig('put', allListed, asset).maxDaysToExpiry).toBe(10);

    const longer = wheelConfig({ ...allListed, call: { ...allListed.call, maxDaysToExpiry: 400 } });
    expect(executionConfig('call', longer, asset).maxDaysToExpiry).toBe(400);
  });
});

describe('freshStateOf', () => {
  const c = wheelConfig();

  it('evaluates the gates without the running execution and sizes the tranche at the strike under the soft caps', () => {
    const s = freshSnapshot('live', { inFlight: true });
    const listing = tradedListing('put');
    const st = deriveState(s, c);
    // The snapshot alone holds on the execution that is running.
    expect(checkGates('put', st, s, c).hold).toBe('in-flight');

    const fresh = freshStateOf(instrument(listing), s, c, READS);

    const whype = hypeAsset(s.market.assets);
    const target = { underlyingSymbol: 'HYPE', asset: whype.address, isPut: true };
    const capacityE18 = remainingCapacityE18(s.market.caps, target, SPOT_E8, CAP_SOFT_MARGIN_BPS);
    expect(capacityE18).not.toBeNull();
    expect(capacityE18).not.toBe(remainingCapacityE18(s.market.caps, target, SPOT_E8));
    const trancheE18 = trancheQuantityE18('put', st, listing.strikeE8, s, c, capacityE18);
    expect(trancheE18).toBeGreaterThan(0n);
    expect(fresh).toEqual({
      gateHold: null,
      trancheQuantityE18: trancheE18,
      basisE8: st.basis.basisE8,
      basisReliable: st.basis.reliable,
      basisEligibleEmpty: false,
      freshFallbackStrikeE8: null,
      freeCollateral: st.capital.put.free,
      spotE8: SPOT_E8,
      listedStrikesE8ForExpiry: fixtureListings()
        .filter((l) => l.isPut && l.expirySec === listing.expirySec)
        .map((l) => l.strikeE8),
      expiriesSec: [
        ...new Set(
          fixtureListings()
            .filter((l) => l.isPut)
            .map((l) => l.expirySec),
        ),
      ],
      deploymentsLast24h: st.deploymentsLast24h,
      notionalLast24h6: st.notionalLast24h6,
      nativeHypeE18: s.chain.nativeHypeE18,
      allowance: 123n,
      fetchedAtMs: NOW_SEC * 1000 + 1500,
      listingsAtMs: INVENTORY_TS * 1000,
      capHeadroomE18: capacityE18,
    });
    expect(fresh.listedStrikesE8ForExpiry).toContain(listing.strikeE8);
  });

  it('reads STOP (live only) and the tripwire as they are now, not as the last tick saw them', () => {
    const target = instrument(tradedListing('put'));
    const stopped = { ...READS, stopFile: true };
    expect(freshStateOf(target, freshSnapshot('live'), c, stopped).gateHold).toBe('kill-switch');
    expect(freshStateOf(target, freshSnapshot('dry-run'), c, stopped).gateHold).toBeNull();
    expect(freshStateOf(target, freshSnapshot('live', { stopFile: true }), c, READS).gateHold).toBeNull();

    const changed = { ...READS, frontendChanged: true };
    expect(freshStateOf(target, freshSnapshot('dry-run'), c, changed).gateHold).toBe('frontend-changed');
  });

  it('gives a call the fresh basis, its eligibility and the fallback strike', () => {
    const s = freshSnapshot('dry-run');
    const target = instrument(tradedListing('call'));
    const st = deriveState(s, c);
    expect(st.basis.reliable).toBe(true);

    const fresh = freshStateOf(target, s, c, READS);
    expect(fresh).toMatchObject({
      gateHold: null,
      basisE8: st.basis.basisE8,
      basisReliable: true,
      basisEligibleEmpty: false,
      freshFallbackStrikeE8: fallbackStrike(s.market.listings, s.nowSec, c)?.listing.strikeE8,
      freeCollateral: st.capital.call.free,
    });
    expect(fresh.freshFallbackStrikeE8).not.toBeNull();
    expect(fresh.listedStrikesE8ForExpiry).toEqual(
      fixtureListings()
        .filter((l) => !l.isPut && l.expirySec === target.expirySec)
        .map((l) => l.strikeE8),
    );

    // A basis above every listed strike leaves nothing eligible: the fallback's condition.
    const highBasis = wheelConfig({
      basis: { ...c.basis, anchor: { ...ANCHOR, basisE8: 1_000_000n * 10n ** 8n } },
    });
    expect(freshStateOf(target, s, highBasis, READS).basisEligibleEmpty).toBe(true);
  });
});
