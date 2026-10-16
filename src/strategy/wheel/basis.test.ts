import { readFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { CHAIN_ID, TOKENS } from '../../domain/constants.ts';
import { parsePositions } from '../../domain/positions.ts';
import type { Position } from '../../domain/types.ts';
import { type BasisEvent, basisEvents, computeBasis } from './basis.ts';
import { classifyRow } from './classify.ts';
import type { BasisConfig } from './config.ts';

const E18 = 10n ** 18n;
const ANCHOR = { ts: 1000, qtyE18: 100n * E18, basisE8: 3000000000n };
/** Appendix B's default `residualToleranceWhype` (0.000001). */
const TOLERANCE_E18 = 10n ** 12n;
/** After every fixture expiry, so every fixture row is settled or pending. */
const NOW_SEC = 1793400000;

function basisConfig(overrides: Partial<BasisConfig> = {}): BasisConfig {
  return {
    anchor: ANCHOR,
    externalFlows: [],
    residualPolicy: 'absorb',
    residualToleranceE18: TOLERANCE_E18,
    ...overrides,
  };
}

function event(tsSec: number, kind: BasisEvent['kind'], qtyE18: bigint, priceE8?: bigint): BasisEvent {
  return {
    tsSec,
    kind,
    qtyE18,
    ...(priceE8 === undefined ? {} : { priceE8 }),
    source: 'flow',
    order: [0, ''],
  };
}

const ADD_50_AT_80 = event(2000, 'add', 50n * E18, 8000000000n);
const REMOVE_50 = event(3000, 'remove', 50n * E18);

function compute(
  events: BasisEvent[],
  observedHypeE18: bigint | null,
  overrides: Partial<BasisConfig> = {},
  anchorInsideSettlementWindow = false,
) {
  return computeBasis({
    events,
    config: basisConfig(overrides),
    observedHypeE18,
    anchorInsideSettlementWindow,
  });
}

function fixturePositions(): Position[] {
  const url = new URL('../../../test/fixtures/positions.json', import.meta.url);
  const rows: unknown = JSON.parse(readFileSync(url, 'utf8'));
  return parsePositions(rows, { underlying: TOKENS.WHYPE.address, chainId: CHAIN_ID }).positions;
}

function rowsOf(positions: Position[]) {
  return positions.map((position) => ({ position, ...classifyRow(position, NOW_SEC) }));
}

function fixturePosition(outcome: 'assigned' | 'exercised' | 'expiredOtm'): Position {
  const found = fixturePositions().find((p) => p.settlement?.outcome === outcome);
  if (found === undefined) throw new Error(`no ${outcome} fixture position`);
  return found;
}

const fakeHash = (byte: string): Hex => `0x${byte.repeat(32)}`;

describe('computeBasis replay', () => {
  it('adds at the price and rounds the average cost up', () => {
    expect(compute([ADD_50_AT_80], 150n * E18)).toEqual({
      basisE8: 4666666667n,
      qtyE18: 150n * E18,
      residualE18: 0n,
      reliable: true,
      warnings: [],
    });
  });

  it('removes at the average, leaving the average unchanged', () => {
    expect(compute([ADD_50_AT_80, REMOVE_50], 100n * E18)).toEqual({
      basisE8: 4666666667n,
      qtyE18: 100n * E18,
      residualE18: 0n,
      reliable: true,
      warnings: [],
    });
  });

  it('accepts a residual within the tolerance without changing the ledger', () => {
    const result = compute([ADD_50_AT_80, REMOVE_50], 100n * E18 + TOLERANCE_E18);
    expect(result).toMatchObject({ basisE8: 4666666667n, qtyE18: 100n * E18, reliable: true, warnings: [] });
    expect(result.residualE18).toBe(TOLERANCE_E18);
  });

  it('applies a same-second add before a remove, whatever the input order', () => {
    const remove = { ...event(2000, 'remove', 50n * E18), source: 'row' as const };
    const add = event(2000, 'add', 50n * E18, 8000000000n);
    const result = compute([remove, add], 0n, { anchor: { ...ANCHOR, qtyE18: 0n } });
    expect(result).toEqual({ basisE8: null, qtyE18: 0n, residualE18: 0n, reliable: true, warnings: [] });
  });
});

describe('computeBasis reconciliation', () => {
  it('absorbs a positive residual by re-running from the anchor with Q0 + R', () => {
    const result = compute([ADD_50_AT_80, REMOVE_50], 120n * E18);
    expect(result).toMatchObject({
      basisE8: 4470588236n,
      qtyE18: 120n * E18,
      residualE18: 20n * E18,
      reliable: true,
    });
    expect(result.warnings).toEqual([expect.stringMatching(/external-deposit/)]);
  });

  it('absorbs a negative residual as a final removal at the average', () => {
    const result = compute([ADD_50_AT_80, REMOVE_50], 90n * E18);
    expect(result).toMatchObject({
      basisE8: 4666666667n,
      qtyE18: 90n * E18,
      residualE18: -10n * E18,
      reliable: true,
    });
    expect(result.warnings).toEqual([expect.stringMatching(/external-withdrawal/)]);
  });

  it('blocks on a residual beyond the tolerance under block-calls, keeping the ledger values', () => {
    const cases: [observedHypeE18: bigint, residualE18: bigint][] = [
      [120n * E18, 20n * E18],
      [90n * E18, -10n * E18],
    ];
    for (const [observedHypeE18, residualE18] of cases) {
      const result = compute([ADD_50_AT_80, REMOVE_50], observedHypeE18, { residualPolicy: 'block-calls' });
      expect(result).toMatchObject({
        basisE8: 4666666667n,
        qtyE18: 100n * E18,
        residualE18,
        reliable: false,
        reason: 'residual-blocked',
      });
      expect(result.warnings).toEqual([expect.stringMatching(/residual-blocked/)]);
    }
  });

  it('skips reconciliation while a basis-relevant row is pending', () => {
    const result = compute([ADD_50_AT_80, REMOVE_50], null);
    expect(result).toMatchObject({
      basisE8: 4666666667n,
      qtyE18: 100n * E18,
      residualE18: 0n,
      reliable: false,
      reason: 'settlement-pending',
    });
    expect(result.warnings).toEqual([expect.stringMatching(/settlement-pending/)]);
  });
});

describe('computeBasis unreliability', () => {
  it('reports basis-negative, not a throw, when a remove exceeds the ledger', () => {
    const result = compute([REMOVE_50], 0n, { anchor: { ...ANCHOR, qtyE18: 0n } });
    expect(result).toMatchObject({ basisE8: null, qtyE18: 0n, reliable: false, reason: 'basis-negative' });
    expect(result.warnings).toEqual([expect.stringMatching(/basis-negative/)]);
  });

  it('reports basis-negative when an absorbed withdrawal exceeds the ledger (a negative observed balance)', () => {
    const result = compute([], -1n * E18);
    expect(result).toMatchObject({
      basisE8: null,
      qtyE18: 0n,
      residualE18: -101n * E18,
      reliable: false,
      reason: 'basis-negative',
    });
    expect(result.warnings).toEqual([
      expect.stringMatching(/external-withdrawal/),
      expect.stringMatching(/basis-negative/),
    ]);
  });

  it('reports an anchor inside a settlement window, still returning the ledger', () => {
    const result = compute([ADD_50_AT_80, REMOVE_50], 100n * E18, {}, true);
    expect(result).toMatchObject({
      basisE8: 4666666667n,
      qtyE18: 100n * E18,
      reliable: false,
      reason: 'anchor-in-settlement-window',
    });
    expect(result.warnings).toEqual([expect.stringMatching(/anchor-in-settlement-window/)]);
  });

  it('reports the first failure in processing order and warns about every one', () => {
    const negativeAnchor = { anchor: { ...ANCHOR, qtyE18: 0n } };
    const all = compute([REMOVE_50], null, negativeAnchor, true);
    expect(all.reason).toBe('anchor-in-settlement-window');
    expect(all.warnings).toEqual([
      expect.stringMatching(/anchor-in-settlement-window/),
      expect.stringMatching(/basis-negative/),
      expect.stringMatching(/settlement-pending/),
    ]);
    expect(compute([REMOVE_50], null, negativeAnchor).reason).toBe('basis-negative');
    const blocked = compute([REMOVE_50], 20n * E18, { ...negativeAnchor, residualPolicy: 'block-calls' });
    expect(blocked).toMatchObject({ reliable: false, reason: 'basis-negative', residualE18: 20n * E18 });
    expect(blocked.warnings).toEqual([
      expect.stringMatching(/basis-negative/),
      expect.stringMatching(/residual-blocked/),
    ]);
  });
});

describe('basisEvents on the fixture', () => {
  const rows = rowsOf(fixturePositions());

  it('yields the 15 settled ITM rows after the anchor in spec order', () => {
    const events = basisEvents(rows, basisConfig({ anchor: { ...ANCHOR, ts: 1760000000 } }));
    expect(events.map((e) => [e.tsSec, e.kind, e.qtyE18 / E18, e.priceE8])).toEqual([
      // Same expiry: the 42.5 put (created 1761916641) precedes the 40.5 put (created 1762173806).
      [1763107200, 'add', 50n, 4250000000n],
      [1763107200, 'add', 50n, 4050000000n],
      [1764316800, 'add', 50n, 3650000000n],
      [1764316800, 'add', 50n, 3750000000n],
      [1764316800, 'add', 50n, 3600000000n],
      [1765526400, 'add', 50n, 3100000000n],
      [1774598400, 'remove', 100n, 3850000000n],
      [1776412800, 'remove', 100n, 4150000000n],
      [1780041600, 'remove', 100n, 4650000000n],
      [1780041600, 'remove', 100n, 4800000000n],
      [1782460800, 'remove', 100n, 4950000000n],
      [1787904000, 'remove', 100n, 8150000000n],
      [1789113600, 'add', 50n, 8000000000n],
      [1790323200, 'remove', 50n, 9050000000n],
      [1790323200, 'remove', 50n, 9050000000n],
    ]);
    expect(events.every((e) => e.source === 'row')).toBe(true);
    expect(events.slice(0, 2).map((e) => e.order[0])).toEqual([1761916641, 1762173806]);
  });

  it('yields nothing for an anchor after every settled expiry', () => {
    expect(basisEvents(rows, basisConfig({ anchor: { ...ANCHOR, ts: 1792000000 } }))).toEqual([]);
  });
});

describe('basisEvents on edited rows and flows', () => {
  const put = fixturePosition('assigned');
  const call = fixturePosition('exercised');

  it('orders by ts, adds before removes, rows before flows, rows by createdAt then txHash, flows by config order', () => {
    const putAt = (createdAtSec: number, byte: string): Position => ({
      ...put,
      expirySec: 5000,
      createdAtSec,
      txHash: fakeHash(byte),
    });
    const positions = [
      putAt(20, 'bb'),
      { ...call, expirySec: 5000, createdAtSec: 1, txHash: fakeHash('dd') },
      putAt(10, 'cc'),
      putAt(10, 'aa'),
    ];
    const externalFlows = [
      { ts: 5000, qtyE18: -5n * E18, basisE8: 9900000000n },
      { ts: 5000, qtyE18: 7n * E18, basisE8: 4400000000n },
      { ts: 5000, qtyE18: 3n * E18 },
      { ts: 4000, qtyE18: -1n * E18 },
    ];
    const events = basisEvents(rowsOf(positions), basisConfig({ externalFlows }));
    expect(events).toEqual([
      { tsSec: 4000, kind: 'remove', qtyE18: 1n * E18, source: 'flow', order: [3, ''] },
      {
        tsSec: 5000,
        kind: 'add',
        qtyE18: 50n * E18,
        priceE8: put.strikeE8,
        source: 'row',
        order: [10, fakeHash('aa')],
      },
      {
        tsSec: 5000,
        kind: 'add',
        qtyE18: 50n * E18,
        priceE8: put.strikeE8,
        source: 'row',
        order: [10, fakeHash('cc')],
      },
      {
        tsSec: 5000,
        kind: 'add',
        qtyE18: 50n * E18,
        priceE8: put.strikeE8,
        source: 'row',
        order: [20, fakeHash('bb')],
      },
      { tsSec: 5000, kind: 'add', qtyE18: 7n * E18, priceE8: 4400000000n, source: 'flow', order: [1, ''] },
      { tsSec: 5000, kind: 'add', qtyE18: 3n * E18, priceE8: ANCHOR.basisE8, source: 'flow', order: [2, ''] },
      {
        tsSec: 5000,
        kind: 'remove',
        qtyE18: call.quantityE18,
        priceE8: call.strikeE8,
        source: 'row',
        order: [1, fakeHash('dd')],
      },
      { tsSec: 5000, kind: 'remove', qtyE18: 5n * E18, source: 'flow', order: [0, ''] },
    ]);
  });

  it('adds the payout of an assigned put, not its quantity', () => {
    const short: Position = {
      ...put,
      expirySec: 5000,
      settlement: { outcome: 'assigned', receivedUnderlyingE18: 49n * E18 },
    };
    expect(basisEvents(rowsOf([short]), basisConfig()).map((e) => e.qtyE18)).toEqual([49n * E18]);
  });

  it('skips OTM, anomalous, unsettled and non-WHYPE-collateral rows, and anything at or before the anchor', () => {
    const otm = fixturePosition('expiredOtm');
    const positions: Position[] = [
      { ...otm, expirySec: 5000 },
      { ...put, expirySec: 5000, settlement: { outcome: 'anomaly', detail: 'test' } },
      { ...put, expirySec: 5000, status: 'open', settlement: null },
      { ...call, expirySec: 5000, collateral: TOKENS.KHYPE.address },
      { ...put, expirySec: ANCHOR.ts },
      { ...call, expirySec: ANCHOR.ts - 1 },
    ];
    const externalFlows = [
      { ts: ANCHOR.ts, qtyE18: 1n * E18 },
      { ts: ANCHOR.ts - 1, qtyE18: -1n * E18 },
    ];
    expect(basisEvents(rowsOf(positions), basisConfig({ externalFlows }))).toEqual([]);
  });
});
