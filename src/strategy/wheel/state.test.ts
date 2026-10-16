import { describe, expect, it } from 'vitest';
import {
  ANCHOR,
  fixturePositions,
  NOW_SEC,
  snapshotFromFixtures,
  wheelConfig,
} from '../../../test/helpers/wheelSnapshot.ts';
import { TOKENS } from '../../domain/constants.ts';
import type { Position } from '../../domain/types.ts';
import type { WheelConfig } from './config.ts';
import { deriveState } from './state.ts';
import type { WheelState } from './types.ts';

const E18 = 10n ** 18n;
const DAY_SEC = 86400;

// The fixture's open rows: a managed put (25 at 78.5, created 1792131925, expiring 1793347200) and two managed
// calls of 50 (the later created 1791196075 and expiring 1792742400; the other expiring 1793347200).
const OPEN_PUT_CREATED_SEC = 1792131925;
const LATEST_CALL_CREATED_SEC = 1791196075;
const FIRST_OPEN_EXPIRY_SEC = 1792742400;
const LAST_OPEN_EXPIRY_SEC = 1793347200;
/** Three rows expire here, after the anchor and before NOW_SEC, all OTM: two managed puts and a managed call. */
const LAST_SETTLED_EXPIRY_SEC = 1792137600;

const PUT_LOCKED_6 = 1962500000n;
const BASELINE_CAPITAL: WheelState['capital'] = {
  put: { free: 5000_000000n, locked: PUT_LOCKED_6, pending: 0n, total: 6962500000n, budget: 6962500000n },
  call: { free: 30n * E18, locked: 100n * E18, pending: 0n, total: 130n * E18, budget: 130n * E18 },
};

function withAnchorTs(ts: number): WheelConfig {
  const config = wheelConfig();
  return { ...config, basis: { ...config.basis, anchor: { ...ANCHOR, ts } } };
}

const isOpenPut = (p: Position): boolean => p.isPut && p.status === 'open';
const isLatestCall = (p: Position): boolean => p.createdAtSec === LATEST_CALL_CREATED_SEC;
const isOtherOpenCall = (p: Position): boolean =>
  !p.isPut && p.status === 'open' && p.expirySec === LAST_OPEN_EXPIRY_SEC;
const isSettled = (p: Position): boolean => p.status === 'settled';

function findFixture(positions: Position[], pick: (p: Position) => boolean): number {
  const index = positions.findIndex(pick);
  if (index < 0) throw new Error('no fixture position matches');
  return index;
}

/** The fixture positions with the first one matching each `pick` replaced by its `edit`. */
function edited(...edits: [pick: (p: Position) => boolean, edit: (p: Position) => Position][]): Position[] {
  let positions = fixturePositions();
  for (const [pick, edit] of edits) {
    const index = findFixture(positions, pick);
    positions = positions.with(index, edit(positions[index] as Position));
  }
  return positions;
}

/** A fixture position, for appending a copy of it. */
function fixturePosition(pick: (p: Position) => boolean): Position {
  const positions = fixturePositions();
  return positions[findFixture(positions, pick)] as Position;
}

/** A deterministic Fisher–Yates shuffle (Park–Miller generator). */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 48271) % 2147483647;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe('deriveState on the fixture', () => {
  const state = deriveState(snapshotFromFixtures(), wheelConfig());

  it('is consistent with 87 vaults on chain and reports nothing', () => {
    expect(state.consistency).toBe('ok');
    expect(state.anomalies).toEqual([]);
    expect(state.warnings).toEqual([]);
  });

  it('locks the open put at its strike and the open calls in WHYPE', () => {
    expect(state.capital).toEqual(BASELINE_CAPITAL);
  });

  it('keeps the anchor basis when no ITM settlement follows it and the observed HYPE matches', () => {
    expect(state.basis).toEqual({
      basisE8: 5000000000n,
      qtyE18: 130n * E18,
      residualE18: 0n,
      reliable: true,
    });
  });

  it('dates the last deployments from the managed rows and counts the put of the last 24 h', () => {
    expect(state.lastDeployTs).toEqual({ put: OPEN_PUT_CREATED_SEC, call: LATEST_CALL_CREATED_SEC });
    expect(state.deploymentsLast24h).toBe(1);
    expect(state.notionalLast24h6).toBe(PUT_LOCKED_6);
  });

  it('outputs every row once, classified, in key order', () => {
    const keys = fixturePositions().map((p) => p.key);
    expect(state.rows.map((row) => row.position.key)).toEqual(keys.toSorted());
    const openPut = state.rows.find((row) => isOpenPut(row.position));
    expect(openPut).toMatchObject({ cls: 'managedPut', phase: 'open' });
  });
});

