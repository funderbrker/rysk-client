import { describe, expect, it } from 'vitest';
import {
  ceilDiv,
  collateralForCall,
  collateralForPut,
  e18FromDecimal,
  floorToIncrement,
  formatStrike,
  fractionFromPct,
  fractionToBps,
  premium6,
  putQuantityFromUsd,
  strikeE8FromKey,
  strikeE8FromNumber,
  strikeE8ToE18,
  strikeE18ToE8,
  UnitError,
  usd6FromDecimal,
} from './units.ts';

const E18 = 10n ** 18n;

describe('strikeE8FromKey', () => {
  it('parses an inventory combination key by string arithmetic', () => {
    expect(strikeE8FromKey('86.500000-1793952000')).toEqual({ strikeE8: 8650000000n, expirySec: 1793952000 });
    expect(strikeE8FromKey('0.004600-1792742400').strikeE8).toBe(460000n);
  });

  it('throws UnitError for a malformed key', () => {
    for (const key of [
      '',
      '86.5',
      '-1793952000',
      '86.5-',
      'abc-1793952000',
      '86.5-17939x2000',
      '0.000000-1',
    ]) {
      expect(() => strikeE8FromKey(key), key).toThrow(UnitError);
    }
  });
});

describe('strike conversions', () => {
  it('converts a number strike through its fixed-point string', () => {
    expect(strikeE8FromNumber(78.5)).toBe(7850000000n);
    expect(strikeE8FromNumber(0.0046)).toBe(460000n);
  });

  it('scales between 8 and 18 decimals', () => {
    expect(strikeE8ToE18(7850000000n)).toBe(78500000000000000000n);
    expect(strikeE18ToE8(78500000000000000000n)).toBe(7850000000n);
    expect(() => strikeE18ToE8(1n)).toThrow(UnitError);
  });

  it('formats a strike without trailing zeros', () => {
    expect(formatStrike(7850000000n)).toBe('78.5');
    expect(formatStrike(8000000000n)).toBe('80');
  });
});

describe('ceilDiv', () => {
  it('rounds an inexact quotient up and leaves an exact one alone', () => {
    expect(ceilDiv(7n, 2n)).toBe(4n);
    expect(ceilDiv(6n, 2n)).toBe(3n);
    expect(ceilDiv(0n, 5n)).toBe(0n);
  });

  it('throws UnitError for a negative dividend or a non-positive divisor', () => {
    expect(() => ceilDiv(-1n, 2n)).toThrow(UnitError);
    expect(() => ceilDiv(1n, 0n)).toThrow(UnitError);
    expect(() => ceilDiv(1n, -2n)).toThrow(UnitError);
  });
});

describe('floorToIncrement', () => {
  it('floors to the step and never clamps up', () => {
    expect(floorToIncrement(10n * E18, 25n * E18)).toBe(0n);
    expect(floorToIncrement(60n * E18, 25n * E18)).toBe(50n * E18);
  });
});

describe('collateral, quantity and premium', () => {
  it('computes put collateral in 6-decimal stables (the real 25 WHYPE put @ 78.5)', () => {
    expect(collateralForPut(25n * E18, 7850000000n)).toBe(1962500000n);
  });

  it('computes call collateral in the collateral token decimals', () => {
    expect(collateralForCall(25n * E18, 18)).toBe(25n * E18);
    expect(collateralForCall(5n * 10n ** 16n, 8)).toBe(5000000n);
  });

  it('computes the floored 6-decimal premium', () => {
    expect(premium6(25n * E18, 1899452000000000000n)).toBe(47486300n);
    expect(premium6(25n * E18, 1109494507915005812n)).toBe(27737362n);
  });

  it('converts a USD budget to a put quantity', () => {
    expect(putQuantityFromUsd(1962500000n, 7850000000n)).toBe(25n * E18);
  });
});

describe('decimal parsing', () => {
  it('parses decimal strings without floats', () => {
    expect(usd6FromDecimal('20000')).toBe(20000000000n);
    expect(e18FromDecimal('0.05')).toBe(5n * 10n ** 16n);
  });

  it('throws UnitError for a non-decimal string', () => {
    expect(() => usd6FromDecimal('1e6')).toThrow(UnitError);
    expect(() => e18FromDecimal('')).toThrow(UnitError);
  });

  it('turns a percentage into a fraction', () => {
    expect(fractionFromPct(40)).toBe(0.4);
  });
});

describe('fractionToBps', () => {
  it('rounds a fraction to whole basis points', () => {
    expect(fractionToBps(0.25)).toBe(2500n);
    expect(fractionToBps(0.5)).toBe(5000n);
    expect(fractionToBps(0)).toBe(0n);
    expect(fractionToBps(1)).toBe(10000n);
    expect(fractionToBps(0.07)).toBe(700n);
    expect(fractionToBps(0.00004)).toBe(0n);
    expect(fractionToBps(0.00006)).toBe(1n);
  });

  it('throws UnitError for NaN, infinities, negatives and fractions above 1', () => {
    for (const f of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.0001]) {
      expect(() => fractionToBps(f), String(f)).toThrow(UnitError);
    }
  });
});
