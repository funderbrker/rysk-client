import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type ConfigPatch, snapshotFromFixtures, wheelConfig } from '../../../test/helpers/wheelSnapshot.ts';
import { aprFraction, minPriceE18ForApr } from '../../domain/apr.ts';
import { CHAIN_ID, TOKENS, TRADED_PRODUCTS } from '../../domain/constants.ts';
import type { Quote, Side } from '../../domain/types.ts';
import { premium6, UnitError } from '../../domain/units.ts';
import type { CallFallbackConfig } from './config.ts';
import { evaluate, pickSide } from './evaluate.ts';
import type { Candidate, Decision, QuotedCandidate, WheelState } from './types.ts';

type SpikeRequest = { reply: { result: Quote } };
const capture = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/spike-capture.json', import.meta.url), 'utf8'),
) as { requests: [SpikeRequest, SpikeRequest, ...SpikeRequest[]] };
const [putSpike, callSpike] = capture.requests;

const E18 = 10n ** 18n;
const Q_E18 = 25n * E18;
/** A quantity that does not divide 10^30, so the price floors' divisions are inexact. */
const Q75_E18 = 75n * E18;
/** The spike's quote time and its expiry 6.9 days out (595 890 s). */
const NOW_SEC = 1792146510;
const EXPIRY_SEC = 1792742400;
/** Twice the tenor: the same premium-to-tenor ratio gives exactly the same net APR. */
const LATER_EXPIRY_SEC = NOW_SEC + 2 * (EXPIRY_SEC - NOW_SEC);
const SPOT_E8 = 8148032044n;
const BASIS_E8 = 12000000000n;
const K78 = 7800000000n;
const K80 = 8000000000n;
/** The fallback call strike of the candidates tests (basis 120, spot 81.48), and the custom strike there. */
const K88_5 = 8850000000n;
const K114 = 11400000000n;
/** The spike put quote's price (net APR 0.7533 on 1 950 USDC). */
const P78 = 1109494507915005812n;
/** 37.5 USDC on 2 000 USDC over 6.9 days: net APR 0.993. */
const P80 = 1500000000000000000n;
/**
 * 1.9425 USD on 25 WHYPE (2 037 USD at spot) over 6.9 days: with a 0.02 USD gas fee (1 % of the premium, under
 * the 2 % guard) net 1.9225 USD, net APR 0.05.
 */
const P_FALLBACK = 77700000000000000n;
const FALLBACK_GAS6 = 20000n;
const SELF = wheelConfig().self;

type CandidateTerms = {
  side?: Side;
  strikeE8: bigint;
  expirySec?: number;
  quantityE18?: bigint;
  mode?: Candidate['mode'];
  delta?: number | null;
};

/** A candidate as `planSide` builds it (25 lots by default); `evaluate` reads none of the listing's fields. */
function candidate(terms: CandidateTerms): Candidate {
  const { side = 'put', strikeE8, expirySec = EXPIRY_SEC, quantityE18 = Q_E18, mode = 'normal' } = terms;
  const delta = terms.delta === undefined ? (side === 'put' ? -0.3 : 0.2) : terms.delta;
  const product = TRADED_PRODUCTS[side];
  return {
    side,
    listing: null,
    product,
    strikeE8,
    expirySec,
    quantityE18,
    collateralAmount: side === 'put' ? (quantityE18 * strikeE8) / 10n ** 20n : quantityE18,
    request: {
      asset: product.underlying,
      assetName: TOKENS.WHYPE.symbol,
      chainId: CHAIN_ID,
      expiry: expirySec,
      isPut: product.isPut,
      quantity: quantityE18.toString(),
      strike: strikeE8.toString(),
      taker: SELF,
      usd: product.strikeAsset,
      collateralAsset: product.collateralAsset,
      isEIP1271: false,
    },
    mode,
    rank: 1,
    indicativeApr: delta === null ? null : 0.5,
    delta,
  };
}

