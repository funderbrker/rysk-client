import type { Hex } from 'viem';
import type { Side } from '../domain/types.ts';
import type { Snapshot } from '../strategy/wheel/types.ts';

/** The memo fields a `Snapshot` carries. */
type SnapshotMemo = Snapshot['memo'];

/** A quote key's backoff after below-floor or failed quotes (spec §8.7). */
export type KeyBackoff = {
  /** Chain seconds before which the key is not quoted. */
  untilSec: number;
  /** Backoffs since the key was last reset; the n-th lasts `min(3600, 300 × 2^(n−1))` s. */
  n: number;
  /** Spot at the last backoff: a move of more than 2 % from it resets the key. */
  spotE8: bigint;
  /**
   * The listing's indicative APR at the last backoff: a rise of more than 25 % resets the key. `null` for a custom
   * strike, which has no listing: only a spot move resets it.
   */
  indicativeApr: number | null;
};

/** The terms an `unknown` result traded, matched against new positions while it waits for evidence. */
export type TradeTerms = { isPut: boolean; strikeE8: bigint; expirySec: number; quantityE18: bigint };

/** A `filled` trade whose row the positions API does not list yet. */
export type PendingVisibility = { side: Side; txHash: Hex; sinceSec: number };

/** An `unknown` result waiting for evidence that it filled (spec §7.5). */
export type UnknownWait = {
  side: Side;
  /** Server seconds when the confirm was sent: a matching row must be created at or after it. */
  confirmSentAtSec: number;
  /** The vault counter read just before `execute`: any increase is evidence. */
  counterBefore: bigint;
  sinceSec: number;
  terms: TradeTerms;
};

const BACKOFF_BASE_SEC = 300;
const BACKOFF_CAP_SEC = 3600;
/** A reset needs spot to move by more than 1/50 (2 %) of the spot at the backoff. */
const SPOT_RESET_DIVISOR = 50n;
const APR_RESET_RATIO = 1.25;

/** The backoff key of an instrument, listed or a custom strike: `side|strikeE8|expirySec`. */
export function backoffKeyOf(side: Side, strikeE8: bigint, expirySec: number): string {
  return `${side}|${strikeE8}|${expirySec}`;
}

/**
 * The daemon's in-memory state, lost on restart: the fields a `Snapshot` carries (`snapshotMemo()` copies them),
 * plus the loop's bookkeeping. The loop writes it, `gatherSnapshot` sets `uptimeSec` and `serverSkewMs`, and the
 * wiring's callbacks set `lastConfirmSec`, `cooldownUntilSec`, `usedQuoteNonces` and `lastNonceMs` (execution)
 * and call `observeServerDate` (the REST client's `onServerDate`).
 */
export class Memo implements SnapshotMemo {
  lastConfirmSec: Partial<Record<Side, number>> = {};
  cooldownUntilSec: Partial<Record<Side, number>> = {};
  simulatedDeploySec: Partial<Record<Side, number>> = {};
  inFlight = false;
  /** Whole seconds since `startedAtMs`, as of the last snapshot. */
  uptimeSec = 0;
  /**
   * Gate G5's skew (local minus server, ms), set each snapshot: the larger in magnitude of the REST skew
   * (`restSkewMs`, from the latest `Date` header) and `min(0, localMs − blockTs × 1000)`. A block from the future
   * is skew; a block from the past is only old, which is gate G4's to judge.
   */
  serverSkewMs = 0;
  frontendChanged = false;
  stopFile = false;
  lastNoPendingSeenSec: number | null = null;

  /** By `backoffKeyOf`; entries outlive their delay so the next backoff doubles. */
  readonly keyBackoff = new Map<string, KeyBackoff>();
  /** A side whose floor was unmet is not re-planned before this (chain seconds). */
  replanDueSec: Partial<Record<Side, number>> = {};
  /** Quote nonces signed in this process (check C5). */
  readonly usedQuoteNonces = new Set<string>();
  /** The last signed confirm nonce, epoch ms (check C15). */
  readonly lastNonceMs = { value: 0 };
  /** When confirm errors (`confirm-rejected`, `reverted`) and reverts happened, chain seconds. */
  confirmErrorsSec: number[] = [];
  revertsSec: number[] = [];
  pendingVisibility: PendingVisibility[] = [];
  unknownWaits: UnknownWait[] = [];
  /** Set by a fatal event; live never executes again in this process. */
  haltedLive = false;
  readonly startedAtMs: number;
  aprEchoDisagreements = 0;
  /** `localMs − serverMs` at the latest REST response with a `Date` header; `null` before the first. */
  restSkewMs: number | null = null;

