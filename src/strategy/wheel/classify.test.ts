import { readFileSync } from 'node:fs';
import { type Address, isAddressEqual } from 'viem';
import { describe, expect, it } from 'vitest';
import { CHAIN_ID, TOKENS } from '../../domain/constants.ts';
import { parsePositions } from '../../domain/positions.ts';
import type { Position } from '../../domain/types.ts';
import { classifyRow, isBasisRelevant, isManaged } from './classify.ts';
import type { RowClass } from './types.ts';

const NOW_SEC = 1792144000;
/** After every open fixture row's expiry (1792742400 and 2 × 1793347200). */
const AFTER_OPEN_EXPIRIES_SEC = 1793400000;
const OPTS = { underlying: TOKENS.WHYPE.address, chainId: CHAIN_ID } as const;
const ALL_CLASSES: RowClass[] = [
  'managedPut',
  'managedCall',
  'whypeCallOtherUsd',
  'whypePutOtherUsd',
  'hypeForeignCollateral',
  'foreign',
  'otherChain',
];

type Row = Record<string, unknown>;

function fixtureRows(): Row[] {
  const url = new URL('../../../test/fixtures/positions.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Row[];
}

function fixturePositions(rows: Row[] = fixtureRows()): Position[] {
  return parsePositions(rows, OPTS).positions;
}

function countBy<T>(items: T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[keyOf(item)] = (counts[keyOf(item)] ?? 0) + 1;
  return counts;
}

/** The first fixture position matching `pick`. */
function fixturePosition(pick: (p: Position) => boolean): Position {
  const found = fixturePositions().find(pick);
  if (found === undefined) throw new Error('no fixture position matches');
  return found;
}

const OTHER_UNDERLYING: Address = '0x1111111111111111111111111111111111111111';

const isManagedPutTerms = (p: Position): boolean =>
  p.isPut && isAddressEqual(p.usd, TOKENS.USDC.address) && isAddressEqual(p.collateral, TOKENS.USDC.address);

describe('classifyRow on the fixture', () => {
  const positions = fixturePositions();

  it('splits the 77 WHYPE positions into managed and other-stable puts and calls', () => {
    expect(countBy(positions, (p) => classifyRow(p, NOW_SEC).cls)).toEqual({
      managedPut: 10,
      managedCall: 17,
      whypePutOtherUsd: 21,
      whypeCallOtherUsd: 29,
    });
  });

  it('has 3 open and 74 settled rows and nothing pending before the open expiries', () => {
    expect(countBy(positions, (p) => classifyRow(p, NOW_SEC).phase)).toEqual({ open: 3, settled: 74 });
  });

  it('marks the open rows pendingSettlement once their expiries have passed', () => {
    const pending = positions.filter(
      (p) => classifyRow(p, AFTER_OPEN_EXPIRIES_SEC).phase === 'pendingSettlement',
    );
    expect(pending.map((p) => p.expirySec).sort((a, b) => a - b)).toEqual([
      1792742400, 1793347200, 1793347200,
    ]);
    expect(countBy(positions, (p) => classifyRow(p, AFTER_OPEN_EXPIRIES_SEC).phase)).toEqual({
      pendingSettlement: 3,
      settled: 74,
    });
  });

  it('classifies a kHYPE-collateral call as hypeForeignCollateral', () => {
    const rows = fixtureRows();
    const index = rows.findIndex((row) => row.isPut === false && row.status === '');
    if (index < 0) throw new Error('no open call in the fixture');
    rows[index] = {
      ...(rows[index] as Row),
      collateral: TOKENS.KHYPE.address.toLowerCase(),
      symbol: 'kHYPE',
    };
    const khypeCall = fixturePositions(rows).find((p) => isAddressEqual(p.collateral, TOKENS.KHYPE.address));
    if (khypeCall === undefined) throw new Error('the mutated row did not parse as a position');
    expect(classifyRow(khypeCall, NOW_SEC)).toEqual({ cls: 'hypeForeignCollateral', phase: 'open' });
  });
});

describe('classifyRow on edited positions', () => {
  const managedPut = fixturePosition(isManagedPutTerms);
  const openCall = fixturePosition((p) => !p.isPut && p.status === 'open');

  it('classifies the other HYPE collaterals, other underlyings and other chains', () => {
    for (const token of [TOKENS.LHYPE, TOKENS.WSTHYPE]) {
      expect(classifyRow({ ...openCall, collateral: token.address }, NOW_SEC).cls).toBe(
        'hypeForeignCollateral',
      );
    }
    expect(classifyRow({ ...managedPut, underlying: OTHER_UNDERLYING }, NOW_SEC).cls).toBe('foreign');
    expect(classifyRow({ ...managedPut, chainId: 1 }, NOW_SEC).cls).toBe('otherChain');
  });

  it('needs USDC as both the strike asset and the collateral for a managed put', () => {
    expect(classifyRow({ ...managedPut, collateral: TOKENS.USDT0.address }, NOW_SEC).cls).toBe(
      'whypePutOtherUsd',
    );
    expect(classifyRow({ ...managedPut, usd: TOKENS.USDH.address }, NOW_SEC).cls).toBe('whypePutOtherUsd');
  });

  it('compares addresses case-insensitively', () => {
    const lowercased: Position = {
      ...managedPut,
      underlying: TOKENS.WHYPE.address.toLowerCase() as Address,
      usd: TOKENS.USDC.address.toLowerCase() as Address,
      collateral: TOKENS.USDC.address.toLowerCase() as Address,
    };
    expect(classifyRow(lowercased, NOW_SEC).cls).toBe('managedPut');
  });

  it('is pendingSettlement from the expiry second on, and unknown for an unknown status', () => {
    expect(classifyRow(openCall, openCall.expirySec - 1).phase).toBe('open');
    expect(classifyRow(openCall, openCall.expirySec).phase).toBe('pendingSettlement');
    expect(classifyRow({ ...openCall, status: 'unknown' }, NOW_SEC).phase).toBe('unknown');
    expect(classifyRow({ ...openCall, status: 'unknown' }, openCall.expirySec + 1).phase).toBe('unknown');
  });
});

describe('class predicates', () => {
  it('treats the WHYPE puts and WHYPE-collateral calls as basis-relevant and the USDC ones as managed', () => {
    expect(ALL_CLASSES.filter(isBasisRelevant)).toEqual([
      'managedPut',
      'managedCall',
      'whypeCallOtherUsd',
      'whypePutOtherUsd',
    ]);
    expect(ALL_CLASSES.filter(isManaged)).toEqual(['managedPut', 'managedCall']);
  });
});
