import type { Hex } from 'viem';
import type { Side } from '../domain/types.ts';
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

/** What `resolveWaits` reports through (`record` never throws), and halts through. */
export type WaitEffects = HaltEffects & { record(stream: RecordStream, record: object): void };

const RETRY_COOLDOWN_SEC = 60;
const CONFIRM_ERROR_WINDOW_SEC = 3_600;
const MAX_CONFIRM_ERRORS = 3;
const REVERT_WINDOW_SEC = 86_400;
const MAX_REVERTS = 2;
const APR_ECHO_WINDOW_SEC = 3_600;
const MAX_APR_ECHO_DISAGREEMENTS = 2;

/**
 * Applies one execution result to the side's cooldown (spec §7.5) and the halt rules (spec §9.4, §10):
 *
 * - `aborted` before the confirm: no cooldown. Two C7 APR echo disagreements within an hour halt live; an `echo`
 *   abort in live halts (the execution already wrote STOP).
 * - `aborted('confirm-rejected')` and `reverted`: 60 s, and `lastConfirmSec[side]` cleared so the DCA interval is
 *   not consumed; three confirm errors (either kind) within an hour, or two reverts within 24 h, halt live. A
 *   rejection is also watched for the fill its reply denied (`resolveWaits`); a later sent confirm on the same
 *   trade (side and terms) ends that watch, since a row with those terms is the new confirm's from then on.
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
  for (const error of 'bookkeepingErrors' in result ? result.bookkeepingErrors : []) {
    ctx.log.error({ side, error }, 'execution bookkeeping failed');
    if (error.startsWith('writeStop')) memo.haltedLive = true;
  }
  if (result.status !== 'aborted') endRejectedWatch(memo, side, ctx.terms);
  switch (result.status) {
    case 'aborted':
      if (result.stage === 'confirm-rejected') {
        confirmFailed(memo, side, false, nowSec, c, ctx);
        watchRejected(memo, side, result.confirmSentAtSec, nowSec, ctx.terms);
      } else if (result.stage === 'guard' && isAprEchoDisagreement(result)) {
        const recent = within(memo.aprEchoDisagreementsSec, nowSec, APR_ECHO_WINDOW_SEC);
        memo.aprEchoDisagreementsSec = [...recent, nowSec];
        if (memo.aprEchoDisagreementsSec.length >= MAX_APR_ECHO_DISAGREEMENTS) {
          haltLive(
            memo,
            `${memo.aprEchoDisagreementsSec.length} apr echo disagreements within an hour`,
            c,
            ctx,
          );
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
 * `unknownMaxWaitSec` is dropped with an error (an `unknown` one also clears its cooldown). A rejected confirm is
 * watched as long, by position only (another trade may move the counter) and holding nothing: a matching row
 * created at or after it is a fill its error reply denied, which went through no receipt verification, so it is
 * recorded as `rejected-filled` and halts live (spec §10); without one the watch ends silently.
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
  memo.rejectedWatches = memo.rejectedWatches.filter((watch) => {
    const waitedSec = s.nowSec - watch.sinceSec;
    const row = s.positions.find(
      (p) => p.createdAtSec >= watch.confirmSentAtSec && sameTerms(p, watch.terms),
    );
    if (row === undefined) return waitedSec < maxWaitSec;
    const detail = {
      side: watch.side,
      txHash: row.txHash,
      waitedSec,
      confirmSentAtSec: watch.confirmSentAtSec,
    };
    fx.record('executions', { step: 'rejected-filled', ...detail });
    haltLive(memo, `rejected confirm filled anyway: ${row.txHash}`, c, fx);
    return false;
  });
}

/**
 * Watches a rejected confirm for the fill its reply denied. A watch already on the same trade is replaced, keeping
 * the earlier send: a row created between the two confirms is still one of them.
 */
function watchRejected(
  memo: Memo,
  side: Side,
  confirmSentAtSec: number,
  nowSec: number,
  terms: TradeTerms,
): void {
  const earlier = memo.rejectedWatches.find((watch) => watch.side === side && sameTerms(watch.terms, terms));
  endRejectedWatch(memo, side, terms);
  memo.rejectedWatches.push({
    side,
    confirmSentAtSec: Math.min(confirmSentAtSec, earlier?.confirmSentAtSec ?? confirmSentAtSec),
    sinceSec: nowSec,
    terms,
  });
}

/** A sent confirm on the same trade ends its rejected watch: a row with these terms is the new confirm's now. */
function endRejectedWatch(memo: Memo, side: Side, terms: TradeTerms): void {
  memo.rejectedWatches = memo.rejectedWatches.filter(
    (watch) => !(watch.side === side && sameTerms(watch.terms, terms)),
  );
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

/** The same option and size; a `Position` carries these fields too. */
function sameTerms(a: TradeTerms, b: TradeTerms): boolean {
  return (
    a.isPut === b.isPut &&
    a.strikeE8 === b.strikeE8 &&
    a.expirySec === b.expirySec &&
    a.quantityE18 === b.quantityE18
  );
}

function sameHash(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
