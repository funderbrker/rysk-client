import { readFileSync } from 'node:fs';
import { type Address, getAddress, isAddress, isAddressEqual, zeroAddress } from 'viem';
import { z } from 'zod';
import { TOKENS, type TokenInfo, type TokenKey, tokenBySymbol } from '../domain/constants.ts';
import { e18FromDecimal, fractionFromPct, usd6FromDecimal, usdE8FromDecimal } from '../domain/units.ts';
import type { SideConfig, WheelConfig } from '../strategy/wheel/config.ts';
import { HARD_CAP_RFQ_PER_MIN, REQUOTE_RESERVE_RFQ_PER_MIN } from './bucket.ts';
import { LOG_LEVELS } from './logger.ts';

/** The daemon's configuration: the config file normalized (spec §8.9) and the run mode resolved (spec §9.1). */
export type AppConfig = {
  mode: 'live' | 'dry-run';
  account: { address: Address; keystorePath: string };
  rpcUrl: string;
  rysk: { restUrl: string; wsUrl: string; appUrl: string };
  tickSeconds: number;
  dataDir: string;
  logLevel: string;
  wheel: WheelConfig;
  sampler: SamplerConfig;
  /** `--max-trades` (set by the CLI; the file cannot): exit after this many completed executions. */
  maxTrades?: number;
  /** Notices for the caller to log; `loadConfig` never logs. */
  warnings: string[];
};

/**
 * The research sampler (spec §9.2); `putStables` (USDC only) and `callCollaterals` (WHYPE only) are token
 * addresses.
 */
export type SamplerConfig = {
  enabled: boolean;
  /**
   * Sockets (takers) the wiring opens for the sampler, one RFQ in flight each (spec §9.2); 1–8. `runSampler` itself
   * uses whatever takers it is given.
   */
  parallel: number;
  sweepEveryMin: number;
  pinned: number;
  pinnedEveryMin: number;
  takerPairEveryMin: number;
  inventoryEveryMin: number;
  publicFillsEveryMin: number;
  requestTimeoutMs: number;
  putStables: Address[];
  callCollaterals: Address[];
};

/**
 * An invalid config. `path` is the offending JSON path (`put.minOtmPct`, `sampler.putStables[1]`), or `''`
 * for the whole file.
 */
export class ConfigError extends Error {
  readonly path: string;

  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(path === '' ? reason : `${path}: ${reason}`, options);
    this.name = 'ConfigError';
    this.path = path;
  }
}

const E18 = 10n ** 18n;
const DECIMAL = /^(-?)[0-9]+(?:\.([0-9]+))?$/;
const BPS_TOLERANCE = 1e-9;
const JSON_ERROR_PLACE = /at position \d+(?: \(line \d+ column \d+\))?/;

/** Why `text` is not a decimal string of at most `decimals` places (negative only when `signed`), if it is not. */
function decimalProblem(text: string, decimals: number, signed: boolean): string | undefined {
  const match = DECIMAL.exec(text);
  if (match === null) return `'${text}' is not a decimal string`;
  if (match[1] === '-' && !signed) return `'${text}' must not be negative`;
  if ((match[2]?.length ?? 0) > decimals) return `'${text}' has more than ${decimals} decimals`;
  return undefined;
}

/** A decimal string converted to `bigint` by string arithmetic (never a float). */
function decimal(decimals: number, convert: (text: string) => bigint, signed = false) {
  return z.string().transform((text, ctx) => {
    const problem = decimalProblem(text, decimals, signed);
    if (problem === undefined) return convert(text);
    ctx.addIssue({ code: 'custom', message: problem });
    return z.NEVER;
  });
}

/** `fractionToBps` scales bigint amounts by a fraction, so a fraction must be a whole number of basis points. */
function isBpsFraction(fraction: number): boolean {
  const bps = fraction * 10_000;
  return fraction >= 0 && fraction <= 1 && Math.abs(Math.round(bps) - bps) <= BPS_TOLERANCE;
}

/** `null` (unbounded or off) becomes `undefined`. */
function unbounded<T extends z.ZodType>(schema: T) {
  return schema.nullable().transform((value) => value ?? undefined);
}

