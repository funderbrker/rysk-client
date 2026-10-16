import { type Address, isAddress, isAddressEqual, zeroAddress } from 'viem';
import { aprFraction, aprFractionFromRyskApy, collateral6For } from '../domain/apr.ts';
import { ADDRESSES, CHAIN_ID, TOKENS } from '../domain/constants.ts';
import { uintOf } from '../domain/parse.ts';
import type { ConfirmBody, Quote } from '../domain/types.ts';
import { collateralForCall, collateralForPut, premium6 } from '../domain/units.ts';
import { EIP712_DOMAIN, toConfirmationMessage } from '../rysk/eip712.ts';
import { echoMismatches } from './echo.ts';
import type { CheckResult, ExecutionCandidate, FreshState, TradeIntent } from './types.ts';

declare const checkedBrand: unique symbol;

/** A confirm body that passed every pre-sign check (C17); only `runPreSignChecks` produces one. */
export type CheckedConfirmBody = ConfirmBody & { readonly [checkedBrand]: true };

/**
 * The config's `safety` block (Appendix B) normalized, plus the traded side's limits and the WHYPE asset's
 * trade sizes and strike precision. Fractions are fractions (`minOtmPct: 0.01` is 1 %); `aprEchoTolerancePp` is in percentage points.
 */
export type ExecutionConfig = {
  maxGasFee6: bigint;
  maxGasFeeBps: number;
  minNetPremium6: bigint;
  minQuoteTtlSec: number;
  maxQuoteTtlSec: number;
  maxPremiumFractionOfCollateral: number;
  aprEchoTolerancePp: number;
  verifyMakerSig: 'warn' | 'enforce';
  maxDeploymentsPer24h: number;
  maxNotionalPer24h6: bigint;
  minNativeHypeE18: bigint;
  minApr: number;
  minOtmPct: number;
  minStrikeOverBasisPct: number;
  fallbackMinNetPremium6: bigint;
  minTradeSizeE18: bigint;
  maxTradeSizeE18: bigint;
  maxContractsPerTradeE18: bigint;
  strikePrecisionE8: bigint;
  minHoursToExpiry: number;
  maxDaysToExpiry: number;
};

/**
 * Everything the checklist reads. `freshQuote` is the quote held after REQUOTE and `body` our confirm body
 * built from it; `gasFee6` is the GAS step's fee (the echo is never re-parsed for it). `signerAddress` is `null`
 * in dry-run; `recoveredMaker` is `recoverQuoteSigner(freshQuote)`, or `null` when recovery failed.
 */
export type CheckContext = {
  mode: 'live' | 'dry-run';
  intent: TradeIntent;
  freshQuote: Quote;
  body: ConfirmBody;
  echoed: Record<string, unknown>;
  gasFee6: bigint;
  fresh: FreshState;
  config: ExecutionConfig;
  serverNowSec: number;
  nowMs: number;
  signerAddress: Address | null;
  usedQuoteNonces: ReadonlySet<string>;
  lastNonceMs: number;
  stopFile: boolean;
  lockHeld: boolean;
  inFlightExcludingSelf: boolean;
  recoveredMaker: Address | null;
};

/**
 * `body` is the branded body in live and `null` in dry-run, so no signable body exists outside live mode;
 * `gasFee6` is the fee C9 bounded, the one to sign.
 */
export type PreSignResult =
  | { ok: true; body: CheckedConfirmBody | null; gasFee6: bigint; results: CheckResult[] }
  | { ok: false; failed: CheckResult; results: CheckResult[] };

type Outcome = Omit<CheckResult, 'id'>;
type Check = (ctx: CheckContext) => Outcome;

const E8 = 10n ** 8n;
const E18 = 10n ** 18n;
const PPM = 1_000_000n;
const NONCE_SKEW_MS = 5000;
const MAX_FRESH_STATE_AGE_MS = 10_000;
const MAX_LISTINGS_AGE_MS = 300_000;
const MODES: readonly string[] = ['normal', 'basis-fallback', 'basis-fallback-custom'];
/** How C7's detail starts when the quote's `apy` disagrees with our APR (its price checks say otherwise). */
const APR_ECHO_DETAIL = 'our APR ';

