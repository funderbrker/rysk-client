import type { Side } from './types.ts';
import { fractionFromPct, UnitError } from './units.ts';

/** A 365.25-day year, which is what Rysk annualises over. */
export const SECONDS_PER_YEAR = 31_557_600n;

const E9 = 10n ** 9n;
const E20 = 10n ** 20n;
const E30 = 10n ** 30n;

/** USD value (6 dp) of the collateral behind `qE18` options: a put locks q × strike, a call q underlying at spot. */
export function collateral6For(side: Side, qE18: bigint, strikeE8: bigint, spotE8: bigint): bigint {
  const priceE8 = side === 'put' ? strikeE8 : spotE8;
  return (qE18 * priceE8) / E20;
}

/**
 * Annualised return of `net6` on `collateral6` until expiry, as a fraction (0.6283 is 62.83 %), floored to 9
 * decimals; a negative net (gas above premium) stays negative.
 */
export function aprFraction(net6: bigint, collateral6: bigint, nowSec: number, expirySec: number): number {
  if (collateral6 <= 0n) throw new UnitError(`collateral ${collateral6} must be positive`);
  const aprE9 = floorDiv(net6 * SECONDS_PER_YEAR * E9, collateral6 * tenorSec(nowSec, expirySec));
  return Number(aprE9) / 1e9;
}

/**
 * Lowest price whose premium, less `gasFee6`, reaches `aprFloor` by `aprFraction`. The needed net premium and the
 * price are both rounded up, so `aprFraction(premium6(qE18, price) − gasFee6, …) >= aprFloor` always holds.
 */
export function minPriceE18ForApr(
  aprFloor: number,
  collateral6: bigint,
  qE18: bigint,
  nowSec: number,
  expirySec: number,
  gasFee6: bigint,
): bigint {
  if (!Number.isFinite(aprFloor) || aprFloor < 0) throw new UnitError(`invalid APR floor ${aprFloor}`);
  if (collateral6 <= 0n || qE18 <= 0n || gasFee6 < 0n) {
    throw new UnitError(`invalid collateral ${collateral6}, quantity ${qE18} or gas fee ${gasFee6}`);
  }
  const net6 = ceilDiv(
    aprFloorE9(aprFloor) * collateral6 * tenorSec(nowSec, expirySec),
    SECONDS_PER_YEAR * E9,
  );
  return ceilDiv((net6 + gasFee6) * E30, qE18);
}

/** Rysk quotes `apy` as a percentage (75.33). */
export function aprFractionFromRyskApy(apy: number): number {
  return fractionFromPct(apy);
}

function tenorSec(nowSec: number, expirySec: number): bigint {
  if (!Number.isSafeInteger(nowSec) || !Number.isSafeInteger(expirySec) || expirySec <= nowSec) {
    throw new UnitError(`expiry ${expirySec} is not after now ${nowSec}`);
  }
  return BigInt(expirySec - nowSec);
}

/** Smallest 9-decimal APR that `aprFraction` reports as `>= aprFloor`; corrects the float ceil by one if needed. */
function aprFloorE9(aprFloor: number): bigint {
  const floorE9 = BigInt(Math.ceil(aprFloor * 1e9));
  return Number(floorE9) / 1e9 < aprFloor ? floorE9 + 1n : floorE9;
}

/** Floor division for `b > 0` (bigint `/` truncates toward zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b < 0n ? q - 1n : q;
}

/** Ceiling division for `a >= 0`, `b > 0`. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
