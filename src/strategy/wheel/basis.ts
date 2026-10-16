import { formatUnits } from 'viem';
import type { Position } from '../../domain/types.ts';
import { ceilDiv } from '../../domain/units.ts';
import { isBasisRelevant } from './classify.ts';
import type { BasisConfig, BasisFlow } from './config.ts';
import type { Phase, RowClass } from './types.ts';

/**
 * One change to the HYPE held after the anchor (spec §8.4). An add carries its cost price (the anchor's when
 * absent); a row's remove carries the strike for logging only, since every removal is at the average cost.
 * `order` breaks ties between events with the same `tsSec`, `kind` and `source`: `[createdAtSec, txHash]` for a
 * row, `[index in externalFlows, '']` for a flow.
 */
export type BasisEvent = {
  tsSec: number;
  kind: 'add' | 'remove';
  qtyE18: bigint;
  priceE8?: bigint;
  source: 'row' | 'flow';
  order: [number, string];
};

export type BasisUnreliableReason =
  | 'basis-negative'
  | 'anchor-in-settlement-window'
  | 'settlement-pending'
  | 'residual-blocked';

/**
 * The average cost of the HYPE held (`null` when none is), the ledger quantity and `observed − ledger` (0 when no
 * reconciliation ran). `reason` is the first failure in processing order; `warnings` lists every one.
 */
export type BasisResult = {
  basisE8: bigint | null;
  qtyE18: bigint;
  residualE18: bigint;
  reliable: boolean;
  reason?: BasisUnreliableReason;
  warnings: string[];
};

type BasisRow = { position: Position; cls: RowClass; phase: Phase };
/** Cost in e8 USD × e18 HYPE, so the average is `costE26 / qE18` in e8 USD. */
type Ledger = { qE18: bigint; costE26: bigint };

const EMPTY: Ledger = { qE18: 0n, costE26: 0n };
const KIND_RANK: Record<BasisEvent['kind'], number> = { add: 0, remove: 1 };
const SOURCE_RANK: Record<BasisEvent['source'], number> = { row: 0, flow: 1 };

/**
 * The ledger events after `config.anchor.ts`, in replay order: assigned puts add their payout at the strike and
 * exercised calls remove their quantity, each at its expiry, for settled basis-relevant rows; `externalFlows`
 * deposits add at their `basisE8` (default the anchor's) and withdrawals remove. ITM comes from the parsed payout
 * (`settlement`), never from prices; an anomalous settlement adds no event.
 */
export function basisEvents(rows: BasisRow[], config: BasisConfig): BasisEvent[] {
  const anchorSec = config.anchor.ts;
  const fromRows = rows.flatMap((row) => {
    const event = rowEvent(row);
    return event !== null && event.tsSec > anchorSec ? [event] : [];
  });
  const fromFlows = config.externalFlows.flatMap((flow, index) =>
    flow.ts > anchorSec ? [flowEvent(flow, index, config.anchor.basisE8)] : [],
  );
  return sortEvents([...fromRows, ...fromFlows]);
}

/**
 * Replays `events` (re-sorted, so input order does not matter) from the anchor in exact bigint and reconciles the
 * ledger against `observedHypeE18` (wallet WHYPE plus WHYPE locked in open calls; `null` while a basis-relevant
 * row is pending, which skips reconciliation). Unreliability never throws: the ledger values are still returned.
 */
export function computeBasis(args: {
  events: BasisEvent[];
  config: BasisConfig;
  observedHypeE18: bigint | null;
  anchorInsideSettlementWindow: boolean;
}): BasisResult {
  const { config, observedHypeE18 } = args;
  const { anchor } = config;
  const events = sortEvents(args.events);
  const reasons: BasisUnreliableReason[] = [];
  const warnings: string[] = [];
  function fail(reason: BasisUnreliableReason, warning: string): void {
    reasons.push(reason);
    warnings.push(`${reason}: ${warning}`);
  }

  if (args.anchorInsideSettlementWindow) {
    fail(
      'anchor-in-settlement-window',
      `anchor ts ${anchor.ts} is within a basis-relevant settlement window`,
    );
  }
  const replayed = replay(events, anchor.qtyE18, anchor.basisE8);
  for (const shortfall of replayed.shortfalls) fail('basis-negative', shortfall);
  let ledger: Ledger = replayed;

  let residualE18 = 0n;
  if (observedHypeE18 === null) {
    fail('settlement-pending', 'a basis-relevant row awaits settlement; the residual is not checked');
  } else {
    residualE18 = observedHypeE18 - ledger.qE18;
    const outside = residualE18 > config.residualToleranceE18 || -residualE18 > config.residualToleranceE18;
    if (outside && config.residualPolicy === 'block-calls') {
      fail(
        'residual-blocked',
        `residual ${whype(residualE18)} exceeds the tolerance; record it in externalFlows`,
      );
    } else if (outside && residualE18 > 0n) {
      // External WHYPE is placed at the anchor, at its price, so later removals do not re-order it.
      ledger = replay(events, anchor.qtyE18 + residualE18, anchor.basisE8);
      warnings.push(`external-deposit: residual ${whype(residualE18)} absorbed at the anchor price`);
    } else if (outside) {
      warnings.push(`external-withdrawal: residual ${whype(residualE18)} removed at the average cost`);
      const removed = removeAtAverage(ledger, -residualE18);
      if (removed === null) {
        fail('basis-negative', shortfall('the external withdrawal', -residualE18, ledger));
      }
      ledger = removed ?? EMPTY;
    }
  }

  return {
    basisE8: ledger.qE18 === 0n ? null : ceilDiv(ledger.costE26, ledger.qE18),
    qtyE18: ledger.qE18,
    residualE18,
    reliable: reasons.length === 0,
    ...(reasons[0] === undefined ? {} : { reason: reasons[0] }),
    warnings,
  };
}

