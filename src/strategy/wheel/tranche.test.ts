import { describe, expect, it } from 'vitest';
import {
  type ConfigPatch,
  fixtureAssets,
  snapshotFromFixtures,
  wheelConfig,
} from '../../../test/helpers/wheelSnapshot.ts';
import type { Side } from '../../domain/types.ts';
import { UnitError } from '../../domain/units.ts';
import type { WheelConfig } from './config.ts';
import { trancheQuantityE18 } from './tranche.ts';
import type { SideCapital, WheelState } from './types.ts';

const E18 = 10n ** 18n;
const LOT_E18 = 25n * E18;
/** One lot of 25 puts at 78.5 locks 1 962.5 USDC. */
const STRIKE_E8 = 7850000000n;
const ZERO: SideCapital = { free: 0n, locked: 0n, pending: 0n, total: 0n, budget: 0n };

/** USDC in 6 dp. */
function usdc(amount: bigint): bigint {
  return amount * 1_000_000n;
}

/** A state holding only `side`'s capital; `total` is free + locked + pending and the budget defaults to it. */
function stateWith(
  side: Side,
  capital: { free: bigint; locked?: bigint; pending?: bigint; budget?: bigint },
): WheelState {
  const { free, locked = 0n, pending = 0n } = capital;
  const total = free + locked + pending;
  return {
    consistency: 'ok',
    rows: [],
    capital: {
      put: ZERO,
      call: ZERO,
      [side]: { free, locked, pending, total, budget: capital.budget ?? total },
    },
    basis: { basisE8: null, qtyE18: 0n, residualE18: 0n, reliable: true },
    lastDeployTs: {},
    deploymentsLast24h: 0,
    notionalLast24h6: 0n,
    anomalies: [],
    warnings: [],
  };
}

/** A quarter of the budget per tranche, single lots allowed, with no per-trade contract limit in the way. */
function config(patch: ConfigPatch = {}): WheelConfig {
  const unlimited = { maxContractsPerTradeE18: 1_000_000n * E18 };
  return wheelConfig({
    ...patch,
    put: { ...unlimited, ...patch.put },
    call: { ...unlimited, ...patch.call },
  });
}

const snapshot = snapshotFromFixtures({ market: { assets: fixtureAssets() } });

function tranche(
  side: Side,
  st: WheelState,
  opts: { c?: WheelConfig; capacityE18?: bigint | null; strikeE8?: bigint } = {},
): bigint {
  const { c = config(), capacityE18 = null, strikeE8 = STRIKE_E8 } = opts;
  return trancheQuantityE18(side, st, strikeE8, snapshot, c, capacityE18);
}

describe('trancheQuantityE18 for puts', () => {
  it('sizes one lot from a quarter of a 10 000 USDC budget at 78.5', () => {
    // The target of 2 500 USDC covers one 1 962.5 lot.
    expect(tranche('put', stateWith('put', { free: usdc(10_000n) }))).toBe(LOT_E18);
  });

  it('returns 0 when the free USDC cannot lock one lot, even as a single lot', () => {
    // The target is still 2 500 but the room is the 1 500 free.
    const st = stateWith('put', { free: usdc(1_500n), locked: usdc(8_500n) });
    expect(tranche('put', st)).toBe(0n);
  });

  it('counts pending collateral against the budget', () => {
    const capital = { free: usdc(5_000n), locked: usdc(3_000n), budget: usdc(6_000n) };
    // The room is 6 000 − 3 000 = 3 000: the 1 500 target is below a lot, so a single lot.
    expect(tranche('put', stateWith('put', capital))).toBe(LOT_E18);
    // With 2 000 pending the room is 1 000, below a lot.
    expect(tranche('put', stateWith('put', { ...capital, pending: usdc(2_000n) }))).toBe(0n);
  });

  it('sizes 12 lots from a 100 000 USDC budget when no limit binds', () => {
    // A 25 000 target over 1 962.5 per lot.
    expect(tranche('put', stateWith('put', { free: usdc(100_000n) }))).toBe(12n * LOT_E18);
  });

  it('caps at maxContractsPerTradeE18, rounded down to whole lots', () => {
    const st = stateWith('put', { free: usdc(100_000n) });
    expect(tranche('put', st, { c: config({ put: { maxContractsPerTradeE18: LOT_E18 } }) })).toBe(LOT_E18);
    expect(tranche('put', st, { c: config({ put: { maxContractsPerTradeE18: 60n * E18 } }) })).toBe(
      50n * E18,
    );
  });

  it('rounds the remaining cap capacity down to whole lots', () => {
    const st = stateWith('put', { free: usdc(100_000n) });
    expect(tranche('put', st, { capacityE18: 30n * E18 })).toBe(LOT_E18);
    expect(tranche('put', st, { capacityE18: 10n * E18 })).toBe(0n);
    expect(tranche('put', st, { capacityE18: 1000n * E18 })).toBe(12n * LOT_E18);
  });

  it('throws UnitError for a strike at which a lot locks nothing', () => {
    const st = stateWith('put', { free: usdc(10_000n) });
    expect(() => tranche('put', st, { strikeE8: 0n })).toThrow(UnitError);
  });
});

describe('trancheQuantityE18 for calls', () => {
  const st = stateWith('call', { free: 30n * E18 });

  it('takes a single lot when the 7.5 WHYPE target is below a lot but the 30 free hold one', () => {
    expect(tranche('call', st)).toBe(LOT_E18);
  });

  it('returns 0 below a lot when single lots are not allowed', () => {
    expect(tranche('call', st, { c: config({ tranche: { allowSingleLot: false } }) })).toBe(0n);
  });

  it("caps at the asset's maxTradeSizeE18", () => {
    // A 25 000 WHYPE target is 1 000 lots; WHYPE trades at most 5 000 contracts.
    expect(tranche('call', stateWith('call', { free: 100_000n * E18 }))).toBe(5000n * E18);
  });
});
