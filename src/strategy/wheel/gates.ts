import { isAddressEqual } from 'viem';
import { CAP_SOFT_MARGIN_BPS, remainingCapacityE18 } from '../../domain/caps.ts';
import { TOKENS } from '../../domain/constants.ts';
import type { Asset, Side } from '../../domain/types.ts';
import { fractionToBps } from '../../domain/units.ts';
import { isBasisRelevant } from './classify.ts';
import type { WheelConfig } from './config.ts';
import { trancheQuantityE18 } from './tranche.ts';
import type { GateResult, HoldReason, Snapshot, WheelState } from './types.ts';

export type GateCheck = { hold: HoldReason | null; results: GateResult[] };

type Context = { side: Side; st: WheelState; s: Snapshot; c: WheelConfig };
type Failure = { reason: HoldReason; detail: string };
type Gate = { id: string; appliesTo?: (ctx: Context) => boolean; check: (ctx: Context) => Failure | null };

const MAX_BLOCK_AGE_MS = 30_000;
const MAX_INVENTORY_AGE_MS = 120_000;
const HOUR_SEC = 3_600;
const BPS = 10_000n;
const E20 = 10n ** 20n;

const liveOnly = ({ s }: Context): boolean => s.mode === 'live';

// Spec §8.3, in order. Number comparisons are written as the negated pass condition so that NaN fails closed.
const GATES: Gate[] = [
  { id: 'G1', check: noAnomalies },
  { id: 'G2', check: consistent },
  { id: 'G3', check: noPendingSettlement },
  { id: 'G4', check: freshData },
  { id: 'G5', check: clocksAgree },
  { id: 'G6', check: marketOpen },
  { id: 'G7', appliesTo: liveOnly, check: pastStartupQuiet },
  { id: 'G8', check: nothingInFlight },
  { id: 'G9', appliesTo: liveOnly, check: gasReserve },
  { id: 'G10', check: switchedOn },
  { id: 'G11', appliesTo: liveOnly, check: underDailyLimits },
  { id: 'S1', check: sideEnabled },
  { id: 'S2', check: intervalPassed },
  { id: 'S3', check: trancheFillsALot },
  { id: 'S4', appliesTo: ({ side }) => side === 'call', check: basisReliable },
  {
    id: 'S5',
    appliesTo: ({ side, c }) => side === 'put' && c.safety.maxHypeExposurePct !== undefined,
    check: hypeExposure,
  },
];

/**
 * The gates for one side (spec §8.3): G1–G11 then S1–S5, in order. `results` holds every gate that applies —
 * G7, G9 and G11 in live mode only, S4 for calls, S5 for puts when `maxHypeExposurePct` is set — each evaluated
 * even after one fails; `hold` is the first failing gate's reason, `null` when all pass. G4's "rows fetched this
 * tick" is the snapshot's contract (its positions are parsed each tick) and is not checked here. Pure; throws
 * `UnitError` for a `trancheFraction` or `maxHypeExposurePct` outside 0 to 1, which config validation rejects.
 */
export function checkGates(side: Side, st: WheelState, s: Snapshot, c: WheelConfig): GateCheck {
  const ctx: Context = { side, st, s, c };
  const results: GateResult[] = [];
  let hold: HoldReason | null = null;
  for (const gate of GATES) {
    if (gate.appliesTo !== undefined && !gate.appliesTo(ctx)) continue;
    const failure = gate.check(ctx);
    if (failure === null) {
      results.push({ id: gate.id, pass: true });
    } else {
      results.push({ id: gate.id, pass: false, detail: failure.detail });
      hold ??= failure.reason;
    }
  }
  return { hold, results };
}

function fail(reason: HoldReason, detail: string): Failure {
  return { reason, detail };
}

/** The WHYPE asset, or `undefined` where `hypeAsset` would throw. */
function whypeAsset(s: Snapshot): Asset | undefined {
  return s.market.assets.find((asset) => isAddressEqual(asset.address, TOKENS.WHYPE.address));
}

/** G1: no anomalies and no row with an unknown status. */
function noAnomalies({ st }: Context): Failure | null {
  if (st.anomalies.length > 0) {
    return fail('anomaly', `${st.anomalies.length} anomalies, the first: ${st.anomalies[0]}`);
  }
  const unknown = st.rows.filter((row) => row.phase === 'unknown').length;
  return unknown > 0 ? fail('anomaly', `${unknown} rows with an unknown status`) : null;
}

