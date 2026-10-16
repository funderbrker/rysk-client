import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { CHAIN_ID, TOKENS } from './constants.ts';
import { PositionParseError, parsePositions } from './positions.ts';
import type { Position, Settlement } from './types.ts';

const E18 = 10n ** 18n;
const OPTS = { underlying: TOKENS.WHYPE.address, chainId: CHAIN_ID } as const;

type Row = Record<string, unknown>;

function fixtureRows(): Row[] {
  const url = new URL('../../test/fixtures/positions.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Row[];
}

function isWhypeRow(row: Row): boolean {
  return String(row.address).toLowerCase() === TOKENS.WHYPE.address.toLowerCase();
}

/** The fixture with one row replaced by `mutate(row)`; the first row matching `pick` is the one replaced. */
function mutated(pick: (row: Row) => boolean, mutate: (row: Row) => Row): Row[] {
  const rows = fixtureRows();
  const index = rows.findIndex(pick);
  if (index < 0) throw new Error('no fixture row matches');
  rows[index] = mutate({ ...(rows[index] as Row) });
  return rows;
}

function countBy<T>(items: T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[keyOf(item)] = (counts[keyOf(item)] ?? 0) + 1;
  return counts;
}

type Match = Partial<Position> & { outcome?: Settlement['outcome'] };

function find(positions: Position[], match: Match): Position {
  const { outcome, ...fields } = match;
  const found = positions.find(
    (p) =>
      Object.entries(fields).every(([name, value]) => p[name as keyof Position] === value) &&
      (outcome === undefined || p.settlement?.outcome === outcome),
  );
  if (found === undefined) throw new Error(`no position matches ${JSON.stringify(Object.keys(match))}`);
  return found;
}

/** The first settled WHYPE put or call in the fixture with the given outcome-defining payout shape. */
function settledRow(isPut: boolean, assignedOrExercised: boolean): (row: Row) => boolean {
  return (row) =>
    isWhypeRow(row) &&
    row.status === 'SETTLED' &&
    row.isPut === isPut &&
    (row.payout !== '0') === assignedOrExercised;
}

describe('parsePositions on the fixture', () => {
  const { positions, otherRows, warnings } = parsePositions(fixtureRows(), OPTS);

  it('parses the 77 chain-999 WHYPE rows and keeps the 10 others for the vault count', () => {
    expect(positions).toHaveLength(77);
    expect(otherRows).toHaveLength(10);
    expect(warnings).toEqual([]);
    for (const row of otherRows) expect(row.chainId).toBe(999);
  });

  it('maps status and classifies every settlement from payout fields', () => {
    expect(countBy(positions, (p) => p.status)).toEqual({ open: 3, settled: 74 });
    expect(countBy(positions, (p) => p.settlement?.outcome ?? 'none')).toEqual({
      none: 3,
      assigned: 7,
      exercised: 8,
      expiredOtm: 59,
    });
  });

  it('parses the open put exactly', () => {
    const rows = fixtureRows();
    const put = find(positions, { status: 'open', isPut: true });
    expect(put).toEqual({
      key: `${String(rows[0]?.txHash)}|true|7850000000|1793347200|${TOKENS.USDC.address.toLowerCase()}|${25n * E18}`,
      underlying: TOKENS.WHYPE.address,
      chainId: 999,
      isPut: true,
      strikeE8: 7850000000n,
      quantityE18: 25n * E18,
      priceE18: 1899452000000000000n,
      premium6: 47486300n,
      usd: TOKENS.USDC.address,
      collateral: TOKENS.USDC.address,
      assetSymbol: 'WHYPE',
      createdAtSec: 1792131925,
      expirySec: 1793347200,
      txHash: rows[0]?.txHash,
      status: 'open',
      settlement: null,
    });
  });

  it('reads an exercised call, an assigned put and an OTM put', () => {
    const settlement = (match: Match): Settlement | null => find(positions, match).settlement;
    const exercised = settlement({ isPut: false, strikeE8: 9050000000n, outcome: 'exercised' });
    expect(exercised).toEqual({ outcome: 'exercised', receivedStable6: 4525000000n });
    const assigned = settlement({ isPut: true, strikeE8: 8000000000n, outcome: 'assigned' });
    expect(assigned).toEqual({ outcome: 'assigned', receivedUnderlyingE18: 50n * E18 });
    const expiredOtm = settlement({ isPut: true, strikeE8: 8100000000n, outcome: 'expiredOtm' });
    expect(expiredOtm).toEqual({ outcome: 'expiredOtm', collateralReturned: 2025000000n });
  });

  it('checksums addresses, lowercases tx hashes and gives every row a distinct key', () => {
    for (const p of positions) {
      expect(p.collateral).toBe(getAddress(p.collateral));
      expect(p.usd).toBe(getAddress(p.usd));
      expect(p.txHash).toBe(p.txHash.toLowerCase());
    }
    const keys = [...positions.map((p) => p.key), ...otherRows.map((row) => row.key)];
    expect(new Set(keys).size).toBe(87);
  });

  it('lowercases an upper-case tx hash, in the position and in its key', () => {
    const rows = mutated(isWhypeRow, (row) => ({
      ...row,
      txHash: `0x${String(row.txHash).slice(2).toUpperCase()}`,
    }));
    const upper = String(rows.find(isWhypeRow)?.txHash);
    expect(upper).toMatch(/^0x[0-9A-F]{64}$/);
    expect(upper).not.toBe(upper.toLowerCase());
    const [first] = parsePositions(rows, OPTS).positions;
    expect(first?.txHash).toBe(upper.toLowerCase());
    expect(first?.key.startsWith(`${upper.toLowerCase()}|`)).toBe(true);
  });

  it('builds foreign keys in the same normalized form', () => {
    const rows = fixtureRows();
    const ubtc = rows.find((row) => row.symbol === 'UBTC') as Row;
    const strikeE8 = BigInt(String(ubtc.strike)) / 10n ** 10n;
    expect(otherRows).toContainEqual({
      chainId: 999,
      key: `${String(ubtc.txHash)}|${String(ubtc.isPut)}|${strikeE8}|${String(ubtc.expiry)}|${String(ubtc.collateral).toLowerCase()}|${String(ubtc.quantity)}`,
    });
  });
});

describe('parsePositions on mutated rows', () => {
  it('maps an unrecognized status to unknown without throwing', () => {
    const rows = mutated(isWhypeRow, (row) => ({ ...row, status: 'WEIRD' }));
    const [first] = parsePositions(rows, OPTS).positions;
    expect(first?.status).toBe('unknown');
    expect(first?.settlement).toBeNull();
  });

  it('marks a row that is not a buy as unknown, even when settled', () => {
    const rows = mutated(settledRow(true, false), (row) => ({ ...row, isBuy: false }));
    const { positions } = parsePositions(rows, OPTS);
    expect(countBy(positions, (p) => p.status)).toEqual({ open: 3, settled: 73, unknown: 1 });
    expect(positions.filter((p) => p.status === 'unknown')[0]?.settlement).toBeNull();
  });

  it.each([
    ['quantity', 'abc'],
    ['quantity', '0'],
    ['strike', '78500000000000000001'],
    ['premium', '47486300000000000001'],
    ['price', '1.5'],
    ['collateral', '0x1234'],
    ['usd', undefined],
    ['txHash', '0xabc'],
    ['isPut', 'true'],
    ['expiry', 1793347200.5],
    ['createdAt', '1792131925'],
    ['symbol', ''],
    ['payout', ''],
    ['settlementCollateralPayout', null],
    ['payoutAsset', 'WHYPE'],
  ])('throws PositionParseError on a WHYPE row with %s %j', (field, value) => {
    const rows = mutated(isWhypeRow, (row) => ({ ...row, [field]: value }));
    expect(() => parsePositions(rows, OPTS)).toThrow(PositionParseError);
  });

  it('only warns about an invalid foreign row and still counts it', () => {
    const rows = mutated(
      (row) => !isWhypeRow(row),
      (row) => ({ ...row, quantity: 'abc' }),
    );
    const { positions, otherRows, warnings } = parsePositions(rows, OPTS);
    expect(positions).toHaveLength(77);
    expect(otherRows).toHaveLength(10);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/quantity/);
  });

  it('counts a duplicated foreign row once, with one warning per duplicated key', () => {
    const rows = fixtureRows();
    const foreign = rows.filter((row) => !isWhypeRow(row));
    const [first, second] = foreign;
    if (first === undefined || second === undefined) throw new Error('fixture has no foreign rows');
    const { positions, otherRows, warnings } = parsePositions([...rows, first, first, { ...second }], OPTS);
    expect(positions).toHaveLength(77);
    expect(otherRows).toHaveLength(10);
    expect(new Set(otherRows.map((row) => row.key)).size).toBe(10);
    expect(warnings).toEqual([
      expect.stringMatching(/^positions: 3 rows share the key 0x[0-9a-f]{64}\|.*; counted once$/),
      expect.stringMatching(/^positions: 2 rows share the key 0x[0-9a-f]{64}\|.*; counted once$/),
    ]);
  });

  it.each([
    ['address deleted', { address: undefined }],
    ['a malformed address', { address: '0x123' }],
    ['a string chainId', { chainId: '999' }],
  ])('throws for a row that could be a position, with %s', (_name, change) => {
    const rows = mutated(isWhypeRow, (row) => ({ ...row, ...change }));
    expect(() => parsePositions(rows, OPTS)).toThrow(PositionParseError);
  });

  it('throws for a row that is not an object', () => {
    expect(() => parsePositions([...fixtureRows(), null], OPTS)).toThrow(PositionParseError);
  });

  it('only warns about a row that is provably foreign by chain or by underlying', () => {
    const otherChain = mutated(isWhypeRow, (row) => ({ ...row, chainId: 1, address: '0x123' }));
    const byChain = parsePositions(otherChain, OPTS);
    expect(byChain.positions).toHaveLength(76);
    expect(byChain.otherRows.filter((row) => row.chainId === 1)).toHaveLength(1);
    expect(byChain.warnings).toEqual([expect.stringMatching(/address/)]);

    const foreignAsset = mutated(
      (row) => !isWhypeRow(row),
      (row) => ({ ...row, chainId: '999' }),
    );
    const byUnderlying = parsePositions(foreignAsset, OPTS);
    expect(byUnderlying.otherRows).toHaveLength(10);
    expect(byUnderlying.warnings).toEqual([expect.stringMatching(/chainId/)]);
  });

  it('throws when the top level is not an array', () => {
    expect(() => parsePositions({ rows: [] }, OPTS)).toThrow(PositionParseError);
  });
});