const PASS: Outcome = { pass: true };

function fail(detail: string): Outcome {
  return { pass: false, detail };
}

function notApplicable(detail: string): Outcome {
  return { pass: true, na: true, detail };
}

/** A decimal uint string as a bigint; throws (failing the check) for anything else. */
function uint(value: unknown, what: string): bigint {
  const parsed = uintOf(value);
  if (parsed === undefined) throw new Error(`${what} '${String(value)}' is not a decimal uint string`);
  return parsed;
}

/** A non-negative config fraction in parts per million, for bigint comparisons. */
function ppm(fraction: number, what: string): bigint {
  if (!Number.isFinite(fraction) || fraction < 0) throw new Error(`${what} ${fraction} is not a fraction`);
  return BigInt(Math.round(fraction * 1e6));
}

function sameAddress(a: unknown, b: Address): boolean {
  return typeof a === 'string' && isAddress(a, { strict: false }) && isAddressEqual(a, b);
}

function sameUint(a: unknown, b: unknown): boolean {
  const value = uintOf(a);
  return value !== undefined && value === uintOf(b);
}

/** The candidate's mode; throws (failing the check) for any other string, so no unknown mode reads as a fallback. */
function modeOf(ctx: CheckContext): ExecutionCandidate['mode'] {
  const mode: unknown = ctx.intent.candidate.mode;
  if (typeof mode !== 'string' || !MODES.includes(mode)) {
    throw new Error(`unknown candidate mode '${String(mode)}'`);
  }
  return mode as ExecutionCandidate['mode'];
}

/** Our own address: the signer in live, the configured account (the request's taker) in dry-run. */
function self(ctx: CheckContext): Address | null {
  return ctx.mode === 'live' ? ctx.signerAddress : ctx.intent.candidate.request.taker;
}

/** Quantity, price, strike and the premium and collateral (USD, 6 dp) they imply, from a quote or our body. */
function terms(ctx: CheckContext, source: { quantity: string; price: string; strike: string }) {
  const qtyE18 = uint(source.quantity, 'quantity');
  const priceE18 = uint(source.price, 'price');
  const strikeE8 = uint(source.strike, 'strike');
  return {
    qtyE18,
    priceE18,
    strikeE8,
    premium6: premium6(qtyE18, priceE18),
    collateral6: collateral6For(ctx.intent.side, qtyE18, strikeE8, ctx.fresh.spotE8),
  };
}

/** C1: live, no STOP file, lock held, signing as the configured account, no EIP-1271. */
function c1(ctx: CheckContext): Outcome {
  if (ctx.mode === 'dry-run') return notApplicable('dry-run');
  if (ctx.stopFile) return fail('data/STOP is present');
  if (!ctx.lockHeld) return fail('live lock not held');
  // Strategy requests carry `config.account.address` as the taker in both modes.
  const account = ctx.intent.candidate.request.taker;
  if (ctx.signerAddress === null || !isAddressEqual(ctx.signerAddress, account)) {
    return fail(`signer ${ctx.signerAddress} is not the configured account ${account}`);
  }
  if (ctx.intent.candidate.request.isEIP1271 !== false) return fail('isEIP1271 must be false');
  return PASS;
}

