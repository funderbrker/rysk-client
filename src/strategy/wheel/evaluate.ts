import { aprFraction, aprFractionFromRyskApy, collateral6For, minPriceE18ForApr } from '../../domain/apr.ts';
import { uintOf } from '../../domain/parse.ts';
import type { Quote, Side } from '../../domain/types.ts';
import { ceilDiv, premium6, UnitError } from '../../domain/units.ts';
import type { WheelConfig } from './config.ts';
import type { Candidate, Decision, QuotedCandidate, Snapshot, WheelState } from './types.ts';

type Trade = Extract<Decision, { kind: 'trade' }>;
type Mode = Candidate['mode'];

/** A quote within the gas limits, priced at the tick: what `evaluate` ranks and floors. */
type Priced = {
  candidate: Candidate;
  quote: Quote;
  gasFee6: bigint;
  /** The gross premium, USD 6 dp. */
  premium6: bigint;
  /** `premium6 − gasFee6`, USD 6 dp. */
  net6: bigint;
  collateral6: bigint;
  aprNet: number;
  respondedAtMs: number;
};

/** The modes that skip the APR floor (spec §8.6); an unknown mode is held to it. */
const IS_FALLBACK: Record<Mode, boolean> = {
  normal: false,
  'basis-fallback': true,
  'basis-fallback-custom': true,
};
/**
 * Ranked before the net APR. A plan holds either normal or fallback candidates, never both, so in practice this
 * only puts a qualifying custom strike ahead of K* (spec §8.6: the custom strike is taken when its net premium
 * clears the floor); normal first keeps the order total and would prefer a strike above the basis.
 */
const MODE_RANK: Record<Mode, number> = { normal: 0, 'basis-fallback-custom': 1, 'basis-fallback': 2 };
const SIDE_ORDER: Record<Side, number> = { put: 0, call: 1 };
const BPS = 10_000n;
const E20 = 10n ** 20n;
/** `premium6` divides `quantityE18 × priceE18` by this. */
const E30 = 10n ** 30n;
const USD6 = 1e6;

/**
 * The decision for one side's quotes (spec §8.7), agreeing with pre-sign checks C5, C8 and C9.
 *
 * Under `safety.verifyMakerSig: 'enforce'` a quote whose maker signature did not verify (`makerSigOk` false or
 * `null`) is dropped as if it never came back. Each other answered quote with a gas preview is priced:
 * `net6 = premium6(quantityE18, price) − gasFee6` and `aprNet = aprFraction(net6, collateral6For(…), nowSec,
 * expirySec)`, unless its fee breaks a C9 limit (negative, above `maxGasFee6`, or `gasFee6 × 10 000 >
 * premium6 × maxGasFeeBps`). A priced quote qualifies with `net6 ≥` its net floor (`safety.minNetPremium6`; for a
 * fallback the larger of that and `call.fallback.minNetPremium6`) and, for a normal candidate only, `aprNet ≥
 * c[side].minApr`.
 *
 * The trade is the first qualifying quote by: mode (`MODE_RANK`: a custom fallback strike before K*), higher
 * `aprNet`, shorter tenor, lower `|delta|` (a custom strike's `null` delta last), earlier `respondedAtMs`, then
 * position in `qs`. It carries `minPriceE18`, the lowest price at which this quote's terms and `gasFee6` still pass
 * C8 and C9 (`minPriceE18For`), and for a fallback `lossIfExercisedUsd` when the basis is known.
 *
 * With no answered quote it holds `no-quotes`; when no answered quote could be priced (gas preview failed or a gas
 * limit broken), `gas`; otherwise `apr-floor` with the first priced quote by the same order. Pure; throws for a
 * candidate of the other side, and `UnitError` for a price that is not a uint string or a candidate with no tenor
 * or collateral left at `s.nowSec`.
 */
