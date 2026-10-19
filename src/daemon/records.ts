import { type Address, isAddressEqual, zeroAddress } from 'viem';
import { aprFraction, collateral6For } from '../domain/apr.ts';
import { tokenByAddress } from '../domain/constants.ts';
import { uintOf } from '../domain/parse.ts';
import type { Listing, Quote, QuoteRequest, Side } from '../domain/types.ts';
import { premium6, UnitError } from '../domain/units.ts';
import type { TradeIntent } from '../execution/types.ts';
import type { QuoteResult } from '../rysk/taker.ts';
import type { WheelConfig } from '../strategy/wheel/config.ts';
import type {
  Candidate,
  Decision,
  QuotedCandidate,
  QuoteOutcome,
  SidePlan,
  Snapshot,
  WheelState,
} from '../strategy/wheel/types.ts';
import { backoffKeyOf, type Memo } from './memo.ts';

// The bodies of the loop's and the research sampler's records (spec §9.3); the recorder adds the envelope and
// writes bigints as strings. No top-level key may be an envelope field (`v`, `kind`, `tsMs`, `runId`, `mode`,
// `codeRev`, `configHash`).

type Gas = Extract<QuoteOutcome, { ok: true }>['gas'];
type RfqFailure = { error: 'timeout' | 'rpc-error' | 'mismatch' | 'socket-closed'; message: string };
type RfqAnswer = { quote: Quote; respondedAtMs: number; makerSigOk: boolean | null };
/** What a quote's premium and APR are priced on: a `Candidate`, or a sampled instrument. */
type Priced = {
  side: Side;
  strikeE8: bigint;
  expirySec: number;
  quantityE18: bigint;
  indicativeApr: number | null;
};

/** A sampler RFQ's result: the taker's, plus the maker signature check of a quote (`null` when not checked). */
export type SampleOutcome =
  | (Extract<QuoteResult, { ok: true }> & { makerSigOk: boolean | null })
  | Extract<QuoteResult, { ok: false }>;

/** Why a sampler RFQ was sent and what it was sent against. */
export type SampleContext = {
  purpose: 'sweep' | 'pinned' | 'taker-pair';
  /** The stream's run, 1 for its first. */
  run: number;
  /** Local seconds when the RFQ was sent: the tenor and APR are counted from it. */
  nowSec: number;
  /**
   * HYPE spot: the daemon's WHYPE asset price (`asset`), else the latest listings' index (`index`); `null` with
   * `spotSource: 'none'` when neither is known.
   */
  spotE8: bigint | null;
  spotSource: 'asset' | 'index' | 'none';
  inventoryTs: number | null;
  /** The instrument's current listing; `undefined` once it is de-listed (a pinned instrument as a custom strike). */
  listing: Listing | undefined;
};

/** A candidate's id in the records: its backoff key, `side|strikeE8|expirySec`. */
export function candidateKey(c: Candidate): string {
  return backoffKeyOf(c.side, c.strikeE8, c.expirySec);
}

/** `state`: what the tick derived, with the chain reads and the memo behind it. */
export function stateRecord(tick: number, st: WheelState, s: Snapshot, memo: Memo): object {
  const phases: Record<string, number> = {};
  for (const { phase } of st.rows) phases[phase] = (phases[phase] ?? 0) + 1;
  return {
    tick,
    nowSec: s.nowSec,
    localNowMs: s.localNowMs,
    chain: s.chain,
    spotE8: s.market.spotE8,
    inventoryTs: s.market.inventoryTs,
    consistency: st.consistency,
    capital: st.capital,
    basis: st.basis,
    lastDeployTs: st.lastDeployTs,
    deploymentsLast24h: st.deploymentsLast24h,
    notionalLast24h6: st.notionalLast24h6,
    counts: {
      positions: s.positions.length,
      otherRows: s.otherRowCount,
      phases,
      listings: s.market.listings.length,
      caps: s.market.caps.length,
    },
    anomalies: st.anomalies,
    warnings: st.warnings,
    memo: {
      ...s.memo,
      haltedLive: memo.haltedLive,
      replanDueSec: memo.replanDueSec,
      backedOffKeys: memo.keyBackoff.size,
      pendingVisibility: memo.pendingVisibility.length,
      unknownWaits: memo.unknownWaits.length,
      rejectedWatches: memo.rejectedWatches.length,
    },
  };
}