/** The spike quote of the candidate's side, re-priced at the candidate's terms. */
function quote(cand: Candidate, priceE18: bigint, apy = 75.33): Quote {
  const spike = cand.side === 'put' ? putSpike.reply.result : callSpike.reply.result;
  return {
    ...spike,
    strike: cand.strikeE8.toString(),
    expiry: cand.expirySec,
    quantity: cand.quantityE18.toString(),
    price: priceE18.toString(),
    apy,
  };
}

type Reply = {
  gasFee6?: bigint;
  gasFailed?: boolean;
  respondedAtMs?: number;
  apy?: number;
  price?: string;
  makerSigOk?: boolean | null;
};

function quoted(cand: Candidate, priceE18: bigint, reply: Reply = {}): QuotedCandidate {
  const { gasFee6 = 0n, gasFailed = false, respondedAtMs = NOW_SEC * 1000 + 500, makerSigOk = true } = reply;
  const q = quote(cand, priceE18, reply.apy);
  return {
    candidate: cand,
    outcome: {
      ok: true,
      quote: reply.price === undefined ? q : { ...q, price: reply.price },
      requestedAtMs: NOW_SEC * 1000,
      respondedAtMs,
      makerSigOk,
      gas: gasFailed ? { ok: false, reason: 'exceeds-premium' } : { ok: true, gasFee6 },
    },
  };
}

function unanswered(cand: Candidate, error: 'timeout' | 'mismatch' = 'timeout'): QuotedCandidate {
  return {
    candidate: cand,
    outcome: { ok: false, error, message: `quote ${error}`, requestedAtMs: NOW_SEC * 1000 },
  };
}

/** A consistent state; `evaluate` reads only the basis. */
function state(basisE8: bigint | null = BASIS_E8): WheelState {
  const capital = { free: 0n, locked: 0n, pending: 0n, total: 0n, budget: 0n };
  return {
    consistency: 'ok',
    rows: [],
    capital: { put: capital, call: capital },
    basis: { basisE8, qtyE18: 130n * E18, residualE18: 0n, reliable: true },
    lastDeployTs: {},
    deploymentsLast24h: 0,
    notionalLast24h6: 0n,
    anomalies: [],
    warnings: [],
  };
}

function run(side: Side, qs: QuotedCandidate[], config: ConfigPatch = {}, st = state()): Decision {
  const s = snapshotFromFixtures({ nowSec: NOW_SEC, market: { spotE8: SPOT_E8 } });
  return evaluate(side, qs, st, s, wheelConfig(config));
}

type Trade = Extract<Decision, { kind: 'trade' }>;

function traded(decision: Decision): Trade {
  if (decision.kind !== 'trade') throw new Error(`expected a trade, got hold '${decision.reason}'`);
  return decision;
}

function withFallback(patch: Partial<CallFallbackConfig>): ConfigPatch {
  return { call: { fallback: { ...wheelConfig().call.fallback, ...patch } } };
}

const put78 = candidate({ strikeE8: K78 });
const put80 = candidate({ strikeE8: K80 });
const fallbackCall = candidate({ side: 'call', strikeE8: K88_5, mode: 'basis-fallback', delta: 0.12 });
const customCall = candidate({ side: 'call', strikeE8: K114, mode: 'basis-fallback-custom', delta: null });
const HOLD_GAS = { kind: 'hold', side: 'put', reason: 'gas' } as const;

