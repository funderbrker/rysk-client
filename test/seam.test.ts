import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { executionConfig, freshStateOf } from '../src/daemon/trade.ts';
import { aprFraction, collateral6For, minPriceE18ForApr } from '../src/domain/apr.ts';
import { hypeAsset } from '../src/domain/inventory.ts';
import type { ConfirmBody, Listing, Position, Quote, Side } from '../src/domain/types.ts';
import { ceilDiv, premium6 } from '../src/domain/units.ts';
import { buildConfirmBody } from '../src/execution/body.ts';
import { type CheckContext, runPreSignChecks } from '../src/execution/checks.ts';
import type { CheckResult, TradeIntent } from '../src/execution/types.ts';
import type { CallFallbackConfig, WheelConfig } from '../src/strategy/wheel/config.ts';
import {
  CUSTOM_STRIKE_PRECISION_E8,
  customFallbackStrikeE8,
  deriveState,
  evaluate,
  fallbackStrike,
  planSide,
} from '../src/strategy/wheel/index.ts';
import type { Candidate, QuoteOutcome, Snapshot } from '../src/strategy/wheel/types.ts';
import {
  ANCHOR,
  type ConfigPatch,
  fixtureAssets,
  fixtureCaps,
  fixtureListings,
  fixturePositions,
  NOW_SEC,
  snapshotFromFixtures,
  wheelConfig,
} from './helpers/wheelSnapshot.ts';

// The seam between the planner and the pre-sign checklist (spec §8.6, §7.2): every candidate `planSide` plans, given
// a quote that clears its floor, must pass `evaluate` and then every check `sellOption` runs on the same snapshot.

const capture = JSON.parse(
  readFileSync(new URL('./fixtures/spike-capture.json', import.meta.url), 'utf8'),
) as {
  gas: { full: { body: string } };
};
const DAY_SEC = 86_400;
const SPOT_E8 = 8148032044n;
/** The fixture's expiries 6.9 and 13.9 days out. */
const E1 = 1792742400;
const E2 = 1793347200;
const E30 = 10n ** 30n;
const GAS6 = 10_000n;
const MAKER: Address = '0x000000000000000000000000000000000000beef';
const SIGNATURE: Hex = `0x${'11'.repeat(65)}`;

type Mode = Snapshot['mode'];
type Scenario = {
  mode: Mode;
  spotE8?: bigint;
  /** In place of the fixture's listings. */
  listings?: Listing[];
  basisE8?: bigint;
  call?: { maxDaysToExpiry?: number; minStrikeOverBasisPct?: number; fallback?: Partial<CallFallbackConfig> };
  safety?: ConfigPatch['safety'];
};

/** The fixture rows with the open put deployed two days back, so the put's 24 h interval has passed. */
const POSITIONS: Position[] = fixturePositions().map((p) =>
  p.isPut && p.status === 'open' ? { ...p, createdAtSec: NOW_SEC - 2 * DAY_SEC } : p,
);
const MARKET = { assets: fixtureAssets(), listings: fixtureListings(), caps: fixtureCaps() };

/** The fixture wallet with every gate passing on both sides, the basis from the anchor. */
function tick(sc: Scenario): { s: Snapshot; c: WheelConfig } {
  const s = snapshotFromFixtures({
    mode: sc.mode,
    positions: POSITIONS,
    market: {
      ...MARKET,
      listings: sc.listings ?? MARKET.listings,
      spotE8: sc.spotE8 ?? SPOT_E8,
      inventoryTs: NOW_SEC,
    },
    memo: { lastNoPendingSeenSec: NOW_SEC - 3600 },
  });
  const base = wheelConfig();
  const c = wheelConfig({
    mode: sc.mode,
    basis: { ...base.basis, anchor: { ...ANCHOR, basisE8: sc.basisE8 ?? ANCHOR.basisE8 } },
    call: {
      ...(sc.call?.maxDaysToExpiry === undefined ? {} : { maxDaysToExpiry: sc.call.maxDaysToExpiry }),
      minStrikeOverBasisPct: sc.call?.minStrikeOverBasisPct ?? 0,
      fallback: { ...base.call.fallback, ...sc.call?.fallback },
    },
    ...(sc.safety === undefined ? {} : { safety: sc.safety }),
  });
  return { s, c };
}