/** C2: a fresh state (≤ 10 s old) passes every gate (in-flight evaluated without us) and re-sizes to the intent. */
function c2(ctx: CheckContext): Outcome {
  const { fresh, config } = ctx;
  const ageMs = ctx.nowMs - fresh.fetchedAtMs;
  if (!(ageMs <= MAX_FRESH_STATE_AGE_MS)) return fail(`fresh state is ${ageMs} ms old`);
  if (fresh.gateHold !== null) return fail(`gate holds: ${fresh.gateHold}`);
  if (ctx.inFlightExcludingSelf) return fail('another execution is in flight');
  if (ctx.mode === 'live' && fresh.nativeHypeE18 < config.minNativeHypeE18) {
    return fail(`native HYPE ${fresh.nativeHypeE18} below the gas reserve ${config.minNativeHypeE18}`);
  }
  const intended = ctx.intent.candidate.quantityE18;
  if (fresh.trancheQuantityE18 !== intended) {
    return fail(`fresh tranche ${fresh.trancheQuantityE18} differs from the intent's ${intended}`);
  }
  return PASS;
}

/** C3: the body trades the pinned WHYPE product of the intent's side, as a sell, to us; fallback is calls only. */
function c3(ctx: CheckContext): Outcome {
  const { body } = ctx;
  const isPut = ctx.intent.side === 'put';
  if (isPut && modeOf(ctx) !== 'normal') return fail('fallback mode on a put');
  const taker = self(ctx);
  const wrong: string[] = [];
  if (!sameAddress(body.assetAddress, TOKENS.WHYPE.address)) wrong.push('assetAddress');
  if (!sameAddress(body.usd, TOKENS.USDC.address)) wrong.push('usd');
  const collateral = isPut ? TOKENS.USDC.address : TOKENS.WHYPE.address;
  if (!sameAddress(body.collateralAsset, collateral)) wrong.push('collateralAsset');
  if (body.chainId !== CHAIN_ID) wrong.push('chainId');
  if (body.isPut !== isPut) wrong.push('isPut');
  if (body.isTakerBuy !== false) wrong.push('isTakerBuy');
  if (taker === null || !sameAddress(body.taker, taker)) wrong.push('taker');
  return wrong.length === 0 ? PASS : fail(`body not pinned: ${wrong.join(', ')}`);
}

/** C4: the fresh quote echoes the request on every term field (spec §6.7) and is a taker sell. */
function c4(ctx: CheckContext): Outcome {
  const quote = ctx.freshQuote;
  const request = ctx.intent.candidate.request;
  const differs: string[] = [];
  if (!sameAddress(quote.assetAddress, request.asset)) differs.push('assetAddress');
  if (quote.chainId !== request.chainId) differs.push('chainId');
  if (quote.expiry !== request.expiry) differs.push('expiry');
  if (quote.isPut !== request.isPut) differs.push('isPut');
  if (!sameUint(quote.quantity, request.quantity)) differs.push('quantity');
  if (!sameUint(quote.strike, request.strike)) differs.push('strike');
  if (!sameAddress(quote.usd, request.usd)) differs.push('usd');
  if (!sameAddress(quote.collateralAsset, request.collateralAsset)) differs.push('collateralAsset');
  if (quote.isTakerBuy !== false) differs.push('isTakerBuy');
  return differs.length === 0 ? PASS : fail(`quote differs from the request: ${differs.join(', ')}`);
}

/** C5: a real maker other than us, a quote nonce we never signed, and (when enforced) the maker's signature. */
function c5(ctx: CheckContext): Outcome {
  const quote = ctx.freshQuote;
  const us = self(ctx);
  if (!isAddress(quote.maker, { strict: false })) return fail(`maker '${quote.maker}' is not an address`);
  if (isAddressEqual(quote.maker, zeroAddress)) return fail('maker is the zero address');
  if (us !== null && isAddressEqual(quote.maker, us)) return fail('maker is our own address');
  // Compared by value: the same uint64 nonce may arrive with leading zeros.
  const nonce = uint(quote.nonce, 'quote nonce');
  for (const used of ctx.usedQuoteNonces) {
    if (uintOf(used) === nonce) return fail(`quote nonce ${quote.nonce} was already signed`);
  }
  const signedByMaker = ctx.recoveredMaker !== null && isAddressEqual(ctx.recoveredMaker, quote.maker);
  if (signedByMaker) return PASS;
  return ctx.config.verifyMakerSig === 'enforce'
    ? fail('maker-signature-mismatch')
    : { pass: true, detail: 'maker-signature-mismatch (warn)' };
}