describe('evaluate', () => {
  it('trades the put with the higher net APR and floors its price at the APR floor', () => {
    const qs = [quoted(put78, P78), quoted(put80, P80, { apy: 99.3 })];
    const d = traded(run('put', qs, { put: { minApr: 0.4 } }));

    expect(d.candidate).toBe(put80);
    expect(d.quote).toEqual(quote(put80, P80, 99.3));
    expect(d.gasFee6).toBe(0n);
    expect(Math.abs(d.aprNet - 1.0)).toBeLessThan(0.02);
    expect(d.aprRysk).toBeCloseTo(0.993, 10);
    expect(d.minPriceE18).toBeGreaterThan(0n);
    expect(d.minPriceE18).toBe(minPriceE18ForApr(0.4, 2000_000000n, Q_E18, NOW_SEC, EXPIRY_SEC, 0n));
    expect(d.minPriceE18).toBeLessThanOrEqual(P80);
    expect(d.maxGasFee6).toBe(500000n);
    expect(d.lossIfExercisedUsd).toBeUndefined();
  });

  it("nets the gas fee out of the APR and into the side's price floor", () => {
    const d = traded(run('put', [quoted(put80, P80, { gasFee6: 300000n })], { put: { minApr: 0.6 } }));

    expect(d.gasFee6).toBe(300000n);
    expect(d.aprNet).toBe(aprFraction(37_200000n, 2000_000000n, NOW_SEC, EXPIRY_SEC));
    expect(d.minPriceE18).toBe(minPriceE18ForApr(0.6, 2000_000000n, Q_E18, NOW_SEC, EXPIRY_SEC, 300000n));
  });

  it('floors a normal price at the net floor or the gas guard when either needs more than the APR floor', () => {
    // A 30 USD net floor needs 1.2 USD per option; the APR floor only 0.604.
    const net = traded(run('put', [quoted(put80, P80)], { safety: { minNetPremium6: 30_000000n } }));
    expect(net.minPriceE18).toBe(1200000000000000000n);
    // A 0.5 USD fee is 2 % of a 25 USD premium (1 USD per option); the APR floor needs 0.624 with that fee.
    const gas = traded(run('put', [quoted(put80, P80, { gasFee6: 500000n })]));
    expect(minPriceE18ForApr(0.4, 2000_000000n, Q_E18, NOW_SEC, EXPIRY_SEC, 500000n)).toBe(
      624243680000000000n,
    );
    expect(gas.minPriceE18).toBe(1000000000000000000n);
  });

  it('holds apr-floor with the best net APR seen when no quote clears the floor', () => {
    const d = run('put', [quoted(put78, P78), quoted(put80, P80)], { put: { minApr: 1.5 } });

    if (d.kind !== 'hold') throw new Error('expected a hold');
    expect(d).toMatchObject({ side: 'put', reason: 'apr-floor' });
    expect(d.best?.candidate).toBe(put80);
    expect(Math.abs((d.best?.aprNet ?? 0) - 1.0)).toBeLessThan(0.02);
  });

  it('qualifies a quote exactly at the APR floor or exactly at the net floor', () => {
    const apr80 = aprFraction(37_500000n, 2000_000000n, NOW_SEC, EXPIRY_SEC);
    expect(traded(run('put', [quoted(put80, P80)], { put: { minApr: apr80 } })).candidate).toBe(put80);
    const atNetFloor = { safety: { minNetPremium6: 37_500000n } };
    expect(traded(run('put', [quoted(put80, P80)], atNetFloor)).candidate).toBe(put80);
  });

  it('skips a quote whose gas preview failed', () => {
    const d = traded(run('put', [quoted(put78, P78), quoted(put80, P80, { gasFailed: true })]));

    expect(d.candidate).toBe(put78);
    expect(d.aprNet).toBeCloseTo(0.7533, 4);
  });

  it('skips a quote whose gas fee takes the whole premium (net below minNetPremium6)', () => {
    // Gas limits lifted so that only the net floor rejects it.
    const config = { safety: { maxGasFee6: 100_000000n, maxGasFeeBps: 10_000 } };
    const d = traded(run('put', [quoted(put78, P78), quoted(put80, P80, { gasFee6: 37_500000n })], config));

    expect(d.candidate).toBe(put78);
  });

  it('skips a normal quote whose net premium is below safety.minNetPremium6 even above the APR floor', () => {
    const d = run('put', [quoted(put78, P78), quoted(put80, P80)], {
      safety: { minNetPremium6: 40_000000n },
    });

    expect(d).toMatchObject({ kind: 'hold', reason: 'apr-floor', best: { candidate: put80 } });
  });

  describe('gas limits (C9) and maker signatures (C5)', () => {
    it('skips a fee above maxGasFee6, never counting it as the best seen', () => {
      const over = quoted(put80, P80, { gasFee6: 500001n });

      expect(traded(run('put', [quoted(put78, P78), over])).candidate).toBe(put78);
      expect(run('put', [over])).toEqual(HOLD_GAS);
      expect(traded(run('put', [quoted(put80, P80, { gasFee6: 500000n })])).candidate).toBe(put80);
      const held = run('put', [quoted(put78, P78), over], { put: { minApr: 1.5 } });
      expect(held).toMatchObject({ reason: 'apr-floor', best: { candidate: put78 } });
    });

    it('skips a fee above maxGasFeeBps of the premium', () => {
      // 1 % of the 37.5 USD premium is 0.375 USD.
      const config = { safety: { maxGasFeeBps: 100 } };

      expect(run('put', [quoted(put80, P80, { gasFee6: 375001n })], config)).toEqual(HOLD_GAS);
      expect(traded(run('put', [quoted(put80, P80, { gasFee6: 375000n })], config)).candidate).toBe(put80);
    });

    it('skips a negative fee', () => {
      const negative = quoted(put80, P80, { gasFee6: -1n });

      expect(run('put', [negative])).toEqual(HOLD_GAS);
      expect(traded(run('put', [quoted(put78, P78), negative])).candidate).toBe(put78);
    });

    it("drops quotes without a verified maker signature under 'enforce' only", () => {
      const enforce: ConfigPatch = { safety: { verifyMakerSig: 'enforce' } };
      const unverified = quoted(put80, P80, { makerSigOk: false });
      const unknown = quoted(put80, P80, { makerSigOk: null });

      expect(traded(run('put', [quoted(put78, P78), unverified], enforce)).candidate).toBe(put78);
      expect(run('put', [unverified, unknown], enforce)).toEqual({
        kind: 'hold',
        side: 'put',
        reason: 'no-quotes',
      });
      const held = run('put', [quoted(put78, P78), unverified], { ...enforce, put: { minApr: 1.5 } });
      expect(held).toMatchObject({ reason: 'apr-floor', best: { candidate: put78 } });
      expect(traded(run('put', [quoted(put78, P78), unverified])).candidate).toBe(put80);
      expect(traded(run('put', [unknown], { safety: { verifyMakerSig: 'warn' } })).candidate).toBe(put80);
    });
  });

  it('holds gas when every answered quote failed its gas preview', () => {
    const qs = [quoted(put78, P78, { gasFailed: true }), unanswered(put80)];
    expect(run('put', qs)).toEqual(HOLD_GAS);
  });

  it('holds no-quotes when no quote came back', () => {
    expect(run('put', [unanswered(put78), unanswered(put80, 'mismatch')])).toEqual({
      kind: 'hold',
      side: 'put',
      reason: 'no-quotes',
    });
    expect(run('call', [])).toEqual({ kind: 'hold', side: 'call', reason: 'no-quotes' });
  });

  describe('call fallback', () => {
    it.each([
      ['basis-fallback', 0.12],
      ['basis-fallback-custom', null],
    ] as const)('trades a %s call below the APR floor and records the loss if exercised', (mode, delta) => {
      const cand = candidate({ side: 'call', strikeE8: K88_5, mode, delta });
      const qs = [quoted(cand, P_FALLBACK, { gasFee6: FALLBACK_GAS6, apy: 5.2 })];
      const d = traded(run('call', qs, { call: { minApr: 0.4 } }));

      expect(d.candidate).toBe(cand);
      expect(d.aprNet).toBeCloseTo(0.05, 3);
      expect(d.aprNet).toBeLessThan(0.4);
      expect(d.aprRysk).toBeCloseTo(0.052, 10);
      // (120 − 88.5) × 25 = 787.5 USD below the basis, less the 1.9225 USD net premium.
      expect(d.lossIfExercisedUsd).toBe(785.5775);
      // The price where the net premium is exactly the 1 USD floor after the 0.02 USD fee.
      expect(d.minPriceE18).toBe(40800000000000000n);
      expect(premium6(Q_E18, d.minPriceE18) - FALLBACK_GAS6).toBe(1_000000n);
      expect(premium6(Q_E18, d.minPriceE18 - 1n) - FALLBACK_GAS6).toBeLessThan(1_000000n);
      expect(d.maxGasFee6).toBe(500000n);
    });

    it('floors a fallback by the larger of fallback.minNetPremium6 and safety.minNetPremium6', () => {
      // Net 1.9225 USD.
      const qs = [quoted(fallbackCall, P_FALLBACK, { gasFee6: FALLBACK_GAS6 })];
      const heldBySafety = run('call', qs, { safety: { minNetPremium6: 5_000000n } });
      const heldByFallback = run('call', qs, withFallback({ minNetPremium6: 2_000000n }));

      expect(heldBySafety).toMatchObject({
        kind: 'hold',
        reason: 'apr-floor',
        best: { candidate: fallbackCall },
      });
      expect(heldByFallback).toMatchObject({
        kind: 'hold',
        reason: 'apr-floor',
        best: { candidate: fallbackCall },
      });
      // The price floor uses the same floor: 1.5 USD plus the fee.
      const d = traded(run('call', qs, { safety: { minNetPremium6: 1_500000n } }));
      expect(d.minPriceE18).toBe(60800000000000000n);
    });

    it('takes a qualifying custom strike over K*, even at a lower net APR', () => {
      // 114 at 0.05 per option: net 1.23 USD (APR 0.032) against K*'s 1.9225 USD (APR 0.05).
      const custom = quoted(customCall, 50000000000000000n, { gasFee6: FALLBACK_GAS6 });
      const kStar = quoted(fallbackCall, P_FALLBACK, { gasFee6: FALLBACK_GAS6 });

      const d = traded(run('call', [kStar, custom]));
      expect(d.candidate).toBe(customCall);
      expect(d.aprNet).toBeLessThan(aprFraction(1_922500n, 2037_008011n, NOW_SEC, EXPIRY_SEC));
      // 114 at 0.04: net 0.98 USD, below the 1 USD floor, so K* trades.
      const low = quoted(customCall, 40000000000000000n, { gasFee6: FALLBACK_GAS6 });
      expect(traded(run('call', [low, kStar])).candidate).toBe(fallbackCall);
    });

    it('records no loss when the strike is above the basis, and none without a basis', () => {
      const qs = [quoted(fallbackCall, P_FALLBACK, { gasFee6: FALLBACK_GAS6 })];

      expect(traded(run('call', qs, {}, state(8000000000n))).lossIfExercisedUsd).toBe(0);
      expect(traded(run('call', qs, {}, state(null))).lossIfExercisedUsd).toBeUndefined();
    });
  });

  describe('price floors round up (75 options, inexact divisions)', () => {
    const call75 = candidate({ side: 'call', strikeE8: K88_5, quantityE18: Q75_E18, mode: 'basis-fallback' });

    it('at the net floor: the floor price nets the floor, one wei less does not', () => {
      // Gas guard lifted so the net floor (1 USD after a 0.075 USD fee) sets the price.
      const config = { safety: { maxGasFeeBps: 10_000 } };
      const d = traded(run('call', [quoted(call75, P_FALLBACK, { gasFee6: 75000n })], config));

      expect(d.minPriceE18).toBe(14333333333333334n);
      expect(premium6(Q75_E18, d.minPriceE18) - 75000n).toBeGreaterThanOrEqual(1_000000n);
      expect(premium6(Q75_E18, d.minPriceE18 - 1n) - 75000n).toBeLessThan(1_000000n);
    });

    it('at the gas guard: the floor price passes the bps guard, one wei less does not', () => {
      // 0.040001 USD at 3 % needs a 1.333367 USD premium, more than the 1.040001 USD the net floor needs.
      const gasFee6 = 40001n;
      const config = { safety: { maxGasFeeBps: 300 } };
      const d = traded(run('call', [quoted(call75, P_FALLBACK, { gasFee6 })], config));

      expect(d.minPriceE18).toBe(17778226666666667n);
      expect(gasFee6 * 10_000n).toBeLessThanOrEqual(premium6(Q75_E18, d.minPriceE18) * 300n);
      expect(gasFee6 * 10_000n).toBeGreaterThan(premium6(Q75_E18, d.minPriceE18 - 1n) * 300n);
    });
  });

  describe('ties on net APR', () => {
    it('prefer the shorter tenor', () => {
      const later = candidate({ strikeE8: K80, expirySec: LATER_EXPIRY_SEC });
      const qs = [quoted(later, 2n * P80), quoted(put80, P80)];
      const d = traded(run('put', qs));

      expect(aprFraction(75_000000n, 2000_000000n, NOW_SEC, LATER_EXPIRY_SEC)).toBe(d.aprNet);
      expect(d.candidate).toBe(put80);
    });

    it('then the lower |delta|, a null delta after any number and two nulls equal', () => {
      const wide = candidate({ strikeE8: K80, delta: -0.3 });
      const narrow = candidate({ strikeE8: K80, delta: -0.2 });
      const none = candidate({ strikeE8: K80, delta: null });
      const alsoNone = candidate({ strikeE8: K80, delta: null });

      expect(traded(run('put', [quoted(wide, P80), quoted(narrow, P80)])).candidate).toBe(narrow);
      expect(traded(run('put', [quoted(none, P80), quoted(wide, P80)])).candidate).toBe(wide);
      const nulls = [
        quoted(none, P80, { respondedAtMs: 2_000 }),
        quoted(alsoNone, P80, { respondedAtMs: 1_000 }),
      ];
      expect(traded(run('put', nulls)).candidate).toBe(alsoNone);
    });

    it('then the earlier response, then the order of the quotes', () => {
      const first = candidate({ strikeE8: K80 });
      const second = candidate({ strikeE8: K80 });

      const earlierSecond = [
        quoted(first, P80, { respondedAtMs: 2_000 }),
        quoted(second, P80, { respondedAtMs: 1_000 }),
      ];
      expect(traded(run('put', earlierSecond)).candidate).toBe(second);
      const sameTime = [
        quoted(first, P80, { respondedAtMs: 1_000 }),
        quoted(second, P80, { respondedAtMs: 1_000 }),
      ];
      expect(traded(run('put', sameTime)).candidate).toBe(first);
    });
  });

  it('throws for a candidate of the other side or a quote price that is not a uint string', () => {
    expect(() => run('call', [quoted(put80, P80)])).toThrow(/side/);
    expect(() => run('put', [quoted(put80, P80, { price: '1.5' })])).toThrow(UnitError);
  });
});

