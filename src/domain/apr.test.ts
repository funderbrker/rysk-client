import { describe, expect, it } from 'vitest';
import { aprFraction, aprFractionFromRyskApy, collateral6For, minPriceE18ForApr } from './apr.ts';
import { premium6, UnitError } from './units.ts';

const Q = 25n * 10n ** 18n;

describe('aprFraction', () => {
  it('matches the real fill (25 WHYPE put @ 78.5, 62.83 %)', () => {
    expect(aprFraction(47486300n, 1962500000n, 1792131925, 1793347200)).toBeCloseTo(0.6283, 4);
  });

  it('matches the spike put quote apy (75.33)', () => {
    const apr = aprFraction(27737362n, 1950000000n, 1792146507, 1792742400);
    expect(Math.abs(apr - 0.753299)).toBeLessThan(0.0005);
  });

  it('floors a net loss below the 9-decimal resolution to negative, not zero', () => {
    expect(aprFraction(-1n, 1_000_000_000_000n, 1792131925, 1793347200)).toBeLessThan(0);
  });

  it('throws UnitError when the option has expired or there is no collateral', () => {
    expect(() => aprFraction(1n, 1962500000n, 1793347200, 1793347200)).toThrow(UnitError);
    expect(() => aprFraction(1n, 0n, 1792131925, 1793347200)).toThrow(UnitError);
  });
});

describe('collateral6For', () => {
  it('values put collateral at strike and call collateral at spot', () => {
    expect(collateral6For('put', Q, 7850000000n, 8148032044n)).toBe(1962500000n);
    expect(collateral6For('call', Q, 7850000000n, 8148032044n)).toBe(2037008011n);
  });
});

describe('minPriceE18ForApr', () => {
  it('returns the lowest price whose premium meets the APR floor', () => {
    const p = minPriceE18ForApr(0.4, 1950000000n, Q, 1792146507, 1792742400, 0n);
    expect(aprFraction(premium6(Q, p), 1950000000n, 1792146507, 1792742400)).toBeGreaterThanOrEqual(0.4);
    expect(aprFraction(premium6(Q, p - 10n ** 15n), 1950000000n, 1792146507, 1792742400)).toBeLessThan(0.4);
  });

  it('adds the gas fee to the premium the price must cover', () => {
    const gasFee6 = 500000n;
    const p = minPriceE18ForApr(0.4, 1950000000n, Q, 1792146507, 1792742400, gasFee6);
    const net6 = (price: bigint): bigint => premium6(Q, price) - gasFee6;
    expect(aprFraction(net6(p), 1950000000n, 1792146507, 1792742400)).toBeGreaterThanOrEqual(0.4);
    expect(aprFraction(net6(p - 1n), 1950000000n, 1792146507, 1792742400)).toBeLessThan(0.4);
  });
});

describe('aprFractionFromRyskApy', () => {
  it('turns the quote apy percentage into a fraction', () => {
    expect(aprFractionFromRyskApy(75.33)).toBeCloseTo(0.7533, 10);
  });
});
