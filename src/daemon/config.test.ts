import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { zeroAddress } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKENS } from '../domain/constants.ts';
import type { WheelConfig } from '../strategy/wheel/config.ts';
import { ConfigError, loadConfig, parseConfig } from './config.ts';

const EXAMPLE_PATH = fileURLToPath(new URL('../../config.example.json', import.meta.url));
const EXAMPLE_TEXT = readFileSync(EXAMPLE_PATH, 'utf8');
const DRY = { live: false };
const LIVE = { live: true };
/** The read-only commands' flags: the anchor rule, which refuses the example's zero anchor, is off. */
const READ_ONLY = { live: false, requireAnchor: false };
const E18 = 10n ** 18n;
// The public Anvil #0 account, as in the keystore fixture.
const ANVIL0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

type Json = { [key: string]: unknown };

/**
 * The example's JSON with `changes` applied: dotted path → new value; `undefined` deletes the key. The zero anchor
 * is replaced first by a filled-in one, so the result is valid for `run`; a change to `basis.anchor` wins.
 */
function exampleWith(changes: Record<string, unknown> = {}): Json {
  const config = JSON.parse(EXAMPLE_TEXT) as Json;
  (config.basis as Json).anchor = { ts: 1760000000, qtyWhype: '100', basisUsd: '42' };
  for (const [path, value] of Object.entries(changes)) {
    const keys = path.split('.');
    const last = keys.pop() ?? '';
    let target = config;
    for (const key of keys) target = target[key] as Json;
    if (value === undefined) Reflect.deleteProperty(target, last);
    else target[last] = value;
  }
  return config;
}