/** C6: enough, but not implausibly much, time left on the quote, which ends before the option expires. */
function c6(ctx: CheckContext): Outcome {
  const { validUntil, expiry } = ctx.freshQuote;
  const { minQuoteTtlSec, maxQuoteTtlSec } = ctx.config;
  const ttlSec = validUntil - ctx.serverNowSec;
  if (!(ttlSec >= minQuoteTtlSec && ttlSec <= maxQuoteTtlSec)) {
    return fail(`quote TTL ${ttlSec}s outside [${minQuoteTtlSec}, ${maxQuoteTtlSec}]`);
  }
  if (!(validUntil < expiry)) return fail(`quote valid until ${validUntil}, not before expiry ${expiry}`);
  return PASS;
}

/** C7: a positive, plausible price whose APR (gas 0) agrees with the quote's `apy`. */
function c7(ctx: CheckContext): Outcome {
  const quote = ctx.freshQuote;
  const { config } = ctx;
  const t = terms(ctx, quote);
  if (t.priceE18 <= 0n) return fail('price is zero');
  const isPut = ctx.intent.side === 'put';
  const referenceE8 = isPut ? t.strikeE8 : ctx.fresh.spotE8;
  // price / 1e18 ≤ fraction × reference / 1e8
  const maxFraction = ppm(config.maxPremiumFractionOfCollateral, 'maxPremiumFractionOfCollateral');
  if (t.priceE18 * E8 * PPM > maxFraction * referenceE8 * E18) {
    const of = isPut ? 'strike' : 'spot';
    return fail(`price ${t.priceE18} is more than ${config.maxPremiumFractionOfCollateral} of the ${of}`);
  }
  const ours = aprFraction(t.premium6, t.collateral6, ctx.serverNowSec, quote.expiry);
  const quoted = aprFractionFromRyskApy(quote.apy);
  if (!(Math.abs(ours - quoted) <= config.aprEchoTolerancePp / 100)) {
    return fail(
      `${APR_ECHO_DETAIL}${ours} vs quoted ${quoted}: more than ${config.aprEchoTolerancePp} pp apart`,
    );
  }
  return PASS;
}

/**
 * Whether a failed check (an `aborted('guard')` result's `checkId` and `message`) is C7's APR echo disagreement
 * rather than one of C7's price checks; the daemon halts live on the second (spec §10).
 */
export function isAprEchoDisagreement(failure: { checkId?: string; message: string }): boolean {
  return failure.checkId === 'C7' && failure.message.startsWith(APR_ECHO_DETAIL);
}

/** C8: the net premium after the GAS step's fee clears the APR floor (normal) or the fallback floor. */
function c8(ctx: CheckContext): Outcome {
  const { config } = ctx;
  const t = terms(ctx, ctx.freshQuote);
  const net6 = t.premium6 - ctx.gasFee6;
  if (modeOf(ctx) === 'normal') {
    const apr = aprFraction(net6, t.collateral6, ctx.serverNowSec, ctx.freshQuote.expiry);
    if (!(apr >= config.minApr)) return fail(`net APR ${apr} below the floor ${config.minApr}`);
  } else if (net6 < config.fallbackMinNetPremium6) {
    return fail(`net premium ${net6} below the fallback floor ${config.fallbackMinNetPremium6}`);
  }
  if (net6 < config.minNetPremium6) return fail(`net premium ${net6} below ${config.minNetPremium6}`);
  return PASS;
}

