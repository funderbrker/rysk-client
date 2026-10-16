import { CHAIN_ID } from '../../domain/constants.ts';
import type { Position, Side } from '../../domain/types.ts';
import { collateralForPut } from '../../domain/units.ts';
import { stringifyBig } from '../../lib/json.ts';
import { basisEvents, computeBasis } from './basis.ts';
import { classifyRow, isBasisRelevant, isManaged } from './classify.ts';
import type { WheelConfig } from './config.ts';
import type { Phase, RowClass, SideCapital, Snapshot, WheelState } from './types.ts';

type Row = WheelState['rows'][number];
type Deduplicated = { positions: Position[]; warnings: string[]; anomalies: string[] };

const SIDES: Side[] = ['put', 'call'];
/** The class of the rows a side deploys: their creation dates the side's last deployment. */
const MANAGED_CLASS: Record<Side, RowClass> = { put: 'managedPut', call: 'managedCall' };
/** The classes whose open and pending rows hold the side's collateral (USDC for puts, our WHYPE for calls). */
const LOCKING_CLASSES: Record<Side, RowClass[]> = {
  put: ['managedPut'],
  call: ['managedCall', 'whypeCallOtherUsd'],
};
const DAY_SEC = 86_400;
/** An anchor this soon after a basis-relevant expiry may predate that row's settlement (spec §8.4). */
const SETTLEMENT_WINDOW_SEC = 6 * 3_600;
const E20 = 10n ** 20n;

/**
 * The wheel's view of one tick (spec §8.2): the rows de-duplicated by key and classified, the chain cross-check,
 * per-side capital, the HYPE basis, the deployment clock and the rolling 24 h deployments. Pure and order
 * invariant: rows are sorted by key (and, among copies of one key, by content) before anything reads them, so any
 * permutation of `s.positions` gives a deep-equal state. Never throws on a well-typed snapshot; problems are
 * reported in `anomalies` (gate G1 holds on any) and `warnings`.
 */
export function deriveState(s: Snapshot, c: WheelConfig): WheelState {
  const unique = deduplicate(s.positions);
  const rows: Row[] = unique.positions.map((position) => ({
    position,
    ...classifyRow(position, s.nowSec),
  }));
  const anomalies = [...unique.anomalies, ...rows.flatMap(rowAnomaly)];

  // The chain counts vaults, and a duplicated API row is not a second vault, so the de-duplicated rows are
  // compared (the duplicate is warned about above). `otherRowCount` already counts only chain-999 rows.
  const apiCount999 = BigInt(
    rows.filter((row) => row.position.chainId === CHAIN_ID).length + s.otherRowCount,
  );
  const counter = s.chain.vaultCounter;
  const consistency: WheelState['consistency'] =
    counter === apiCount999 ? 'ok' : counter > apiCount999 ? 'api-lag' : 'inconsistent';
  if (consistency === 'inconsistent') {
    anomalies.push(
      `inconsistent: the vault counter ${counter} is below the ${apiCount999} chain-999 rows the API returned`,
    );
  }

  const capital: WheelState['capital'] = {
    put: sideCapital(
      floorAtZero(s.chain.usdc6 - c.put.reserve6),
      lockedIn(rows, 'put', 'open'),
      lockedIn(rows, 'put', 'pendingSettlement'),
      c.put.maxCapital6,
    ),
    call: sideCapital(
      floorAtZero(s.chain.whypeE18 - c.call.reserveE18),
      lockedIn(rows, 'call', 'open'),
      lockedIn(rows, 'call', 'pendingSettlement'),
      c.call.maxCapitalE18,
    ),
  };

  const relevant = rows.filter((row) => isBasisRelevant(row.cls));
  const anchorSec = c.basis.anchor.ts;
  const { warnings: basisWarnings, ...basis } = computeBasis({
    events: basisEvents(relevant, c.basis),
    config: c.basis,
    // Wallet WHYPE plus the WHYPE locked in open calls, which is the call side's `locked`.
    observedHypeE18: relevant.some((row) => row.phase === 'pendingSettlement')
      ? null
      : s.chain.whypeE18 + capital.call.locked,
    anchorInsideSettlementWindow: relevant.some(
      ({ position: p }) => anchorSec >= p.expirySec && anchorSec <= p.expirySec + SETTLEMENT_WINDOW_SEC,
    ),
  });

  const recent = rows.filter((row) => isManaged(row.cls) && row.position.createdAtSec > s.nowSec - DAY_SEC);
  return {
    consistency,
    rows,
    capital,
    basis,
    lastDeployTs: lastDeploySec(rows, s.memo),
    deploymentsLast24h: recent.length,
    notionalLast24h6: recent.reduce((sum, row) => sum + notional6(row, s.market.spotE8), 0n),
    anomalies,
    warnings: [...unique.warnings, ...basisWarnings],
  };
}