function configError(load: () => unknown): ConfigError {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

const tempDirs: string[] = [];

function writeTemp(config: Json | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rysk-config-'));
  tempDirs.push(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, typeof config === 'string' ? config : JSON.stringify(config));
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig on config.example.json', () => {
  it('normalizes units at the boundary', () => {
    const config = loadConfig(EXAMPLE_PATH, READ_ONLY);

    expect(config.mode).toBe('dry-run');
    expect(config.wheel.put.minApr).toBe(0.4);
    expect(config.wheel.put.minOtmPct).toBe(0.01);
    expect(config.wheel.put.reserve6).toBe(0n);
    expect(config.wheel.safety.maxNotionalPer24h6).toBe(20000_000000n);
    expect(config.wheel.safety.minNativeHypeE18).toBe(5n * 10n ** 16n);
    expect(config.wheel.basis.anchor).toEqual({ ts: 0, qtyE18: 0n, basisE8: 0n });
    expect(config.wheel.safety.maxGasFee6).toBe(500000n);
    expect(config.wheel.call.fallback.minNetPremium6).toBe(1_000000n);
    expect(config.wheel.put.maxCapital6).toBeUndefined();
  });

  it('maps every field of the file onto AppConfig and WheelConfig', () => {
    const side = {
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
    const wheel: WheelConfig = {
      mode: 'dry-run',
      enabled: true,
      self: zeroAddress,
      put: { ...side, reserve6: 0n, maxCapital6: undefined },
      call: {
        ...side,
        reserveE18: 0n,
        maxCapitalE18: undefined,
        minStrikeOverBasisPct: 0,
        fallback: {
          enabled: true,
          scope: 'window',
          customStrikeFirst: false,
          maxDiscountToBasisPct: undefined,
          minNetPremium6: 1_000000n,
        },
      },
      tranche: { allowSingleLot: true },
      basis: {
        anchor: { ts: 0, qtyE18: 0n, basisE8: 0n },
        externalFlows: [],
        residualPolicy: 'absorb',
        residualToleranceE18: 10n ** 12n,
      },
      quoting: {
        quotesPerSide: 3,
        rfqTimeoutMs: 15000,
        replanSec: 300,
        prefilterRatio: 0.5,
        strategyRfqPerMin: 12,
        samplerRfqPerMin: 6,
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
        verifyMakerSig: 'enforce',
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
        maxHypeExposurePct: undefined,
        pauseOnFrontendChange: true,
      },
    };

    expect(loadConfig(EXAMPLE_PATH, READ_ONLY)).toEqual({
      mode: 'dry-run',
      account: { address: zeroAddress, keystorePath: 'keystore/wheel' },
      rpcUrl: 'https://rpc.hyperliquid.xyz/evm',
      rysk: {
        restUrl: 'https://v12.rysk.finance',
        wsUrl: 'wss://v12.rysk.finance/taker',
        appUrl: 'https://app.rysk.finance',
      },
      tickSeconds: 60,
      dataDir: 'data',
      logLevel: 'info',
      wheel,
      sampler: {
        enabled: true,
        sweepEveryMin: 60,
        pinned: 4,
        pinnedEveryMin: 5,
        takerPairEveryMin: 60,
        inventoryEveryMin: 5,
        publicFillsEveryMin: 60,
        requestTimeoutMs: 6000,
        putStables: [TOKENS.USDC.address],
        callCollaterals: [TOKENS.WHYPE.address],
      },
      warnings: [],
    });
  });

  it('resolves the sampled call collaterals to WHYPE alone', () => {
    expect(loadConfig(EXAMPLE_PATH, READ_ONLY).sampler.callCollaterals).toEqual([TOKENS.WHYPE.address]);
  });

  it('throws ConfigError for --live when the file says dry-run', () => {
    expect(configError(() => loadConfig(writeTemp(exampleWith()), LIVE)).path).toBe('mode');
  });
});

describe('mode resolution', () => {
  it('runs live with --live and mode live', () => {
    const path = writeTemp(exampleWith({ mode: 'live', 'account.address': ANVIL0 }));
    const config = loadConfig(path, LIVE);
    expect(config.mode).toBe('live');
    expect(config.wheel.mode).toBe('live');
    expect(config.wheel.self).toBe(ANVIL0);
    expect(config.warnings).toEqual([]);
  });

  it('runs dry-run with a warning when the file says live but --live is absent', () => {
    const config = parseConfig(exampleWith({ mode: 'live', 'account.address': ANVIL0 }), DRY);
    expect(config.mode).toBe('dry-run');
    expect(config.wheel.mode).toBe('dry-run');
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toMatch(/--live/);
  });

  it('refuses a live run on the zero address', () => {
    expect(configError(() => parseConfig(exampleWith({ mode: 'live' }), LIVE)).path).toBe('account.address');
  });

  it('refuses a live run under verifyMakerSig "warn", which dry-run allows', () => {
    const warn = { mode: 'live', 'account.address': ANVIL0, 'safety.verifyMakerSig': 'warn' };
    const error = configError(() => parseConfig(exampleWith(warn), LIVE));
    expect(error.path).toBe('safety.verifyMakerSig');
    expect(error.message).toContain('"enforce"');
    expect(parseConfig(exampleWith(warn), DRY).wheel.safety.verifyMakerSig).toBe('warn');
  });

  it('never reads maxTrades from the file', () => {
    expect(parseConfig(exampleWith(), DRY).maxTrades).toBeUndefined();
    expect(configError(() => parseConfig(exampleWith({ maxTrades: 1 }), DRY)).path).toBe('maxTrades');
  });
});

describe('basis anchor (spec §8.4)', () => {
  it('throws when call.enabled and anchor.basisUsd is 0', () => {
    const error = configError(() => parseConfig(exampleWith({ 'basis.anchor.basisUsd': '0' }), DRY));
    expect(error.path).toBe('basis.anchor.basisUsd');
    expect(error.message).toContain('basis.anchor.basisUsd');
  });

  it('throws when call.enabled and anchor.ts is 0', () => {
    expect(configError(() => parseConfig(exampleWith({ 'basis.anchor.ts': 0 }), DRY)).path).toBe(
      'basis.anchor.ts',
    );
  });

  it('skips the anchor rule under requireAnchor false, and keeps it by default', () => {
    const zeroAnchor = { ts: 0, qtyWhype: '0', basisUsd: '0' };
    const raw = exampleWith({ 'call.enabled': true, 'basis.anchor': zeroAnchor });

    const config = parseConfig(raw, { ...DRY, requireAnchor: false });
    expect(config.wheel.call.enabled).toBe(true);
    expect(config.wheel.basis.anchor).toEqual({ ts: 0, qtyE18: 0n, basisE8: 0n });
    expect(configError(() => parseConfig(raw, DRY)).path).toBe('basis.anchor.ts');
    expect(configError(() => parseConfig(raw, { ...DRY, requireAnchor: true })).path).toBe('basis.anchor.ts');
    expect(configError(() => loadConfig(writeTemp(raw), DRY)).path).toBe('basis.anchor.ts');
  });

  it("refuses config.example.json's zero anchor for run, and a half-filled one, while calls are enabled", () => {
    const error = configError(() => loadConfig(EXAMPLE_PATH, DRY));
    expect(error.path).toBe('basis.anchor.ts');
    expect(error.message).toContain('rysk basis suggest-anchor');
    // `ts` and `qtyWhype` copied from `suggest-anchor`, `basisUsd` not yet set.
    const halfFilled = exampleWith({ 'basis.anchor': { ts: 1760000000, qtyWhype: '100', basisUsd: '0' } });
    expect(configError(() => parseConfig(halfFilled, DRY)).path).toBe('basis.anchor.basisUsd');
    expect(loadConfig(EXAMPLE_PATH, READ_ONLY).wheel.basis.anchor).toEqual({
      ts: 0,
      qtyE18: 0n,
      basisE8: 0n,
    });
  });

  it('accepts the zero anchor while calls are disabled', () => {
    const zeroAnchor = { ts: 0, qtyWhype: '0', basisUsd: '0' };
    const config = parseConfig(exampleWith({ 'call.enabled': false, 'basis.anchor': zeroAnchor }), DRY);
    expect(config.wheel.basis.anchor).toEqual({ ts: 0, qtyE18: 0n, basisE8: 0n });
  });
});

describe('normalization', () => {
  it('converts optional limits and external flows', () => {
    const config = parseConfig(
      exampleWith({
        'put.maxCapitalUsdc': '1000.5',
        'call.maxCapitalWhype': '10',
        'call.fallback.maxDiscountToBasisPct': 10,
        'safety.maxHypeExposurePct': 50,
        'basis.externalFlows': [
          { ts: 1760000100, qtyWhype: '2.5', basisUsd: '40.25' },
          { ts: 1760000200, qtyWhype: '-1' },
          { ts: 1760000300, qtyWhype: '1', basisUsd: null },
        ],
      }),
      DRY,
    );
    expect(config.wheel.put.maxCapital6).toBe(1000_500000n);
    expect(config.wheel.call.maxCapitalE18).toBe(10n * E18);
    expect(config.wheel.call.fallback.maxDiscountToBasisPct).toBe(0.1);
    expect(config.wheel.safety.maxHypeExposurePct).toBe(0.5);
    expect(config.wheel.basis.externalFlows).toEqual([
      { ts: 1760000100, qtyE18: 25n * 10n ** 17n, basisE8: 40_25000000n },
      { ts: 1760000200, qtyE18: -E18, basisE8: undefined },
      { ts: 1760000300, qtyE18: E18, basisE8: undefined },
    ]);
  });

  it('checksums the account address and resolves sampler symbols in any case', () => {
    const config = parseConfig(
      exampleWith({
        'account.address': ANVIL0.toLowerCase(),
        'sampler.putStables': ['Usdc'],
        'sampler.callCollaterals': ['WHYPE'],
      }),
      DRY,
    );
    expect(config.account.address).toBe(ANVIL0);
    expect(config.wheel.self).toBe(ANVIL0);
    expect(config.sampler.putStables).toEqual([TOKENS.USDC.address]);
    expect(config.sampler.callCollaterals).toEqual([TOKENS.WHYPE.address]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['0 and 100 percent', { 'put.minOtmPct': 0, 'call.minOtmPct': 100 }],
    ['a percentage in whole basis points', { 'call.minStrikeOverBasisPct': 12.34 }],
    ['tranche fractions at the bounds', { 'put.trancheFraction': 1, 'call.trancheFraction': 0.0001 }],
    ['an APR floor off the basis-point grid', { 'put.minAprPct': 33.333, 'call.minAprPct': 0 }],
    ['an equal delta band', { 'put.minAbsDelta': 0.3, 'put.maxAbsDelta': 0.3 }],
    ['a tenor window of one instant', { 'call.minHoursToExpiry': 384, 'call.maxDaysToExpiry': 16 }],
    [
      'the lowest tick and 1 for every positive count',
      {
        tickSeconds: 5,
        'quoting.quotesPerSide': 1,
        'quoting.rfqTimeoutMs': 1,
        'quoting.strategyRfqPerMin': 1,
        'quoting.samplerRfqPerMin': 1,
        'safety.maxGasFeeBps': 1,
        'safety.confirmTimeoutMs': 1,
        'safety.maxFeePerGasGwei': 1,
        'safety.unknownMaxWaitSec': 1,
        'sampler.requestTimeoutMs': 1,
        'put.maxContractsPerTrade': 1,
      },
    ],
    [
      'USDC for puts and WHYPE for calls, in any case',
      {
        'sampler.putStables': ['USDC'],
        'sampler.callCollaterals': ['WHYPE'],
      },
    ],
    ['equal quote TTL bounds', { 'safety.minQuoteTtlSec': 600, 'safety.maxQuoteTtlSec': 600 }],
    ['ws: for the taker socket', { 'rysk.wsUrl': 'ws://localhost:8080/taker' }],
  ])('accepts %s', (_why, changes) => {
    expect(() => parseConfig(exampleWith(changes), DRY)).not.toThrow();
  });

  it('keeps an APR floor off the basis-point grid as a float', () => {
    expect(parseConfig(exampleWith({ 'put.minAprPct': 33.333 }), DRY).wheel.put.minApr).toBeCloseTo(
      0.33333,
      12,
    );
  });
});

const DECIMAL_FIELDS = [
  'put.reserveUsdc',
  'put.maxCapitalUsdc',
  'call.reserveWhype',
  'call.maxCapitalWhype',
  'call.fallback.minNetPremiumUsd',
  'basis.anchor.qtyWhype',
  'basis.anchor.basisUsd',
  'basis.residualToleranceWhype',
  'safety.maxGasFeeUsd',
  'safety.minNetPremiumUsd',
  'safety.maxNotionalPer24hUsd',
  'safety.minNativeHype',
];

const INTEGER_FIELDS = [
  'tickSeconds',
  'quoting.quotesPerSide',
  'quoting.rfqTimeoutMs',
  'quoting.replanSec',
  'quoting.strategyRfqPerMin',
  'quoting.samplerRfqPerMin',
  'safety.maxGasFeeBps',
  'safety.minQuoteTtlSec',
  'safety.maxQuoteTtlSec',
  'safety.maxClockSkewMs',
  'safety.startupQuietSec',
  'safety.settlementGraceSec',
  'safety.maxDeploymentsPer24h',
  'safety.maxFeePerGasGwei',
  'safety.confirmTimeoutMs',
  'safety.unknownMaxWaitSec',
  'sampler.sweepEveryMin',
  'sampler.pinned',
  'sampler.pinnedEveryMin',
  'sampler.takerPairEveryMin',
  'sampler.inventoryEveryMin',
  'sampler.publicFillsEveryMin',
  'sampler.requestTimeoutMs',
  'basis.anchor.ts',
  'put.maxContractsPerTrade',
  'call.maxContractsPerTrade',
];

/** Integer fields where 0 is refused too. */
const POSITIVE_FIELDS = [
  'quoting.quotesPerSide',
  'quoting.rfqTimeoutMs',
  'quoting.strategyRfqPerMin',
  'quoting.samplerRfqPerMin',
  'safety.maxGasFeeBps',
  'safety.confirmTimeoutMs',
  'safety.maxFeePerGasGwei',
  'safety.unknownMaxWaitSec',
  'sampler.requestTimeoutMs',
  'put.maxContractsPerTrade',
  'call.maxContractsPerTrade',
];

const PCT_FIELDS = [
  'put.minOtmPct',
  'call.minOtmPct',
  'call.minStrikeOverBasisPct',
  'call.fallback.maxDiscountToBasisPct',
  'safety.aprEchoToleranceRelPct',
  'safety.maxHypeExposurePct',
];

type Invalid = [why: string, changes: Record<string, unknown>, path: string];

const INVALID: Invalid[] = [
  ...DECIMAL_FIELDS.map((field): Invalid => [`a negative ${field}`, { [field]: '-1' }, field]),
  ['a decimal given as a JSON number', { 'put.reserveUsdc': 0 }, 'put.reserveUsdc'],
  ['a decimal in exponent notation', { 'safety.maxNotionalPer24hUsd': '2e4' }, 'safety.maxNotionalPer24hUsd'],
  ['an empty decimal', { 'safety.minNativeHype': '' }, 'safety.minNativeHype'],
  ['a decimal without an integer part', { 'safety.maxGasFeeUsd': '.5' }, 'safety.maxGasFeeUsd'],
  ['a decimal with a trailing point', { 'call.reserveWhype': '1.' }, 'call.reserveWhype'],
  ['more decimals than USD 6 dp holds', { 'safety.maxGasFeeUsd': '0.0000001' }, 'safety.maxGasFeeUsd'],
  [
    'more decimals than a basis 8 dp holds',
    { 'basis.anchor.basisUsd': '50.000000001' },
    'basis.anchor.basisUsd',
  ],
  [
    'a negative external flow basis',
    { 'basis.externalFlows': [{ ts: 1760000100, qtyWhype: '1', basisUsd: '-1' }] },
    'basis.externalFlows[0].basisUsd',
  ],
  [
    'a malformed external flow quantity',
    { 'basis.externalFlows': [{ ts: 1760000100, qtyWhype: '+1' }] },
    'basis.externalFlows[0].qtyWhype',
  ],
  [
    'a fractional external flow timestamp',
    { 'basis.externalFlows': [{ ts: 1.5, qtyWhype: '1' }] },
    'basis.externalFlows[0].ts',
  ],
  ...INTEGER_FIELDS.flatMap((field): Invalid[] => [
    [`a fractional ${field}`, { [field]: 7.5 }, field],
    [`a negative ${field}`, { [field]: -1 }, field],
  ]),
  ['tickSeconds below 5', { tickSeconds: 4 }, 'tickSeconds'],
  ...POSITIVE_FIELDS.map((field): Invalid => [`${field} 0`, { [field]: 0 }, field]),
  ['minQuoteTtlSec above maxQuoteTtlSec', { 'safety.minQuoteTtlSec': 601 }, 'safety.minQuoteTtlSec'],
  ['aprEchoTolerancePp 0', { 'safety.aprEchoTolerancePp': 0 }, 'safety.aprEchoTolerancePp'],
  ...PCT_FIELDS.flatMap((field): Invalid[] => [
    [`${field} above 100 %`, { [field]: 101 }, field],
    [`a negative ${field}`, { [field]: -1 }, field],
    [`${field} off the basis-point grid`, { [field]: 0.005 }, field],
  ]),
  ['trancheFraction above 1', { 'put.trancheFraction': 1.5 }, 'put.trancheFraction'],
  ['a negative trancheFraction', { 'call.trancheFraction': -0.25 }, 'call.trancheFraction'],
  ['trancheFraction off the basis-point grid', { 'put.trancheFraction': 0.33333 }, 'put.trancheFraction'],
  ['a negative minAprPct', { 'put.minAprPct': -1 }, 'put.minAprPct'],
  ['a delta above 1', { 'call.maxAbsDelta': 1.5 }, 'call.maxAbsDelta'],
  ['minAbsDelta above maxAbsDelta', { 'put.minAbsDelta': 0.5 }, 'put.minAbsDelta'],
  ['minHoursToExpiry beyond maxDaysToExpiry', { 'call.minHoursToExpiry': 385 }, 'call.minHoursToExpiry'],
  ['a malformed account address', { 'account.address': '0x1234' }, 'account.address'],
  [
    'a mixed-case address with a bad checksum',
    { 'account.address': `0xF${ANVIL0.slice(3)}` },
    'account.address',
  ],
  ['an unknown put stable', { 'sampler.putStables': ['usdc', 'dai'] }, 'sampler.putStables[1]'],
  ...['usdt0', 'usdh'].map(
    (symbol): Invalid => [
      `the dropped put stable ${symbol}`,
      { 'sampler.putStables': ['usdc', symbol] },
      'sampler.putStables[1]',
    ],
  ),
  ['an unknown call collateral', { 'sampler.callCollaterals': ['ubtc'] }, 'sampler.callCollaterals[0]'],
  ...['khype', 'lhype', 'wsthype'].map(
    (symbol): Invalid => [
      `the dropped call collateral ${symbol}`,
      { 'sampler.callCollaterals': ['whype', symbol] },
      'sampler.callCollaterals[1]',
    ],
  ),
  ['a HYPE token as a put stable', { 'sampler.putStables': ['usdc', 'whype'] }, 'sampler.putStables[1]'],
  [
    'a stable as a call collateral',
    { 'sampler.callCollaterals': ['whype', 'usdc'] },
    'sampler.callCollaterals[1]',
  ],
  ['an unknown log level', { logLevel: 'verbose' }, 'logLevel'],
  ['an rpcUrl that is not a URL', { rpcUrl: 'rpc.hyperliquid.xyz' }, 'rpcUrl'],
  ['an rpcUrl that is not http(s)', { rpcUrl: 'wss://rpc.hyperliquid.xyz/evm' }, 'rpcUrl'],
  ['a taker socket URL that is not ws(s)', { 'rysk.wsUrl': 'https://v12.rysk.finance/taker' }, 'rysk.wsUrl'],
  ['a REST URL that is not http(s)', { 'rysk.restUrl': 'wss://v12.rysk.finance' }, 'rysk.restUrl'],
  ['an unknown mode', { mode: 'paper' }, 'mode'],
  ['an unknown verifyMakerSig', { 'safety.verifyMakerSig': 'strict' }, 'safety.verifyMakerSig'],
  ['an unknown residualPolicy', { 'basis.residualPolicy': 'ignore' }, 'basis.residualPolicy'],
  ['an unknown fallback scope', { 'call.fallback.scope': 'any' }, 'call.fallback.scope'],
  ['an unknown key', { 'put.minAprPCT': 40 }, 'put.minAprPCT'],
  ['a missing key', { 'safety.pauseOnFrontendChange': undefined }, 'safety.pauseOnFrontendChange'],
];

describe('validation', () => {
  it.each(INVALID)('rejects %s', (_why, changes, path) => {
    expect(configError(() => parseConfig(exampleWith(changes), DRY)).path).toBe(path);
  });

  it('rejects a file that is not a JSON object', () => {
    expect(configError(() => parseConfig([], DRY)).path).toBe('');
  });

  it('wraps an unreadable file and malformed JSON in ConfigError', () => {
    expect(configError(() => loadConfig(join(tmpdir(), 'rysk-no-such-config.json'), DRY)).path).toBe('');
    expect(configError(() => loadConfig(writeTemp('{ "mode": '), DRY)).path).toBe('');
  });

  it('reports a JSON syntax error by position or class, never quoting the file', () => {
    // V8's "Unexpected token" message quotes the source near the error: all of it when it is this short.
    const whole = configError(() => loadConfig(writeTemp('/v2/abcdefghijklmnop'), DRY));
    expect(whole.message).toMatch(/is not valid JSON \(SyntaxError\)$/);
    expect(inspect(whole)).not.toContain('abcdefghijklmnop');
    const nearby = configError(() => loadConfig(writeTemp('{"rpcUrl": /v2/abcdefghijklmnop1234}'), DRY));
    expect(inspect(nearby)).not.toContain('/v2/');
    const placed = configError(() => loadConfig(writeTemp('{ "mode": "dry-run" "enabled": true }'), DRY));
    expect(placed.message).toMatch(/is not valid JSON at position 20 \(line 1 column 21\)$/);
  });
});

describe('RFQ rates (spec §8.7)', () => {
  it('keeps the strategy and sampler rates at most 18 a minute together, 2 under the hard cap', () => {
    const rates = (strategy: number, sampler: number) =>
      exampleWith({ 'quoting.strategyRfqPerMin': strategy, 'quoting.samplerRfqPerMin': sampler });
    expect(parseConfig(rates(12, 6), DRY).wheel.quoting).toMatchObject({
      strategyRfqPerMin: 12,
      samplerRfqPerMin: 6,
    });
    expect(parseConfig(rates(17, 1), DRY).wheel.quoting.strategyRfqPerMin).toBe(17);

    const error = configError(() => parseConfig(rates(12, 7), DRY));
    expect(error.path).toBe('quoting.strategyRfqPerMin');
    expect(error.message).toContain('exceeds 18 a minute');
    expect(configError(() => parseConfig(rates(18, 1), DRY)).path).toBe('quoting.strategyRfqPerMin');
  });
});
