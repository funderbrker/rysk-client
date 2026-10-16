import { readFileSync } from 'node:fs';
import {
  formatTransactionReceipt,
  getAddress,
  type Hex,
  keccak256,
  stringToHex,
  type TransactionReceipt,
} from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ADDRESSES, TOKENS, TRADED_PRODUCTS } from '../domain/constants.ts';
import type { ConfirmBody, Quote, QuoteRequest } from '../domain/types.ts';
import { premium6 } from '../domain/units.ts';
import type { ConfirmationMessage } from '../rysk/eip712.ts';
import type { ConfirmReply } from '../rysk/taker.ts';
import type { ExecutionConfig } from './checks.ts';
import { sellOption } from './sell.ts';
import type { ExecutionEvent, FreshState, TradeDeps, TradeIntent } from './types.ts';

type SpikeRequest = { request: QuoteRequest; reply: { result: Quote } };
const capture = JSON.parse(
  readFileSync(new URL('../../test/fixtures/spike-capture.json', import.meta.url), 'utf8'),
) as { requests: [SpikeRequest, ...SpikeRequest[]]; gas: { full: { body: string } } };
const [putSpike] = capture.requests;
/** The spike put quote: 25 WHYPE puts at 78, valid until 1792146573. */
const QUOTE = putSpike.reply.result;

const FILL_RECEIPT: TransactionReceipt = formatTransactionReceipt(
  JSON.parse(readFileSync(new URL('../../test/fixtures/receipt.json', import.meta.url), 'utf8')),
);
const FILL_HASH = FILL_RECEIPT.transactionHash;
const APPROVE_HASH = keccak256(stringToHex('approve'));
const APPROVE_RECEIPT: TransactionReceipt = { ...FILL_RECEIPT, transactionHash: APPROVE_HASH, logs: [] };
const SIGNATURE: Hex = `0x${'1b'.repeat(65)}`;

const E18 = 10n ** 18n;
/** The address of `test/fixtures/keystore-anvil0.json` (the public Anvil #0 account). */
const SELF = getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
const USDC = TOKENS.USDC.address;
const MARGIN_POOL = ADDRESSES.marginPool;
const SERVER_NOW_SEC = 1792146510;
const NOW_MS = SERVER_NOW_SEC * 1000 + 250;
/** 25 contracts × strike 78 = 1950 USDC. */
const COLLATERAL = 1950000000n;
const GAS_FEE6 = 120_000n;
/** What the echo's `gasFee` says; deliberately not `GAS_FEE6`: the fee comes only from the `GasResult`. */
const ECHOED_GAS_FEE = '130000';
const PREMIUM6 = premium6(25n * E18, BigInt(QUOTE.price));

const HAPPY_STEPS = [
  'precheck',
  'approve',
  'requote',
  'gas',
  'checks',
  'trade-intent',
  'confirm-sent',
  'confirm-reply',
  'receipt',
  'verified',
];

function config(): ExecutionConfig {
  return {
    maxGasFee6: 500_000n,
    maxGasFeeBps: 200,
    minNetPremium6: 1_000_000n,
    minQuoteTtlSec: 15,
    maxQuoteTtlSec: 600,
    maxPremiumFractionOfCollateral: 0.15,
    aprEchoTolerancePp: 1,
    verifyMakerSig: 'warn',
    maxDeploymentsPer24h: 4,
    maxNotionalPer24h6: 20_000_000_000n,
    minNativeHypeE18: 5n * 10n ** 16n,
    minApr: 0.4,
    minOtmPct: 0.01,
    minStrikeOverBasisPct: 0,
    fallbackMinNetPremium6: 1_000_000n,
    minTradeSizeE18: 25n * E18,
    maxTradeSizeE18: 5000n * E18,
    maxContractsPerTradeE18: 25n * E18,
    strikePrecisionE8: 1_000_000n,
    minHoursToExpiry: 36,
    maxDaysToExpiry: 16,
  };
}

/** A fresh state in which the spike put passes every gate and check, given the current allowance. */
function freshState(allowance: bigint): FreshState {
  return {
    gateHold: null,
    trancheQuantityE18: 25n * E18,
    basisE8: null,
    basisReliable: false,
    basisEligibleEmpty: false,
    freshFallbackStrikeE8: null,
    freeCollateral: 5000_000000n,
    spotE8: 8148032044n,
    listedStrikesE8ForExpiry: [7500000000n, 7800000000n, 8000000000n],
    expiriesSec: [1792742400, 1793347200],
    deploymentsLast24h: 0,
    notionalLast24h6: 0n,
    nativeHypeE18: E18,
    allowance,
    fetchedAtMs: NOW_MS - 2000,
    listingsAtMs: NOW_MS - 60_000,
    capHeadroomE18: 30n * E18,
  };
}

/** Selling the spike put, held with 5 s left so the run re-quotes it. */
function intent(): TradeIntent {
  return {
    side: 'put',
    candidate: {
      side: 'put',
      strikeE8: 7800000000n,
      expirySec: QUOTE.expiry,
      quantityE18: 25n * E18,
      collateralAmount: COLLATERAL,
      request: { ...putSpike.request, taker: SELF },
      mode: 'normal',
      product: TRADED_PRODUCTS.put,
    },
    quote: { ...QUOTE, validUntil: SERVER_NOW_SEC + 5 },
    minPriceE18: BigInt(QUOTE.price),
    maxGasFee6: 500_000n,
  };
}