function rowEvent({ position: p, cls, phase }: BasisRow): BasisEvent | null {
  if (phase !== 'settled' || !isBasisRelevant(cls)) return null;
  const at: Omit<BasisEvent, 'kind' | 'qtyE18'> = {
    tsSec: p.expirySec,
    priceE8: p.strikeE8,
    source: 'row',
    order: [p.createdAtSec, p.txHash],
  };
  if (p.settlement?.outcome === 'assigned') {
    return { ...at, kind: 'add', qtyE18: p.settlement.receivedUnderlyingE18 };
  }
  if (p.settlement?.outcome === 'exercised') return { ...at, kind: 'remove', qtyE18: p.quantityE18 };
  return null;
}

/** A withdrawal ignores `basisE8`: it leaves at the average cost. */
function flowEvent(flow: BasisFlow, index: number, anchorBasisE8: bigint): BasisEvent {
  const order: [number, string] = [index, ''];
  return flow.qtyE18 < 0n
    ? { tsSec: flow.ts, kind: 'remove', qtyE18: -flow.qtyE18, source: 'flow', order }
    : {
        tsSec: flow.ts,
        kind: 'add',
        qtyE18: flow.qtyE18,
        priceE8: flow.basisE8 ?? anchorBasisE8,
        source: 'flow',
        order,
      };
}

/** `tsSec`; adds before removes; rows before flows; then `order` (number, then string by code unit). */
function sortEvents(events: BasisEvent[]): BasisEvent[] {
  return events.toSorted(
    (a, b) =>
      a.tsSec - b.tsSec ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
      a.order[0] - b.order[0] ||
      compareStrings(a.order[1], b.order[1]),
  );
}

/**
 * Average-cost replay from `q0E18` HYPE at `b0E8`. A removal beyond the ledger empties it and is reported as a
 * shortfall; the replay goes on so the result is still computed.
 */
function replay(events: BasisEvent[], q0E18: bigint, b0E8: bigint): Ledger & { shortfalls: string[] } {
  let ledger: Ledger = { qE18: q0E18, costE26: q0E18 * b0E8 };
  const shortfalls: string[] = [];
  for (const event of events) {
    if (event.kind === 'add') {
      ledger = {
        qE18: ledger.qE18 + event.qtyE18,
        costE26: ledger.costE26 + event.qtyE18 * (event.priceE8 ?? b0E8),
      };
      continue;
    }
    const removed = removeAtAverage(ledger, event.qtyE18);
    if (removed === null) {
      shortfalls.push(shortfall(`the ${event.source} event at ${event.tsSec}`, event.qtyE18, ledger));
    }
    ledger = removed ?? EMPTY;
  }
  return { ...ledger, shortfalls };
}

/** `cost × (q − n) / q`: the average is unchanged up to flooring. `null` when `n > q`. */
function removeAtAverage(ledger: Ledger, qtyE18: bigint): Ledger | null {
  if (qtyE18 > ledger.qE18) return null;
  const qE18 = ledger.qE18 - qtyE18;
  return { qE18, costE26: ledger.qE18 === 0n ? 0n : (ledger.costE26 * qE18) / ledger.qE18 };
}

function shortfall(what: string, qtyE18: bigint, ledger: Ledger): string {
  return `${what} removes ${whype(qtyE18)} but the ledger holds ${whype(ledger.qE18)}; the anchor is wrong or a deposit is unrecorded`;
}

function whype(qtyE18: bigint): string {
  return `${formatUnits(qtyE18, 18)} WHYPE`;
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