export function evaluate(
  side: Side,
  qs: QuotedCandidate[],
  st: WheelState,
  s: Snapshot,
  c: WheelConfig,
): Decision {
  let answered = false;
  const priced: Priced[] = [];
  for (const { candidate, outcome } of qs) {
    if (candidate.side !== side) {
      throw new Error(`a ${candidate.side} candidate in the ${side} side's quotes`);
    }
    if (!outcome.ok) continue;
    // C5 fails an unverified maker signature under 'enforce'; `null` (not recovered) counts as unverified.
    if (c.safety.verifyMakerSig === 'enforce' && outcome.makerSigOk !== true) continue;
    answered = true;
    if (!outcome.gas.ok) continue;
    const p = price(candidate, outcome.quote, outcome.gas.gasFee6, outcome.respondedAtMs, s);
    if (withinGasLimits(p, c)) priced.push(p);
  }
  if (!answered) return { kind: 'hold', side, reason: 'no-quotes' };

  const chosen = first(priced.filter((p) => qualifies(p, c)));
  if (chosen !== undefined) return trade(chosen, st, s, c);
  const seen = first(priced);
  if (seen === undefined) return { kind: 'hold', side, reason: 'gas' };
  return {
    kind: 'hold',
    side,
    reason: 'apr-floor',
    best: { candidate: seen.candidate, aprNet: seen.aprNet },
  };
}

/**
 * The trade to execute this tick (spec §8.7): the one with the larger `aprNet − c[side].minApr`, the put on a tie
 * (then the earlier one); `null` when no decision trades. A fallback's margin may be negative.
 */
export function pickSide(decisions: Decision[], c: WheelConfig): Decision | null {
  let picked: Trade | null = null;
  for (const d of decisions) {
    if (d.kind === 'trade' && (picked === null || outranks(d, picked, c))) picked = d;
  }
  return picked;
}

/** A larger margin over the side's APR floor, or an equal one on the put side. */
function outranks(a: Trade, b: Trade, c: WheelConfig): boolean {
  const lead = margin(a, c) - margin(b, c);
  return lead > 0 || (lead === 0 && SIDE_ORDER[a.candidate.side] < SIDE_ORDER[b.candidate.side]);
}

function margin(d: Trade, c: WheelConfig): number {
  return d.aprNet - c[d.candidate.side].minApr;
}

function price(
  candidate: Candidate,
  quote: Quote,
  gasFee6: bigint,
  respondedAtMs: number,
  s: Snapshot,
): Priced {
  const priceE18 = uintOf(quote.price);
  if (priceE18 === undefined) throw new UnitError(`quote price '${quote.price}' is not a uint string`);
  const { side, quantityE18, strikeE8, expirySec } = candidate;
  const gross6 = premium6(quantityE18, priceE18);
  const net6 = gross6 - gasFee6;
  const collateral6 = collateral6For(side, quantityE18, strikeE8, s.market.spotE8);
  const aprNet = aprFraction(net6, collateral6, s.nowSec, expirySec);
  return { candidate, quote, gasFee6, premium6: gross6, net6, collateral6, aprNet, respondedAtMs };
}

/** C9's fee limits: not negative, at most `maxGasFee6`, and at most `maxGasFeeBps` of the gross premium. */
function withinGasLimits(p: Priced, c: WheelConfig): boolean {
  const { maxGasFee6, maxGasFeeBps } = c.safety;
  return p.gasFee6 >= 0n && p.gasFee6 <= maxGasFee6 && p.gasFee6 * BPS <= p.premium6 * BigInt(maxGasFeeBps);
}

function qualifies(p: Priced, c: WheelConfig): boolean {
  const { side, mode } = p.candidate;
  if (p.net6 < netFloor6(mode, c)) return false;
  return isFallback(mode) || p.aprNet >= c[side].minApr;
}

function isFallback(mode: Mode): boolean {
  return IS_FALLBACK[mode] === true;
}

/** C8's net premium floor: `safety.minNetPremium6`, and for a fallback also `call.fallback.minNetPremium6`. */
function netFloor6(mode: Mode, c: WheelConfig): bigint {
  const safety6 = c.safety.minNetPremium6;
  if (!isFallback(mode)) return safety6;
  const fallback6 = c.call.fallback.minNetPremium6;
  return fallback6 > safety6 ? fallback6 : safety6;
}

