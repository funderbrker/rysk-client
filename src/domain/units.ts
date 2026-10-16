import { formatUnits, parseUnits } from 'viem';

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitError';
  }
}

const STRIKE_DECIMALS = 8;
const E10 = 10n ** 10n;
const E20 = 10n ** 20n;
const E30 = 10n ** 30n;
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;
const INTEGER = /^[0-9]+$/;

/** Parses an inventory combination key `"<strike>-<expirySec>"`, e.g. `"86.500000-1793952000"`. */
export function strikeE8FromKey(key: string): { strikeE8: bigint; expirySec: number } {
  const dash = key.lastIndexOf('-');
  const strike = key.slice(0, dash);
  const expiry = key.slice(dash + 1);
  if (dash < 0 || !DECIMAL.test(strike) || !INTEGER.test(expiry)) {
    throw new UnitError(`malformed combination key '${key}'`);
  }
  const strikeE8 = parseUnits(strike, STRIKE_DECIMALS);
  const expirySec = Number(expiry);
  if (strikeE8 <= 0n || expirySec <= 0 || !Number.isSafeInteger(expirySec)) {
    throw new UnitError(`malformed combination key '${key}'`);
  }
  return { strikeE8, expirySec };
}

/** Converts a number strike through its 8-decimal string, so no float multiply can drift. */
export function strikeE8FromNumber(strike: number): bigint {
  if (!Number.isFinite(strike)) throw new UnitError(`invalid strike ${strike}`);
  const strikeE8 = parseDecimal(strike.toFixed(STRIKE_DECIMALS), STRIKE_DECIMALS);
  if (strikeE8 <= 0n) throw new UnitError(`invalid strike ${strike}`);
  return strikeE8;
}

export function strikeE8ToE18(strikeE8: bigint): bigint {
  return strikeE8 * E10;
}

/** Throws unless the 18-decimal strike is exactly representable with 8 decimals. */
export function strikeE18ToE8(strikeE18: bigint): bigint {
  if (strikeE18 % E10 !== 0n) throw new UnitError(`strike ${strikeE18} (e18) has more than 8 decimals`);
  return strikeE18 / E10;
}

/** `7850000000n` → `"78.5"`. */
export function formatStrike(strikeE8: bigint): string {
  return formatUnits(strikeE8, STRIKE_DECIMALS);
}

/** `⌈a / b⌉` for `a ≥ 0`, `b > 0` (bigint `/` truncates). */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (a < 0n || b <= 0n) throw new UnitError(`cannot ceil-divide ${a} by ${b}`);
  return (a + b - 1n) / b;
}

/** Largest multiple of `stepE18` not above `qE18`; never rounds up (10 against a step of 25 gives 0). */
export function floorToIncrement(qE18: bigint, stepE18: bigint): bigint {
  if (stepE18 <= 0n || qE18 < 0n) throw new UnitError(`cannot floor ${qE18} to step ${stepE18}`);
  return (qE18 / stepE18) * stepE18;
}

/** A call locks one underlying per option, in the collateral token's own decimals. */
export function collateralForCall(qE18: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new UnitError(`unsupported token decimals ${decimals}`);
  }
  return qE18 / 10n ** BigInt(18 - decimals);
}

/** A put locks quantity × strike in 6-decimal stables. */
export function collateralForPut(qE18: bigint, strikeE8: bigint): bigint {
  return (qE18 * strikeE8) / E20;
}

/** The put quantity (18 dp) that `usd6` of stable collateral backs at `strikeE8`. */
export function putQuantityFromUsd(usd6: bigint, strikeE8: bigint): bigint {
  if (strikeE8 <= 0n) throw new UnitError(`invalid strike ${strikeE8} (e8)`);
  return (usd6 * E20) / strikeE8;
}

/** Premium in 6-decimal USD, floored; equals the API's `premium`. */
export function premium6(qE18: bigint, priceE18: bigint): bigint {
  return (qE18 * priceE18) / E30;
}

export function usd6FromDecimal(s: string): bigint {
  return parseDecimal(s, 6);
}

export function e18FromDecimal(s: string): bigint {
  return parseDecimal(s, 18);
}

/** A USD price in strike units, 8 dp (`'50'` → `5_000_000_000n`), such as a HYPE basis. */
export function usdE8FromDecimal(s: string): bigint {
  return parseDecimal(s, STRIKE_DECIMALS);
}

/** `40` → `0.4`. */
export function fractionFromPct(n: number): number {
  return n / 100;
}

/**
 * A fraction from 0 to 1 in whole basis points (`0.25` → `2500n`), rounded once so that bigint amounts are
 * scaled by `× bps / 10_000n` rather than through a float.
 */
export function fractionToBps(fraction: number): bigint {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new UnitError(`invalid fraction ${fraction}`);
  }
  return BigInt(Math.round(fraction * 10_000));
}

function parseDecimal(value: string, decimals: number): bigint {
  try {
    return parseUnits(value, decimals);
  } catch {
    throw new UnitError(`'${value}' is not a decimal number`);
  }
}