describe('deriveState chain cross-check', () => {
  it('reads a vault counter above the API row count as API lag, without an anomaly', () => {
    const state = deriveState(snapshotFromFixtures({ chain: { vaultCounter: 88n } }), wheelConfig());
    expect(state.consistency).toBe('api-lag');
    expect(state.anomalies).toEqual([]);
  });

  it('reads a vault counter below the API row count as inconsistent, with an anomaly', () => {
    const state = deriveState(snapshotFromFixtures({ chain: { vaultCounter: 86n } }), wheelConfig());
    expect(state.consistency).toBe('inconsistent');
    expect(state.anomalies).toEqual([expect.stringMatching(/vault counter 86 .* 87 /)]);
  });

  it('counts the other chain-999 rows', () => {
    const state = deriveState(snapshotFromFixtures({ otherRowCount: 9 }), wheelConfig());
    expect(state.consistency).toBe('api-lag');
  });
});

describe('deriveState de-duplication and order', () => {
  it('counts a duplicated row once, with one warning, and stays consistent', () => {
    const positions = [...fixturePositions(), fixturePosition(isOpenPut)];
    const state = deriveState(snapshotFromFixtures({ positions }), wheelConfig());
    expect(state.capital).toEqual(BASELINE_CAPITAL);
    expect(state.rows).toHaveLength(77);
    expect(state.consistency).toBe('ok');
    expect(state.anomalies).toEqual([]);
    expect(state.warnings).toEqual([
      expect.stringMatching(/2 rows share the key 0x[0-9a-f]+\|true\|7850000000\|/),
    ]);
  });

  it('warns once per duplicated key', () => {
    const openPut = fixturePosition(isOpenPut);
    const call = fixturePosition(isLatestCall);
    const positions = [...fixturePositions(), openPut, openPut, call];
    const state = deriveState(snapshotFromFixtures({ positions }), wheelConfig());
    expect(state.capital).toEqual(BASELINE_CAPITAL);
    expect(state.warnings).toHaveLength(2);
    expect(state.warnings).toContainEqual(expect.stringMatching(/^positions: 3 rows share the key /));
    expect(state.warnings).toContainEqual(expect.stringMatching(/^positions: 2 rows share the key /));
  });

  it('flags duplicates that disagree as an anomaly, keeping the same copy in any order', () => {
    const openPut = fixturePosition(isOpenPut);
    const revised: Position = {
      ...openPut,
      status: 'settled',
      settlement: { outcome: 'expiredOtm', collateralReturned: PUT_LOCKED_6 },
    };
    const forward = deriveState(
      snapshotFromFixtures({ positions: [...fixturePositions(), revised] }),
      wheelConfig(),
    );
    const backward = deriveState(
      snapshotFromFixtures({ positions: [revised, ...fixturePositions()].reverse() }),
      wheelConfig(),
    );
    expect(forward.anomalies).toEqual([
      expect.stringMatching(/^positions: the rows with the key .* disagree/),
    ]);
    expect(forward.warnings).toHaveLength(1);
    expect(backward).toEqual(forward);
  });

  it('derives a deep-equal state from any permutation of the rows', () => {
    const positions = [
      ...edited([isSettled, (p) => ({ ...p, status: 'unknown', settlement: null })]),
      fixturePosition(isOpenPut),
      { ...fixturePosition(isLatestCall), createdAtSec: LATEST_CALL_CREATED_SEC + 1 },
    ];
    const reference = deriveState(snapshotFromFixtures({ positions }), wheelConfig());
    expect(reference.anomalies).toHaveLength(2);
    expect(reference.warnings).toHaveLength(2);
    const permutations = [
      positions.toReversed(),
      ...[1, 7, 42, 1234567].map((seed) => shuffled(positions, seed)),
    ];
    for (const permutation of permutations) {
      expect(deriveState(snapshotFromFixtures({ positions: permutation }), wheelConfig())).toEqual(reference);
    }
  });
});