/** `quotes`: one RFQ with its context, outcome, quote fields and the premium and net APR it implies. */
export function quoteRecord(tick: number, candidate: Candidate, outcome: QuoteOutcome, s: Snapshot): object {
  const { request } = candidate;
  const base = {
    tick,
    side: candidate.side,
    purpose: candidate.mode === 'basis-fallback-custom' ? 'fallback-custom' : 'candidate',
    instrument: {
      key: candidateKey(candidate),
      isPut: request.isPut,
      strikeE8: candidate.strikeE8,
      expirySec: candidate.expirySec,
      quantityE18: candidate.quantityE18,
      usd: request.usd,
      collateralAsset: request.collateralAsset,
      candidateMode: candidate.mode,
      rank: candidate.rank,
    },
    takerKind: takerKindOf(request.taker),
    context: {
      spotE8: s.market.spotE8,
      inventoryTs: s.market.inventoryTs,
      indicativeApr: candidate.indicativeApr,
      delta: candidate.delta,
      ...timeContext(s.nowSec, candidate.expirySec),
    },
    requestedAtMs: outcome.requestedAtMs,
  };
  if (!outcome.ok) return { ...base, ...failureFields(outcome) };
  const { quote, gas } = outcome;
  return {
    ...base,
    ...answerFields(outcome, s.memo.serverSkewMs),
    gas: gas.ok ? { ok: true, gasFee6: gas.gasFee6 } : { ok: false, reason: gas.reason },
    ...derived(candidate, quote.price, gas, s),
  };
}

/**
 * `quotes` for a research sampler RFQ (spec §9.2): `quoteRecord`'s fields without a gas preview, so the premium's
 * APR is gross only, and with the instrument's stablecoin and collateral symbols. The quote's TTL is on the local
 * clock (the sampler has no server skew).
 */
export function sampleQuoteRecord(request: QuoteRequest, outcome: SampleOutcome, ctx: SampleContext): object {
  const terms: Priced = {
    side: request.isPut ? 'put' : 'call',
    strikeE8: BigInt(request.strike),
    expirySec: request.expiry,
    quantityE18: BigInt(request.quantity),
    indicativeApr: ctx.listing?.indicativeApr ?? null,
  };
  const base = {
    purpose: ctx.purpose,
    run: ctx.run,
    side: terms.side,
    instrument: {
      key: backoffKeyOf(terms.side, terms.strikeE8, terms.expirySec),
      isPut: request.isPut,
      strikeE8: terms.strikeE8,
      expirySec: terms.expirySec,
      quantityE18: terms.quantityE18,
      usd: request.usd,
      usdSymbol: symbolOf(request.usd),
      collateralAsset: request.collateralAsset,
      collateralSymbol: symbolOf(request.collateralAsset),
      listed: ctx.listing !== undefined,
    },
    takerKind: takerKindOf(request.taker),
    context: {
      spotE8: ctx.spotE8,
      spotSource: ctx.spotSource,
      inventoryTs: ctx.inventoryTs,
      indicativeApr: terms.indicativeApr,
      delta: ctx.listing?.delta ?? null,
      ...timeContext(ctx.nowSec, terms.expirySec),
    },
    requestedAtMs: outcome.requestedAtMs,
  };
  if (!outcome.ok) return { ...base, ...failureFields(outcome) };
  return {
    ...base,
    ...answerFields(outcome, 0),
    ...grossDerived(terms, outcome.quote.price, ctx.spotE8, ctx.nowSec),
  };
}