/** C9: the gas echo is exactly our body plus the known extras, and the gas fee is within both limits. */
function c9(ctx: CheckContext): Outcome {
  const { config, gasFee6 } = ctx;
  const mismatches = echoMismatches(ctx.body, ctx.echoed);
  if (mismatches.length > 0) return fail(`gas echo differs: ${mismatches.join(', ')}`);
  const premium = terms(ctx, ctx.freshQuote).premium6;
  if (gasFee6 < 0n) return fail(`gas fee ${gasFee6} is negative`);
  if (gasFee6 * 10_000n > premium * BigInt(config.maxGasFeeBps)) {
    return fail(`gas fee ${gasFee6} above ${config.maxGasFeeBps} bps of premium ${premium}`);
  }
  if (gasFee6 > config.maxGasFee6) return fail(`gas fee ${gasFee6} above ${config.maxGasFee6}`);
  return PASS;
}

/**
 * C10: the strike sits in the OTM band around fresh spot, on the strike grid, and is listed (unless custom) in
 * listings at most 5 min old.
 */
function c10(ctx: CheckContext): Outcome {
  const { fresh, config } = ctx;
  const strikeE8 = uint(ctx.body.strike, 'body strike');
  const spotE8 = fresh.spotE8;
  const otm = ppm(config.minOtmPct, 'minOtmPct');
  const inBand =
    ctx.intent.side === 'put'
      ? strikeE8 * 10n >= spotE8 * 6n && strikeE8 * PPM <= spotE8 * (PPM - otm)
      : strikeE8 * PPM >= spotE8 * (PPM + otm) && strikeE8 * 10n <= spotE8 * 14n;
  if (!inBand) return fail(`${ctx.intent.side} strike ${strikeE8} outside the band around spot ${spotE8}`);
  if (config.strikePrecisionE8 <= 0n || strikeE8 % config.strikePrecisionE8 !== 0n) {
    return fail(`strike ${strikeE8} not a multiple of ${config.strikePrecisionE8}`);
  }
  const listingsAgeMs = ctx.nowMs - fresh.listingsAtMs;
  if (!(listingsAgeMs <= MAX_LISTINGS_AGE_MS)) return fail(`listings are ${listingsAgeMs} ms old`);
  const listed = fresh.listedStrikesE8ForExpiry.includes(strikeE8);
  if (!listed && modeOf(ctx) !== 'basis-fallback-custom') {
    return fail(`strike ${strikeE8} not listed for expiry ${ctx.body.expiry}`);
  }
  return PASS;
}

/** C11: the expiry is in the current inventory and inside the tenor window (fallback: the minimum only). */
function c11(ctx: CheckContext): Outcome {
  const { config } = ctx;
  const expirySec = ctx.body.expiry;
  if (!ctx.fresh.expiriesSec.includes(expirySec)) return fail(`expiry ${expirySec} not in the inventory`);
  const tenorSec = expirySec - ctx.serverNowSec;
  if (!(tenorSec >= config.minHoursToExpiry * 3600)) {
    return fail(`tenor ${tenorSec}s below ${config.minHoursToExpiry} h`);
  }
  if (modeOf(ctx) === 'normal' && !(tenorSec <= config.maxDaysToExpiry * 86_400)) {
    return fail(`tenor ${tenorSec}s above ${config.maxDaysToExpiry} days`);
  }
  return PASS;
}

/** C12: a whole number of lots, between one lot and the trade-size limits. */
function c12(ctx: CheckContext): Outcome {
  const { config } = ctx;
  const qtyE18 = uint(ctx.body.quantity, 'body quantity');
  const lotE18 = config.minTradeSizeE18;
  if (lotE18 <= 0n || qtyE18 % lotE18 !== 0n) return fail(`quantity ${qtyE18} not a multiple of ${lotE18}`);
  const maxE18 =
    config.maxTradeSizeE18 < config.maxContractsPerTradeE18
      ? config.maxTradeSizeE18
      : config.maxContractsPerTradeE18;
  if (qtyE18 < lotE18 || qtyE18 > maxE18) return fail(`quantity ${qtyE18} outside [${lotE18}, ${maxE18}]`);
  return PASS;
}

/**
 * C13: the collateral is what the strike and quantity require, fits in free collateral (net of the reserve)
 * and, in live, equals the allowance exactly (the allowance clause is n/a in dry-run).
 */