/** G2: the vault counter matches the API's chain-999 rows. */
function consistent({ st }: Context): Failure | null {
  if (st.consistency === 'api-lag')
    return fail('api-lag', 'the chain counts vaults the API does not list yet');
  if (st.consistency === 'inconsistent') {
    return fail('inconsistent', 'the API lists more chain-999 rows than the chain counts vaults');
  }
  return null;
}

/**
 * G3: no row that moves our WHYPE awaits settlement, and the settlement grace has passed since the first tick
 * that saw none (`null` until a tick after a restart has seen none; `startupQuietSec` covers the restart).
 */
function noPendingSettlement({ st, s, c }: Context): Failure | null {
  const pending = st.rows.filter((row) => row.phase === 'pendingSettlement' && isBasisRelevant(row.cls));
  if (pending.length > 0) return fail('settlement-pending', `${pending.length} rows await settlement`);
  const sinceSec = s.memo.lastNoPendingSeenSec;
  if (sinceSec === null) return fail('settlement-pending', 'no settlement-free tick recorded yet');
  const graceSec = c.safety.settlementGraceSec;
  const elapsedSec = s.nowSec - sinceSec;
  return !(elapsedSec >= graceSec)
    ? fail('settlement-pending', `settlements done ${elapsedSec} s ago, within the ${graceSec} s grace`)
    : null;
}

/** G4: the block is at most 30 s old and the inventory at most 120 s, by the process clock. */
function freshData({ s }: Context): Failure | null {
  const blockAgeMs = s.localNowMs - s.chain.blockTs * 1000;
  if (!(blockAgeMs <= MAX_BLOCK_AGE_MS)) {
    return fail('stale-data', `block ${s.chain.blockNumber} is ${blockAgeMs} ms old`);
  }
  const inventoryAgeMs = s.localNowMs - s.market.inventoryTs * 1000;
  return !(inventoryAgeMs <= MAX_INVENTORY_AGE_MS)
    ? fail('stale-data', `the inventory is ${inventoryAgeMs} ms old`)
    : null;
}

/** G5: the server clock is within `maxClockSkewMs` of ours. */
function clocksAgree({ s, c }: Context): Failure | null {
  const skewMs = s.memo.serverSkewMs;
  return !(Math.abs(skewMs) <= c.safety.maxClockSkewMs)
    ? fail('clock-skew', `the server clock is ${skewMs} ms off, beyond ${c.safety.maxClockSkewMs} ms`)
    : null;
}

/** G6: the WHYPE asset is active and its market open (`marketStatus.isOpen !== false`), with HYPE listings. */
function marketOpen({ s }: Context): Failure | null {
  const whype = whypeAsset(s);
  if (whype === undefined) return fail('market-closed', 'no WHYPE asset');
  if (!whype.active) return fail('market-closed', 'the WHYPE asset is inactive');
  if (!whype.marketOpen) return fail('market-closed', 'the WHYPE market is closed');
  const listed = s.market.listings.some((listing) =>
    listing.products.some((product) => isAddressEqual(product.underlying, TOKENS.WHYPE.address)),
  );
  return listed ? null : fail('market-closed', 'no HYPE listings');
}

/** G7 (live): the process has been up for `startupQuietSec`. */
function pastStartupQuiet({ s, c }: Context): Failure | null {
  const { uptimeSec } = s.memo;
  return !(uptimeSec >= c.safety.startupQuietSec)
    ? fail('quiet-period', `up ${uptimeSec} s, within the ${c.safety.startupQuietSec} s startup quiet period`)
    : null;
}

/** G8: no execution in flight, no unmined transaction of ours, and the side is not cooling down. */
function nothingInFlight({ side, s }: Context): Failure | null {
  if (s.memo.inFlight) return fail('in-flight', 'an execution is in flight');
  const gap = s.chain.pendingNonceGap;
  if (gap !== 0) return fail('tx-pending', `the pending nonce is ${gap} ahead of the latest`);
  const untilSec = s.memo.cooldownUntilSec[side];
  return untilSec !== undefined && !(untilSec <= s.nowSec)
    ? fail('cooldown', `the ${side} side cools down until ${untilSec}`)
    : null;
}

/** G9 (live): enough native HYPE for gas. */
function gasReserve({ s, c }: Context): Failure | null {
  const { nativeHypeE18 } = s.chain;
  return nativeHypeE18 < c.safety.minNativeHypeE18
    ? fail('gas-reserve', `native HYPE ${nativeHypeE18} (e18) is below ${c.safety.minNativeHypeE18}`)
    : null;
}

/**
 * G10: in live, no STOP file (dry-run continues with it, spec §9.4); in both modes the wheel enabled and no
 * frontend change while `pauseOnFrontendChange` is on.
 */