/** The spike's `/api/gas` echo carrying `body`'s fields: the server echoes what it is sent. */
function echoOf(body: ConfirmBody): Record<string, unknown> {
  const spike = JSON.parse(capture.gas.full.body) as Record<string, unknown>;
  return { ...spike, ...body, gasFee: ECHOED_GAS_FEE };
}

/** A `confirm` that writes the frame (firing `onSent`) and then replies `reply`. */
function replying(reply: ConfirmReply): TradeDeps['rpc']['confirm'] {
  return async (_params, opts) => {
    opts.onSent?.();
    return reply;
  };
}

/**
 * Every dependency of a run that fills: the wallet starts with no allowance and vault counter 87; `approve`
 * sets the allowance, and a `confirm` replying with the fill's hash mines it (counter 88, allowance spent).
 */
function fakes(mode: 'live' | 'dry-run' = 'live') {
  const chain = { allowance: 0n, counter: 87n };
  const controller = new AbortController();
  const signConfirmation = vi.fn<(m: ConfirmationMessage) => Promise<Hex>>(async () => SIGNATURE);
  const deps = {
    mode,
    signal: controller.signal,
    walletAddress: SELF,
    freshState: vi.fn<TradeDeps['freshState']>(async () => freshState(chain.allowance)),
    quotes: {
      requestQuote: vi.fn<TradeDeps['quotes']['requestQuote']>(async () => ({
        ok: true,
        quote: QUOTE,
        requestedAtMs: NOW_MS - 900,
        respondedAtMs: NOW_MS - 400,
      })),
    },
    rest: {
      gasFee: vi.fn<TradeDeps['rest']['gasFee']>(async (body) => ({
        ok: true,
        gasFee6: GAS_FEE6,
        echoed: echoOf(body),
      })),
    },
    rpc: {
      confirm: vi.fn<TradeDeps['rpc']['confirm']>(async (_params, opts) => {
        opts.onSent?.();
        chain.counter += 1n;
        chain.allowance -= COLLATERAL;
        return { kind: 'hash', txHash: FILL_HASH };
      }),
    },
    collateral: {
      allowance: vi.fn<TradeDeps['collateral']['allowance']>(async () => chain.allowance),
      approve: vi.fn<TradeDeps['collateral']['approve']>(async (_token, _spender, amount) => {
        chain.allowance = amount;
        return APPROVE_HASH;
      }),
      waitForReceipt: vi.fn<TradeDeps['collateral']['waitForReceipt']>(async (hash) =>
        hash === APPROVE_HASH ? APPROVE_RECEIPT : FILL_RECEIPT,
      ),
      nonces: vi.fn<TradeDeps['collateral']['nonces']>(async () => ({ pending: 7, latest: 7 })),
      vaultCounter: vi.fn<TradeDeps['collateral']['vaultCounter']>(async () => chain.counter),
    },
    signer: mode === 'live' ? { address: SELF, signConfirmation } : null,
    clock: {
      serverNowSec: vi.fn<TradeDeps['clock']['serverNowSec']>(() => SERVER_NOW_SEC),
      nowMs: vi.fn<TradeDeps['clock']['nowMs']>(() => NOW_MS),
    },
    record: vi.fn<TradeDeps['record']>(),
    checks: config(),
    verifyReceipt: vi.fn<TradeDeps['verifyReceipt']>(() => ({
      ok: true,
      vaultId: 88n,
      premiumReceived6: PREMIUM6 - GAS_FEE6,
    })),
    writeStop: vi.fn<TradeDeps['writeStop']>(),
    timeouts: { requoteMs: 10_000, confirmMs: 60_000, receiptMs: 120_000 },
    usedQuoteNonces: new Set<string>(),
    lastNonceMs: { value: NOW_MS - 60_000 },
    onConfirmSent: vi.fn<TradeDeps['onConfirmSent']>(),
    onConfirmCleared: vi.fn<TradeDeps['onConfirmCleared']>(),
    guards: {
      stopFile: vi.fn<TradeDeps['guards']['stopFile']>(() => false),
      lockHeld: vi.fn<TradeDeps['guards']['lockHeld']>(() => mode === 'live'),
      inFlightExcludingSelf: vi.fn<TradeDeps['guards']['inFlightExcludingSelf']>(() => false),
    },
    recoverMaker: vi.fn<TradeDeps['recoverMaker']>(async (q) => q.maker),
  } satisfies TradeDeps;
  return { deps, chain, controller, signConfirmation };
}

type Deps = ReturnType<typeof fakes>['deps'];

function events(deps: Deps): ExecutionEvent[] {
  return deps.record.mock.calls.map(([event]) => event);
}

function steps(deps: Deps): string[] {
  return events(deps).map((event) => event.step);
}

function eventAt(deps: Deps, step: string): ExecutionEvent {
  const found = events(deps).find((event) => event.step === step);
  if (found === undefined) throw new Error(`no '${step}' event in ${steps(deps).join(', ')}`);
  return found;
}

/** When `mock` was first called, comparable across mocks. */
function firstCall(mock: { mock: { invocationCallOrder: number[] } }): number {
  const order = mock.mock.invocationCallOrder[0];
  if (order === undefined) throw new Error('never called');
  return order;
}

