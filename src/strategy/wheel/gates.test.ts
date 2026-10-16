import { describe, expect, it } from 'vitest';
import {
  type ConfigPatch,
  fixtureAssets,
  fixtureCaps,
  fixtureListings,
  fixturePositions,
  NOW_SEC,
  type SnapshotPatch,
  snapshotFromFixtures,
  wheelConfig,
} from '../../../test/helpers/wheelSnapshot.ts';
import { TOKENS } from '../../domain/constants.ts';
import type { Asset, Cap, Position, Side } from '../../domain/types.ts';
import { checkGates } from './gates.ts';
import { deriveState } from './state.ts';
import type { HoldReason, WheelState } from './types.ts';

const E18 = 10n ** 18n;
const HOUR_SEC = 3600;
const DAY_SEC = 86_400;
const SIDES: Side[] = ['put', 'call'];
const GLOBAL_IDS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11'];

const isOpenPut = (p: Position): boolean => p.isPut && p.status === 'open';
const isOpenCall = (p: Position): boolean => !p.isPut && p.status === 'open';
const isSettled = (p: Position): boolean => p.status === 'settled';

/** The fixture rows with the open put deployed two days back, so the put's 24 h interval has passed. */
function happyPositions(): Position[] {
  return fixturePositions().map((p) => (isOpenPut(p) ? { ...p, createdAtSec: NOW_SEC - 2 * DAY_SEC } : p));
}

/** `happyPositions()` with the first row matching `pick` replaced by its `edit`. */
function positionsWith(pick: (p: Position) => boolean, edit: (p: Position) => Position): Position[] {
  const positions = happyPositions();
  const index = positions.findIndex(pick);
  if (index < 0) throw new Error('no fixture position matches');
  return positions.with(index, edit(positions[index] as Position));
}

function assetsWith(edit: (whype: Asset) => Asset): Asset[] {
  return fixtureAssets().map((asset) => (asset.symbol === 'WHYPE' ? edit(asset) : asset));
}

/**
 * The fixture tick with every gate passing: the captured market and caps, the open put deployed two days back,
 * and the last pending settlement seen an hour back (past the 900 s grace).
 */
function snapshot(patch: SnapshotPatch = {}) {
  return snapshotFromFixtures({
    positions: happyPositions(),
    ...patch,
    market: { assets: fixtureAssets(), listings: fixtureListings(), caps: fixtureCaps(), ...patch.market },
    memo: { lastNoPendingSeenSec: NOW_SEC - HOUR_SEC, ...patch.memo },
  });
}

type Case = { snapshot?: SnapshotPatch; state?: Partial<WheelState>; config?: ConfigPatch };

/** The gates for `side` on the patched fixture tick, its state derived and then patched. */
function gates(side: Side, test: Case = {}) {
  const s = snapshot(test.snapshot);
  const c = wheelConfig({ mode: s.mode, ...test.config });
  return checkGates(side, { ...deriveState(s, c), ...test.state }, s, c);
}

function hold(side: Side, test: Case = {}): HoldReason | null {
  return gates(side, test).hold;
}

/** The hold on both sides, for the global gates. */
function holds(test: Case): (HoldReason | null)[] {
  return SIDES.map((side) => hold(side, test));
}