const usd6 = decimal(6, usd6FromDecimal);
const e18 = decimal(18, e18FromDecimal);
const signedE18 = decimal(18, e18FromDecimal, true);
const usdE8 = decimal(8, usdE8FromDecimal);
const count = z.number().int().nonnegative();
/** A rate, timeout or count where 0 would stall the daemon silently (an empty token bucket, an instant timeout). */
const positiveCount = z.number().int().positive();
const nonNegative = z.number().nonnegative();
const unitInterval = z.number().min(0).max(1);
const nonEmpty = z.string().min(1);
const bpsFraction = z.number().refine(isBpsFraction, 'must be a fraction from 0 to 1 in whole basis points');
/** A `*Pct` field that feeds `fractionToBps`, as a fraction (`1` → `0.01`). */
const bpsPct = z.number().transform((pct, ctx) => {
  const fraction = fractionFromPct(pct);
  if (isBpsFraction(fraction)) return fraction;
  ctx.addIssue({
    code: 'custom',
    message: 'must be a percentage from 0 to 100 in whole basis points (0.01 %)',
  });
  return z.NEVER;
});
const contractsE18 = positiveCount.transform((contracts) => BigInt(contracts) * E18);
const httpUrl = z.url({ protocol: /^https?$/, error: 'must be an http: or https: URL' });
const socketUrl = z.url({ protocol: /^wss?$/, error: 'must be a ws: or wss: URL' });

/** Lowercase or EIP-55 checksummed (a mixed-case typo fails its checksum), returned checksummed. */
const address = z.string().transform((value, ctx) => {
  if (isAddress(value, { strict: true })) return getAddress(value);
  ctx.addIssue({ code: 'custom', message: `'${value}' is not a lowercase or checksummed address` });
  return z.NEVER;
});

/** The sampler's put legs: USDC only. USDT0 was dropped once the data showed it priced the same as USDC. */
const PUT_STABLES: readonly TokenKey[] = ['USDC'];
/**
 * The sampler's call legs: WHYPE only. The kHYPE, LHYPE and wstHYPE legs were dropped on the operator's ruling that
 * no makers quote them.
 */
const CALL_COLLATERALS: readonly TokenKey[] = ['WHYPE'];

/** A token symbol in any case (`usdc`, `KHYPE`) among `allowed`, resolved to its address. */
function tokenAddress(allowed: readonly TokenKey[], kind: string) {
  const symbols = allowed.map((key) => TOKENS[key].symbol.toLowerCase()).join(', ');
  return z.string().transform((symbol, ctx) => {
    let token: TokenInfo;
    try {
      token = tokenBySymbol(symbol);
    } catch {
      ctx.addIssue({ code: 'custom', message: `unknown token symbol '${symbol}'` });
      return z.NEVER;
    }
    if (allowed.some((key) => TOKENS[key].address === token.address)) return token.address;
    ctx.addIssue({ code: 'custom', message: `'${symbol}' is not ${kind} (${symbols})` });
    return z.NEVER;
  });
}

const logLevel = z
  .string()
  .refine((level) => LOG_LEVELS.includes(level), `must be one of ${LOG_LEVELS.join(', ')}`);

const sideFields = {
  enabled: z.boolean(),
  minAprPct: nonNegative.transform(fractionFromPct),
  minHoursToExpiry: nonNegative,
  maxDaysToExpiry: nonNegative,
  minAbsDelta: unitInterval,
  maxAbsDelta: unitInterval,
  minOtmPct: bpsPct,
  minIntervalHours: nonNegative,
  trancheFraction: bpsFraction,
  maxContractsPerTrade: contractsE18,
};