function c13(ctx: CheckContext): Outcome {
  const { body, fresh } = ctx;
  const amount = uint(body.collateralAmount, 'body collateralAmount');
  const qtyE18 = uint(body.quantity, 'body quantity');
  const required =
    ctx.intent.side === 'put'
      ? collateralForPut(qtyE18, uint(body.strike, 'body strike'))
      : collateralForCall(qtyE18, TOKENS.WHYPE.decimals);
  if (amount !== required) return fail(`collateral ${amount} is not the required ${required}`);
  if (amount > fresh.freeCollateral) return fail(`collateral ${amount} above free ${fresh.freeCollateral}`);
  if (ctx.mode === 'dry-run') return notApplicable('allowance not checked in dry-run');
  if (fresh.allowance !== amount) return fail(`allowance ${fresh.allowance} is not exactly ${amount}`);
  return PASS;
}

/**
 * C14: caps soft check (spec §8.5): the quantity fits the cap headroom, which the provider computes with the
 * 0.95 margin, and the fresh tranche, which is cut to it.
 */
function c14(ctx: CheckContext): Outcome {
  const qtyE18 = uint(ctx.body.quantity, 'body quantity');
  const { capHeadroomE18, trancheQuantityE18 } = ctx.fresh;
  if (capHeadroomE18 !== null && qtyE18 > capHeadroomE18) {
    return fail(`quantity ${qtyE18} above the cap headroom ${capHeadroomE18}`);
  }
  if (qtyE18 > trancheQuantityE18) {
    return fail(`quantity ${qtyE18} above the cap-bounded tranche ${trancheQuantityE18}`);
  }
  return PASS;
}

/** C15: the signing domain is the pinned one and our nonce is fresh, increasing and near the clock. */
function c15(ctx: CheckContext): Outcome {
  const domain = EIP712_DOMAIN;
  const pinned =
    domain.name === 'rysk' &&
    domain.version === '0.0.0' &&
    domain.chainId === CHAIN_ID &&
    sameAddress(domain.verifyingContract, ADDRESSES.rysk);
  if (!pinned) return fail('EIP-712 domain is not the pinned one');
  const nonceMs = Number(uint(ctx.body.nonce, 'body nonce'));
  if (!Number.isSafeInteger(nonceMs)) return fail(`nonce ${ctx.body.nonce} is not a safe integer`);
  if (!(nonceMs > ctx.lastNonceMs)) return fail(`nonce ${nonceMs} not above the last ${ctx.lastNonceMs}`);
  if (!(Math.abs(nonceMs - ctx.nowMs) <= NONCE_SKEW_MS)) {
    return fail(`nonce ${nonceMs} more than ${NONCE_SKEW_MS} ms from now ${ctx.nowMs}`);
  }
  return PASS;
}

/** C16: the 24 h deployment count and notional stay under their limits with this trade included. */
function c16(ctx: CheckContext): Outcome {
  const { fresh, config } = ctx;
  if (!(fresh.deploymentsLast24h < config.maxDeploymentsPer24h)) {
    return fail(`${fresh.deploymentsLast24h} deployments in 24 h; limit ${config.maxDeploymentsPer24h}`);
  }
  const notional6 = fresh.notionalLast24h6 + terms(ctx, ctx.body).collateral6;
  if (notional6 >= config.maxNotionalPer24h6) {
    return fail(`24 h notional ${notional6} with this trade reaches ${config.maxNotionalPer24h6}`);
  }
  return PASS;
}

/** The body fields `buildConfirmBody` copies from the quote, with the quote field each one carries. */
const QUOTE_FIELDS: [keyof ConfirmBody, keyof Quote][] = [
  ['assetAddress', 'assetAddress'],
  ['expiry', 'expiry'],
  ['isPut', 'isPut'],
  ['maker', 'maker'],
  ['price', 'price'],
  ['quantity', 'quantity'],
  ['quoteNonce', 'nonce'],
  ['quoteSignature', 'signature'],
  ['quoteValidUntil', 'validUntil'],
  ['validUntil', 'validUntil'],
  ['strike', 'strike'],
  ['usd', 'usd'],
  ['collateralAsset', 'collateralAsset'],
];