describe('checkGates on the fixture tick', () => {
  it('passes every gate on both sides and lists them in order', () => {
    expect(gates('put')).toEqual({
      hold: null,
      results: [...GLOBAL_IDS, 'S1', 'S2', 'S3'].map((id) => ({ id, pass: true })),
    });
    expect(gates('call')).toEqual({
      hold: null,
      results: [...GLOBAL_IDS, 'S1', 'S2', 'S3', 'S4'].map((id) => ({ id, pass: true })),
    });
  });

  it('evaluates S5 on puts only when maxHypeExposurePct is set', () => {
    const config = { safety: { maxHypeExposurePct: 0.9 } };
    expect(gates('put', { config }).results.map((r) => r.id)).toEqual([
      ...GLOBAL_IDS,
      'S1',
      'S2',
      'S3',
      'S5',
    ]);
    expect(gates('call', { config }).results.map((r) => r.id)).not.toContain('S5');
  });

  it('skips the live-only gates in dry-run', () => {
    const test: Case = {
      snapshot: { mode: 'dry-run', memo: { uptimeSec: 10 }, chain: { nativeHypeE18: 0n } },
      state: { deploymentsLast24h: 4 },
    };
    const { hold: dryHold, results } = gates('put', test);
    expect(dryHold).toBeNull();
    expect(results.map((r) => r.id)).toEqual([
      'G1',
      'G2',
      'G3',
      'G4',
      'G5',
      'G6',
      'G8',
      'G10',
      'S1',
      'S2',
      'S3',
    ]);
  });

  it('holds on the first failing gate and still evaluates the rest', () => {
    const { hold: first, results } = gates('put', { snapshot: { memo: { inFlight: true, stopFile: true } } });
    expect(first).toBe('in-flight');
    const failed = results.filter((r) => !r.pass);
    expect(failed.map((r) => r.id)).toEqual(['G8', 'G10']);
    for (const result of failed) expect(result.detail).toEqual(expect.any(String));
    expect(results).toHaveLength(GLOBAL_IDS.length + 3);
  });
});

