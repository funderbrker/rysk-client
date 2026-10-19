import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../strategy/wheel/types.ts';
import { backoffKeyOf, Memo } from './memo.ts';

const NOW_SEC = 1792144000;
const SPOT_E8 = 8000000000n;
const KEY = backoffKeyOf('put', 7800000000n, 1792742400);

describe('backoffKeyOf', () => {
  it('joins side, strike and expiry', () => {
    expect(KEY).toBe('put|7800000000|1792742400');
  });
});

describe('Memo: key backoff', () => {
  it('backs a key off 5 min, then doubles per below-floor quote up to 60 min', () => {
    const memo = new Memo(0);
    const delays: number[] = [];
    let nowSec = NOW_SEC;
    for (let n = 1; n <= 6; n++) {
      memo.backoffKey(KEY, nowSec, SPOT_E8, 0.5);
      const entry = memo.keyBackoff.get(KEY);
      delays.push((entry?.untilSec ?? 0) - nowSec);
      expect(entry?.n).toBe(n);
      nowSec = entry?.untilSec ?? nowSec;
    }
    expect(delays).toEqual([300, 600, 1200, 2400, 3600, 3600]);
  });

  it('holds the key until the delay has passed', () => {
    const memo = new Memo(0);
    expect(memo.isBackedOff(KEY, NOW_SEC)).toBe(false);
    memo.backoffKey(KEY, NOW_SEC, SPOT_E8, 0.5);
    expect(memo.isBackedOff(KEY, NOW_SEC)).toBe(true);
    expect(memo.isBackedOff(KEY, NOW_SEC + 299)).toBe(true);
    expect(memo.isBackedOff(KEY, NOW_SEC + 300)).toBe(false);
    expect(memo.isBackedOff(backoffKeyOf('call', 7800000000n, 1792742400), NOW_SEC)).toBe(false);
  });

  it('resets when spot moved more than 2 % from the spot at the backoff', () => {
    const memo = new Memo(0);
    memo.backoffKey(KEY, NOW_SEC, SPOT_E8, 0.5);
    // 2 % exactly (80 → 81.6 and 78.4) keeps it.
    expect(memo.resetBackoffIf(KEY, 8160000000n, 0.5)).toBe(false);
    expect(memo.resetBackoffIf(KEY, 7840000000n, 0.5)).toBe(false);
    expect(memo.isBackedOff(KEY, NOW_SEC)).toBe(true);
    expect(memo.resetBackoffIf(KEY, 8160000001n, 0.5)).toBe(true);
    expect(memo.keyBackoff.has(KEY)).toBe(false);

    memo.backoffKey(KEY, NOW_SEC, SPOT_E8, 0.5);
    expect(memo.resetBackoffIf(KEY, 7839999999n, 0.5)).toBe(true);
    // The count starts over after a reset.
    memo.backoffKey(KEY, NOW_SEC, SPOT_E8, 0.5);
    expect(memo.keyBackoff.get(KEY)?.n).toBe(1);
  });

  it("resets when the key's indicative APR rose more than 25 %", () => {
    const memo = new Memo(0);
    memo.backoffKey(KEY, NOW_SEC, SPOT_E8, 0.4);
    expect(memo.resetBackoffIf(KEY, SPOT_E8, 0.5)).toBe(false);
    expect(memo.resetBackoffIf(KEY, SPOT_E8, 0.3)).toBe(false);
    expect(memo.resetBackoffIf(KEY, SPOT_E8, 0.5001)).toBe(true);
    expect(memo.isBackedOff(KEY, NOW_SEC)).toBe(false);
  });

  it('backs a custom strike off without an indicative APR: only a spot move resets it', () => {
    const memo = new Memo(0);
    const custom = backoffKeyOf('call', 10000000000n, 1792742400);
    memo.backoffKey(custom, NOW_SEC, SPOT_E8, null);
    expect(memo.keyBackoff.get(custom)).toMatchObject({ n: 1, untilSec: NOW_SEC + 300, indicativeApr: null });
    expect(memo.resetBackoffIf(custom, SPOT_E8, null)).toBe(false);
    // A listing's APR on the same key later on does not reset it either.
    expect(memo.resetBackoffIf(custom, SPOT_E8, 9)).toBe(false);
    expect(memo.isBackedOff(custom, NOW_SEC)).toBe(true);
    expect(memo.resetBackoffIf(custom, 8160000001n, null)).toBe(true);
  });

  it('ignores a reset for a key that is not backed off', () => {
    expect(new Memo(0).resetBackoffIf(KEY, 1n, 9)).toBe(false);
  });

  it('forgets the keys of expired listings', () => {
    const memo = new Memo(0);
    const later = backoffKeyOf('call', 9000000000n, 1793347200);
    memo.backoffKey(KEY, NOW_SEC, SPOT_E8, 0.5);
    memo.backoffKey(later, NOW_SEC, SPOT_E8, 0.5);
    memo.forgetExpiredKeys(1792742400);
    expect([...memo.keyBackoff.keys()]).toEqual([later]);
  });
});