/** A price 1.5 times the least that clears the candidate's floor (C8): the net floor, and the APR floor if normal. */
function priceFor(k: Candidate, s: Snapshot, c: WheelConfig): bigint {
  const { minNetPremium6 } = c.safety;
  const fallback6 = c.call.fallback.minNetPremium6;
  const net6 = k.mode === 'normal' || minNetPremium6 >= fallback6 ? minNetPremium6 : fallback6;
  let floorE18 = ceilDiv((net6 + GAS6) * E30, k.quantityE18);
  if (k.mode === 'normal') {
    const collateral6 = collateral6For(k.side, k.quantityE18, k.strikeE8, s.market.spotE8);
    const aprE18 = minPriceE18ForApr(
      c[k.side].minApr,
      collateral6,
      k.quantityE18,
      s.nowSec,
      k.expirySec,
      GAS6,
    );
    if (aprE18 > floorE18) floorE18 = aprE18;
  }
  return (floorE18 * 3n) / 2n;
}

/** The maker's quote for the candidate's request, its `apy` our gross APR (C7). */
function quoteFor(k: Candidate, s: Snapshot, c: WheelConfig): QuoteOutcome {
  const priceE18 = priceFor(k, s, c);
  const collateral6 = collateral6For(k.side, k.quantityE18, k.strikeE8, s.market.spotE8);
  const apr = aprFraction(premium6(k.quantityE18, priceE18), collateral6, s.nowSec, k.expirySec);
  const quote: Quote = {
    assetAddress: k.request.asset,
    chainId: k.request.chainId,
    expiry: k.request.expiry,
    isPut: k.request.isPut,
    isTakerBuy: false,
    quantity: k.request.quantity,
    strike: k.request.strike,
    maker: MAKER,
    nonce: '4242',
    price: priceE18.toString(),
    validUntil: s.nowSec + 60,
    signature: SIGNATURE,
    usd: k.request.usd,
    collateralAsset: k.request.collateralAsset,
    apy: apr * 100,
  };
  const at = s.localNowMs;
  return {
    ok: true,
    quote,
    requestedAtMs: at,
    respondedAtMs: at + 250,
    makerSigOk: true,
    gas: { ok: true, gasFee6: GAS6 },
  };
}

/** The spike's `/api/gas` echo carrying `body`'s fields: the server echoes what it is sent. */
function echoOf(body: ConfirmBody): Record<string, unknown> {
  return { ...(JSON.parse(capture.gas.full.body) as Record<string, unknown>), ...body };
}

/**
 * The checklist as `sellOption` runs it on `k`: evaluate's decision as the intent, a fresh state from `freshStateOf`
 * on the same snapshot (taken mid-execution), our body, and the GAS step's fee. Live reads the exact allowance with
 * the lock held and the configured account signing.
 */
function checklist(
  k: Candidate,
  s: Snapshot,
  c: WheelConfig,
): { decision: string; results: CheckResult[]; ok: boolean } {
  const st = deriveState(s, c);
  const decision = evaluate(k.side, [{ candidate: k, outcome: quoteFor(k, s, c) }], st, s, c);
  if (decision.kind !== 'trade') return { decision: `hold ${decision.reason}`, results: [], ok: false };
  const intent: TradeIntent = {
    side: k.side,
    candidate: decision.candidate,
    quote: decision.quote,
    minPriceE18: decision.minPriceE18,
    maxGasFee6: decision.maxGasFee6,
  };
  const taken: Snapshot = { ...s, memo: { ...s.memo, inFlight: true } };
  const reads = { allowance: k.collateralAmount, stopFile: false, frontendChanged: false };
  const fresh = freshStateOf({ side: k.side, strikeE8: k.strikeE8, expirySec: k.expirySec }, taken, c, reads);
  const nowMs = s.localNowMs + 2000;
  const body = buildConfirmBody({
    quote: decision.quote,
    taker: c.self,
    collateralAmount: k.collateralAmount,
    nonceMs: nowMs,
  });
  const live = s.mode === 'live';
  const ctx: CheckContext = {
    mode: s.mode,
    intent,
    freshQuote: decision.quote,
    body,
    echoed: echoOf(body),
    gasFee6: decision.gasFee6,
    fresh,
    config: executionConfig(k.side, c, hypeAsset(s.market.assets)),
    serverNowSec: s.nowSec,
    nowMs,
    signerAddress: live ? c.self : null,
    usedQuoteNonces: new Set(),
    lastNonceMs: nowMs - 60_000,
    stopFile: false,
    lockHeld: live,
    inFlightExcludingSelf: false,
    recoveredMaker: MAKER,
  };
  const result = runPreSignChecks(ctx);
  return { decision: 'trade', results: result.results, ok: result.ok };
}