function takerKindOf(taker: Address): 'zero' | 'self' {
  return isAddressEqual(taker, zeroAddress) ? 'zero' : 'self';
}

function symbolOf(token: Address): string | null {
  return tokenByAddress(token)?.symbol ?? null;
}

/** The tenor left at `nowSec` and the UTC weekday and hour then. */
function timeContext(nowSec: number, expirySec: number) {
  const at = new Date(nowSec * 1000);
  return { tenorSec: expirySec - nowSec, weekdayUtc: at.getUTCDay(), hourUtc: at.getUTCHours() };
}

/** A failed RFQ's outcome (`rpc-error` is recorded as `error`), its error and message. */
function failureFields(failure: RfqFailure) {
  const kind = failure.error === 'rpc-error' ? 'error' : failure.error;
  return { outcome: kind, error: failure.error, message: failure.message };
}

/** An answered RFQ: when it arrived, the quote's fields with its TTL at arrival, and the maker signature check. */
function answerFields(answer: RfqAnswer, serverSkewMs: number) {
  const { quote, respondedAtMs } = answer;
  return {
    outcome: 'quote',
    respondedAtMs,
    quote: {
      maker: quote.maker,
      priceE18: quote.price,
      validUntil: quote.validUntil,
      ttlSec: ttlAtResponseSec(quote.validUntil, respondedAtMs, serverSkewMs),
      nonce: quote.nonce,
      apy: quote.apy,
    },
    makerSigOk: answer.makerSigOk,
  };
}

/**
 * The quote's time left when it arrived, on the server clock (`serverSkewMs` is local minus server), in seconds to
 * the millisecond.
 */
function ttlAtResponseSec(validUntilSec: number, respondedAtMs: number, serverSkewMs: number): number {
  return (validUntilSec * 1000 - (respondedAtMs - serverSkewMs)) / 1000;
}

/**
 * `decisions` for a side that planned: gates, capital, basis, the planned candidates and the keys among them left
 * out as backed off, the quotes obtained and the result (with `detail` when the side held without evaluating).
 */
export function decisionRecord(
  tick: number,
  plan: SidePlan,
  quoted: QuotedCandidate[],
  decision: Decision,
  t: { st: WheelState; s: Snapshot; c: WheelConfig; backedOff: string[]; detail?: string | undefined },
): object {
  const { side } = plan;
  return {
    tick,
    side,
    nowSec: t.s.nowSec,
    gates: plan.gates,
    capital: t.st.capital[side],
    basis: t.st.basis,
    floor: { minApr: t.c[side].minApr },
    backedOff: t.backedOff,
    plan:
      plan.kind === 'hold'
        ? { kind: 'hold', reason: plan.reason, detail: plan.detail }
        : { kind: 'quote', prefilterBypassed: plan.prefilterBypassed, detail: plan.detail },
    candidates: plan.kind === 'quote' ? plan.candidates.map(candidateSummary) : [],
    excluded: plan.excluded,
    quotes: quoted.map(({ candidate, outcome }) =>
      outcome.ok
        ? { key: candidateKey(candidate), ok: true, priceE18: outcome.quote.price, gas: outcome.gas }
        : { key: candidateKey(candidate), ok: false, error: outcome.error },
    ),
    result:
      t.detail === undefined ? decisionSummary(decision) : { ...decisionSummary(decision), detail: t.detail },
  };
}

/** `decisions` for a side waiting for `replanDueSec`: the hold it repeats, no RFQs. */
export function replanRecord(
  tick: number,
  side: Side,
  nowSec: number,
  dueSec: number,
  held: Decision,
): object {
  return { tick, side, nowSec, replanDueSec: dueSec, result: decisionSummary(held) };
}