describe('settlement anomalies', () => {
  function outcomeOf(rows: Row[]): Settlement | null {
    const { positions } = parsePositions(rows, OPTS);
    return positions.find((p) => p.settlement?.outcome === 'anomaly')?.settlement ?? null;
  }

  it('flags a settled row with no payout and no collateral returned', () => {
    const rows = mutated(settledRow(true, false), (row) => ({ ...row, settlementCollateralPayout: '0' }));
    expect(outcomeOf(rows)).toMatchObject({ outcome: 'anomaly' });
  });

  it('flags a settled row with both a payout and collateral returned', () => {
    const rows = mutated(settledRow(false, true), (row) => ({ ...row, settlementCollateralPayout: '1' }));
    expect(outcomeOf(rows)).toMatchObject({ outcome: 'anomaly' });
  });

  it('flags an assignment paid in another asset or another amount', () => {
    const otherAsset = mutated(settledRow(true, true), (row) => ({
      ...row,
      payoutAsset: TOKENS.USDC.address,
    }));
    expect(outcomeOf(otherAsset)).toMatchObject({ outcome: 'anomaly' });
    const otherAmount = mutated(settledRow(true, true), (row) => ({ ...row, payout: String(49n * E18) }));
    expect(outcomeOf(otherAmount)).toMatchObject({ outcome: 'anomaly' });
  });

  it('flags an exercise paid in another asset or another amount', () => {
    const otherAsset = mutated(settledRow(false, true), (row) => ({ ...row, payoutAsset: '' }));
    expect(outcomeOf(otherAsset)).toMatchObject({ outcome: 'anomaly' });
    const otherAmount = mutated(settledRow(false, true), (row) => ({ ...row, payout: '4525000001' }));
    expect(outcomeOf(otherAmount)).toMatchObject({ outcome: 'anomaly' });
  });
});
