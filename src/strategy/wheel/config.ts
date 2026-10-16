import type { Address } from 'viem';

/**
 * The wheel's configuration: Appendix B normalized at the boundary (spec §8.9; the parser lives in the daemon).
 * USD and USDC amounts are 6 dp (`…6`), WHYPE and HYPE amounts 18 dp (`…E18`), basis prices 8 dp (`…E8`);
 * fractions are numbers (0.01 is 1 %), including the fields that keep a `Pct` name; an unbounded or disabled
 * optional limit (`null` in the file) is `undefined`.
 */
export type WheelConfig = {
  mode: 'live' | 'dry-run';
  enabled: boolean;
  /** The configured account (`account.address`): the quote requests' taker in both modes. */
  self: Address;
  put: PutConfig;
  call: CallConfig;
  tranche: { allowSingleLot: boolean };
  basis: BasisConfig;
  quoting: QuotingConfig;
  safety: SafetyConfig;
};

/** The limits both sides share (spec §8.5, §8.6). */
export type SideConfig = {
  enabled: boolean;
  /** The net APR floor as a fraction (0.4 is 40 %); `minAprPct` in the file. */
  minApr: number;
  minHoursToExpiry: number;
  maxDaysToExpiry: number;
  /** The `|delta|` band, inclusive. */
  minAbsDelta: number;
  maxAbsDelta: number;
  /** Minimum distance of the strike from spot as a FRACTION of spot (0.01 is 1 %), despite the name. */
  minOtmPct: number;
  /** Minimum time between deployments on this side (gate S2). */
  minIntervalHours: number;
  /** The share of the side's budget one tranche targets (0.25 is a quarter). */
  trancheFraction: number;
  /** `maxContractsPerTrade` (whole contracts) in 18 dp. */
  maxContractsPerTradeE18: bigint;
};

export type PutConfig = SideConfig & {
  /** USDC (6 dp) kept out of the put budget (`reserveUsdc`). */
  reserve6: bigint;
  /** The put budget cap in USDC 6 dp (`maxCapitalUsdc`); `undefined` is unbounded. */
  maxCapital6?: bigint;
};

export type CallConfig = SideConfig & {
  /** WHYPE (18 dp) kept out of the call budget (`reserveWhype`). */
  reserveE18: bigint;
  /** The call budget cap in WHYPE 18 dp (`maxCapitalWhype`); `undefined` is unbounded. */
  maxCapitalE18?: bigint;
  /** A call strike must be at least `basis × (1 + this)`; a FRACTION (0.01 is 1 %), despite the name. */
  minStrikeOverBasisPct: number;
  fallback: CallFallbackConfig;
};

/** The call fallback when no listed strike clears the basis (spec §8.6). */
export type CallFallbackConfig = {
  enabled: boolean;
  /** Whether basis eligibility looks only inside the tenor window (`'window'`) or at every listed expiry. */
  scope: 'window' | 'all-listed';
  customStrikeFirst: boolean;
  /**
   * Hold when the fallback strike is below `basis × (1 − this)`; a FRACTION (0.1 is 10 %), despite the name;
   * `undefined` is off.
   */
  maxDiscountToBasisPct?: number;
  /** The fallback's net premium floor, USD 6 dp (`minNetPremiumUsd`). */
  minNetPremium6: bigint;
};

/** The HYPE basis ledger's inputs (spec §8.4). Timestamps are epoch seconds. */
export type BasisConfig = {
  /** HYPE owned at `ts` (wallet WHYPE plus WHYPE locked in calls open then) and its average cost. */
  anchor: { ts: number; qtyE18: bigint; basisE8: bigint };
  /** Deposits (positive `qtyE18`) and withdrawals (negative); a deposit without `basisE8` uses the anchor's. */
  externalFlows: BasisFlow[];
  residualPolicy: 'absorb' | 'block-calls';
  /** `residualToleranceWhype` in 18 dp. */
  residualToleranceE18: bigint;
};

export type BasisFlow = { ts: number; qtyE18: bigint; basisE8?: bigint };

export type QuotingConfig = {
  quotesPerSide: number;
  rfqTimeoutMs: number;
  /** How often a due side whose floor is unmet re-plans. */
  replanSec: number;
  /** Candidates need `indicativeApr ≥ minApr × prefilterRatio`. */
  prefilterRatio: number;
  strategyRfqPerMin: number;
  samplerRfqPerMin: number;
};

/**
 * Appendix B `safety`, normalized the same way as the execution checklist's configuration (its safety fields
 * carry the same names and units).
 */
export type SafetyConfig = {
  /** `maxGasFeeUsd`, USD 6 dp. */
  maxGasFee6: bigint;
  maxGasFeeBps: number;
  /** `minNetPremiumUsd`, USD 6 dp. */
  minNetPremium6: bigint;
  minQuoteTtlSec: number;
  maxQuoteTtlSec: number;
  maxPremiumFractionOfCollateral: number;
  /** Percentage points, not a fraction. */
  aprEchoTolerancePp: number;
  verifyMakerSig: 'warn' | 'enforce';
  /** Gate G5. */
  maxClockSkewMs: number;
  /** Gate G7, and G3's cover after a restart. */
  startupQuietSec: number;
  /** Gate G3. */
  settlementGraceSec: number;
  settlementOverdueHours: number;
  maxDeploymentsPer24h: number;
  /** `maxNotionalPer24hUsd`, USD 6 dp: strike × quantity for puts, spot × quantity for calls. */
  maxNotionalPer24h6: bigint;
  /** `minNativeHype`, 18 dp (gate G9). */
  minNativeHypeE18: bigint;
  maxFeePerGasGwei: number;
  confirmTimeoutMs: number;
  unknownMaxWaitSec: number;
  /** Gate S5: the cap on HYPE exposure as a FRACTION (0.5 is 50 %), despite the name; `undefined` is off. */
  maxHypeExposurePct?: number;
  pauseOnFrontendChange: boolean;
};
