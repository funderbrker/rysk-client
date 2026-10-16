import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCaps, remainingCapacityE18 } from './caps.ts';
import { TOKENS } from './constants.ts';
import type { Cap } from './types.ts';

const E18 = 10n ** 18n;
const WHYPE = TOKENS.WHYPE.address;
const CALL = { underlyingSymbol: 'HYPE', asset: WHYPE, isPut: false };
const PUT = { underlyingSymbol: 'HYPE', asset: WHYPE, isPut: true };

type CapRow = { name: string; type: string; cap: string; usage: string };

function capsFixture(): CapRow[] {
  return JSON.parse(
    readFileSync(new URL('../../test/fixtures/caps.json', import.meta.url), 'utf8'),
  ) as CapRow[];
}

function cap(name: string, type: Cap['type'], capE18: bigint, usageE18: bigint): Cap {
  return { name, type, capE18, usageE18 };
}

describe('parseCaps', () => {
  it('parses every captured cap, keeping GLOBAL rows with their own type', () => {
    const { caps, dropped } = parseCaps(capsFixture());
    expect(dropped).toBe(0);
    expect(caps).toHaveLength(107);
    expect(caps.find((row) => row.name === 'GLOBAL')).toEqual({
      name: 'GLOBAL',
      type: 'NOTIONAL',
      capE18: 4_000_000n * E18,
      usageE18: 1_295_082_500_000_000_000_000_000n,
    });
  });

  it('drops and counts invalid rows, including types other than CONTRACTS and NOTIONAL', () => {
    const rows: unknown[] = [
      ...capsFixture(),
      { name: 'GLOBAL', type: 'GLOBAL', cap: '1', usage: '0' },
      { name: 'HYPE', type: 'contracts', cap: '1', usage: '0' },
      { name: 'HYPE', type: 'CONTRACTS', cap: '1.5', usage: '0' },
      { name: 'HYPE', type: 'CONTRACTS', cap: '1', usage: -1 },
      { name: '', type: 'CONTRACTS', cap: '1', usage: '0' },
      'HYPE',
    ];
    const { caps, dropped } = parseCaps(rows);
    expect(dropped).toBe(6);
    expect(caps).toHaveLength(107);
  });

  it('throws only on a malformed top level', () => {
    for (const json of [null, {}, 'caps']) expect(() => parseCaps(json), JSON.stringify(json)).toThrow();
  });
});

describe('remainingCapacityE18', () => {
  const { caps } = parseCaps(capsFixture());

  it('binds a call on the HYPE NOTIONAL cap priced at spot', () => {
    const remaining = remainingCapacityE18(caps, CALL, 8148032044n);
    expect(remaining).not.toBeNull();
    expect(remaining).toBeGreaterThan(32480n * E18);
    expect(remaining).toBeLessThan(32481n * E18);
  });

  it('binds a put on the WHYPE-put NOTIONAL cap priced at strike', () => {
    const remaining = remainingCapacityE18(caps, PUT, 7850000000n);
    expect(remaining).not.toBeNull();
    expect(remaining).toBeGreaterThan(12738n * E18);
    expect(remaining).toBeLessThan(12739n * E18);
  });

  it('returns null when every matching cap is zero (not enforced)', () => {
    const matching = new Set([
      'GLOBAL',
      'HYPE',
      WHYPE.toLowerCase(),
      `${WHYPE.toLowerCase()}-false`,
      `${WHYPE.toLowerCase()}-true`,
    ]);
    const zeroed = capsFixture().map((row) => (matching.has(row.name) ? { ...row, cap: '0' } : row));
    const parsed = parseCaps(zeroed).caps;
    expect(remainingCapacityE18(parsed, CALL, 8148032044n)).toBeNull();
    expect(remainingCapacityE18(parsed, PUT, 7850000000n)).toBeNull();
  });

  it('returns null when no cap applies', () => {
    expect(remainingCapacityE18([cap('PUMP', 'CONTRACTS', 10n * E18, 0n)], CALL, 8148032044n)).toBeNull();
    expect(remainingCapacityE18([], CALL, 8148032044n)).toBeNull();
  });

  it('takes the minimum over GLOBAL, symbol, asset and asset-side, matching addresses in any casing', () => {
    const khype = TOKENS.KHYPE.address;
    const lower = khype.toLowerCase();
    const rows = [
      cap('GLOBAL', 'CONTRACTS', 900n * E18, 0n),
      cap('HYPE', 'CONTRACTS', 800n * E18, 100n * E18),
      cap(lower, 'CONTRACTS', 600n * E18, 0n),
      cap(`0x${khype.slice(2).toUpperCase()}-false`, 'CONTRACTS', 500n * E18, 25n * E18),
      cap(`${lower}-true`, 'CONTRACTS', 50n * E18, 0n),
      cap(WHYPE, 'CONTRACTS', 1n * E18, 0n),
      cap('PUMP', 'CONTRACTS', 1n * E18, 0n),
    ];
    const target = { underlyingSymbol: 'HYPE', asset: khype };
    expect(remainingCapacityE18(rows, { ...target, isPut: false }, 8000000000n)).toBe(475n * E18);
    expect(remainingCapacityE18(rows, { ...target, isPut: true }, 8000000000n)).toBe(50n * E18);
  });

  it('converts NOTIONAL headroom to contracts at the given price, flooring', () => {
    const rows = [cap('HYPE', 'NOTIONAL', 1000n * E18, 200n * E18)];
    expect(remainingCapacityE18(rows, CALL, 8000000000n)).toBe(10n * E18);
    expect(remainingCapacityE18(rows, CALL, 3000000000n)).toBe(26666666666666666666n);
  });

  it('skips zero caps but never returns negative headroom', () => {
    const rows = [cap('GLOBAL', 'NOTIONAL', 0n, 5n * E18), cap('HYPE', 'CONTRACTS', 100n * E18, 125n * E18)];
    expect(remainingCapacityE18(rows, CALL, 8000000000n)).toBe(0n);
  });

  it('rejects a non-positive notional price', () => {
    expect(() => remainingCapacityE18(caps, CALL, 0n)).toThrow();
  });
});