/**
 * C17: the body to be branded carries exactly the checked quote's terms, so what C4–C8 checked is what is
 * signed, and the confirmation message builds from it.
 */
function c17(ctx: CheckContext): Outcome {
  const differs = QUOTE_FIELDS.filter(([bodyKey, quoteKey]) => {
    const sent = ctx.body[bodyKey];
    const quoted = ctx.freshQuote[quoteKey];
    return typeof quoted === 'string' && isAddress(quoted, { strict: false })
      ? !sameAddress(sent, quoted)
      : sent !== quoted;
  }).map(([bodyKey]) => bodyKey);
  if (differs.length > 0) return fail(`body differs from the quote: ${differs.join(', ')}`);
  toConfirmationMessage(ctx.body, ctx.gasFee6);
  return PASS;
}

/** C18 (calls): a reliable basis, and the strike clears it (normal) or is still the fallback strike. */
function c18(ctx: CheckContext): Outcome {
  if (ctx.intent.side === 'put') return notApplicable('calls only');
  const { fresh, config } = ctx;
  if (!fresh.basisReliable) return fail('basis is unreliable');
  const strikeE8 = uint(ctx.body.strike, 'body strike');
  const mode = modeOf(ctx);
  if (mode === 'normal') {
    if (fresh.basisE8 === null) return fail('basis is undefined');
    const margin = ppm(config.minStrikeOverBasisPct, 'minStrikeOverBasisPct');
    if (strikeE8 * PPM < fresh.basisE8 * (PPM + margin)) {
      return fail(`strike ${strikeE8} below basis ${fresh.basisE8} × (1 + ${config.minStrikeOverBasisPct})`);
    }
    return PASS;
  }
  if (!fresh.basisEligibleEmpty) return fail('strikes above the basis are listed again');
  const expected = mode === 'basis-fallback' ? fresh.freshFallbackStrikeE8 : ctx.intent.candidate.strikeE8;
  if (strikeE8 !== expected) return fail(`strike ${strikeE8} is not the ${mode} strike ${expected}`);
  return PASS;
}

const CHECKS: [string, Check][] = [
  ['C1', c1],
  ['C2', c2],
  ['C3', c3],
  ['C4', c4],
  ['C5', c5],
  ['C6', c6],
  ['C7', c7],
  ['C8', c8],
  ['C9', c9],
  ['C10', c10],
  ['C11', c11],
  ['C12', c12],
  ['C13', c13],
  ['C14', c14],
  ['C15', c15],
  ['C16', c16],
  ['C17', c17],
  ['C18', c18],
];

/** A check that throws (a malformed field, a bad config value) fails rather than escaping. */
function evaluate(check: Check, ctx: CheckContext): Outcome {
  try {
    return check(ctx);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The pre-sign checklist (spec §7.2), C1–C18 in order, stopping at the first failure. A body copy is checked
 * and, when every check passes in live, returned frozen as the only `CheckedConfirmBody` the signer accepts,
 * with the gas fee C9 bounded. In dry-run, C1 and the allowance clause of C13 are recorded n/a, every other
 * check runs, and no body is returned.
 */
export function runPreSignChecks(ctx: CheckContext): PreSignResult {
  const body: ConfirmBody = { ...ctx.body };
  const checked: CheckContext = { ...ctx, body };
  const results: CheckResult[] = [];
  for (const [id, check] of CHECKS) {
    const result: CheckResult = { id, ...evaluate(check, checked) };
    results.push(result);
    if (!result.pass) return { ok: false, failed: result, results };
  }
  const branded = ctx.mode === 'live' ? (Object.freeze(body) as CheckedConfirmBody) : null;
  return { ok: true, body: branded, gasFee6: ctx.gasFee6, results };
}