describe('pickSide', () => {
  function tradeOf(side: Side, aprNet: number): Trade {
    const cand = side === 'put' ? put80 : candidate({ side: 'call', strikeE8: 9000000000n });
    return {
      kind: 'trade',
      candidate: cand,
      quote: quote(cand, P80),
      gasFee6: 0n,
      aprNet,
      aprRysk: aprNet,
      minPriceE18: 1n,
      maxGasFee6: 500000n,
    };
  }
  const putTrade = (aprNet: number) => tradeOf('put', aprNet);
  const callTrade = (aprNet: number) => tradeOf('call', aprNet);
  const hold = (side: Side): Decision => ({ kind: 'hold', side, reason: 'apr-floor' });

  it('picks the side with the larger net APR over its floor', () => {
    const put = putTrade(0.9);
    expect(pickSide([put, callTrade(0.7)], wheelConfig())).toBe(put);
  });

  it('measures each side against its own floor', () => {
    const call = callTrade(0.7);
    const c = wheelConfig({ put: { minApr: 0.8 }, call: { minApr: 0.4 } });
    expect(pickSide([putTrade(0.9), call], c)).toBe(call);
  });

  it('breaks a tie toward the put and ignores holds', () => {
    const put = putTrade(0.7);
    expect(pickSide([hold('call'), callTrade(0.7), put], wheelConfig())).toBe(put);
  });

  it('returns null when no decision trades', () => {
    expect(pickSide([hold('put'), hold('call')], wheelConfig())).toBeNull();
    expect(pickSide([], wheelConfig())).toBeNull();
  });
});
