import type { Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { fixturePositions, snapshotFromFixtures, wheelConfig } from '../../test/helpers/wheelSnapshot.ts';
import type { Position } from '../domain/types.ts';
import type { TradeResult } from '../execution/types.ts';
import type { Snapshot } from '../strategy/wheel/types.ts';
import { applyTradeResult, resolveWaits, type TradeContext } from './cooldown.ts';
import { Memo } from './memo.ts';

const E18 = 10n ** 18n;
const NOW_SEC = 1792144000;
const TX: Hex = `0x${'ab'.repeat(32)}`;
const OTHER_TX: Hex = `0x${'cd'.repeat(32)}`;
const TERMS = { isPut: true, strikeE8: 7800000000n, expirySec: 1792742400, quantityE18: 25n * E18 };
const c = wheelConfig();
const dry = wheelConfig({ mode: 'dry-run' });

function context(patch: Partial<TradeContext> = {}): TradeContext {
  return {
    terms: TERMS,
    counterBefore: 87n,
    writeStop: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
    ...patch,
  };
}

function aborted(stage: Extract<TradeResult, { status: 'aborted' }>['stage'], extra = {}): TradeResult {
  return { status: 'aborted', stage, message: `${stage} failed`, ...extra };
}

const rejected: TradeResult = {
  status: 'aborted',
  stage: 'confirm-rejected',
  message: 'confirm rejected (-32000): no',
  bookkeepingErrors: [],
};
const reverted: TradeResult = { status: 'reverted', txHash: TX, bookkeepingErrors: [] };

function unknown(reason: Extract<TradeResult, { status: 'unknown' }>['reason']): TradeResult {
  return { status: 'unknown', reason, confirmSentAtSec: NOW_SEC - 5, bookkeepingErrors: [] };
}

function filled(txHash: Hex = TX): TradeResult {
  const quote = {} as Extract<TradeResult, { status: 'filled' }>['quote'];
  return { status: 'filled', txHash, quote, premium6: 37_500000n, gasFee6: 10_000n, bookkeepingErrors: [] };
}

/** A memo with the put side mid-trade: its last confirm sent and its cooldown running. */
function trading(): Memo {
  const memo = new Memo(0);
  memo.lastConfirmSec.put = NOW_SEC - 5;
  memo.cooldownUntilSec.put = NOW_SEC + 1800;
  return memo;
}

describe('applyTradeResult: §7.5 cooldowns', () => {
  it.each([
    'precheck',
    'approve',
    'requote',
    'price-floor',
    'gas',
    'guard',
    'sign',
    'shutdown',
    'dry-run',
  ] as const)('leaves the memo alone for an abort at %s, before any confirm', (stage) => {
    const memo = new Memo(0);
    const ctx = context();
    applyTradeResult(memo, 'put', aborted(stage, { checkId: 'C10' }), NOW_SEC, c, ctx);
    expect(memo.cooldownUntilSec).toEqual({});
    expect(memo.confirmErrorsSec).toEqual([]);
    expect(memo.haltedLive).toBe(false);
    expect(ctx.writeStop).not.toHaveBeenCalled();
  });

  it.each([
    ['confirm-rejected', rejected],
    ['reverted', reverted],
  ] as const)('%s: 60 s cooldown and the last confirm cleared, so the interval is not used', (_, result) => {
    const memo = trading();
    applyTradeResult(memo, 'put', result, NOW_SEC, c, context());
    expect(memo.cooldownUntilSec.put).toBe(NOW_SEC + 60);
    expect(memo.lastConfirmSec.put).toBeUndefined();
    expect(memo.confirmErrorsSec).toEqual([NOW_SEC]);
    expect(memo.revertsSec).toEqual(result.status === 'reverted' ? [NOW_SEC] : []);
    expect(memo.haltedLive).toBe(false);
  });

  it('halts live on the third confirm error within an hour', () => {
    const memo = new Memo(0);
    const ctx = context();
    applyTradeResult(memo, 'put', rejected, NOW_SEC, c, ctx);
    applyTradeResult(memo, 'call', rejected, NOW_SEC + 1200, c, ctx);
    expect(ctx.writeStop).not.toHaveBeenCalled();
    applyTradeResult(memo, 'put', rejected, NOW_SEC + 3599, c, ctx);
    expect(ctx.writeStop).toHaveBeenCalledOnce();
    expect(memo.haltedLive).toBe(true);
    expect(ctx.log.fatal).toHaveBeenCalledOnce();
  });

  it('does not count confirm errors more than an hour old', () => {
    const memo = new Memo(0);
    const ctx = context();
    applyTradeResult(memo, 'put', rejected, NOW_SEC, c, ctx);
    applyTradeResult(memo, 'put', rejected, NOW_SEC + 1800, c, ctx);
    applyTradeResult(memo, 'put', rejected, NOW_SEC + 3600, c, ctx);
    expect(ctx.writeStop).not.toHaveBeenCalled();
    expect(memo.haltedLive).toBe(false);
  });

  it('halts live on the second revert within 24 h', () => {
    const memo = new Memo(0);
    const ctx = context();
    applyTradeResult(memo, 'put', reverted, NOW_SEC, c, ctx);
    expect(memo.haltedLive).toBe(false);
    applyTradeResult(memo, 'call', reverted, NOW_SEC + 86_399, c, ctx);
    expect(ctx.writeStop).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('revert'));
    expect(memo.haltedLive).toBe(true);
  });

  it('does not count a revert more than 24 h old', () => {
    const memo = new Memo(0);
    const ctx = context();
    applyTradeResult(memo, 'put', reverted, NOW_SEC, c, ctx);
    applyTradeResult(memo, 'put', reverted, NOW_SEC + 86_400, c, ctx);
    expect(memo.haltedLive).toBe(false);
  });

  it('halts even when the STOP file cannot be written', () => {
    const memo = new Memo(0);
    const ctx = context({
      writeStop: vi.fn(() => {
        throw new Error('EACCES');
      }),
    });
    applyTradeResult(memo, 'put', reverted, NOW_SEC, c, ctx);
    applyTradeResult(memo, 'put', reverted, NOW_SEC + 60, c, ctx);
    expect(memo.haltedLive).toBe(true);
    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.any(String),
    );
  });

  it('filled: waits for the txHash to appear, cooling the side down meanwhile', () => {
    const memo = trading();
    applyTradeResult(memo, 'put', filled(), NOW_SEC, c, context());
    expect(memo.pendingVisibility).toEqual([{ side: 'put', txHash: TX, sinceSec: NOW_SEC }]);
    expect(memo.cooldownUntilSec.put).toBe(NOW_SEC + 1800);
    expect(memo.lastConfirmSec.put).toBe(NOW_SEC - 5);
  });

  it('unknown: waits for evidence and never re-signs meanwhile', () => {
    const memo = trading();
    applyTradeResult(memo, 'put', unknown('receipt-timeout'), NOW_SEC, c, context());
    expect(memo.unknownWaits).toEqual([
      { side: 'put', confirmSentAtSec: NOW_SEC - 5, counterBefore: 87n, sinceSec: NOW_SEC, terms: TERMS },
    ]);
    expect(memo.cooldownUntilSec.put).toBe(NOW_SEC + 1800);
    expect(memo.haltedLive).toBe(false);
  });

  it('unknown(verify-failed) halts live whether or not STOP was written', () => {
    const memo = trading();
    applyTradeResult(memo, 'put', unknown('verify-failed'), NOW_SEC, c, context());
    expect(memo.haltedLive).toBe(true);
    expect(memo.unknownWaits).toHaveLength(1);
  });

  it('logs every bookkeeping error and halts on a failed STOP write', () => {
    const memo = trading();
    const ctx = context();
    const result: TradeResult = { ...filled(), bookkeepingErrors: ['record(receipt): ENOSPC'] };
    applyTradeResult(memo, 'put', result, NOW_SEC, c, ctx);
    expect(ctx.log.error).toHaveBeenCalledOnce();
    expect(memo.haltedLive).toBe(false);

    const stopFailed: TradeResult = {
      ...unknown('verify-failed'),
      bookkeepingErrors: ['writeStop: EACCES', 'record(stop): EACCES'],
    };
    const other = new Memo(0);
    const ctx2 = context();
    applyTradeResult(other, 'call', stopFailed, NOW_SEC, c, ctx2);
    expect(ctx2.log.error).toHaveBeenCalledTimes(2);
    expect(other.haltedLive).toBe(true);
  });

  it('halts live on the second APR echo disagreement, not on other C7 failures', () => {
    const memo = new Memo(0);
    const ctx = context();
    const echo = aborted('guard', {
      checkId: 'C7',
      message: 'our APR 0.75 vs quoted 0.774: more than 1 pp apart',
    });
    applyTradeResult(
      memo,
      'put',
      aborted('guard', { checkId: 'C7', message: 'price is zero' }),
      NOW_SEC,
      c,
      ctx,
    );
    applyTradeResult(memo, 'put', echo, NOW_SEC, c, ctx);
    expect(memo.aprEchoDisagreements).toBe(1);
    expect(memo.haltedLive).toBe(false);
    applyTradeResult(memo, 'call', echo, NOW_SEC + 60, c, ctx);
    expect(memo.aprEchoDisagreements).toBe(2);
    expect(ctx.writeStop).toHaveBeenCalledExactlyOnceWith('apr echo disagreement twice');
    expect(memo.haltedLive).toBe(true);
    expect(memo.cooldownUntilSec).toEqual({});
  });

  it('dry-run never writes STOP: it logs what live would have halted on', () => {
    const memo = new Memo(0);
    const ctx = context();
    const echo = aborted('guard', {
      checkId: 'C7',
      message: 'our APR 0.75 vs quoted 0.774: more than 1 pp apart',
    });
    applyTradeResult(memo, 'put', echo, NOW_SEC, dry, ctx);
    applyTradeResult(memo, 'put', echo, NOW_SEC, dry, ctx);
    expect(ctx.writeStop).not.toHaveBeenCalled();
    expect(ctx.log.error).toHaveBeenCalledOnce();
  });

  it('an echo abort in live halts (the execution wrote STOP)', () => {
    const memo = new Memo(0);
    applyTradeResult(memo, 'put', aborted('echo', { echoOk: false }), NOW_SEC, c, context());
    expect(memo.haltedLive).toBe(true);
    const dryMemo = new Memo(0);
    applyTradeResult(dryMemo, 'put', aborted('echo', { echoOk: false }), NOW_SEC, dry, context());
    expect(dryMemo.haltedLive).toBe(false);
  });
});