/**
 * One position per key, in key order, with one warning per duplicated key. Copies of a key are ordered by
 * their content so the same one is kept whatever the input order; copies that differ (say, open in one and
 * settled in another) leave capital and the basis ambiguous, so they are an anomaly too. The parser builds
 * every position with the same field order, so equal content serializes equally.
 */
function deduplicate(positions: Position[]): Deduplicated {
  const sorted = positions
    .map((position) => ({ position, content: stringifyBig(position) }))
    .toSorted(
      (a, b) => compareStrings(a.position.key, b.position.key) || compareStrings(a.content, b.content),
    );
  const out: Deduplicated = { positions: [], warnings: [], anomalies: [] };
  const copies = new Map<string, { count: number; disagree: boolean }>();
  let kept: (typeof sorted)[number] | undefined;
  for (const entry of sorted) {
    const { key } = entry.position;
    if (kept?.position.key !== key) {
      kept = entry;
      out.positions.push(entry.position);
      continue;
    }
    const seen = copies.get(key) ?? { count: 1, disagree: false };
    copies.set(key, { count: seen.count + 1, disagree: seen.disagree || entry.content !== kept.content });
  }
  for (const [key, { count, disagree }] of copies) {
    out.warnings.push(`positions: ${count} rows share the key ${key}; counted once`);
    if (disagree) out.anomalies.push(`positions: the rows with the key ${key} disagree`);
  }
  return out;
}

/**
 * An unknown status, or a settlement the payout fields do not explain: either way the row adds no ledger event,
 * so the basis (and for an unknown row, the capital) could be silently wrong.
 */
function rowAnomaly({ position: p, phase }: Row): string[] {
  if (phase === 'unknown') return [`row ${p.key}: unknown status`];
  if (phase !== 'settled') return [];
  if (p.settlement === null) return [`row ${p.key}: settled without a settlement`];
  return p.settlement.outcome === 'anomaly'
    ? [`row ${p.key}: anomalous settlement: ${p.settlement.detail}`]
    : [];
}

function sideCapital(free: bigint, locked: bigint, pending: bigint, maxCapital?: bigint): SideCapital {
  const total = free + locked + pending;
  const budget = maxCapital !== undefined && maxCapital < total ? maxCapital : total;
  return { free, locked, pending, total, budget };
}

/** The side's collateral held by its locking rows in `phase`: `quantity × strike` USDC for puts, WHYPE for calls. */
function lockedIn(rows: Row[], side: Side, phase: Phase): bigint {
  return rows
    .filter((row) => row.phase === phase && LOCKING_CLASSES[side].includes(row.cls))
    .reduce(
      (sum, { position: p }) =>
        sum + (side === 'put' ? collateralForPut(p.quantityE18, p.strikeE8) : p.quantityE18),
      0n,
    );
}

/** The latest of the side's managed rows' creation, the last confirm sent and (dry-run) simulated deployments. */
function lastDeploySec(rows: Row[], memo: Snapshot['memo']): WheelState['lastDeployTs'] {
  const out: WheelState['lastDeployTs'] = {};
  for (const side of SIDES) {
    const times = rows
      .filter((row) => row.cls === MANAGED_CLASS[side])
      .map((row) => row.position.createdAtSec)
      .concat(memo.lastConfirmSec[side] ?? [], memo.simulatedDeploySec[side] ?? []);
    if (times.length > 0) out[side] = times.reduce((a, b) => Math.max(a, b));
  }
  return out;
}

/** USD 6 dp: strike × quantity for a put, spot × quantity for a call (spec §8.9). */
function notional6({ position: p, cls }: Row, spotE8: bigint): bigint {
  return cls === 'managedPut' ? collateralForPut(p.quantityE18, p.strikeE8) : (p.quantityE18 * spotE8) / E20;
}

function floorAtZero(amount: bigint): bigint {
  return amount > 0n ? amount : 0n;
}

/** By UTF-16 code unit, independent of locale. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