/** A decision's result: the trade's terms and prices, or the hold's reason and the best quote seen. */
export function decisionSummary(d: Decision): object {
  if (d.kind === 'hold') {
    const best =
      d.best === undefined ? {} : { best: { key: candidateKey(d.best.candidate), aprNet: d.best.aprNet } };
    return { kind: 'hold', reason: d.reason, ...best };
  }
  return {
    kind: 'trade',
    key: candidateKey(d.candidate),
    candidateMode: d.candidate.mode,
    quantityE18: d.candidate.quantityE18,
    priceE18: d.quote.price,
    gasFee6: d.gasFee6,
    aprNet: d.aprNet,
    aprRysk: d.aprRysk,
    minPriceE18: d.minPriceE18,
    maxGasFee6: d.maxGasFee6,
    lossIfExercisedUsd: d.lossIfExercisedUsd,
  };
}

/** The `executions` record's summary of what was executed. */
export function intentSummary(intent: TradeIntent): object {
  const { candidate, quote } = intent;
  return {
    side: intent.side,
    key: backoffKeyOf(candidate.side, candidate.strikeE8, candidate.expirySec),
    candidateMode: candidate.mode,
    quantityE18: candidate.quantityE18,
    collateralAmount: candidate.collateralAmount,
    maker: quote.maker,
    priceE18: quote.price,
    quoteNonce: quote.nonce,
    validUntil: quote.validUntil,
    minPriceE18: intent.minPriceE18,
    maxGasFee6: intent.maxGasFee6,
  };
}

function candidateSummary(c: Candidate): object {
  return {
    key: candidateKey(c),
    rank: c.rank,
    candidateMode: c.mode,
    quantityE18: c.quantityE18,
    collateralAmount: c.collateralAmount,
    indicativeApr: c.indicativeApr,
    delta: c.delta,
  };
}

/**
 * The gross premium; the APR on it before gas (`aprGross`) and after the previewed gas (`aprNet`, `null` without a
 * preview), each priced as `evaluate` prices it; and each APR over the listing's indicative one, when both are
 * positive. The gross ratio compares like with like (indicative APRs ignore gas) and survives a failed preview.
 */
function derived(candidate: Candidate, price: string, gas: Gas, s: Snapshot) {
  const gross = grossDerived(candidate, price, s.market.spotE8, s.nowSec);
  const aprNet =
    gross.premium6 !== null && gas.ok
      ? aprOf(gross.premium6 - gas.gasFee6, candidate, s.market.spotE8, s.nowSec)
      : null;
  return {
    premium6: gross.premium6,
    aprGross: gross.aprGross,
    aprNet,
    aprGrossOverIndicative: gross.aprGrossOverIndicative,
    aprNetOverIndicative: overIndicative(aprNet, candidate.indicativeApr),
  };
}

/** The gross premium of `price`, its APR at `nowSec` and that APR over the indicative one; `null`s for a bad price. */
function grossDerived(terms: Priced, price: string, spotE8: bigint | null, nowSec: number) {
  const priceE18 = uintOf(price);
  if (priceE18 === undefined) return { premium6: null, aprGross: null, aprGrossOverIndicative: null };
  const gross6 = premium6(terms.quantityE18, priceE18);
  const aprGross = aprOf(gross6, terms, spotE8, nowSec);
  return {
    premium6: gross6,
    aprGross,
    aprGrossOverIndicative: overIndicative(aprGross, terms.indicativeApr),
  };
}

function overIndicative(apr: number | null, indicative: number | null): number | null {
  return apr !== null && apr > 0 && indicative !== null && indicative > 0 ? apr / indicative : null;
}

/** `amount6`'s APR on the instrument's collateral; `null` when it cannot be priced (a call without spot, expired). */
function aprOf(amount6: bigint, terms: Priced, spotE8: bigint | null, nowSec: number): number | null {
  const { side, quantityE18, strikeE8, expirySec } = terms;
  try {
    // A call without spot has no collateral value, which `aprFraction` rejects.
    return aprFraction(amount6, collateral6For(side, quantityE18, strikeE8, spotE8 ?? 0n), nowSec, expirySec);
  } catch (error) {
    if (error instanceof UnitError) return null;
    throw error;
  }
}