function switchedOn({ s, c }: Context): Failure | null {
  if (s.mode === 'live' && s.memo.stopFile) return fail('kill-switch', 'the STOP file is present');
  if (!c.enabled) return fail('disabled', 'the wheel is disabled');
  if (s.memo.frontendChanged && c.safety.pauseOnFrontendChange) {
    return fail('frontend-changed', 'the Rysk frontend version changed');
  }
  return null;
}

/** G11 (live): under the rolling 24 h deployment count and notional. */
function underDailyLimits({ st, c }: Context): Failure | null {
  const { maxDeploymentsPer24h, maxNotionalPer24h6 } = c.safety;
  if (!(st.deploymentsLast24h < maxDeploymentsPer24h)) {
    return fail(
      'daily-limit',
      `${st.deploymentsLast24h} deployments in 24 h, the limit is ${maxDeploymentsPer24h}`,
    );
  }
  return st.notionalLast24h6 >= maxNotionalPer24h6
    ? fail(
        'daily-limit',
        `notional ${st.notionalLast24h6} (6 dp) in 24 h, the limit is ${maxNotionalPer24h6}`,
      )
    : null;
}

/** S1: the side is enabled. */
function sideEnabled({ side, c }: Context): Failure | null {
  return c[side].enabled ? null : fail('disabled', `the ${side} side is disabled`);
}

/** S2: `minIntervalHours` since the side's last deployment, if any. */
function intervalPassed({ side, st, s, c }: Context): Failure | null {
  const lastSec = st.lastDeployTs[side];
  if (lastSec === undefined) return null;
  const elapsedSec = s.nowSec - lastSec;
  const { minIntervalHours } = c[side];
  return !(elapsedSec >= minIntervalHours * HOUR_SEC)
    ? fail('interval', `the last ${side} deployment was ${elapsedSec} s ago, within ${minIntervalHours} h`)
    : null;
}

/**
 * S3: the side's tranche is at least one lot. Puts are sized at spot, which is at or above any OTM put strike and
 * so the costliest lot; the planner re-sizes at each candidate's strike. The caps headroom keeps the soft
 * margin and prices NOTIONAL caps at spot on both sides; when it alone leaves less than a lot the hold is `cap`.
 */
function trancheFillsALot({ side, st, s, c }: Context): Failure | null {
  const whype = whypeAsset(s);
  if (whype === undefined) return fail('below-min-lot', 'no WHYPE asset to size a lot');
  const { spotE8 } = s.market;
  if (spotE8 <= 0n) return fail('below-min-lot', `invalid spot ${spotE8} (e8)`);
  const lotE18 = whype.minTradeSizeE18;
  const target = { underlyingSymbol: 'HYPE', asset: whype.address, isPut: side === 'put' };
  const capacityE18 = remainingCapacityE18(s.market.caps, target, spotE8, CAP_SOFT_MARGIN_BPS);
  const quantityE18 = trancheQuantityE18(side, st, spotE8, s, c, capacityE18);
  if (quantityE18 >= lotE18) return null;
  const uncappedE18 = capacityE18 === null ? quantityE18 : trancheQuantityE18(side, st, spotE8, s, c, null);
  return uncappedE18 >= lotE18
    ? fail('cap', `the caps leave ${capacityE18} (e18) contracts, below one lot of ${lotE18}`)
    : fail('below-min-lot', `the ${side} tranche is below one lot of ${lotE18} (e18)`);
}

/** S4 (calls): the HYPE basis is reliable and defined. */
function basisReliable({ st }: Context): Failure | null {
  const { basis } = st;
  if (!basis.reliable)
    return fail('basis-unreliable', `the HYPE basis is unreliable: ${basis.reason ?? 'unknown'}`);
  return basis.basisE8 === null
    ? fail('basis-unreliable', 'the ledger holds no HYPE, so there is no basis')
    : null;
}

/** S5 (puts, when set): HYPE, at spot, is at most `maxHypeExposurePct` of the HYPE plus the put capital. */
function hypeExposure({ st, s, c }: Context): Failure | null {
  const maxPct = c.safety.maxHypeExposurePct;
  if (maxPct === undefined) return null;
  const capBps = fractionToBps(maxPct);
  const hypeUsd6 = (st.capital.call.total * s.market.spotE8) / E20;
  const capitalUsd6 = hypeUsd6 + st.capital.put.total;
  if (hypeUsd6 * BPS <= capBps * capitalUsd6) return null;
  return fail(
    'exposure-cap',
    `HYPE is ${(hypeUsd6 * BPS) / capitalUsd6} bps of the capital, above ${capBps}`,
  );
}