describe('Memo: lastNoPendingSeenSec', () => {
  it('starts null and is set once, on the first tick of a run without pending settlements', () => {
    const memo = new Memo(0);
    expect(memo.lastNoPendingSeenSec).toBeNull();
    memo.observePendingSettlement(false, NOW_SEC);
    expect(memo.lastNoPendingSeenSec).toBe(NOW_SEC);
    // Not refreshed while the run lasts, or G3 would hold forever.
    memo.observePendingSettlement(false, NOW_SEC + 60);
    memo.observePendingSettlement(false, NOW_SEC + 1000);
    expect(memo.lastNoPendingSeenSec).toBe(NOW_SEC);
  });

  it('is null while a row is pending and restarts with the next run', () => {
    const memo = new Memo(0);
    memo.observePendingSettlement(false, NOW_SEC);
    memo.observePendingSettlement(true, NOW_SEC + 60);
    expect(memo.lastNoPendingSeenSec).toBeNull();
    memo.observePendingSettlement(true, NOW_SEC + 120);
    expect(memo.lastNoPendingSeenSec).toBeNull();
    memo.observePendingSettlement(false, NOW_SEC + 180);
    expect(memo.lastNoPendingSeenSec).toBe(NOW_SEC + 180);
  });
});

describe('Memo: serverSkewMs', () => {
  const blockTs = NOW_SEC;

  it('is the REST skew when the block is in the past', () => {
    const memo = new Memo(0);
    memo.observeServerDate(NOW_SEC * 1000 + 1000, NOW_SEC * 1000 + 1500);
    memo.updateServerSkew(NOW_SEC * 1000 + 20_000, blockTs);
    // A 20 s old block is G4's to judge, not skew.
    expect(memo.serverSkewMs).toBe(500);
  });

  it('counts a block from the future as skew when it is the larger', () => {
    const memo = new Memo(0);
    memo.observeServerDate(NOW_SEC * 1000 - 1000, NOW_SEC * 1000 - 500);
    memo.updateServerSkew(NOW_SEC * 1000 - 4000, blockTs);
    expect(memo.serverSkewMs).toBe(-4000);
  });

  it('keeps the REST skew when it is larger than a future block', () => {
    const memo = new Memo(0);
    memo.observeServerDate(NOW_SEC * 1000, NOW_SEC * 1000 + 5000);
    memo.updateServerSkew(NOW_SEC * 1000 - 1000, blockTs);
    expect(memo.serverSkewMs).toBe(5000);
  });

  it('uses the block alone before any REST date was seen', () => {
    const memo = new Memo(0);
    memo.updateServerSkew(NOW_SEC * 1000 + 3000, blockTs);
    expect(memo.serverSkewMs).toBe(0);
    memo.updateServerSkew(NOW_SEC * 1000 - 3500, blockTs);
    expect(memo.serverSkewMs).toBe(-3500);
  });
});

describe('Memo: snapshotMemo', () => {
  it("is assignable to the snapshot's memo and copies the per-side maps", () => {
    const memo = new Memo(1000);
    memo.cooldownUntilSec.put = NOW_SEC + 60;
    memo.lastConfirmSec.call = NOW_SEC;
    memo.uptimeSec = 42;
    const view: Snapshot['memo'] = memo.snapshotMemo();
    expect(view).toEqual({
      lastConfirmSec: { call: NOW_SEC },
      cooldownUntilSec: { put: NOW_SEC + 60 },
      simulatedDeploySec: {},
      inFlight: false,
      uptimeSec: 42,
      serverSkewMs: 0,
      frontendChanged: false,
      stopFile: false,
      lastNoPendingSeenSec: null,
    });
    memo.cooldownUntilSec.put = 1;
    expect(view.cooldownUntilSec.put).toBe(NOW_SEC + 60);
  });

  it('starts with the process state empty', () => {
    const memo = new Memo(1234);
    expect(memo.startedAtMs).toBe(1234);
    expect(memo.haltedLive).toBe(false);
    expect(memo.aprEchoDisagreementsSec).toEqual([]);
    expect(memo.usedQuoteNonces.size).toBe(0);
    expect(memo.lastNonceMs).toEqual({ value: 0 });
    expect(memo.pendingVisibility).toEqual([]);
    expect(memo.unknownWaits).toEqual([]);
    expect(memo.rejectedWatches).toEqual([]);
    expect(memo.replanDueSec).toEqual({});
  });
});
