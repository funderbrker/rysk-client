import { readFileSync } from 'node:fs';
import type { Address } from 'viem';
import { parseCaps } from '../../src/domain/caps.ts';
import { CHAIN_ID, TOKENS } from '../../src/domain/constants.ts';
import { parseAssets, parseInventory } from '../../src/domain/inventory.ts';
import { parsePositions } from '../../src/domain/positions.ts';
import type { Asset, Cap, Listing, Position } from '../../src/domain/types.ts';
import type {
  CallConfig,
  PutConfig,
  SafetyConfig,
  SideConfig,
  WheelConfig,
} from '../../src/strategy/wheel/config.ts';
import type { Snapshot } from '../../src/strategy/wheel/types.ts';

// Shared by the wheel strategy tests: the fixture wallet as one strategy tick sees it, and Appendix B's defaults.

const E18 = 10n ** 18n;
export const NOW_SEC = 1792144000;
const SELF: Address = '0x2222222222222222222222222222222222222222';
export const SPOT_E8 = 4000000000n;
export const ANCHOR = { ts: 1792000000, qtyE18: 130n * E18, basisE8: 5000000000n };

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}

export function fixturePositions(): Position[] {
  return parsePositions(fixture('positions.json'), { underlying: TOKENS.WHYPE.address, chainId: CHAIN_ID })
    .positions;
}

/** The captured chain-999 assets; WHYPE trades in lots of 25 up to 5 000. */
export function fixtureAssets(): Asset[] {
  return parseAssets(fixture('assets.json')).assets;
}

/** The captured HYPE listings, observed at `NOW_SEC`. */
export function fixtureListings(): Listing[] {
  const opts = {
    underlyingSymbol: 'HYPE',
    underlying: TOKENS.WHYPE.address,
    observedAtSec: NOW_SEC,
  } as const;
  return parseInventory(fixture('inventory.json'), opts).listings;
}

export function fixtureCaps(): Cap[] {
  return parseCaps(fixture('caps.json')).caps;
}

export type SnapshotPatch = Partial<Omit<Snapshot, 'chain' | 'market' | 'memo'>> & {
  chain?: Partial<Snapshot['chain']>;
  market?: Partial<Snapshot['market']>;
  memo?: Partial<Snapshot['memo']>;
};

/** The fixture's 77 WHYPE positions plus its 10 other chain-999 rows, 87 vaults on chain. */
export function snapshotFromFixtures(patch: SnapshotPatch = {}): Snapshot {
  const base: Snapshot = {
    nowSec: NOW_SEC,
    localNowMs: NOW_SEC * 1000,
    mode: 'live',
    self: SELF,
    chain: {
      blockNumber: 1n,
      blockTs: NOW_SEC,
      whypeE18: 30n * E18,
      usdc6: 5000_000000n,
      usdt06: 0n,
      nativeHypeE18: E18,
      allowanceUsdc6: 0n,
      allowanceWhypeE18: 0n,
      vaultCounter: 87n,
      pendingNonceGap: 0,
    },
    positions: fixturePositions(),
    otherRowCount: 10,
    market: { assets: [], listings: [], caps: [], spotE8: SPOT_E8, inventoryTs: NOW_SEC },
    memo: {
      lastConfirmSec: {},
      cooldownUntilSec: {},
      simulatedDeploySec: {},
      inFlight: false,
      uptimeSec: 3600,
      serverSkewMs: 0,
      frontendChanged: false,
      stopFile: false,
      lastNoPendingSeenSec: NOW_SEC,
    },
  };
  return {
    ...base,
    ...patch,
    chain: { ...base.chain, ...patch.chain },
    market: { ...base.market, ...patch.market },
    memo: { ...base.memo, ...patch.memo },
  };
}

const SIDE: SideConfig = {
  enabled: true,
  minApr: 0.4,
  minHoursToExpiry: 36,
  maxDaysToExpiry: 16,
  minAbsDelta: 0.05,
  maxAbsDelta: 0.45,
  minOtmPct: 0.01,
  minIntervalHours: 24,
  trancheFraction: 0.25,
  maxContractsPerTradeE18: 25n * E18,
};

export type ConfigPatch = Partial<Omit<WheelConfig, 'put' | 'call' | 'safety'>> & {
  put?: Partial<PutConfig>;
  call?: Partial<CallConfig>;
  safety?: Partial<SafetyConfig>;
};

/** Appendix B's defaults, normalized, in live mode with the anchor above. */
export function wheelConfig(patch: ConfigPatch = {}): WheelConfig {
  const { put, call, safety, ...rest } = patch;
  return {
    mode: 'live',
    enabled: true,
    self: SELF,
    tranche: { allowSingleLot: true },
    basis: { anchor: ANCHOR, externalFlows: [], residualPolicy: 'absorb', residualToleranceE18: 10n ** 12n },
    quoting: {
      quotesPerSide: 3,
      rfqTimeoutMs: 15000,
      replanSec: 300,
      prefilterRatio: 0.5,
      strategyRfqPerMin: 12,
      samplerRfqPerMin: 6,
    },
    ...rest,
    put: { ...SIDE, reserve6: 0n, ...put },
    call: {
      ...SIDE,
      reserveE18: 0n,
      minStrikeOverBasisPct: 0,
      fallback: { enabled: true, scope: 'window', customStrikeFirst: false, minNetPremium6: 1_000000n },
      ...call,
    },
    safety: {
      maxGasFee6: 500000n,
      maxGasFeeBps: 200,
      minNetPremium6: 1_000000n,
      minQuoteTtlSec: 15,
      maxQuoteTtlSec: 600,
      maxPremiumFractionOfCollateral: 0.15,
      aprEchoTolerancePp: 1,
      aprEchoToleranceRelPct: 0.05,
      verifyMakerSig: 'warn',
      maxClockSkewMs: 3000,
      startupQuietSec: 600,
      settlementGraceSec: 900,
      settlementOverdueHours: 6,
      maxDeploymentsPer24h: 4,
      maxNotionalPer24h6: 20000_000000n,
      minNativeHypeE18: 5n * 10n ** 16n,
      maxFeePerGasGwei: 5,
      confirmTimeoutMs: 60000,
      unknownMaxWaitSec: 1800,
      pauseOnFrontendChange: true,
      ...safety,
    },
  };
}