describe('checkGates global gates', () => {
  it('G1 holds on an anomaly', () => {
    expect(holds({ state: { anomalies: ['row x: unknown status'] } })).toEqual(['anomaly', 'anomaly']);
  });

  it('G1 holds on an unknown row even without an anomaly', () => {
    const positions = positionsWith(isSettled, (p) => ({ ...p, status: 'unknown', settlement: null }));
    expect(holds({ snapshot: { positions }, state: { anomalies: [] } })).toEqual(['anomaly', 'anomaly']);
  });

  it('G2 holds on API lag and on an inconsistent chain', () => {
    expect(holds({ snapshot: { chain: { vaultCounter: 88n } } })).toEqual(['api-lag', 'api-lag']);
    expect(holds({ state: { consistency: 'inconsistent' } })).toEqual(['inconsistent', 'inconsistent']);
  });

  it('G3 holds while a managed row is pending settlement', () => {
    const positions = positionsWith(isOpenPut, (p) => ({ ...p, expirySec: NOW_SEC - 60 }));
    expect(holds({ snapshot: { positions } })).toEqual(['settlement-pending', 'settlement-pending']);
  });

  it('G3 ignores a pending row that does not move our WHYPE', () => {
    const toKhype = (p: Position): Position => ({
      ...p,
      collateral: TOKENS.KHYPE.address,
      expirySec: NOW_SEC - 60,
    });
    const { results } = gates('put', { snapshot: { positions: positionsWith(isOpenCall, toKhype) } });
    expect(results.find((r) => r.id === 'G3')).toEqual({ id: 'G3', pass: true });
  });

  it('G3 holds until the settlement grace has passed since no row was pending', () => {
    const since = (lastNoPendingSeenSec: number | null) =>
      holds({ snapshot: { memo: { lastNoPendingSeenSec } } });
    expect(since(NOW_SEC - 100)).toEqual(['settlement-pending', 'settlement-pending']);
    expect(since(null)).toEqual(['settlement-pending', 'settlement-pending']);
    expect(since(NOW_SEC - 900)).toEqual([null, null]);
  });

  it('G4 holds on a block older than 30 s or an inventory older than 120 s', () => {
    expect(holds({ snapshot: { chain: { blockTs: NOW_SEC - 40 } } })).toEqual(['stale-data', 'stale-data']);
    expect(holds({ snapshot: { chain: { blockTs: NOW_SEC - 30 } } })).toEqual([null, null]);
    expect(holds({ snapshot: { market: { inventoryTs: NOW_SEC - 121 } } })).toEqual([
      'stale-data',
      'stale-data',
    ]);
    expect(holds({ snapshot: { market: { inventoryTs: NOW_SEC - 120 } } })).toEqual([null, null]);
  });

  it('G5 holds when the server clock is more than maxClockSkewMs away', () => {
    expect(holds({ snapshot: { memo: { serverSkewMs: 5000 } } })).toEqual(['clock-skew', 'clock-skew']);
    expect(holds({ snapshot: { memo: { serverSkewMs: -5000 } } })).toEqual(['clock-skew', 'clock-skew']);
    expect(holds({ snapshot: { memo: { serverSkewMs: 3000 } } })).toEqual([null, null]);
  });

  it('G6 holds when the WHYPE market is inactive, closed, missing or unlisted', () => {
    const closed = ['market-closed', 'market-closed'];
    expect(holds({ snapshot: { market: { assets: assetsWith((a) => ({ ...a, active: false })) } } })).toEqual(
      closed,
    );
    expect(
      holds({ snapshot: { market: { assets: assetsWith((a) => ({ ...a, marketOpen: false })) } } }),
    ).toEqual(closed);
    const withoutWhype = fixtureAssets().filter((a) => a.symbol !== 'WHYPE');
    expect(holds({ snapshot: { market: { assets: withoutWhype } } })).toEqual(closed);
    expect(holds({ snapshot: { market: { listings: [] } } })).toEqual(closed);
  });

  it('G7 holds in live mode until the startup quiet period has passed', () => {
    expect(holds({ snapshot: { memo: { uptimeSec: 10 } } })).toEqual(['quiet-period', 'quiet-period']);
    expect(holds({ snapshot: { memo: { uptimeSec: 600 } } })).toEqual([null, null]);
  });

  it('G8 holds while an execution or a transaction is in flight, and while the side cools down', () => {
    expect(holds({ snapshot: { memo: { inFlight: true } } })).toEqual(['in-flight', 'in-flight']);
    expect(holds({ snapshot: { chain: { pendingNonceGap: 1 } } })).toEqual(['tx-pending', 'tx-pending']);
    const coolingPut = (untilSec: number) =>
      holds({ snapshot: { memo: { cooldownUntilSec: { put: untilSec } } } });
    expect(coolingPut(NOW_SEC + 60)).toEqual(['cooldown', null]);
    expect(coolingPut(NOW_SEC)).toEqual([null, null]);
  });

  it('G9 holds in live mode below the native HYPE gas reserve', () => {
    expect(holds({ snapshot: { chain: { nativeHypeE18: 10n ** 16n } } })).toEqual([
      'gas-reserve',
      'gas-reserve',
    ]);
  });

  it('G10 holds on the kill switch, a disabled wheel and a frontend change when pausing on it', () => {
    expect(holds({ snapshot: { memo: { stopFile: true } } })).toEqual(['kill-switch', 'kill-switch']);
    expect(holds({ config: { enabled: false } })).toEqual(['disabled', 'disabled']);
    const changed = { snapshot: { memo: { frontendChanged: true } } };
    expect(holds(changed)).toEqual(['frontend-changed', 'frontend-changed']);
    expect(holds({ ...changed, config: { safety: { pauseOnFrontendChange: false } } })).toEqual([null, null]);
  });

  it('G10 holds on the STOP file in live only: dry-run continues (spec §9.4)', () => {
    const stop = { memo: { stopFile: true } };
    expect(holds({ snapshot: { ...stop, mode: 'live' } })).toEqual(['kill-switch', 'kill-switch']);
    expect(holds({ snapshot: { ...stop, mode: 'dry-run' } })).toEqual([null, null]);
    expect(gates('put', { snapshot: { ...stop, mode: 'dry-run' } }).results).toContainEqual({
      id: 'G10',
      pass: true,
    });
    // A disabled wheel and a frontend change hold in both modes.
    expect(holds({ snapshot: { mode: 'dry-run' }, config: { enabled: false } })).toEqual([
      'disabled',
      'disabled',
    ]);
    expect(holds({ snapshot: { mode: 'dry-run', memo: { frontendChanged: true } } })).toEqual([
      'frontend-changed',
      'frontend-changed',
    ]);
  });

  it('G11 holds in live mode at the daily deployment or notional limit', () => {
    expect(holds({ state: { deploymentsLast24h: 4 } })).toEqual(['daily-limit', 'daily-limit']);
    expect(holds({ state: { deploymentsLast24h: 3 } })).toEqual([null, null]);
    expect(holds({ state: { notionalLast24h6: 20000_000000n } })).toEqual(['daily-limit', 'daily-limit']);
  });
});