/** Appendix B: the shape and per-field rules, with units converted (decimal strings → bigint, `*Pct` → fraction). */
const configFile = z.strictObject({
  mode: z.enum(['live', 'dry-run']),
  enabled: z.boolean(),
  account: z.strictObject({ address, keystorePath: nonEmpty }),
  rpcUrl: httpUrl,
  rysk: z.strictObject({ restUrl: httpUrl, wsUrl: socketUrl, appUrl: httpUrl }),
  tickSeconds: count.min(5),
  dataDir: nonEmpty,
  logLevel,
  put: z.strictObject({ ...sideFields, reserveUsdc: usd6, maxCapitalUsdc: unbounded(usd6) }),
  call: z.strictObject({
    ...sideFields,
    reserveWhype: e18,
    maxCapitalWhype: unbounded(e18),
    minStrikeOverBasisPct: bpsPct,
    fallback: z.strictObject({
      enabled: z.boolean(),
      scope: z.enum(['window', 'all-listed']),
      customStrikeFirst: z.boolean(),
      maxDiscountToBasisPct: unbounded(bpsPct),
      minNetPremiumUsd: usd6,
    }),
  }),
  tranche: z.strictObject({ allowSingleLot: z.boolean() }),
  basis: z.strictObject({
    anchor: z.strictObject({ ts: count, qtyWhype: e18, basisUsd: usdE8 }),
    externalFlows: z
      .array(z.strictObject({ ts: count, qtyWhype: signedE18, basisUsd: unbounded(usdE8).optional() }))
      .default([]),
    residualPolicy: z.enum(['absorb', 'block-calls']),
    residualToleranceWhype: e18,
  }),
  quoting: z.strictObject({
    quotesPerSide: positiveCount,
    rfqTimeoutMs: positiveCount,
    replanSec: count,
    prefilterRatio: nonNegative,
    strategyRfqPerMin: positiveCount,
    samplerRfqPerMin: positiveCount,
  }),
  safety: z.strictObject({
    maxGasFeeUsd: usd6,
    maxGasFeeBps: positiveCount,
    minNetPremiumUsd: usd6,
    minQuoteTtlSec: count,
    maxQuoteTtlSec: count,
    maxPremiumFractionOfCollateral: unitInterval,
    /** Positive: a put is held to this alone, and 0 would demand float equality (every put would fail C7). */
    aprEchoTolerancePp: z.number().positive(),
    aprEchoToleranceRelPct: bpsPct,
    verifyMakerSig: z.enum(['warn', 'enforce']),
    maxClockSkewMs: count,
    startupQuietSec: count,
    settlementGraceSec: count,
    settlementOverdueHours: nonNegative,
    maxDeploymentsPer24h: count,
    maxNotionalPer24hUsd: usd6,
    minNativeHype: e18,
    maxFeePerGasGwei: positiveCount,
    confirmTimeoutMs: positiveCount,
    unknownMaxWaitSec: positiveCount,
    maxHypeExposurePct: unbounded(bpsPct),
    pauseOnFrontendChange: z.boolean(),
  }),
  sampler: z.strictObject({
    enabled: z.boolean(),
    parallel: positiveCount.max(8),
    sweepEveryMin: count,
    pinned: count,
    pinnedEveryMin: count,
    takerPairEveryMin: count,
    inventoryEveryMin: count,
    publicFillsEveryMin: count,
    requestTimeoutMs: positiveCount,
    putStables: z.array(tokenAddress(PUT_STABLES, 'a USD stable')),
    callCollaterals: z.array(tokenAddress(CALL_COLLATERALS, 'a HYPE collateral')),
  }),
});

type ConfigFile = z.output<typeof configFile>;
type SideFile = ConfigFile['put'] | ConfigFile['call'];

/**
 * How the config is read. `live` is `--live`. `requireAnchor` (default true) applies the basis anchor rule; the
 * read-only commands turn it off, since `basis suggest-anchor` is how an operator finds the anchor to fill in.
 */
export type ConfigFlags = { live: boolean; requireAnchor?: boolean };