/**
 * Dry-run call scenarios: spot 81.48 (every listed call inside 1.4 S) and 75 (105 and 110 above it); bases below,
 * between and above the listed strikes; windows of 16, 7 (the first expiry only) and 5 days (no expiry); both
 * scopes, with and without the custom strike, with and without a strike-over-basis margin.
 */
function callScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];
  const bases = [5000000000n, 8600000000n, 8850000000n, 9000000000n, 10000000000n, 12000000000n];
  for (const spotE8 of [SPOT_E8, 7500000000n]) {
    for (const basisE8 of bases) {
      for (const maxDaysToExpiry of [16, 7, 5]) {
        for (const scope of ['window', 'all-listed'] as const) {
          for (const customStrikeFirst of [false, true]) {
            for (const minStrikeOverBasisPct of [0, 0.01]) {
              const fallback = { scope, customStrikeFirst };
              const call = { maxDaysToExpiry, minStrikeOverBasisPct, fallback };
              scenarios.push({ mode: 'dry-run', spotE8, basisE8, call });
            }
          }
        }
      }
    }
  }
  return scenarios;
}

function label(side: Side, k: Candidate, sc: Scenario): string {
  return `${JSON.stringify(sc, (_, v) => (typeof v === 'bigint' ? v.toString() : v))} ${side} ${k.mode} ${k.strikeE8}@${k.expirySec}`;
}

/** Every planned candidate of `sides` in `sc` with its checklist outcome; the failures as readable lines. */
function seam(sc: Scenario, sides: Side[] = ['put', 'call']) {
  const { s, c } = tick(sc);
  const st = deriveState(s, c);
  const checked: { side: Side; k: Candidate; results: CheckResult[] }[] = [];
  const failures: string[] = [];
  for (const side of sides) {
    const plan = planSide(side, st, s, c);
    if (plan.kind !== 'quote') continue;
    for (const k of plan.candidates) {
      const out = checklist(k, s, c);
      checked.push({ side, k, results: out.results });
      if (!out.ok) {
        const failed = out.results.find((r) => !r.pass);
        failures.push(`${label(side, k, sc)}: ${out.decision} ${failed?.id ?? ''} ${failed?.detail ?? ''}`);
      }
    }
  }
  return { s, c, checked, failures };
}

