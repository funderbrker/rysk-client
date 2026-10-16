import type { Hex } from 'viem';
import type { Position, Side } from '../domain/types.ts';
import { isAprEchoDisagreement } from '../execution/checks.ts';
import type { TradeResult } from '../execution/types.ts';
import type { WheelConfig } from '../strategy/wheel/config.ts';
import type { Snapshot } from '../strategy/wheel/types.ts';
import type { Log } from './logger.ts';
import type { Memo, TradeTerms, UnknownWait } from './memo.ts';
import type { RecordStream } from './recorder.ts';

/** How a fatal event reaches the outside: the STOP file (live only) and the log. */
export type HaltEffects = {
  /** Writes `data/STOP`; a throw is logged and never stops the halt. */
  writeStop(reason: string): void;
  log: Log;
};

/** What `applyTradeResult` needs besides the result: the traded terms and the counter for `unknown` evidence. */
export type TradeContext = HaltEffects & {
  terms: TradeTerms;
  /** The vault counter read just before `execute`. */
  counterBefore: bigint;
};

/** What `resolveWaits` reports through; `record` never throws. */
export type WaitEffects = { log: Log; record(stream: RecordStream, record: object): void };

const RETRY_COOLDOWN_SEC = 60;
const CONFIRM_ERROR_WINDOW_SEC = 3_600;
const MAX_CONFIRM_ERRORS = 3;
const REVERT_WINDOW_SEC = 86_400;
const MAX_REVERTS = 2;
const MAX_APR_ECHO_DISAGREEMENTS = 2;

/**
 * Applies one execution result to the side's cooldown (spec §7.5) and the halt rules (spec §9.4, §10):
 *
 * - `aborted` before the confirm: no cooldown. The second C7 APR echo disagreement halts live; an `echo` abort in
 *   live halts (the execution already wrote STOP).
 * - `aborted('confirm-rejected')` and `reverted`: 60 s, and `lastConfirmSec[side]` cleared so the DCA interval is
 *   not consumed; three confirm errors (either kind) within an hour, or two reverts within 24 h, halt live.
 * - `filled`: the side cools down until its `txHash` appears in the positions API, at most `unknownMaxWaitSec`.
 * - `unknown`: the side cools down until evidence that it filled (`resolveWaits`), at most `unknownMaxWaitSec`;
 *   `verify-failed` also halts live (the execution wrote STOP, or listed the failure).
 *
 * Every `bookkeepingErrors` entry is logged at error level; a failed `writeStop` halts live. `nowSec` is chain time.
 */
export function applyTradeResult(
  memo: Memo,
  side: Side,
  result: TradeResult,
  nowSec: number,
  c: WheelConfig,
  ctx: TradeContext,
): void {
  for (const error of result.bookkeepingErrors ?? []) {
    ctx.log.error({ side, error }, 'execution bookkeeping failed');
    if (error.startsWith('writeStop')) memo.haltedLive = true;
  }
  switch (result.status) {
    case 'aborted':
      if (result.stage === 'confirm-rejected') {
        confirmFailed(memo, side, false, nowSec, c, ctx);
      } else if (result.stage === 'guard' && isAprEchoDisagreement(result)) {
        memo.aprEchoDisagreements += 1;
        if (memo.aprEchoDisagreements === MAX_APR_ECHO_DISAGREEMENTS) {
          haltLive(memo, 'apr echo disagreement twice', c, ctx);
        }
      } else if (result.stage === 'echo' && c.mode === 'live') {
        memo.haltedLive = true;
        // The execution wrote STOP; its message names any failure to.
        ctx.log.fatal({ side, message: result.message }, 'gas echo mismatch: halting live');
      }
      return;
    case 'reverted':
      confirmFailed(memo, side, true, nowSec, c, ctx);
      return;
    case 'filled':
      memo.pendingVisibility.push({ side, txHash: result.txHash, sinceSec: nowSec });
      memo.cooldownUntilSec[side] = nowSec + c.safety.unknownMaxWaitSec;
      return;
    case 'unknown': {
      const { confirmSentAtSec, reason } = result;
      memo.unknownWaits.push({
        side,
        confirmSentAtSec,
        counterBefore: ctx.counterBefore,
        sinceSec: nowSec,
        terms: ctx.terms,
      });
      memo.cooldownUntilSec[side] = nowSec + c.safety.unknownMaxWaitSec;
      if (reason === 'verify-failed') {
        memo.haltedLive = true;
        ctx.log.fatal({ side, txHash: result.txHash }, 'fill verification failed: halting live');
      } else {
        ctx.log.warn({ side, reason }, 'trade outcome unknown: holding the side until there is evidence');
      }
      return;
    }
  }
}