/** Reads, validates and normalizes the config file at `path`; throws `ConfigError`. */
export function loadConfig(path: string, flags: ConfigFlags): AppConfig {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError('', `cannot read config file '${path}': ${reasonOf(error)}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    // No `cause`: V8's message quotes the source around the error, which can hold the RPC URL's key.
    throw new ConfigError('', `config file '${path}' is not valid JSON ${jsonErrorPlace(error)}`);
  }
  return parseConfig(raw, flags);
}

/** Validates and normalizes a parsed config file (see `ConfigFlags`). Throws `ConfigError`. */
export function parseConfig(raw: unknown, flags: ConfigFlags): AppConfig {
  const parsed = configFile.safeParse(raw);
  if (!parsed.success) throw fromIssues(parsed.error.issues);
  const file = parsed.data;
  checkSide('put', file.put);
  checkSide('call', file.call);
  if (flags.requireAnchor ?? true) checkAnchor(file);
  checkQuoteTtl(file);
  checkRfqRates(file);
  const warnings: string[] = [];
  const mode = resolveMode(file, flags.live, warnings);
  return {
    mode,
    account: file.account,
    rpcUrl: file.rpcUrl,
    rysk: file.rysk,
    tickSeconds: file.tickSeconds,
    dataDir: file.dataDir,
    logLevel: file.logLevel,
    wheel: wheelConfig(file, mode),
    sampler: file.sampler,
    warnings,
  };
}

function fromIssues(issues: readonly z.core.$ZodIssue[]): ConfigError {
  const [first, ...rest] = issues;
  if (first === undefined) return new ConfigError('', 'invalid config');
  const keys = first.code === 'unrecognized_keys' ? [...first.path, ...first.keys.slice(0, 1)] : first.path;
  const more =
    rest.length === 0 ? '' : ` (and ${rest.length} more ${rest.length === 1 ? 'issue' : 'issues'})`;
  return new ConfigError(jsonPath(keys), `${first.message}${more}`);
}

function jsonPath(keys: readonly PropertyKey[]): string {
  return keys.reduce<string>((path, key) => {
    if (typeof key === 'number') return `${path}[${key}]`;
    return path === '' ? String(key) : `${path}.${String(key)}`;
  }, '');
}

function checkSide(side: 'put' | 'call', config: SideFile): void {
  if (config.minAbsDelta > config.maxAbsDelta) {
    throw new ConfigError(
      `${side}.minAbsDelta`,
      `${config.minAbsDelta} exceeds maxAbsDelta ${config.maxAbsDelta}`,
    );
  }
  if (config.minHoursToExpiry * 3600 > config.maxDaysToExpiry * 86_400) {
    throw new ConfigError(
      `${side}.minHoursToExpiry`,
      `${config.minHoursToExpiry} h exceeds maxDaysToExpiry ${config.maxDaysToExpiry} d`,
    );
  }
}

/**
 * Spec §8.4: a zero anchor would disable the basis rule, so calls need a real one to run (see `ConfigFlags`). The
 * example ships a zero anchor, so `run` refuses it, field by field, until the operator has filled in both the
 * time and the basis price; a half-filled anchor is caught the same way.
 */
function checkAnchor(file: ConfigFile): void {
  if (!file.call.enabled) return;
  const { anchor } = file.basis;
  const hint = 'must be positive while call.enabled (see `rysk basis suggest-anchor`)';
  if (anchor.ts <= 0) throw new ConfigError('basis.anchor.ts', hint);
  if (anchor.basisUsd <= 0n) throw new ConfigError('basis.anchor.basisUsd', hint);
}

/** Check C6 accepts a quote TTL in `[minQuoteTtlSec, maxQuoteTtlSec]`; an empty range rejects every quote. */
function checkQuoteTtl(file: ConfigFile): void {
  const { minQuoteTtlSec, maxQuoteTtlSec } = file.safety;
  if (minQuoteTtlSec > maxQuoteTtlSec) {
    throw new ConfigError(
      'safety.minQuoteTtlSec',
      `${minQuoteTtlSec} s exceeds maxQuoteTtlSec ${maxQuoteTtlSec} s`,
    );
  }
}

/**
 * Spec §8.7: the strategy and the sampler share the hard cap (`HARD_CAP_RFQ_PER_MIN`), and an execution's re-quote does not take
 * from it (waiting would spend the quote's TTL), so the two loops together keep 2 a minute free for re-quotes.
 */
function checkRfqRates(file: ConfigFile): void {
  const { strategyRfqPerMin, samplerRfqPerMin } = file.quoting;
  const maxPerMin = HARD_CAP_RFQ_PER_MIN - REQUOTE_RESERVE_RFQ_PER_MIN;
  if (strategyRfqPerMin + samplerRfqPerMin > maxPerMin) {
    throw new ConfigError(
      'quoting.strategyRfqPerMin',
      `${strategyRfqPerMin} plus samplerRfqPerMin ${samplerRfqPerMin} exceeds ${maxPerMin} a minute ` +
        `(the hard cap of ${HARD_CAP_RFQ_PER_MIN} less ${REQUOTE_RESERVE_RFQ_PER_MIN} kept for execution re-quotes)`,
    );
  }
}

/**
 * Spec §9.1: live needs `--live` and `mode: "live"`; `--live` alone is an error; the file alone runs dry. A live
 * run also needs the trading wallet and `verifyMakerSig: "enforce"`: under `"warn"` a quote whose maker signature
 * does not recover could be signed and sent (the chain would refuse it, but the confirm counts as an error).
 */
function resolveMode(file: ConfigFile, live: boolean, warnings: string[]): AppConfig['mode'] {
  if (live && file.mode === 'dry-run') {
    throw new ConfigError('mode', `--live needs mode "live" in the config, which says "dry-run"`);
  }
  if (!live) {
    if (file.mode === 'live')
      warnings.push('config mode is "live" but --live was not given: running dry-run');
    return 'dry-run';
  }
  if (isAddressEqual(file.account.address, zeroAddress)) {
    throw new ConfigError('account.address', 'a live run needs the trading wallet, not the zero address');
  }
  if (file.safety.verifyMakerSig !== 'enforce') {
    throw new ConfigError(
      'safety.verifyMakerSig',
      `must be "enforce" for a live run, not "${file.safety.verifyMakerSig}"`,
    );
  }
  return 'live';
}

function wheelConfig(file: ConfigFile, mode: AppConfig['mode']): WheelConfig {
  const { put, call, basis, safety } = file;
  return {
    mode,
    enabled: file.enabled,
    self: file.account.address,
    put: { ...sideConfig(put), reserve6: put.reserveUsdc, maxCapital6: put.maxCapitalUsdc },
    call: {
      ...sideConfig(call),
      reserveE18: call.reserveWhype,
      maxCapitalE18: call.maxCapitalWhype,
      minStrikeOverBasisPct: call.minStrikeOverBasisPct,
      fallback: {
        enabled: call.fallback.enabled,
        scope: call.fallback.scope,
        customStrikeFirst: call.fallback.customStrikeFirst,
        maxDiscountToBasisPct: call.fallback.maxDiscountToBasisPct,
        minNetPremium6: call.fallback.minNetPremiumUsd,
      },
    },
    tranche: file.tranche,
    basis: {
      anchor: { ts: basis.anchor.ts, qtyE18: basis.anchor.qtyWhype, basisE8: basis.anchor.basisUsd },
      externalFlows: basis.externalFlows.map((flow) => ({
        ts: flow.ts,
        qtyE18: flow.qtyWhype,
        basisE8: flow.basisUsd,
      })),
      residualPolicy: basis.residualPolicy,
      residualToleranceE18: basis.residualToleranceWhype,
    },
    quoting: file.quoting,
    safety: {
      maxGasFee6: safety.maxGasFeeUsd,
      maxGasFeeBps: safety.maxGasFeeBps,
      minNetPremium6: safety.minNetPremiumUsd,
      minQuoteTtlSec: safety.minQuoteTtlSec,
      maxQuoteTtlSec: safety.maxQuoteTtlSec,
      maxPremiumFractionOfCollateral: safety.maxPremiumFractionOfCollateral,
      aprEchoTolerancePp: safety.aprEchoTolerancePp,
      aprEchoToleranceRelPct: safety.aprEchoToleranceRelPct,
      verifyMakerSig: safety.verifyMakerSig,
      maxClockSkewMs: safety.maxClockSkewMs,
      startupQuietSec: safety.startupQuietSec,
      settlementGraceSec: safety.settlementGraceSec,
      settlementOverdueHours: safety.settlementOverdueHours,
      maxDeploymentsPer24h: safety.maxDeploymentsPer24h,
      maxNotionalPer24h6: safety.maxNotionalPer24hUsd,
      minNativeHypeE18: safety.minNativeHype,
      maxFeePerGasGwei: safety.maxFeePerGasGwei,
      confirmTimeoutMs: safety.confirmTimeoutMs,
      unknownMaxWaitSec: safety.unknownMaxWaitSec,
      maxHypeExposurePct: safety.maxHypeExposurePct,
      pauseOnFrontendChange: safety.pauseOnFrontendChange,
    },
  };
}

function sideConfig(side: SideFile): SideConfig {
  return {
    enabled: side.enabled,
    minApr: side.minAprPct,
    minHoursToExpiry: side.minHoursToExpiry,
    maxDaysToExpiry: side.maxDaysToExpiry,
    minAbsDelta: side.minAbsDelta,
    maxAbsDelta: side.maxAbsDelta,
    minOtmPct: side.minOtmPct,
    minIntervalHours: side.minIntervalHours,
    trancheFraction: side.trancheFraction,
    maxContractsPerTradeE18: side.maxContractsPerTrade,
  };
}

/**
 * Where `JSON.parse` failed (`at position 61 (line 1 column 62)`), else the error's class; never V8's
 * message itself, whose "Unexpected token" form quotes the file around the error.
 */
function jsonErrorPlace(error: unknown): string {
  const place = error instanceof Error ? JSON_ERROR_PLACE.exec(error.message) : null;
  if (place !== null) return place[0];
  return `(${error instanceof Error ? error.name : 'unknown error'})`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