describe('deriveState anomalies', () => {
  it('flags a row with an unknown status', () => {
    const positions = edited([isSettled, (p) => ({ ...p, status: 'unknown', settlement: null })]);
    const state = deriveState(snapshotFromFixtures({ positions }), wheelConfig());
    expect(state.anomalies).toEqual([expect.stringMatching(/^row .*: unknown status$/)]);
    expect(state.rows.filter((row) => row.phase === 'unknown')).toHaveLength(1);
  });

  it('flags a settlement the payout fields do not explain, since it leaves no ledger event', () => {
    const settlement = { outcome: 'anomaly', detail: 'payout 1 with collateral returned 1' } as const;
    const positions = edited([isSettled, (p) => ({ ...p, settlement })]);
    const state = deriveState(snapshotFromFixtures({ positions }), wheelConfig());
    expect(state.anomalies).toEqual([
      expect.stringMatching(/^row .*: anomalous settlement: payout 1 with collateral returned 1$/),
    ]);
  });

  it('flags a settled row without a settlement', () => {
    const positions = edited([isSettled, (p) => ({ ...p, settlement: null })]);
    const state = deriveState(snapshotFromFixtures({ positions }), wheelConfig());
    expect(state.anomalies).toEqual([expect.stringMatching(/^row .*: settled without a settlement$/)]);
  });
});

describe('deriveState capital', () => {
  it('keeps the reserves out of free capital, never below zero, and caps the budget', () => {
    const config = wheelConfig({
      put: { reserve6: 1000_000000n, maxCapital6: 3000_000000n },
      call: { reserveE18: 40n * E18 },
    });
    const state = deriveState(snapshotFromFixtures(), config);
    expect(state.capital.put).toEqual({
      free: 4000_000000n,
      locked: PUT_LOCKED_6,
      pending: 0n,
      total: 5962500000n,
      budget: 3000_000000n,
    });
    expect(state.capital.call).toEqual({
      free: 0n,
      locked: 100n * E18,
      pending: 0n,
      total: 100n * E18,
      budget: 100n * E18,
    });
    const capped = deriveState(snapshotFromFixtures(), wheelConfig({ call: { maxCapitalE18: 50n * E18 } }));
    expect(capped.capital.call.budget).toBe(50n * E18);
  });

  it('moves rows past their expiry from locked to pending and holds the basis reconciliation', () => {
    const atFirst = deriveState(snapshotFromFixtures({ nowSec: FIRST_OPEN_EXPIRY_SEC }), wheelConfig());
    expect(atFirst.capital.call).toMatchObject({ locked: 50n * E18, pending: 50n * E18, total: 130n * E18 });
    expect(atFirst.capital.put).toMatchObject({ locked: PUT_LOCKED_6, pending: 0n });
    expect(atFirst.basis).toMatchObject({
      reliable: false,
      reason: 'settlement-pending',
      basisE8: 5000000000n,
    });
    expect(atFirst.warnings).toEqual([expect.stringMatching(/^settlement-pending: /)]);

    const atLast = deriveState(snapshotFromFixtures({ nowSec: LAST_OPEN_EXPIRY_SEC }), wheelConfig());
    expect(atLast.capital.put).toMatchObject({ locked: 0n, pending: PUT_LOCKED_6, total: 6962500000n });
    expect(atLast.capital.call).toMatchObject({ locked: 0n, pending: 100n * E18 });
  });

  it('locks WHYPE in other-stable calls but USDC only in managed puts', () => {
    const toUsdt0 = (p: Position): Position => ({ ...p, usd: TOKENS.USDT0.address });
    const positions = edited([isOpenPut, toUsdt0], [isLatestCall, toUsdt0]);
    const state = deriveState(snapshotFromFixtures({ positions }), wheelConfig());
    expect(state.capital.put).toMatchObject({ locked: 0n, total: 5000_000000n });
    expect(state.capital.call).toMatchObject({ locked: 100n * E18, total: 130n * E18 });
    expect(state.basis).toMatchObject({ basisE8: 5000000000n, residualE18: 0n, reliable: true });
  });
});

