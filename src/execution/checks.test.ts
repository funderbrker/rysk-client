import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { TOKENS, TRADED_PRODUCTS } from '../domain/constants.ts';
import type { ConfirmBody, Quote, QuoteRequest, Side } from '../domain/types.ts';
import { recoverQuoteSigner } from '../rysk/eip712.ts';
import { buildConfirmBody } from './body.ts';
import {
  type CheckContext,
  type ExecutionConfig,
  isAprEchoDisagreement,
  runPreSignChecks,
} from './checks.ts';
import type { CheckResult } from './types.ts';

type SpikeRequest = { request: QuoteRequest; reply: { result: Quote } };
const capture = JSON.parse(
  readFileSync(new URL('../../test/fixtures/spike-capture.json', import.meta.url), 'utf8'),
) as { requests: [SpikeRequest, SpikeRequest, ...SpikeRequest[]]; gas: { full: { body: string } } };
const [putSpike, callSpike] = capture.requests;

const E18 = 10n ** 18n;
/** The address of `test/fixtures/keystore-anvil0.json` (the public Anvil #0 account). */
const SELF = getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
const SERVER_NOW_SEC = 1792146510;
const NOW_MS = SERVER_NOW_SEC * 1000 + 250;
const IDS = Array.from({ length: 18 }, (_, i) => `C${i + 1}`);
const MAKERS = {
  put: await recoverQuoteSigner(putSpike.reply.result),
  call: await recoverQuoteSigner(callSpike.reply.result),
};

/** The spike's `/api/gas` echo carrying `body`'s fields: the server echoes what it is sent. */
function echoOf(body: ConfirmBody): Record<string, unknown> {
  return { ...(JSON.parse(capture.gas.full.body) as Record<string, unknown>), ...body };
}

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

/** A live context that passes every check: the spike put (25 WHYPE @ 78) or call (25 WHYPE @ 84.5) quote. */
function context(side: Side): CheckContext {
  const spike = side === 'put' ? putSpike : callSpike;
  const quote = spike.reply.result;
  const request = { ...spike.request, taker: SELF };
  const collateralAmount = side === 'put' ? 1950000000n : 25n * E18;
  const body = buildConfirmBody({ quote, taker: SELF, collateralAmount, nonceMs: NOW_MS });
  return {
    mode: 'live',
    intent: {
      side,
      candidate: {
        side,
        strikeE8: BigInt(quote.strike),
        expirySec: quote.expiry,
        quantityE18: 25n * E18,
        collateralAmount,
        request,
        mode: 'normal',
        product: TRADED_PRODUCTS[side],
      },
      quote,
      minPriceE18: BigInt(quote.price),
      maxGasFee6: 500_000n,
    },
    freshQuote: quote,
    body,
    echoed: echoOf(body),
    gasFee6: 0n,
    fresh: {
      gateHold: null,
      trancheQuantityE18: 25n * E18,
      basisE8: side === 'put' ? null : 8000000000n,
      basisReliable: side === 'call',
      basisEligibleEmpty: false,
      freshFallbackStrikeE8: null,
      freeCollateral: side === 'put' ? 5000_000000n : 30n * E18,
      spotE8: 8148032044n,
      listedStrikesE8ForExpiry:
        side === 'put' ? [7500000000n, 7800000000n, 8000000000n] : [8450000000n, 8700000000n, 9000000000n],
      expiriesSec: [1792742400, 1793347200],
      deploymentsLast24h: 0,
      notionalLast24h6: 0n,
      nativeHypeE18: E18,
      allowance: collateralAmount,
      fetchedAtMs: NOW_MS - 2000,
      listingsAtMs: NOW_MS - 60_000,
      capHeadroomE18: 30n * E18,
    },
    config: config(),
    serverNowSec: SERVER_NOW_SEC,
    nowMs: NOW_MS,
    signerAddress: SELF,
    usedQuoteNonces: new Set(),
    lastNonceMs: NOW_MS - 60_000,
    stopFile: false,
    lockHeld: true,
    inFlightExcludingSelf: false,
    recoveredMaker: MAKERS[side],
  };
}