describe('seam: planSide → evaluate → freshStateOf → runPreSignChecks', () => {
  it.each<Mode>(['dry-run', 'live'])(
    'passes every check for every candidate both sides plan (%s)',
    (mode) => {
      const { checked, failures } = seam({ mode });
      expect(failures).toEqual([]);
      expect(checked.filter((x) => x.side === 'put').length).toBeGreaterThan(0);
      expect(checked.filter((x) => x.side === 'call').length).toBeGreaterThan(0);
      expect(checked.every((x) => x.k.mode === 'normal')).toBe(true);
    },
  );

  it('passes K* (C18 included) in a forced fallback, and plans the custom strike only above K*', () => {
    // A 120 basis is above every listed call strike.
    const sc: Scenario = {
      mode: 'dry-run',
      basisE8: 12000000000n,
      call: { fallback: { customStrikeFirst: true } },
    };
    const { s, c, checked, failures } = seam(sc, ['call']);
    expect(failures).toEqual([]);
    const kStar = fallbackStrike(s.market.listings, s.nowSec, c)?.listing.strikeE8;
    expect(checked.map((x) => [x.k.mode, x.k.strikeE8])).toEqual([
      ['basis-fallback-custom', 11400000000n],
      ['basis-fallback', kStar],
    ]);
    const k = checked.find((x) => x.k.mode === 'basis-fallback');
    expect(k?.results.find((r) => r.id === 'C18')).toEqual({ id: 'C18', pass: true });
  });

  it('agrees across bases, windows, scopes, the custom strike and spots', () => {
    const failures: string[] = [];
    const modes = new Set<string>();
    let customs = 0;
    for (const sc of callScenarios()) {
      const run = seam(sc, ['call']);
      failures.push(...run.failures);
      const kStar = fallbackStrike(run.s.market.listings, run.s.nowSec, run.c)?.listing.strikeE8;
      for (const { k } of run.checked) {
        modes.add(k.mode);
        if (k.mode !== 'basis-fallback-custom') continue;
        customs += 1;
        // Never a custom strike at or below the highest listed one.
        if (kStar === undefined || !(k.strikeE8 > kStar))
          failures.push(`${label('call', k, sc)}: custom ≤ K*`);
      }
    }
    expect(failures).toEqual([]);
    expect([...modes].sort()).toEqual(['basis-fallback', 'basis-fallback-custom', 'normal']);
    expect(customs).toBeGreaterThan(0);
  });

  it('holds the call side and plans no fallback when the tenor window holds no expiry', () => {
    // 36 h to 5 d: the first expiry is 6.9 days out. Below-basis K* (88.5) must never be sold from an empty window.
    for (const basisE8 of [9000000000n, 10000000000n, 12000000000n]) {
      for (const customStrikeFirst of [false, true]) {
        const sc: Scenario = {
          mode: 'dry-run',
          basisE8,
          call: { maxDaysToExpiry: 5, fallback: { customStrikeFirst } },
        };
        const { s, c } = tick(sc);
        expect(planSide('call', deriveState(s, c), s, c)).toMatchObject({
          kind: 'hold',
          reason: 'no-candidates',
        });
        expect(seam(sc, ['call']).checked).toEqual([]);
      }
    }
  });

  it('passes a custom strike rounded down at a low spot through C10 and C18', () => {
    // Spot 41: 1.393 × 41 = 57.11 rounds up to 57.5, above 1.4 × 41 = 57.4, so the custom strike rounds down to 57.
    // Calls at 42–45 a week out and 46 two weeks out; every one is below the 100 basis.
    const spotE8 = 4100000000n;
    const template = MARKET.listings.find(
      (l) => !l.isPut && l.strikeE8 === 8450000000n && l.expirySec === E1,
    );
    if (template === undefined) throw new Error('no fixture call 84.5 at E1');
    const calls = [4200000000n, 4300000000n, 4400000000n, 4500000000n].map((strikeE8) => ({
      ...template,
      strikeE8,
    }));
    const listings = [
      ...MARKET.listings.filter((l) => l.isPut),
      ...calls,
      { ...template, strikeE8: 4600000000n, expirySec: E2 },
    ];
    const roundedUpE8 =
      ceilDiv((spotE8 * 1393n) / 1000n, CUSTOM_STRIKE_PRECISION_E8) * CUSTOM_STRIKE_PRECISION_E8;
    expect(roundedUpE8 * 10n > spotE8 * 14n).toBe(true);
    expect(customFallbackStrikeE8(10000000000n, spotE8, CUSTOM_STRIKE_PRECISION_E8)).toBe(5700000000n);

    const sc: Scenario = {
      mode: 'dry-run',
      spotE8,
      listings,
      basisE8: 10000000000n,
      call: { fallback: { customStrikeFirst: true } },
    };
    const { checked, failures } = seam(sc, ['call']);
    expect(failures).toEqual([]);
    expect(checked.map((x) => [x.k.mode, x.k.strikeE8])).toEqual([
      ['basis-fallback-custom', 5700000000n],
      ['basis-fallback', 4500000000n],
    ]);
    const custom = checked[0]?.results ?? [];
    for (const id of ['C10', 'C18'])
      expect(custom.find((r) => r.id === id)).toMatchObject({ id, pass: true });
  });

  it("keeps live plans inside C16's 24 h notional limit", () => {
    // 2 000 USD a day: puts at 80 and above, and every call lot at spot, would reach it.
    const sc: Scenario = { mode: 'live', safety: { maxNotionalPer24h6: 2000_000000n } };
    const { s, c, checked, failures } = seam(sc);
    expect(failures).toEqual([]);
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.every((x) => x.side === 'put' && x.k.strikeE8 < 8000000000n)).toBe(true);
    expect(planSide('call', deriveState(s, c), s, c)).toMatchObject({ kind: 'hold', reason: 'daily-limit' });
  });
});