describe('resolveWaits', () => {
  function io() {
    return {
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
      record: vi.fn(),
    };
  }

  function position(patch: Partial<Position>): Position {
    const [base] = fixturePositions();
    if (base === undefined) throw new Error('no fixture position');
    return { ...base, ...patch };
  }

  function tickAt(nowSec: number, patch: { positions?: Position[]; vaultCounter?: bigint } = {}): Snapshot {
    return snapshotFromFixtures({
      nowSec,
      positions: patch.positions ?? fixturePositions(),
      chain: { vaultCounter: patch.vaultCounter ?? 87n },
    });
  }

  it('clears the cooldown when the filled txHash appears and records the visibility latency', () => {
    const memo = trading();
    applyTradeResult(memo, 'put', filled(), NOW_SEC, c, context());
    const effects = io();

    resolveWaits(memo, tickAt(NOW_SEC + 60), c, effects);
    expect(memo.cooldownUntilSec.put).toBe(NOW_SEC + 1800);
    expect(memo.pendingVisibility).toHaveLength(1);

    const visible = position({ txHash: TX.toUpperCase().replace('0X', '0x') as Hex });
    resolveWaits(memo, tickAt(NOW_SEC + 120, { positions: [...fixturePositions(), visible] }), c, effects);
    expect(memo.cooldownUntilSec.put).toBeUndefined();
    expect(memo.pendingVisibility).toEqual([]);
    expect(effects.record).toHaveBeenCalledExactlyOnceWith(
      'executions',
      expect.objectContaining({ step: 'visible', side: 'put', txHash: TX, visibilityLatencySec: 120 }),
    );
  });

  it('gives up on visibility after unknownMaxWaitSec with an error', () => {
    const memo = trading();
    applyTradeResult(memo, 'put', filled(), NOW_SEC, c, context());
    const effects = io();
    resolveWaits(memo, tickAt(NOW_SEC + 1799), c, effects);
    expect(memo.pendingVisibility).toHaveLength(1);
    resolveWaits(memo, tickAt(NOW_SEC + 1800), c, effects);
    expect(memo.pendingVisibility).toEqual([]);
    expect(effects.log.error).toHaveBeenCalledOnce();
  });

  it('resolves an unknown result by a matching position created after the confirm was sent', () => {
    const memo = trading();
    applyTradeResult(memo, 'put', unknown('confirm-timeout'), NOW_SEC, c, context());
    const effects = io();
    const terms = {
      isPut: true,
      strikeE8: TERMS.strikeE8,
      expirySec: TERMS.expirySec,
      quantityE18: TERMS.quantityE18,
    };
    // An older row with the same terms, and a newer one with other terms, prove nothing.
    const older = position({ ...terms, createdAtSec: NOW_SEC - 6, txHash: OTHER_TX });
    const otherTerms = position({
      ...terms,
      quantityE18: 50n * E18,
      createdAtSec: NOW_SEC,
      txHash: OTHER_TX,
    });
    resolveWaits(memo, tickAt(NOW_SEC + 60, { positions: [older, otherTerms] }), c, effects);
    expect(memo.unknownWaits).toHaveLength(1);
    expect(memo.cooldownUntilSec.put).toBe(NOW_SEC + 1800);

    const ours = position({ ...terms, createdAtSec: NOW_SEC - 4, txHash: TX });
    resolveWaits(memo, tickAt(NOW_SEC + 120, { positions: [older, ours] }), c, effects);
    expect(memo.unknownWaits).toEqual([]);
    expect(memo.cooldownUntilSec.put).toBeUndefined();
    expect(effects.record).toHaveBeenCalledExactlyOnceWith(
      'executions',
      expect.objectContaining({ step: 'unknown-resolved', side: 'put', evidence: 'position' }),
    );
  });

  it('resolves an unknown result when the vault counter increased', () => {
    const memo = trading();
    applyTradeResult(memo, 'put', unknown('socket-closed'), NOW_SEC, c, context());
    const effects = io();
    resolveWaits(memo, tickAt(NOW_SEC + 60, { vaultCounter: 87n }), c, effects);
    expect(memo.unknownWaits).toHaveLength(1);
    resolveWaits(memo, tickAt(NOW_SEC + 120, { vaultCounter: 88n }), c, effects);
    expect(memo.unknownWaits).toEqual([]);
    expect(memo.cooldownUntilSec.put).toBeUndefined();
    expect(effects.record).toHaveBeenCalledWith(
      'executions',
      expect.objectContaining({ step: 'unknown-resolved', evidence: 'vault-counter' }),
    );
  });

  it('keeps the unknown cooldown until unknownMaxWaitSec, then logs an error and unblocks', () => {
    const memo = trading();
    applyTradeResult(memo, 'put', unknown('shutdown'), NOW_SEC, c, context());
    const effects = io();
    resolveWaits(memo, tickAt(NOW_SEC + 1799), c, effects);
    expect(memo.cooldownUntilSec.put).toBe(NOW_SEC + 1800);
    expect(effects.log.error).not.toHaveBeenCalled();
    resolveWaits(memo, tickAt(NOW_SEC + 1800), c, effects);
    expect(memo.unknownWaits).toEqual([]);
    expect(memo.cooldownUntilSec.put).toBeUndefined();
    expect(effects.log.error).toHaveBeenCalledOnce();
    expect(effects.record).toHaveBeenCalledWith(
      'executions',
      expect.objectContaining({ step: 'unknown-expired', side: 'put' }),
    );
  });
});