/** The first of the best by `compare`, or `undefined` for none. */
function first(priced: Priced[]): Priced | undefined {
  let top: Priced | undefined;
  for (const p of priced) {
    if (top === undefined || compare(p, top) < 0) top = p;
  }
  return top;
}

/** Negative when `a` ranks first: mode, higher `aprNet`, shorter tenor, lower `|delta|`, earlier response. */
function compare(a: Priced, b: Priced): number {
  return (
    MODE_RANK[a.candidate.mode] - MODE_RANK[b.candidate.mode] ||
    b.aprNet - a.aprNet ||
    a.candidate.expirySec - b.candidate.expirySec ||
    compareDelta(a.candidate.delta, b.candidate.delta) ||
    a.respondedAtMs - b.respondedAtMs
  );
}

/** Lower `|delta|` first; a `null` delta (a custom strike) after any number, and two `null`s are equal. */
function compareDelta(a: number | null, b: number | null): number {
  if (a === null || b === null) {
    if (a === b) return 0;
    return a === null ? 1 : -1;
  }
  return Math.abs(a) - Math.abs(b);
}

function trade(p: Priced, st: WheelState, s: Snapshot, c: WheelConfig): Trade {
  const { candidate, quote, gasFee6, aprNet } = p;
  const { basisE8 } = st.basis;
  const loss =
    isFallback(candidate.mode) && basisE8 !== null
      ? { lossIfExercisedUsd: lossIfExercisedUsd(basisE8, p) }
      : {};
  return {
    kind: 'trade',
    candidate,
    quote,
    gasFee6,
    aprNet,
    aprRysk: aprFractionFromRyskApy(quote.apy),
    minPriceE18: minPriceE18For(p, s, c),
    maxGasFee6: c.safety.maxGasFee6,
    ...loss,
  };
}

/**
 * The re-quote's price floor: the lowest price at which this quote, with this `gasFee6`, still passes C8 and C9 —
 * the largest of the net-floor price, the C9 bps-guard price and, for a normal candidate, the APR-floor price
 * (`minPriceE18ForApr`). Each is rounded up, so a price at the floor passes and one below it fails.
 */
function minPriceE18For(p: Priced, s: Snapshot, c: WheelConfig): bigint {
  const { mode, side, quantityE18, expirySec } = p.candidate;
  const floors = [
    priceForPremiumE18(netFloor6(mode, c) + p.gasFee6, quantityE18),
    priceForPremiumE18(minPremiumForGas6(p.gasFee6, c.safety.maxGasFeeBps), quantityE18),
  ];
  if (!isFallback(mode)) {
    floors.push(
      minPriceE18ForApr(c[side].minApr, p.collateral6, quantityE18, s.nowSec, expirySec, p.gasFee6),
    );
  }
  return floors.reduce((max, floor) => (floor > max ? floor : max));
}

/** The lowest price whose `premium6` on `quantityE18` is at least `target6`: the exact inverse of its floor. */
function priceForPremiumE18(target6: bigint, quantityE18: bigint): bigint {
  return ceilDiv(target6 * E30, quantityE18);
}

/** The least gross premium with `gasFee6 × 10 000 ≤ premium6 × maxGasFeeBps` (C9); 0 for no fee. */
function minPremiumForGas6(gasFee6: bigint, maxGasFeeBps: number): bigint {
  return gasFee6 === 0n ? 0n : ceilDiv(gasFee6 * BPS, BigInt(maxGasFeeBps));
}

/**
 * Informational only, never used for a decision: the USD lost against the basis if a fallback call is exercised,
 * `max(0, (basis − strike) × quantity − net premium)`, computed in 6 dp and converted to a number at the end.
 */
function lossIfExercisedUsd(basisE8: bigint, p: Priced): number {
  const { strikeE8, quantityE18 } = p.candidate;
  const loss6 = ((basisE8 - strikeE8) * quantityE18) / E20 - p.net6;
  return loss6 > 0n ? Number(loss6) / USD6 : 0;
}