  constructor(startedAtMs: number) {
    this.startedAtMs = startedAtMs;
  }

  /** Backs `key` off once more: the n-th time for `min(3600, 300 × 2^(n−1))` s from `nowSec`. */
  backoffKey(key: string, nowSec: number, spotE8: bigint, indicativeApr: number | null): void {
    const n = (this.keyBackoff.get(key)?.n ?? 0) + 1;
    const delaySec = Math.min(BACKOFF_CAP_SEC, BACKOFF_BASE_SEC * 2 ** (n - 1));
    this.keyBackoff.set(key, { untilSec: nowSec + delaySec, n, spotE8, indicativeApr });
  }

  isBackedOff(key: string, nowSec: number): boolean {
    const entry = this.keyBackoff.get(key);
    return entry !== undefined && nowSec < entry.untilSec;
  }

  /**
   * Forgets `key`'s backoff, count included, when spot moved more than 2 % from the spot at its backoff or its
   * indicative APR rose more than 25 % (never for a custom strike, which has none); returns whether it did.
   */
  resetBackoffIf(key: string, spotE8: bigint, indicativeApr: number | null): boolean {
    const entry = this.keyBackoff.get(key);
    if (entry === undefined) return false;
    const moveE8 = spotE8 > entry.spotE8 ? spotE8 - entry.spotE8 : entry.spotE8 - spotE8;
    const spotMoved = moveE8 * SPOT_RESET_DIVISOR > entry.spotE8;
    const aprRose =
      indicativeApr !== null &&
      entry.indicativeApr !== null &&
      indicativeApr > entry.indicativeApr * APR_RESET_RATIO;
    if (!spotMoved && !aprRose) return false;
    this.keyBackoff.delete(key);
    return true;
  }

  /** Drops the backoffs of instruments that have expired, so the map does not grow for the process lifetime. */
  forgetExpiredKeys(nowSec: number): void {
    for (const key of this.keyBackoff.keys()) {
      const expirySec = Number(key.slice(key.lastIndexOf('|') + 1));
      if (expirySec <= nowSec) this.keyBackoff.delete(key);
    }
  }

  /**
   * Gate G3's run start (spec §8.3): `nowSec` on the first tick of a run without a pending basis-relevant row, kept
   * (never refreshed) while the run lasts, and `null` on any tick with one pending.
   */
  observePendingSettlement(pending: boolean, nowSec: number): void {
    if (pending) this.lastNoPendingSeenSec = null;
    else this.lastNoPendingSeenSec ??= nowSec;
  }

  /** The REST client's `onServerDate`: records `localMs − serverMs` for the next `updateServerSkew`. */
  observeServerDate(serverMs: number, localMs: number): void {
    this.restSkewMs = localMs - serverMs;
  }

  /** Sets `serverSkewMs` from the latest REST skew and a block read at `localMs`. */
  updateServerSkew(localMs: number, blockTs: number): void {
    const blockSkewMs = Math.min(0, localMs - blockTs * 1000);
    const restSkewMs = this.restSkewMs ?? 0;
    this.serverSkewMs = Math.abs(restSkewMs) >= Math.abs(blockSkewMs) ? restSkewMs : blockSkewMs;
  }

  /** A copy of the fields a `Snapshot` carries, so later changes do not reach a snapshot already taken. */
  snapshotMemo(): SnapshotMemo {
    return {
      lastConfirmSec: { ...this.lastConfirmSec },
      cooldownUntilSec: { ...this.cooldownUntilSec },
      simulatedDeploySec: { ...this.simulatedDeploySec },
      inFlight: this.inFlight,
      uptimeSec: this.uptimeSec,
      serverSkewMs: this.serverSkewMs,
      frontendChanged: this.frontendChanged,
      stopFile: this.stopFile,
      lastNoPendingSeenSec: this.lastNoPendingSeenSec,
    };
  }
}