/** Replaces body fields; the echo follows, as the server echoes what it is sent. */
function patchBody(ctx: CheckContext, patch: Partial<ConfirmBody>): void {
  ctx.body = { ...ctx.body, ...patch };
  ctx.echoed = echoOf(ctx.body);
}

function naIds(results: CheckResult[]): string[] {
  return results.filter((r) => r.na === true).map((r) => r.id);
}

/** Asserts that `id` is the first failing check, after every earlier check passed, and returns it. */
function expectFailure(ctx: CheckContext, id: string): CheckResult {
  const result = runPreSignChecks(ctx);
  if (result.ok) throw new Error(`expected ${id} to fail, but every check passed`);
  expect(result.failed.id).toBe(id);
  expect(result.results.map((r) => r.id)).toEqual(IDS.slice(0, IDS.indexOf(id) + 1));
  expect(result.results.slice(0, -1).every((r) => r.pass)).toBe(true);
  expect(result.failed.pass).toBe(false);
  return result.failed;
}

describe('runPreSignChecks', () => {
  it('passes the spike put quote on all 18 checks in order', () => {
    const ctx = context('put');
    const result = runPreSignChecks(ctx);

    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.id)).toEqual(IDS);
    expect(result.results.every((r) => r.pass)).toBe(true);
    expect(naIds(result.results)).toEqual(['C18']);
    if (result.ok) expect(result.body).toEqual(ctx.body);
  });

  it('returns the gas fee C9 bounded', () => {
    const ctx = context('put');
    ctx.gasFee6 = 123_456n;
    const result = runPreSignChecks(ctx);

    expect(result).toMatchObject({ ok: true, gasFee6: 123_456n });
  });

  it("accepts a gas fee equal to the intent's maxGasFee6 and names the intent when above it", () => {
    const ctx = context('put');
    ctx.intent.maxGasFee6 = 100_000n;
    ctx.gasFee6 = 100_000n;
    expect(runPreSignChecks(ctx).ok).toBe(true);

    ctx.gasFee6 = 100_001n;
    expect(expectFailure(ctx, 'C9').detail).toBe("gas fee 100001 above the intent's 100000");
  });

  it("fails C14's tranche clause on its own", () => {
    const ctx = context('put');
    patchBody(ctx, { quantity: '50000000000000000000', collateralAmount: '3900000000' });
    ctx.fresh.allowance = 3900000000n;
    ctx.fresh.capHeadroomE18 = null;
    ctx.config.maxContractsPerTradeE18 = 50n * E18;
    expect(expectFailure(ctx, 'C14').detail).toContain('cap-bounded tranche');
  });

  it('brands a frozen copy of the body', () => {
    const ctx = context('put');
    const result = runPreSignChecks(ctx);
    if (!result.ok) throw new Error(`unexpected failure ${result.failed.id}`);

    ctx.body.price = '1';
    expect(result.body?.price).toBe(putSpike.reply.result.price);
    expect(Object.isFrozen(result.body)).toBe(true);
  });

  it.each<[string, string, (ctx: CheckContext) => void]>([
    ['a STOP file', 'C1', (ctx) => (ctx.stopFile = true)],
    ['the live lock not held', 'C1', (ctx) => (ctx.lockHeld = false)],
    ['a signer other than the configured account', 'C1', (ctx) => (ctx.signerAddress = MAKERS.put)],
    ['a cooldown gate hold', 'C2', (ctx) => (ctx.fresh.gateHold = 'cooldown')],
    ['a fresh state 10.001 s old', 'C2', (ctx) => (ctx.fresh.fetchedAtMs = NOW_MS - 10_001)],
    ['a fresh state of unknown age', 'C2', (ctx) => (ctx.fresh.fetchedAtMs = Number.NaN)],
    ['a recomputed tranche of 50', 'C2', (ctx) => (ctx.fresh.trancheQuantityE18 = 50n * E18)],
    ['another execution in flight', 'C2', (ctx) => (ctx.inFlightExcludingSelf = true)],
    ['native HYPE below the gas reserve', 'C2', (ctx) => (ctx.fresh.nativeHypeE18 = 10n ** 16n)],
    ['a USDT0 body', 'C3', (ctx) => patchBody(ctx, { usd: TOKENS.USDT0.address })],
    ['a call body for a put intent', 'C3', (ctx) => patchBody(ctx, { isPut: false })],
    [
      'a quote for another strike',
      'C4',
      (ctx) => (ctx.freshQuote = { ...ctx.freshQuote, strike: '7900000000' }),
    ],
    ['a taker-buy quote', 'C4', (ctx) => (ctx.freshQuote = { ...ctx.freshQuote, isTakerBuy: true })],
    [
      'a quote nonce already signed',
      'C5',
      (ctx) => (ctx.usedQuoteNonces = new Set([putSpike.reply.result.nonce])),
    ],
    [
      'a quote nonce already signed, with a leading zero',
      'C5',
      (ctx) => (ctx.usedQuoteNonces = new Set([`0${putSpike.reply.result.nonce}`])),
    ],
    ['a quote from our own address', 'C5', (ctx) => (ctx.freshQuote = { ...ctx.freshQuote, maker: SELF })],
    ['a quote with 3 s left', 'C6', (ctx) => (ctx.serverNowSec = 1792146570)],
    [
      'a quote valid past the expiry',
      'C6',
      (ctx) => {
        const expiry = putSpike.reply.result.validUntil - 1;
        ctx.intent.candidate.request = { ...ctx.intent.candidate.request, expiry };
        ctx.freshQuote = { ...ctx.freshQuote, expiry };
      },
    ],
    [
      'a price of 20 on a strike of 78',
      'C7',
      (ctx) => (ctx.freshQuote = { ...ctx.freshQuote, price: '20000000000000000000' }),
    ],
    ['a quoted apy 2 pp off ours', 'C7', (ctx) => (ctx.freshQuote = { ...ctx.freshQuote, apy: 77.4 })],
    ['an APR floor of 90 %', 'C8', (ctx) => (ctx.config.minApr = 0.9)],
    ['an echoed price of 1', 'C9', (ctx) => (ctx.echoed = { ...ctx.echoed, price: '1' })],
    ['an echoed unknown key', 'C9', (ctx) => (ctx.echoed = { ...ctx.echoed, foo: 1 })],
    ['an echoed isPremium true', 'C9', (ctx) => (ctx.echoed = { ...ctx.echoed, isPremium: true })],
    ['a gas fee of 1 USD (above 2 % of premium)', 'C9', (ctx) => (ctx.gasFee6 = 1_000_000n)],
    ['a gas fee within 2 % but above 0.5 USD', 'C9', (ctx) => (ctx.gasFee6 = 500_001n)],
    [
      "a gas fee within the config's limits but above the intent's",
      'C9',
      (ctx) => {
        ctx.gasFee6 = 100_001n;
        ctx.intent.maxGasFee6 = 100_000n;
      },
    ],
    ['spot at the put strike', 'C10', (ctx) => (ctx.fresh.spotE8 = 7800000000n)],
    ['a put strike below 0.6 × spot', 'C10', (ctx) => (ctx.fresh.spotE8 = 13100000000n)],
    ['a strike off the strike grid', 'C10', (ctx) => (ctx.config.strikePrecisionE8 = 7_000_000n)],
    ['a strike no longer listed', 'C10', (ctx) => (ctx.fresh.listedStrikesE8ForExpiry = [7500000000n])],
    ['an expiry gone from the inventory', 'C11', (ctx) => (ctx.fresh.expiriesSec = [1793347200])],
    ['a tenor below the minimum hours', 'C11', (ctx) => (ctx.config.minHoursToExpiry = 200)],
    ['a tenor above the maximum days', 'C11', (ctx) => (ctx.config.maxDaysToExpiry = 5)],
    ['a body quantity of 26', 'C12', (ctx) => patchBody(ctx, { quantity: '26000000000000000000' })],
    ['an allowance one unit short', 'C13', (ctx) => (ctx.fresh.allowance = 1949999999n)],
    ['free collateral below the amount', 'C13', (ctx) => (ctx.fresh.freeCollateral = 1949999999n)],
    [
      'a collateral amount the strike and quantity do not require',
      'C13',
      (ctx) => {
        patchBody(ctx, { collateralAmount: '1950000001' });
        ctx.fresh.allowance = 1950000001n;
      },
    ],
    [
      'a quantity above the fresh tranche, with no cap applying',
      'C14',
      (ctx) => {
        patchBody(ctx, { quantity: '50000000000000000000', collateralAmount: '3900000000' });
        ctx.fresh.allowance = 3900000000n;
        ctx.fresh.capHeadroomE18 = null;
        ctx.config.maxContractsPerTradeE18 = 50n * E18;
      },
    ],
    ['a nonce 6 s ahead of the clock', 'C15', (ctx) => patchBody(ctx, { nonce: String(NOW_MS + 6000) })],
    ['a nonce not above the last one', 'C15', (ctx) => (ctx.lastNonceMs = NOW_MS)],
    ['a last nonce of NaN', 'C15', (ctx) => (ctx.lastNonceMs = Number.NaN)],
    ['four deployments in 24 h', 'C16', (ctx) => (ctx.fresh.deploymentsLast24h = 4)],
    ['a deployment count of NaN', 'C16', (ctx) => (ctx.fresh.deploymentsLast24h = Number.NaN)],
    ['a 24 h notional reaching the limit', 'C16', (ctx) => (ctx.fresh.notionalLast24h6 = 18_050_000_000n)],
    ['a body price other than the quote', 'C17', (ctx) => patchBody(ctx, { price: '1109494507915005813' })],
  ])('fails on %s → %s', (_, id, mutate) => {
    const ctx = context('put');
    mutate(ctx);
    expectFailure(ctx, id);
  });

  it("tells C7's APR echo disagreement apart from its price checks", () => {
    const echo = context('put');
    echo.freshQuote = { ...echo.freshQuote, apy: 77.4 };
    const echoDetail = expectFailure(echo, 'C7').detail ?? '';
    expect(isAprEchoDisagreement({ checkId: 'C7', message: echoDetail })).toBe(true);
    expect(isAprEchoDisagreement({ checkId: 'C8', message: echoDetail })).toBe(false);
    expect(isAprEchoDisagreement({ message: echoDetail })).toBe(false);

    const price = context('put');
    price.freshQuote = { ...price.freshQuote, price: '20000000000000000000' };
    const priceDetail = expectFailure(price, 'C7').detail ?? '';
    expect(isAprEchoDisagreement({ checkId: 'C7', message: priceDetail })).toBe(false);
  });

  it('names the gate hold and the tranche mismatch', () => {
    const held = context('put');
    held.fresh.gateHold = 'cooldown';
    expect(expectFailure(held, 'C2').detail).toContain('cooldown');

    const resized = context('put');
    resized.fresh.trancheQuantityE18 = 50n * E18;
    expect(expectFailure(resized, 'C2').detail).toContain('50000000000000000000');
  });

  it('accepts a fresh state exactly 10 s old and listings exactly 5 min old', () => {
    const ctx = context('put');
    ctx.fresh.fetchedAtMs = NOW_MS - 10_000;
    ctx.fresh.listingsAtMs = NOW_MS - 300_000;
    expect(runPreSignChecks(ctx).ok).toBe(true);
  });

  it('fails C10 on listings older than 5 min, even for a custom strike', () => {
    const ctx = context('put');
    ctx.fresh.listingsAtMs = NOW_MS - 300_001;
    expect(expectFailure(ctx, 'C10').detail).toContain('300001 ms old');

    const custom = context('call');
    custom.intent.candidate.mode = 'basis-fallback-custom';
    custom.fresh.basisEligibleEmpty = true;
    custom.fresh.listingsAtMs = NOW_MS - 300_001;
    expectFailure(custom, 'C10');
  });

  it('checks the quantity against the cap headroom', () => {
    const atHeadroom = context('put');
    atHeadroom.fresh.capHeadroomE18 = 25n * E18;
    expect(runPreSignChecks(atHeadroom).ok).toBe(true);

    const noCap = context('put');
    noCap.fresh.capHeadroomE18 = null;
    expect(runPreSignChecks(noCap).ok).toBe(true);

    const below = context('put');
    below.fresh.capHeadroomE18 = 24n * E18;
    expect(expectFailure(below, 'C14').detail).toContain('cap headroom');
  });

  describe('candidate mode', () => {
    it('fails C3 for a put in a fallback mode, whatever else would be skipped', () => {
      // The review's probe: a custom-fallback put that the APR floor, listing and tenor checks would reject.
      const probe = context('put');
      probe.intent.candidate.mode = 'basis-fallback-custom';
      probe.config.minApr = 5;
      probe.config.maxDaysToExpiry = 1;
      probe.fresh.listedStrikesE8ForExpiry = [];
      expect(expectFailure(probe, 'C3').detail).toBe('fallback mode on a put');

      const fallback = context('put');
      fallback.intent.candidate.mode = 'basis-fallback';
      expectFailure(fallback, 'C3');
    });

    it('fails an unknown mode instead of treating it as a fallback', () => {
      const put = context('put');
      Object.assign(put.intent.candidate, { mode: 'weird' });
      expect(expectFailure(put, 'C3').detail).toContain("unknown candidate mode 'weird'");

      const call = context('call');
      Object.assign(call.intent.candidate, { mode: 'weird' });
      call.config.minApr = 0.9; // a fallback branch would skip this floor
      expect(expectFailure(call, 'C8').detail).toContain("unknown candidate mode 'weird'");
    });
  });

  it('fails closed when a check throws', () => {
    const ctx = context('put');
    ctx.config.maxGasFeeBps = 1.5;
    expect(expectFailure(ctx, 'C9').detail).toBeTruthy();
  });

  describe('dry-run', () => {
    function dryRun(): CheckContext {
      const ctx = context('put');
      ctx.mode = 'dry-run';
      ctx.signerAddress = null;
      ctx.lockHeld = false;
      ctx.fresh.allowance = 0n;
      return ctx;
    }

    it('passes with no signer and no allowance, with C1 and C13 n/a', () => {
      const result = runPreSignChecks(dryRun());

      expect(result.ok).toBe(true);
      expect(result.results.map((r) => r.id)).toEqual(IDS);
      expect(result.results.every((r) => r.pass)).toBe(true);
      expect(naIds(result.results)).toEqual(['C1', 'C13', 'C18']);
      expect(result).toMatchObject({ ok: true, body: null, gasFee6: 0n });
    });

    it('marks a short allowance n/a in dry-run but fails it in live', () => {
      const ctx = dryRun();
      ctx.fresh.allowance = 1949999999n;
      expect(runPreSignChecks(ctx).ok).toBe(true);

      const live = context('put');
      live.fresh.allowance = 1949999999n;
      expectFailure(live, 'C13');
    });

    it('still checks free collateral', () => {
      const ctx = dryRun();
      ctx.fresh.freeCollateral = 0n;
      expectFailure(ctx, 'C13');
    });

    it('pins the taker to the request taker', () => {
      const ctx = dryRun();
      patchBody(ctx, { taker: MAKERS.put });
      expectFailure(ctx, 'C3');
    });
  });

  describe('maker signature', () => {
    it('records a mismatch as a pass in warn mode', () => {
      const ctx = context('put');
      ctx.recoveredMaker = null;
      const result = runPreSignChecks(ctx);

      expect(result.ok).toBe(true);
      expect(result.results.find((r) => r.id === 'C5')).toEqual({
        id: 'C5',
        pass: true,
        detail: 'maker-signature-mismatch (warn)',
      });
    });

    it('fails a mismatch in enforce mode', () => {
      const ctx = context('put');
      ctx.config.verifyMakerSig = 'enforce';
      expect(runPreSignChecks(ctx).ok).toBe(true);

      ctx.recoveredMaker = MAKERS.call;
      expectFailure(ctx, 'C5');
    });
  });

  describe('calls', () => {
    it('passes the spike call quote above the basis', () => {
      const result = runPreSignChecks(context('call'));

      expect(result.ok).toBe(true);
      expect(result.results.every((r) => r.pass)).toBe(true);
      expect(naIds(result.results)).toEqual([]);
    });

    it('fails C18 for a strike of 84.5 below a basis of 85', () => {
      const ctx = context('call');
      ctx.fresh.basisE8 = 8500000000n;
      expect(ctx.body.strike).toBe('8450000000');
      expectFailure(ctx, 'C18');
    });

    it('fails C10 for a call strike outside [1.01 S, 1.4 S]', () => {
      for (const spotE8 of [8400000000n, 6000000000n]) {
        const ctx = context('call');
        ctx.fresh.spotE8 = spotE8;
        ctx.config.aprEchoTolerancePp = 100; // the call APR moves with spot
        expectFailure(ctx, 'C10');
      }
    });

    it('fails C18 on an unreliable basis', () => {
      const ctx = context('call');
      ctx.fresh.basisReliable = false;
      expectFailure(ctx, 'C18');
    });

    it('applies the strike-over-basis margin', () => {
      const ctx = context('call');
      ctx.config.minStrikeOverBasisPct = 0.06;
      expectFailure(ctx, 'C18');
    });

    describe('basis fallback', () => {
      function fallback(): CheckContext {
        const ctx = context('call');
        ctx.intent.candidate.mode = 'basis-fallback';
        ctx.fresh.basisE8 = 9000000000n;
        ctx.fresh.basisEligibleEmpty = true;
        ctx.fresh.freshFallbackStrikeE8 = 8450000000n;
        return ctx;
      }

      it('passes at the fresh K* below the basis, ignoring the APR floor and the maximum tenor', () => {
        const ctx = fallback();
        ctx.config.minApr = 0.9;
        ctx.config.maxDaysToExpiry = 5;
        expect(runPreSignChecks(ctx).ok).toBe(true);
      });

      it('requires the fallback net premium floor', () => {
        const ctx = fallback();
        ctx.config.fallbackMinNetPremium6 = 30_000_000n;
        expectFailure(ctx, 'C8');
      });

      it('fails C18 when K* moved or the eligible set is no longer empty', () => {
        const moved = fallback();
        moved.fresh.freshFallbackStrikeE8 = 8700000000n;
        expectFailure(moved, 'C18');

        const eligible = fallback();
        eligible.fresh.basisEligibleEmpty = false;
        expectFailure(eligible, 'C18');
      });

      it('fails C18 for a fallback strike that clears the basis: fallback mode sells below it only', () => {
        const ctx = fallback();
        ctx.fresh.basisE8 = 8450000000n;
        expect(expectFailure(ctx, 'C18').detail).toContain('not a fallback');

        ctx.fresh.basisE8 = 8450000001n;
        expect(runPreSignChecks(ctx).ok).toBe(true);
      });

      function custom(freshKStarE8: bigint | null): CheckContext {
        const ctx = fallback();
        ctx.intent.candidate.mode = 'basis-fallback-custom';
        ctx.fresh.listedStrikesE8ForExpiry = [];
        ctx.fresh.freshFallbackStrikeE8 = freshKStarE8;
        return ctx;
      }

      it('accepts an unlisted custom strike above the fresh K*, equal to the candidate strike', () => {
        const ctx = custom(8400000000n);
        expect(runPreSignChecks(ctx).ok).toBe(true);

        ctx.intent.candidate.strikeE8 = 8460000000n;
        expectFailure(ctx, 'C18');
      });

      it('fails a custom strike at or below the fresh K*, or with no fresh K*', () => {
        // The custom 84.5 against a fresh K* of 87, of 84.5, and none.
        for (const freshKStarE8 of [8700000000n, 8450000000n, null]) {
          expectFailure(custom(freshKStarE8), 'C18');
        }
      });
    });
  });
});
