import type { Address } from 'viem';
import type {
  Asset,
  Cap,
  Listing,
  Position,
  Product,
  Quote,
  QuoteRequest,
  Side,
} from '../../domain/types.ts';

/** Everything one tick of the strategy reads (spec §8.1). `nowSec` is the chain block timestamp. */
export type Snapshot = {
  nowSec: number;
  /** The process clock. */
  localNowMs: number;
  mode: 'live' | 'dry-run';
  self: Address;
  chain: {
    blockNumber: bigint;
    /** The block timestamp (epoch seconds). */
    blockTs: number;
    whypeE18: bigint;
    usdc6: bigint;
    usdt06: bigint;
    nativeHypeE18: bigint;
    allowanceUsdc6: bigint;
    allowanceWhypeE18: bigint;
    vaultCounter: bigint;
    /** `pendingNonce − latestNonce`; non-zero means one of our transactions is unmined. */
    pendingNonceGap: number;
  };
  /** The chain-999 WHYPE positions, strictly parsed this tick. */
  positions: Position[];
  /**
   * Chain-999 rows from the positions API that are not WHYPE positions (other underlyings); the wiring counts
   * `parsePositions().otherRows` with `chainId === 999`, so rows the API returns for other chains are not counted.
   */
  otherRowCount: number;
  market: {
    assets: Asset[];
    listings: Listing[];
    caps: Cap[];
    spotE8: bigint;
    /** When the inventory was fetched (epoch seconds). */
    inventoryTs: number;
  };
  memo: {
    /** Set when a confirm is sent; cleared on `confirm-rejected` and `reverted`. */
    lastConfirmSec: Partial<Record<Side, number>>;
    cooldownUntilSec: Partial<Record<Side, number>>;
    /** Dry-run only: simulated deployments, lost on restart (spec §8.8). */
    simulatedDeploySec: Partial<Record<Side, number>>;
    inFlight: boolean;
    uptimeSec: number;
    serverSkewMs: number;
    frontendChanged: boolean;
    stopFile: boolean;
    /**
     * Gate G3: `nowSec` of the first tick (in memory) of the current run of ticks that saw no pending
     * basis-relevant row. Set once when a run starts, not refreshed while it lasts; `null` while such a row is
     * pending and before the first tick after a restart.
     */
    lastNoPendingSeenSec: number | null;
  };
};

export type RowClass =
  | 'managedPut'
  | 'managedCall'
  | 'whypeCallOtherUsd'
  | 'whypePutOtherUsd'
  | 'hypeForeignCollateral'
  | 'foreign'
  | 'otherChain';
export type Phase = 'open' | 'pendingSettlement' | 'settled' | 'unknown';

/** Per-side capital in the side's collateral units: USDC 6 dp for puts, WHYPE 18 dp for calls (spec §8.2). */
export type SideCapital = { free: bigint; locked: bigint; pending: bigint; total: bigint; budget: bigint };

export type WheelState = {
  consistency: 'ok' | 'api-lag' | 'inconsistent';
  rows: { position: Position; cls: RowClass; phase: Phase }[];
  capital: Record<Side, SideCapital>;
  basis: { basisE8: bigint | null; qtyE18: bigint; residualE18: bigint; reliable: boolean; reason?: string };
  lastDeployTs: Partial<Record<Side, number>>;
  deploymentsLast24h: number;
  notionalLast24h6: bigint;
  anomalies: string[];
  warnings: string[];
};

export type HoldReason =
  | 'disabled'
  | 'kill-switch'
  | 'anomaly'
  | 'api-lag'
  | 'inconsistent'
  | 'settlement-pending'
  | 'stale-data'
  | 'clock-skew'
  | 'market-closed'
  | 'frontend-changed'
  | 'quiet-period'
  | 'in-flight'
  | 'tx-pending'
  | 'cooldown'
  | 'gas-reserve'
  | 'daily-limit'
  | 'interval'
  | 'below-min-lot'
  | 'cap'
  | 'basis-unreliable'
  | 'exposure-cap'
  | 'no-candidates'
  | 'no-quotes'
  | 'apr-floor'
  | 'fallback-too-far-below-basis'
  | 'gas';

export type Candidate = {
  side: Side;
  /** `null` for a custom strike. */
  listing: Listing | null;
  product: Product;
  strikeE8: bigint;
  expirySec: number;
  quantityE18: bigint;
  /** In the collateral token's units: USDC 6 dp for puts, WHYPE 18 dp for calls. */
  collateralAmount: bigint;
  request: QuoteRequest;
  mode: 'normal' | 'basis-fallback' | 'basis-fallback-custom';
  /** 1 is the best: the position in the ranked listings it was chosen from, or in the fallback's order. */
  rank: number;
  /** The listing's indicative APR (a fraction) and delta; `null` for a custom strike. */
  indicativeApr: number | null;
  delta: number | null;
};

/** One gate's outcome (spec §8.3); `detail` says why a gate failed. */
export type GateResult = { id: string; pass: boolean; detail?: string };

/**
 * The first candidate filter (spec §8.6) a listing failed; `daily-limit` (C16's notional clause) in live only,
 * `apr-prefilter` only when the prefilter was applied.
 */
export type ExclusionReason =
  | 'product'
  | 'tenor'
  | 'moneyness'
  | 'basis'
  | 'size'
  | 'delta'
  | 'daily-limit'
  | 'apr-prefilter';
/** A listing of the side that the normal path's filters left out. */
export type Exclusion = { strikeE8: bigint; expirySec: number; reason: ExclusionReason };

/**
 * Both kinds carry the side's gate results and the listings filtered out (`[]` when a gate holds, as no listing
 * was screened). `prefilterBypassed` is set when the APR prefilter would have removed every listing that passed
 * the other filters, so the best of them are quoted anyway (the floor applies to the real quotes). A quote plan's
 * `detail` says why it departs from the usual path (a fallback strike K* that clears the basis, quoted as normal).
 */
export type SidePlan =
  | {
      kind: 'hold';
      side: Side;
      reason: HoldReason;
      detail?: string;
      gates: GateResult[];
      excluded: Exclusion[];
    }
  | {
      kind: 'quote';
      side: Side;
      candidates: Candidate[];
      gates: GateResult[];
      excluded: Exclusion[];
      prefilterBypassed: boolean;
      detail?: string;
    };

export type QuoteOutcome =
  | {
      ok: true;
      quote: Quote;
      requestedAtMs: number;
      respondedAtMs: number;
      makerSigOk: boolean | null;
      gas: { ok: true; gasFee6: bigint } | { ok: false; reason: 'exceeds-premium' | 'http' };
    }
  | {
      ok: false;
      error: 'timeout' | 'rpc-error' | 'mismatch' | 'socket-closed';
      message: string;
      requestedAtMs: number;
    };

export type QuotedCandidate = { candidate: Candidate; outcome: QuoteOutcome };

export type Decision =
  | {
      kind: 'trade';
      candidate: Candidate;
      quote: Quote;
      gasFee6: bigint;
      aprNet: number;
      aprRysk: number;
      minPriceE18: bigint;
      maxGasFee6: bigint;
      lossIfExercisedUsd?: number;
    }
  | { kind: 'hold'; side: Side; reason: HoldReason; best?: { candidate: Candidate; aprNet: number } };