describe('deriveState basis', () => {
  it('replays the assignments and exercises that settle after the anchor', () => {
    const assigned = (p: Position): Position => ({
      ...p,
      settlement: { outcome: 'assigned', receivedUnderlyingE18: p.quantityE18 },
    });
    const exercised = (p: Position): Position => ({
      ...p,
      settlement: { outcome: 'exercised', receivedStable6: (p.quantityE18 * p.strikeE8) / 10n ** 20n },
    });
    const settledLast = (isPut: boolean) => (p: Position) =>
      p.isPut === isPut && p.expirySec === LAST_SETTLED_EXPIRY_SEC;
    // 130 at 50 plus 25 at 81 is 155 at 55; removing 25 at the average leaves 130 at 55.
    const positions = edited([settledLast(true), assigned], [settledLast(false), exercised]);
    const state = deriveState(snapshotFromFixtures({ positions }), wheelConfig());
    expect(state.basis).toEqual({
      basisE8: 5500000000n,
      qtyE18: 130n * E18,
      residualE18: 0n,
      reliable: true,
    });
  });

  it('absorbs a residual and passes the basis warnings on', () => {
    const state = deriveState(snapshotFromFixtures({ chain: { whypeE18: 40n * E18 } }), wheelConfig());
    expect(state.basis).toMatchObject({ qtyE18: 140n * E18, residualE18: 10n * E18, reliable: true });
    expect(state.warnings).toEqual([expect.stringMatching(/^external-deposit: /)]);
  });

  it('is unreliable when the anchor falls within 6 h after a basis-relevant expiry', () => {
    for (const ts of [LAST_SETTLED_EXPIRY_SEC, LAST_SETTLED_EXPIRY_SEC + 21600]) {
      const state = deriveState(snapshotFromFixtures(), withAnchorTs(ts));
      expect(state.basis).toMatchObject({ reliable: false, reason: 'anchor-in-settlement-window' });
    }
    const after = deriveState(snapshotFromFixtures(), withAnchorTs(LAST_SETTLED_EXPIRY_SEC + 21601));
    expect(after.basis.reliable).toBe(true);
  });
});

describe('deriveState deployment clock', () => {
  it('takes the latest of the managed rows, the last confirm and the simulated deployments', () => {
    const memo = {
      lastConfirmSec: { put: NOW_SEC - 60, call: 1 },
      simulatedDeploySec: { call: NOW_SEC - 30 },
    };
    const state = deriveState(snapshotFromFixtures({ memo }), wheelConfig());
    expect(state.lastDeployTs).toEqual({ put: NOW_SEC - 60, call: NOW_SEC - 30 });
  });

  it('dates a side only from its managed rows, and leaves a side without any undated', () => {
    const toUsdt0 = (p: Position): Position => ({ ...p, usd: TOKENS.USDT0.address });
    const positions = edited([isLatestCall, toUsdt0]);
    const state = deriveState(snapshotFromFixtures({ positions }), wheelConfig());
    expect(state.lastDeployTs.call).toBe(1790424335);
    const empty = deriveState(snapshotFromFixtures({ positions: [] }), wheelConfig());
    expect(empty.lastDeployTs).toEqual({});
  });

  it('counts managed deployments of the last 24 h on both sides, calls at spot', () => {
    const positions = edited(
      [isLatestCall, (p) => ({ ...p, createdAtSec: NOW_SEC - 100 })],
      [isOtherOpenCall, (p) => ({ ...p, createdAtSec: NOW_SEC - DAY_SEC })],
      [isSettled, (p) => ({ ...p, usd: TOKENS.USDT0.address, createdAtSec: NOW_SEC - 50 })],
    );
    const state = deriveState(snapshotFromFixtures({ positions }), wheelConfig());
    expect(state.deploymentsLast24h).toBe(2);
    // The put's 25 × 78.5 plus the call's 50 × 40 spot.
    expect(state.notionalLast24h6).toBe(PUT_LOCKED_6 + 2000_000000n);
  });
});