describe('checkGates side gates', () => {
  it('S1 holds a disabled side only', () => {
    expect(holds({ config: { put: { enabled: false } } })).toEqual(['disabled', null]);
  });

  it('S2 holds a side deployed less than minIntervalHours ago', () => {
    expect(holds({ state: { lastDeployTs: { put: NOW_SEC - HOUR_SEC } } })).toEqual(['interval', null]);
    expect(holds({ state: { lastDeployTs: { put: NOW_SEC - DAY_SEC } } })).toEqual([null, null]);
  });

  it('S3 holds a side whose tranche is below one lot', () => {
    // No free USDC: the put's room is empty while the call still sizes a lot.
    expect(holds({ snapshot: { chain: { usdc6: 0n } } })).toEqual(['below-min-lot', null]);
  });

  it('S3 reports the cap when only the cap headroom, at a 95 % margin, is below one lot', () => {
    const hypeContracts = (usageE18: bigint): Cap[] => [
      { name: 'HYPE', type: 'CONTRACTS', capE18: 100n * E18, usageE18 },
    ];
    // 95 − 70 leaves exactly one lot; 95 − 71 does not.
    expect(holds({ snapshot: { market: { caps: hypeContracts(70n * E18) } } })).toEqual([null, null]);
    expect(holds({ snapshot: { market: { caps: hypeContracts(71n * E18) } } })).toEqual(['cap', 'cap']);
  });

  it('S3 prices NOTIONAL cap headroom at spot on both sides', () => {
    const hypeNotional = (usageE18: bigint): Cap[] => [
      { name: 'HYPE', type: 'NOTIONAL', capE18: 2000n * E18, usageE18 },
    ];
    // 0.95 × 2 000 − 900 = 1 000 USD is one lot at the 40 spot; at the put's 78.5 strike it would not be.
    expect(holds({ snapshot: { market: { caps: hypeNotional(900n * E18) } } })).toEqual([null, null]);
    expect(holds({ snapshot: { market: { caps: hypeNotional(901n * E18) } } })).toEqual(['cap', 'cap']);
  });

  it('S4 holds calls while the basis is unreliable or undefined', () => {
    const basis = { basisE8: 5000000000n, qtyE18: 130n * E18, residualE18: 0n, reliable: false };
    expect(holds({ state: { basis } })).toEqual([null, 'basis-unreliable']);
    expect(holds({ state: { basis: { ...basis, reliable: true, basisE8: null } } })).toEqual([
      null,
      'basis-unreliable',
    ]);
  });

  it('S5 holds puts while HYPE is above maxHypeExposurePct of the capital', () => {
    const config = { safety: { maxHypeExposurePct: 0.5 } };
    // The put total is 6 962.5 USDC. 596.25 WHYPE in the wallet plus 100 locked is 696.25 at 40, 27 850 USD: 80 %.
    const at80 = { snapshot: { chain: { whypeE18: 59625n * 10n ** 16n } }, config };
    expect(holds(at80)).toEqual(['exposure-cap', null]);
    // 74.0625 + 100 WHYPE at 40 is 6 962.5 USD: exactly 50 %.
    const at50 = { snapshot: { chain: { whypeE18: 740625n * 10n ** 14n } }, config };
    expect(holds(at50)).toEqual([null, null]);
  });
});