/**
 * A fatal event: in live, the in-memory halt (no execution again in this process), `data/STOP` and one fatal
 * line. Dry-run only logs what live would have done, so it keeps quoting (spec §10).
 */
export function haltLive(memo: Memo, reason: string, c: WheelConfig, fx: HaltEffects): void {
  if (c.mode !== 'live') {
    fx.log.error({ reason }, 'live would halt here; dry-run continues');
    return;
  }
  memo.haltedLive = true;
  try {
    fx.writeStop(reason);
  } catch (error) {
    fx.log.error({ err: error, reason }, 'could not write the STOP file; halted in memory');
  }
  fx.log.fatal({ reason }, 'halting live');
}

/**
 * Each tick, before planning: clears a side's cooldown once its filled `txHash` appears in `s.positions`
 * (recording the visibility latency), or once an `unknown` result has evidence — a position created at or after
 * the confirm with the traded terms, or a vault counter above the one read before executing. A wait older than
 * `unknownMaxWaitSec` is dropped with an error (an `unknown` one also clears its cooldown).
 */
export function resolveWaits(memo: Memo, s: Snapshot, c: WheelConfig, fx: WaitEffects): void {
  const maxWaitSec = c.safety.unknownMaxWaitSec;
  memo.pendingVisibility = memo.pendingVisibility.filter(({ side, txHash, sinceSec }) => {
    const waitedSec = s.nowSec - sinceSec;
    if (s.positions.some((p) => sameHash(p.txHash, txHash))) {
      delete memo.cooldownUntilSec[side];
      fx.record('executions', { step: 'visible', side, txHash, visibilityLatencySec: waitedSec });
      return false;
    }
    if (waitedSec < maxWaitSec) return true;
    fx.log.error({ side, txHash, waitedSec }, 'a filled trade is still not in the positions API; unblocking');
    fx.record('executions', { step: 'visibility-timeout', side, txHash, waitedSec });
    return false;
  });
  memo.unknownWaits = memo.unknownWaits.filter((wait) => {
    const { side } = wait;
    const waitedSec = s.nowSec - wait.sinceSec;
    const evidence = evidenceOf(wait, s);
    if (evidence !== null) {
      delete memo.cooldownUntilSec[side];
      const detail = {
        side,
        evidence,
        waitedSec,
        counterBefore: wait.counterBefore,
        vaultCounter: s.chain.vaultCounter,
      };
      fx.record('executions', { step: 'unknown-resolved', ...detail });
      fx.log.warn(detail, 'an unknown trade filled: check the fill');
      return false;
    }
    if (waitedSec < maxWaitSec) return true;
    delete memo.cooldownUntilSec[side];
    fx.log.error({ side, waitedSec }, 'no evidence for an unknown trade; unblocking the side');
    fx.record('executions', { step: 'unknown-expired', side, waitedSec });
    return false;
  });
}

function confirmFailed(
  memo: Memo,
  side: Side,
  reverted: boolean,
  nowSec: number,
  c: WheelConfig,
  fx: HaltEffects,
): void {
  memo.cooldownUntilSec[side] = nowSec + RETRY_COOLDOWN_SEC;
  delete memo.lastConfirmSec[side];
  memo.confirmErrorsSec = [...within(memo.confirmErrorsSec, nowSec, CONFIRM_ERROR_WINDOW_SEC), nowSec];
  memo.revertsSec = within(memo.revertsSec, nowSec, REVERT_WINDOW_SEC);
  if (reverted) memo.revertsSec.push(nowSec);
  if (memo.confirmErrorsSec.length >= MAX_CONFIRM_ERRORS) {
    haltLive(memo, `${memo.confirmErrorsSec.length} confirm errors within an hour`, c, fx);
  } else if (memo.revertsSec.length >= MAX_REVERTS) {
    haltLive(memo, `${memo.revertsSec.length} reverts within 24 h`, c, fx);
  }
}

/** The times less than `windowSec` before `nowSec`. */
function within(timesSec: number[], nowSec: number, windowSec: number): number[] {
  return timesSec.filter((atSec) => nowSec - atSec < windowSec);
}

function evidenceOf(wait: UnknownWait, s: Snapshot): 'position' | 'vault-counter' | null {
  const { terms } = wait;
  const appeared = s.positions.some((p) => p.createdAtSec >= wait.confirmSentAtSec && sameTerms(p, terms));
  if (appeared) return 'position';
  return s.chain.vaultCounter > wait.counterBefore ? 'vault-counter' : null;
}

function sameTerms(p: Position, t: TradeTerms): boolean {
  return (
    p.isPut === t.isPut &&
    p.strikeE8 === t.strikeE8 &&
    p.expirySec === t.expirySec &&
    p.quantityE18 === t.quantityE18
  );
}

function sameHash(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