function recordOrder(deps: Deps, step: string): number {
  const index = steps(deps).indexOf(step);
  const order = deps.record.mock.invocationCallOrder[index];
  if (index < 0 || order === undefined) throw new Error(`no '${step}' event`);
  return order;
}

describe('sellOption', () => {
  describe('live', () => {
    it('approves, re-quotes, checks, signs, confirms and verifies a fill', async () => {
      const { deps, signConfirmation } = fakes();

      const result = await sellOption(deps, intent());

      expect(result).toEqual({
        status: 'filled',
        txHash: FILL_HASH,
        approveTxHash: APPROVE_HASH,
        quote: QUOTE,
        premium6: PREMIUM6,
        gasFee6: GAS_FEE6,
        bookkeepingErrors: [],
      });
      expect(deps.collateral.approve).toHaveBeenCalledExactlyOnceWith(USDC, MARGIN_POOL, 1950000000n);
      expect(deps.quotes.requestQuote).toHaveBeenCalledExactlyOnceWith(
        { ...putSpike.request, taker: SELF },
        { timeoutMs: 10_000, signal: deps.signal },
      );
      expect(deps.rest.gasFee).toHaveBeenCalledOnce();
      expect(deps.freshState).toHaveBeenCalledTimes(2);
      expect(signConfirmation).toHaveBeenCalledOnce();
      expect(deps.rpc.confirm).toHaveBeenCalledOnce();
      expect(deps.verifyReceipt).toHaveBeenCalledExactlyOnceWith(FILL_RECEIPT, {
        self: SELF,
        collateralToken: USDC,
        collateralAmount: COLLATERAL,
        premium6: PREMIUM6,
        gasFee6: GAS_FEE6,
        counterBefore: 87n,
        quantityE18: 25n * E18,
      });
      expect(deps.collateral.waitForReceipt).toHaveBeenLastCalledWith(FILL_HASH, 120_000);
      expect(await Promise.all(deps.collateral.vaultCounter.mock.results.map((r) => r.value))).toEqual([
        87n,
        88n,
      ]);
      expect(deps.onConfirmSent).toHaveBeenCalledExactlyOnceWith('put', SERVER_NOW_SEC);
      expect(deps.onConfirmCleared).not.toHaveBeenCalled();
      expect(deps.writeStop).not.toHaveBeenCalled();
    });

    it('signs our body with the GAS step fee, not the echoed one, and sends it with our signature', async () => {
      const { deps, signConfirmation } = fakes();

      await sellOption(deps, intent());

      const [message] = signConfirmation.mock.calls[0] ?? [];
      expect(message).toMatchObject({
        maker: QUOTE.maker,
        price: BigInt(QUOTE.price),
        quantity: 25n * E18,
        quoteNonce: BigInt(QUOTE.nonce),
        taker: SELF,
        collateralAmount: COLLATERAL,
        nonce: BigInt(NOW_MS),
        gasFee: GAS_FEE6,
      });
      const [params, opts] = deps.rpc.confirm.mock.calls[0] ?? [];
      expect(params).toMatchObject({
        price: QUOTE.price,
        quoteNonce: QUOTE.nonce,
        taker: SELF,
        collateralAmount: '1950000000',
        nonce: String(NOW_MS),
        gasFee: '120000',
        isEIP1271: false,
        signature: SIGNATURE,
      });
      expect(opts?.timeoutMs).toBe(60_000);
      expect(deps.usedQuoteNonces).toEqual(new Set([QUOTE.nonce]));
      expect(deps.lastNonceMs.value).toBe(NOW_MS);
    });

    it('signs a nonce above the last one when the clock has not passed it', async () => {
      const { deps, signConfirmation } = fakes();
      deps.lastNonceMs.value = NOW_MS + 100;

      expect(await sellOption(deps, intent())).toMatchObject({ status: 'filled' });
      expect(signConfirmation.mock.calls[0]?.[0].nonce).toBe(BigInt(NOW_MS + 101));
      expect(deps.lastNonceMs.value).toBe(NOW_MS + 101);
    });

    it('records every step under one execution id, the write-ahead intent before the confirm', async () => {
      const { deps, signConfirmation } = fakes();

      await sellOption(deps, intent());

      expect(steps(deps)).toEqual(HAPPY_STEPS);
      const ids = new Set(events(deps).map((event) => event.execId));
      expect(ids.size).toBe(1);
      expect([...ids][0]).toMatch(/\S/);
      expect(recordOrder(deps, 'trade-intent')).toBeLessThan(firstCall(signConfirmation));
      expect(firstCall(signConfirmation)).toBeLessThan(firstCall(deps.rpc.confirm));
      expect(recordOrder(deps, 'trade-intent')).toBeLessThan(recordOrder(deps, 'confirm-sent'));
      expect(firstCall(deps.collateral.vaultCounter)).toBeLessThan(firstCall(deps.rpc.confirm));
      expect(eventAt(deps, 'trade-intent').detail).toMatchObject({
        typedDataHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        nonce: String(NOW_MS),
      });
      expect(eventAt(deps, 'checks').detail).toMatchObject({ ok: true });
      expect(eventAt(deps, 'gas').detail).toMatchObject({ gasFee6: GAS_FEE6, mismatches: [] });
    });

    it('fills the held quote without re-quoting when its TTL suffices', async () => {
      const { deps } = fakes();
      const held = { ...intent(), quote: QUOTE };

      const result = await sellOption(deps, held);

      expect(result).toMatchObject({ status: 'filled', quote: QUOTE });
      expect(deps.quotes.requestQuote).not.toHaveBeenCalled();
    });

    it('skips the approve when the allowance is already exact', async () => {
      const { deps, chain } = fakes();
      chain.allowance = COLLATERAL;

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({ status: 'filled' });
      expect(result).not.toHaveProperty('approveTxHash');
      expect(deps.collateral.approve).not.toHaveBeenCalled();
    });

    it('records a premium shortfall but still reports the fill', async () => {
      const { deps } = fakes();
      deps.verifyReceipt.mockReturnValueOnce({
        ok: true,
        vaultId: 88n,
        premiumReceived6: PREMIUM6 - GAS_FEE6 - 1n,
      });

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({ status: 'filled' });
      expect(eventAt(deps, 'premium-shortfall').detail).toMatchObject({
        premiumReceived6: PREMIUM6 - GAS_FEE6 - 1n,
        expectedNet6: PREMIUM6 - GAS_FEE6,
      });
      expect(deps.writeStop).not.toHaveBeenCalled();
    });
  });

  describe('dry-run', () => {
    it('exercises the body, the gas echo and every guard, and stops before signing', async () => {
      const { deps } = fakes('dry-run');

      const result = await sellOption(deps, intent());

      expect(result).toEqual({
        status: 'aborted',
        stage: 'dry-run',
        message: expect.any(String),
        echoOk: true,
        wouldApprove: 1950000000n,
      });
      expect(deps.collateral.allowance).toHaveBeenCalledExactlyOnceWith(USDC, SELF, MARGIN_POOL);
      expect(deps.collateral.approve).not.toHaveBeenCalled();
      expect(deps.collateral.nonces).not.toHaveBeenCalled();
      expect(deps.rest.gasFee).toHaveBeenCalledOnce();
      expect(deps.rpc.confirm).not.toHaveBeenCalled();
      expect(deps.collateral.vaultCounter).not.toHaveBeenCalled();
      expect(steps(deps)).toEqual(['precheck', 'approve', 'requote', 'gas', 'checks']);
      expect(deps.usedQuoteNonces.size).toBe(0);
      expect(deps.lastNonceMs.value).toBe(NOW_MS - 60_000);
    });

    it('would approve nothing when the allowance is already exact', async () => {
      const { deps, chain } = fakes('dry-run');
      chain.allowance = COLLATERAL;

      expect(await sellOption(deps, intent())).toMatchObject({ stage: 'dry-run', wouldApprove: 0n });
    });

    it('runs with a STOP file present and no live lock', async () => {
      const { deps } = fakes('dry-run');
      deps.guards.stopFile.mockReturnValue(true);

      expect(await sellOption(deps, intent())).toMatchObject({ status: 'aborted', stage: 'dry-run' });
    });

    it('reports a failed guard rather than the dry-run result', async () => {
      const { deps } = fakes('dry-run');
      deps.freshState.mockResolvedValueOnce(freshState(0n)).mockResolvedValueOnce({
        ...freshState(0n),
        freeCollateral: 0n,
      });

      expect(await sellOption(deps, intent())).toMatchObject({
        status: 'aborted',
        stage: 'guard',
        checkId: 'C13',
      });
    });
  });

  describe('PRECHECK', () => {
    it('aborts on a gate hold, naming it', async () => {
      const { deps } = fakes();
      deps.freshState.mockResolvedValueOnce({ ...freshState(0n), gateHold: 'cooldown' });

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({
        status: 'aborted',
        stage: 'precheck',
        message: expect.stringContaining('cooldown'),
      });
      expect(deps.collateral.nonces).not.toHaveBeenCalled();
      expect(deps.collateral.approve).not.toHaveBeenCalled();
    });

    it.each<[string, (deps: Deps) => void, string]>([
      ['a STOP file', (deps) => deps.guards.stopFile.mockReturnValue(true), 'data/STOP is present'],
      ['the live lock not held', (deps) => deps.guards.lockHeld.mockReturnValue(false), 'live lock not held'],
    ])('aborts on %s before approving', async (_, mutate, message) => {
      const { deps } = fakes();
      mutate(deps);

      expect(await sellOption(deps, intent())).toEqual({ status: 'aborted', stage: 'precheck', message });
      expect(deps.collateral.nonces).not.toHaveBeenCalled();
      expect(deps.collateral.approve).not.toHaveBeenCalled();
    });

    it('aborts before approving a collateral amount the strike and quantity do not require', async () => {
      const { deps } = fakes();
      const wrong = intent();
      wrong.candidate.collateralAmount = COLLATERAL + 1n;

      expect(await sellOption(deps, wrong)).toMatchObject({
        status: 'aborted',
        stage: 'precheck',
        message: expect.stringContaining('1950000000'),
      });
      expect(deps.collateral.nonces).not.toHaveBeenCalled();
      expect(deps.collateral.approve).not.toHaveBeenCalled();
    });

    it('aborts when the fresh tranche differs from the intent', async () => {
      const { deps } = fakes();
      deps.freshState.mockResolvedValueOnce({ ...freshState(0n), trancheQuantityE18: 50n * E18 });

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({
        status: 'aborted',
        stage: 'precheck',
        message: expect.stringContaining('50000000000000000000'),
      });
      expect(deps.collateral.approve).not.toHaveBeenCalled();
    });

    it('aborts on shutdown before reading anything', async () => {
      const { deps, controller } = fakes();
      controller.abort();

      expect(await sellOption(deps, intent())).toEqual({
        status: 'aborted',
        stage: 'precheck',
        message: 'shutdown',
      });
      expect(deps.freshState).not.toHaveBeenCalled();
    });

    it('aborts when the live signer is not the wallet', async () => {
      const { deps, signConfirmation } = fakes();
      const other = { ...deps, signer: { address: getAddress(QUOTE.maker), signConfirmation } };

      expect(await sellOption(other, intent())).toMatchObject({ status: 'aborted', stage: 'precheck' });
      expect(deps.collateral.approve).not.toHaveBeenCalled();
    });

    it('aborts before approving collateral other than the side’s pinned token', async () => {
      const { deps } = fakes();
      const wrong = intent();
      wrong.candidate.product = TRADED_PRODUCTS.call;

      expect(await sellOption(deps, wrong)).toMatchObject({ status: 'aborted', stage: 'precheck' });
      expect(deps.collateral.approve).not.toHaveBeenCalled();
    });

    it('aborts when the snapshot read fails', async () => {
      const { deps } = fakes();
      deps.freshState.mockRejectedValueOnce(new Error('rpc down'));

      expect(await sellOption(deps, intent())).toEqual({
        status: 'aborted',
        stage: 'precheck',
        message: 'rpc down',
      });
    });
  });

  describe('APPROVE', () => {
    it('aborts with the approve hash when the approve is stuck', async () => {
      const { deps } = fakes();
      deps.collateral.waitForReceipt.mockResolvedValueOnce(null);

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({ status: 'aborted', stage: 'approve', approveTxHash: APPROVE_HASH });
      expect(deps.quotes.requestQuote).not.toHaveBeenCalled();
      expect(deps.rest.gasFee).not.toHaveBeenCalled();
    });

    it('aborts without approving while a wallet transaction is pending', async () => {
      const { deps } = fakes();
      deps.collateral.nonces.mockResolvedValueOnce({ pending: 8, latest: 7 });

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({ status: 'aborted', stage: 'approve' });
      expect(result).not.toHaveProperty('approveTxHash');
      expect(deps.collateral.approve).not.toHaveBeenCalled();
    });
  });

  describe('REQUOTE', () => {
    it('aborts at the price floor without signing', async () => {
      const { deps, signConfirmation } = fakes();
      const cheaper = { ...QUOTE, price: String(BigInt(QUOTE.price) - 1n) };
      deps.quotes.requestQuote.mockResolvedValueOnce({
        ok: true,
        quote: cheaper,
        requestedAtMs: NOW_MS - 900,
        respondedAtMs: NOW_MS - 400,
      });

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({ status: 'aborted', stage: 'price-floor', approveTxHash: APPROVE_HASH });
      expect(deps.rest.gasFee).not.toHaveBeenCalled();
      expect(signConfirmation).not.toHaveBeenCalled();
    });

    it('aborts when the re-quote fails', async () => {
      const { deps } = fakes();
      deps.quotes.requestQuote.mockResolvedValueOnce({
        ok: false,
        error: 'timeout',
        message: 'request got no reply within 10000 ms',
        requestedAtMs: NOW_MS,
      });

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({
        status: 'aborted',
        stage: 'requote',
        message: expect.stringContaining('timeout'),
      });
      expect(deps.rest.gasFee).not.toHaveBeenCalled();
    });
  });

  describe('GAS', () => {
    it('aborts when the gas call throws', async () => {
      const { deps, signConfirmation } = fakes();
      deps.rest.gasFee.mockRejectedValueOnce(new Error('POST /api/gas timed out after 15000 ms'));

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({
        status: 'aborted',
        stage: 'gas',
        message: expect.stringContaining('timed out'),
      });
      expect(signConfirmation).not.toHaveBeenCalled();
    });

    it('aborts when the gas fee exceeds the premium', async () => {
      const { deps } = fakes();
      deps.rest.gasFee.mockResolvedValueOnce({
        ok: false,
        reason: 'exceeds-premium',
        status: 400,
        message: 'gas fee more than premium',
      });

      expect(await sellOption(deps, intent())).toMatchObject({ status: 'aborted', stage: 'gas' });
    });

    it('aborts on an echo mismatch and writes STOP in live', async () => {
      const { deps, signConfirmation } = fakes();
      deps.rest.gasFee.mockImplementationOnce(async (body) => ({
        ok: true,
        gasFee6: GAS_FEE6,
        echoed: { ...echoOf(body as ConfirmBody), price: '1' },
      }));

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({ status: 'aborted', stage: 'echo', echoOk: false });
      expect(deps.writeStop).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/^gas echo mismatch: price/),
      );
      expect(steps(deps)).toContain('stop');
      expect(signConfirmation).not.toHaveBeenCalled();
    });

    it('still aborts at the echo, naming the failure, when STOP cannot be written', async () => {
      const { deps } = fakes();
      deps.rest.gasFee.mockImplementationOnce(async (body) => ({
        ok: true,
        gasFee6: GAS_FEE6,
        echoed: { ...echoOf(body as ConfirmBody), price: '1' },
      }));
      deps.writeStop.mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({
        status: 'aborted',
        stage: 'echo',
        echoOk: false,
        message: expect.stringMatching(/^gas echo mismatch: price.*writeStop: EACCES: permission denied/),
      });
      expect(steps(deps)).toContain('stop');
    });

    it('aborts on an echo mismatch in dry-run without writing STOP', async () => {
      const { deps } = fakes('dry-run');
      deps.rest.gasFee.mockImplementationOnce(async (body) => ({
        ok: true,
        gasFee6: GAS_FEE6,
        echoed: { ...echoOf(body as ConfirmBody), foo: 1 },
      }));

      expect(await sellOption(deps, intent())).toMatchObject({
        status: 'aborted',
        stage: 'echo',
        echoOk: false,
      });
      expect(deps.writeStop).not.toHaveBeenCalled();
    });
  });

  describe('CHECKS', () => {
    it('aborts on the first failed check, with its id and detail', async () => {
      const { deps, signConfirmation } = fakes();
      deps.guards.stopFile.mockReturnValueOnce(false).mockReturnValueOnce(true);

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({
        status: 'aborted',
        stage: 'guard',
        checkId: 'C1',
        message: 'data/STOP is present',
        approveTxHash: APPROVE_HASH,
      });
      expect(signConfirmation).not.toHaveBeenCalled();
      expect(deps.usedQuoteNonces.size).toBe(0);
    });

    it('checks a second fresh state taken after the approve', async () => {
      const { deps } = fakes();
      deps.freshState
        .mockResolvedValueOnce(freshState(0n))
        .mockResolvedValueOnce({ ...freshState(COLLATERAL), gateHold: 'in-flight' });

      expect(await sellOption(deps, intent())).toMatchObject({ stage: 'guard', checkId: 'C2' });
      expect(firstCall(deps.collateral.approve)).toBeLessThan(
        deps.freshState.mock.invocationCallOrder[1] ?? 0,
      );
    });

    it('treats a rejected maker recovery as a mismatch, which warn mode passes', async () => {
      const { deps } = fakes();
      deps.recoverMaker.mockRejectedValueOnce(new Error('bad signature'));

      expect(await sellOption(deps, intent())).toMatchObject({ status: 'filled' });
    });
  });

  describe('SIGN', () => {
    it('aborts when the signer throws, never confirming', async () => {
      const { deps, signConfirmation } = fakes();
      signConfirmation.mockRejectedValueOnce(new Error('keystore locked'));

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({ status: 'aborted', stage: 'sign', message: 'keystore locked' });
      expect(deps.rpc.confirm).not.toHaveBeenCalled();
      expect(deps.onConfirmSent).not.toHaveBeenCalled();
      expect(deps.usedQuoteNonces).toEqual(new Set([QUOTE.nonce]));
    });

    it('aborts when the write-ahead record fails, never signing', async () => {
      const { deps, signConfirmation } = fakes();
      deps.record.mockImplementation((event) => {
        if (event.step === 'trade-intent') throw new Error('disk full');
      });

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({ status: 'aborted', stage: 'sign', message: 'disk full' });
      expect(signConfirmation).not.toHaveBeenCalled();
      expect(deps.rpc.confirm).not.toHaveBeenCalled();
    });
  });

  describe('CONFIRM', () => {
    it('aborts on shutdown just before sending', async () => {
      const { deps, controller, signConfirmation } = fakes();
      signConfirmation.mockImplementationOnce(async () => {
        controller.abort();
        return SIGNATURE;
      });

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({ status: 'aborted', stage: 'shutdown' });
      expect(deps.rpc.confirm).not.toHaveBeenCalled();
      expect(deps.onConfirmSent).not.toHaveBeenCalled();
    });

    it('aborts on a JSON-RPC rejection and clears the side’s confirm time', async () => {
      const { deps } = fakes();
      deps.rpc.confirm.mockImplementationOnce(
        replying({ kind: 'rejected', code: -32000, message: 'quote expired' }),
      );

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({
        status: 'aborted',
        stage: 'confirm-rejected',
        message: expect.stringContaining('quote expired'),
        approveTxHash: APPROVE_HASH,
        bookkeepingErrors: [],
      });
      expect(deps.onConfirmSent).toHaveBeenCalledOnce();
      expect(deps.onConfirmCleared).toHaveBeenCalledExactlyOnceWith('put');
      expect(firstCall(deps.onConfirmSent)).toBeLessThan(firstCall(deps.onConfirmCleared));
      expect(deps.collateral.waitForReceipt).not.toHaveBeenCalledWith(FILL_HASH, expect.anything());
    });

    it('treats a rejection with code 0 (a malformed error frame) as unknown', async () => {
      const { deps } = fakes();
      deps.rpc.confirm.mockImplementationOnce(replying({ kind: 'rejected', code: 0, message: '' }));

      const result = await sellOption(deps, intent());

      expect(result).toEqual({
        status: 'unknown',
        reason: 'bad-result',
        confirmSentAtSec: SERVER_NOW_SEC,
        approveTxHash: APPROVE_HASH,
        bookkeepingErrors: [],
      });
      expect(deps.onConfirmCleared).not.toHaveBeenCalled();
    });

    it('treats a non-hash result as unknown', async () => {
      const { deps } = fakes();
      deps.rpc.confirm.mockImplementationOnce(replying({ kind: 'bad-result', raw: 'ok' }));

      expect(await sellOption(deps, intent())).toMatchObject({ status: 'unknown', reason: 'bad-result' });
      expect(deps.onConfirmCleared).not.toHaveBeenCalled();
    });

    it.each<[ConfirmReply & { kind: 'no-reply' }, string]>([
      [{ kind: 'no-reply', reason: 'timeout', sent: true }, 'confirm-timeout'],
      [{ kind: 'no-reply', reason: 'socket-closed', sent: true }, 'socket-closed'],
      [{ kind: 'no-reply', reason: 'socket-closed', sent: false }, 'socket-closed'],
    ])('treats %o as unknown(%s)', async (reply, reason) => {
      const { deps } = fakes();
      deps.rpc.confirm.mockImplementationOnce(async (_params, opts) => {
        if (reply.sent) opts.onSent?.();
        return reply;
      });

      const result = await sellOption(deps, intent());

      expect(result).toEqual({
        status: 'unknown',
        reason,
        confirmSentAtSec: SERVER_NOW_SEC,
        approveTxHash: APPROVE_HASH,
        bookkeepingErrors: [],
      });
      expect(eventAt(deps, 'confirm-reply').detail).toMatchObject({ kind: 'no-reply', sent: reply.sent });
      expect(deps.onConfirmSent).toHaveBeenCalledTimes(reply.sent ? 1 : 0);
      expect(deps.onConfirmCleared).not.toHaveBeenCalled();
    });

    it('confirms at most once, even when the call throws', async () => {
      const { deps } = fakes();
      deps.rpc.confirm.mockRejectedValueOnce(new Error('socket exploded'));

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({
        status: 'unknown',
        reason: 'bad-result',
        confirmSentAtSec: SERVER_NOW_SEC,
      });
      expect(deps.rpc.confirm).toHaveBeenCalledOnce();
      expect(deps.collateral.waitForReceipt).not.toHaveBeenCalledWith(FILL_HASH, expect.anything());
      expect(deps.onConfirmSent).toHaveBeenCalledOnce();
    });

    it('starts the cooldown when a reply proves the frame was sent although onSent never fired', async () => {
      const { deps } = fakes();
      deps.rpc.confirm.mockResolvedValueOnce({ kind: 'rejected', code: -32000, message: 'quote expired' });

      await sellOption(deps, intent());

      expect(deps.onConfirmSent).toHaveBeenCalledExactlyOnceWith('put', SERVER_NOW_SEC);
      expect(steps(deps)).toContain('confirm-sent');
    });

    it('starts the cooldown when the socket reports a sent frame although onSent never fired', async () => {
      const { deps } = fakes();
      deps.rpc.confirm.mockResolvedValueOnce({ kind: 'no-reply', reason: 'timeout', sent: true });

      expect(await sellOption(deps, intent())).toMatchObject({
        status: 'unknown',
        reason: 'confirm-timeout',
      });
      expect(deps.onConfirmSent).toHaveBeenCalledExactlyOnceWith('put', SERVER_NOW_SEC);
    });

    it('abandons the wait for a reply on shutdown', async () => {
      const { deps, controller } = fakes();
      deps.rpc.confirm.mockImplementationOnce((_params, opts) => {
        opts.onSent?.();
        controller.abort();
        return new Promise<ConfirmReply>(() => {});
      });

      expect(await sellOption(deps, intent())).toEqual({
        status: 'unknown',
        reason: 'shutdown',
        confirmSentAtSec: SERVER_NOW_SEC,
        approveTxHash: APPROVE_HASH,
        bookkeepingErrors: [],
      });
      expect(deps.onConfirmSent).toHaveBeenCalledOnce();
    });

    it('keeps the outcome when bookkeeping fails after the send, and lists each failure', async () => {
      const { deps } = fakes();
      deps.record.mockImplementation((event) => {
        if (['confirm-sent', 'confirm-reply', 'receipt', 'verified'].includes(event.step)) {
          throw new Error('disk full');
        }
      });
      deps.onConfirmSent.mockImplementation(() => {
        throw new Error('memo broken');
      });

      expect(await sellOption(deps, intent())).toMatchObject({
        status: 'filled',
        txHash: FILL_HASH,
        bookkeepingErrors: [
          'onConfirmSent: memo broken',
          'record(confirm-sent): disk full',
          'record(confirm-reply): disk full',
          'record(receipt): disk full',
          'record(verified): disk full',
        ],
      });
    });

    it('lists a failure to clear the confirm time on a rejection', async () => {
      const { deps } = fakes();
      deps.rpc.confirm.mockImplementationOnce(
        replying({ kind: 'rejected', code: -32000, message: 'quote expired' }),
      );
      deps.onConfirmCleared.mockImplementationOnce(() => {
        throw new Error('memo broken');
      });

      expect(await sellOption(deps, intent())).toMatchObject({
        status: 'aborted',
        stage: 'confirm-rejected',
        bookkeepingErrors: ['onConfirmCleared: memo broken'],
      });
    });
  });

  describe('RECEIPT', () => {
    it('reports a revert and clears the side’s confirm time', async () => {
      const { deps } = fakes();
      deps.collateral.waitForReceipt.mockImplementation(async (hash) =>
        hash === APPROVE_HASH ? APPROVE_RECEIPT : { ...FILL_RECEIPT, status: 'reverted' },
      );

      const result = await sellOption(deps, intent());

      expect(result).toEqual({
        status: 'reverted',
        txHash: FILL_HASH,
        approveTxHash: APPROVE_HASH,
        bookkeepingErrors: [],
      });
      expect(deps.onConfirmCleared).toHaveBeenCalledExactlyOnceWith('put');
      expect(deps.verifyReceipt).not.toHaveBeenCalled();
    });

    it('reports unknown when no receipt arrives in time', async () => {
      const { deps } = fakes();
      deps.collateral.waitForReceipt.mockImplementation(async (hash) =>
        hash === APPROVE_HASH ? APPROVE_RECEIPT : null,
      );

      expect(await sellOption(deps, intent())).toEqual({
        status: 'unknown',
        reason: 'receipt-timeout',
        confirmSentAtSec: SERVER_NOW_SEC,
        txHash: FILL_HASH,
        approveTxHash: APPROVE_HASH,
        bookkeepingErrors: [],
      });
      expect(deps.writeStop).not.toHaveBeenCalled();
    });

    it('reports unknown when the receipt read fails', async () => {
      const { deps } = fakes();
      deps.collateral.waitForReceipt.mockImplementation(async (hash) => {
        if (hash === APPROVE_HASH) return APPROVE_RECEIPT;
        throw new Error('rpc down');
      });

      expect(await sellOption(deps, intent())).toMatchObject({
        status: 'unknown',
        reason: 'receipt-timeout',
        txHash: FILL_HASH,
      });
    });

    it('abandons the wait for the receipt on shutdown', async () => {
      const { deps, controller } = fakes();
      deps.collateral.waitForReceipt.mockImplementation((hash) => {
        if (hash === APPROVE_HASH) return Promise.resolve(APPROVE_RECEIPT);
        controller.abort();
        return new Promise<TransactionReceipt | null>(() => {});
      });

      expect(await sellOption(deps, intent())).toMatchObject({
        status: 'unknown',
        reason: 'shutdown',
        txHash: FILL_HASH,
      });
    });

    it('writes STOP and reports unknown when the fill does not verify', async () => {
      const { deps } = fakes();
      deps.verifyReceipt.mockReturnValueOnce({ ok: false, problems: ['premium-transfer'] });

      const result = await sellOption(deps, intent());

      expect(result).toEqual({
        status: 'unknown',
        reason: 'verify-failed',
        confirmSentAtSec: SERVER_NOW_SEC,
        txHash: FILL_HASH,
        approveTxHash: APPROVE_HASH,
        bookkeepingErrors: [],
      });
      expect(deps.writeStop).toHaveBeenCalledExactlyOnceWith('fill verification failed: premium-transfer');
      expect(steps(deps)).toContain('stop');
      expect(steps(deps)).not.toContain('verified');
    });

    it('still reports verify-failed, naming the failure, when STOP cannot be written', async () => {
      const { deps } = fakes();
      deps.verifyReceipt.mockReturnValueOnce({ ok: false, problems: ['premium-transfer'] });
      deps.writeStop.mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });

      expect(await sellOption(deps, intent())).toMatchObject({
        status: 'unknown',
        reason: 'verify-failed',
        txHash: FILL_HASH,
        bookkeepingErrors: ['writeStop: EACCES: permission denied'],
      });
      expect(eventAt(deps, 'stop').detail).toEqual({ reason: 'fill verification failed: premium-transfer' });
    });
  });

  describe('CHAIN_VERIFIED', () => {
    it.each<[string, (chain: { allowance: bigint; counter: bigint }) => void]>([
      ['the allowance did not decrease', (chain) => (chain.counter += 1n)],
      [
        'the allowance decreased by less than the amount',
        (chain) => {
          chain.counter += 1n;
          chain.allowance -= COLLATERAL - 1n;
        },
      ],
      ['the vault counter did not move', (chain) => (chain.allowance -= COLLATERAL)],
      [
        'the vault counter moved by two',
        (chain) => {
          chain.counter += 2n;
          chain.allowance -= COLLATERAL;
        },
      ],
    ])('writes STOP and reports unknown when %s', async (_, mine) => {
      const { deps, chain } = fakes();
      deps.rpc.confirm.mockImplementationOnce(async (_params, opts) => {
        opts.onSent?.();
        mine(chain);
        return { kind: 'hash', txHash: FILL_HASH };
      });

      const result = await sellOption(deps, intent());

      expect(result).toMatchObject({ status: 'unknown', reason: 'verify-failed', txHash: FILL_HASH });
      expect(deps.writeStop).toHaveBeenCalledOnce();
      expect(steps(deps)).not.toContain('verified');
    });

    it('writes STOP and reports unknown when a verification read fails', async () => {
      const { deps } = fakes();
      deps.collateral.vaultCounter.mockResolvedValueOnce(87n).mockRejectedValueOnce(new Error('rpc down'));

      expect(await sellOption(deps, intent())).toMatchObject({ status: 'unknown', reason: 'verify-failed' });
      expect(deps.writeStop).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('rpc down'));
    });
  });
});
