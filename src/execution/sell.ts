import { randomUUID } from 'node:crypto';
import { type Address, type Hex, isAddress, isAddressEqual, type TransactionReceipt } from 'viem';
import { approveExact } from '../chain/erc20.ts';
import { ADDRESSES, TOKENS, TRADED_PRODUCTS } from '../domain/constants.ts';
import { uintOf } from '../domain/parse.ts';
import type { ConfirmBody, ConfirmParams, Quote } from '../domain/types.ts';
import { collateralForCall, collateralForPut, premium6 } from '../domain/units.ts';
import { type ConfirmationMessage, hashConfirmation, toConfirmationMessage } from '../rysk/eip712.ts';
import type { ConfirmReply } from '../rysk/taker.ts';
import { buildConfirmBody, buildConfirmParams } from './body.ts';
import { type CheckedConfirmBody, runPreSignChecks } from './checks.ts';
import { echoMismatches } from './echo.ts';
import type { TradeDeps, TradeIntent, TradeResult } from './types.ts';

type Aborted = Extract<TradeResult, { status: 'aborted' }>;
type UnknownReason = Extract<TradeResult, { status: 'unknown' }>['reason'];

/** A terminal result. Steps return one (never throw it) to end the run. */
class Exit {
  readonly result: TradeResult;

  constructor(result: TradeResult) {
    this.result = result;
  }
}

/** The confirm attempt. Once it exists nothing is an abort: the server may have the signed body. */
type Attempt = { atSec: number; sentAtSec: number | null };

/** One execution's state, shared by its steps. */
type Run = {
  readonly deps: TradeDeps;
  readonly intent: TradeIntent;
  readonly execId: string;
  /** Our address: the wallet, which PRECHECK pins to the signer in live. */
  readonly self: Address;
  readonly token: Address;
  /** The exact collateral the trade locks, in the token's own decimals. */
  readonly collateralAmount: bigint;
  approveTxHash?: Hex;
  /** The allowance APPROVE left (live): exactly `collateralAmount`. */
  allowanceAfterApprove?: bigint;
  /** Dry-run: what APPROVE would have approved (0 when the allowance is already exact). */
  wouldApprove?: bigint;
  attempt: Attempt | null;
  /** Bookkeeping failures after the send, as `<operation>: <message>`; every result from then on lists them. */
  readonly bookkeepingErrors: string[];
};

type Gas = { body: ConfirmBody; gasFee6: bigint; echoed: Record<string, unknown> };
type Signed = {
  body: CheckedConfirmBody;
  echoed: Record<string, unknown>;
  message: ConfirmationMessage;
  signature: Hex;
};
type Confirmed = { txHash: Hex; counterBefore: bigint; attempt: Attempt };

const SHUTDOWN = Symbol('shutdown');
const MODES: readonly string[] = ['live', 'dry-run'];
/**
 * REQUOTE replaces a quote with less than `minQuoteTtlSec` plus this many seconds left, so that the quote still
 * clears C6's `minQuoteTtlSec` after the gas POST and the second fresh state that follow the requote.
 */
export const REQUOTE_MARGIN_SEC = 10;

/**
 * Sells `intent` (spec §7.1): PRECHECK → APPROVE → REQUOTE → GAS → CHECKS → [dry-run returns here] → SIGN →
 * CONFIRM → RECEIPT → CHAIN_VERIFIED. The only code path that signs. Every step is recorded under one
 * execution id. Never rejects: a failure before the confirm is sent is `aborted` at its stage; after it, the
 * outcome is `reverted`, `filled` or `unknown`, and `confirm` is never retried.
 */
export async function sellOption(deps: TradeDeps, intent: TradeIntent): Promise<TradeResult> {
  const run: Run = {
    deps,
    intent,
    execId: randomUUID(),
    self: deps.walletAddress,
    token: intent.candidate.product.collateralAsset,
    collateralAmount: intent.candidate.collateralAmount,
    attempt: null,
    bookkeepingErrors: [],
  };
  const prechecked = await beforeSend(run, 'precheck', () => precheck(run));
  if (prechecked instanceof Exit) return prechecked.result;
  const approved = await beforeSend(run, 'approve', () => approve(run));
  if (approved instanceof Exit) return approved.result;
  const quote = await beforeSend(run, 'requote', () => requote(run));
  if (quote instanceof Exit) return quote.result;
  const gas = await beforeSend(run, 'gas', () => quoteGas(run, quote));
  if (gas instanceof Exit) return gas.result;
  const checked = await beforeSend(run, 'guard', () => check(run, quote, gas));
  if (checked instanceof Exit) return checked.result;
  const signed = await beforeSend(run, 'sign', () => sign(run, checked));
  if (signed instanceof Exit) return signed.result;
  const confirmed = await confirm(run, signed);
  if (confirmed instanceof Exit) return confirmed.result;
  const receipt = await awaitReceipt(run, confirmed);
  if (receipt instanceof Exit) return receipt.result;
  return verify(run, quote, signed, confirmed, receipt);
}

/** Runs a step before the confirm is sent: any error is a true abort at `stage`, since nothing was sent. */
async function beforeSend<T>(
  run: Run,
  stage: Aborted['stage'],
  step: () => Promise<T | Exit>,
): Promise<T | Exit> {
  try {
    return await step();
  } catch (error) {
    return abort(run, stage, messageOf(error));
  }
}

/**
 * PRECHECK (C1–C2, before the approve transaction): a known mode (anything but `live` or `dry-run` fails closed);
 * not shutting down; in live, signing as the wallet with no STOP file and the lock held; a candidate whose strike,
 * expiry and quantity are its request's, which names the wallet as the taker; the side's pinned collateral in
 * exactly the amount the request requires; and a fresh state that holds no gate and still sizes the intent's
 * tranche.
 */
async function precheck(run: Run): Promise<Exit | undefined> {
  const { deps, intent } = run;
  const mode: unknown = deps.mode;
  if (typeof mode !== 'string' || !MODES.includes(mode)) {
    return abort(run, 'precheck', `unknown mode '${messageOf(mode)}'`);
  }
  if (deps.signal.aborted) return abort(run, 'precheck', 'shutdown');
  if (deps.mode === 'live' && (deps.signer === null || !isAddressEqual(deps.signer.address, run.self))) {
    return abort(
      run,
      'precheck',
      `signer ${deps.signer?.address ?? 'missing'} is not the wallet ${run.self}`,
    );
  }
  if (deps.mode === 'live' && deps.guards.stopFile()) return abort(run, 'precheck', 'data/STOP is present');
  if (deps.mode === 'live' && !deps.guards.lockHeld()) return abort(run, 'precheck', 'live lock not held');
  if (intent.candidate.side !== intent.side) {
    return abort(
      run,
      'precheck',
      `candidate side ${intent.candidate.side} differs from the intent's ${intent.side}`,
    );
  }
  const differs = requestMismatches(run);
  if (differs.length > 0) {
    return abort(run, 'precheck', `candidate differs from its request: ${differs.join(', ')}`);
  }
  const pinned = TRADED_PRODUCTS[intent.side].collateralAsset;
  if (!isAddressEqual(run.token, pinned)) {
    return abort(run, 'precheck', `collateral ${run.token} is not the ${intent.side} collateral ${pinned}`);
  }
  const required = requiredCollateral(intent);
  if (run.collateralAmount !== required) {
    return abort(
      run,
      'precheck',
      `collateral amount ${run.collateralAmount} is not the required ${required}`,
    );
  }
  const fresh = await deps.freshState();
  const intended = intent.candidate.quantityE18;
  record(run, 'precheck', {
    gateHold: fresh.gateHold,
    trancheQuantityE18: fresh.trancheQuantityE18,
    intentQuantityE18: intended,
  });
  if (fresh.gateHold !== null) return abort(run, 'precheck', `gate holds: ${fresh.gateHold}`);
  if (fresh.trancheQuantityE18 !== intended) {
    return abort(
      run,
      'precheck',
      `fresh tranche ${fresh.trancheQuantityE18} differs from the intent's ${intended}`,
    );
  }
  return undefined;
}

/**
 * Where the candidate departs from the request it quoted: the strike and quantity (wire strings, parsed strictly),
 * the expiry, and a taker other than the wallet. The checklist reads both, so they must agree.
 */
function requestMismatches(run: Run): string[] {
  const { candidate } = run.intent;
  const { request } = candidate;
  const differs: string[] = [];
  if (uintOf(request.strike) !== candidate.strikeE8) differs.push('strike');
  if (request.expiry !== candidate.expirySec) differs.push('expiry');
  if (uintOf(request.quantity) !== candidate.quantityE18) differs.push('quantity');
  const taker: unknown = request.taker;
  const ours =
    typeof taker === 'string' && isAddress(taker, { strict: false }) && isAddressEqual(taker, run.self);
  if (!ours) differs.push('taker');
  return differs;
}

/** What the request's strike and quantity lock: C13's computation, which the quoted body must match. */
function requiredCollateral(intent: TradeIntent): bigint {
  const { quantity, strike } = intent.candidate.request;
  const quantityE18 = uintOf(quantity);
  const strikeE8 = uintOf(strike);
  if (quantityE18 === undefined || strikeE8 === undefined) {
    throw new Error(`request quantity '${quantity}' or strike '${strike}' is not a decimal uint string`);
  }
  return intent.side === 'put'
    ? collateralForPut(quantityE18, strikeE8)
    : collateralForCall(quantityE18, TOKENS.WHYPE.decimals);
}

/**
 * APPROVE: exactly `collateralAmount` for the MarginPool whenever the allowance differs, before the executable
 * quote so mining does not spend its TTL. Dry-run only reads the allowance.
 */
async function approve(run: Run): Promise<Exit | undefined> {
  const { deps, token, self, collateralAmount: amount } = run;
  const spender = ADDRESSES.marginPool;
  if (deps.mode === 'dry-run') {
    const allowance = await deps.collateral.allowance(token, self, spender);
    run.wouldApprove = allowance === amount ? 0n : amount;
    record(run, 'approve', { token, amount, allowance, wouldApprove: run.wouldApprove });
    return undefined;
  }
  const approval = await approveExact(deps.collateral, { token, owner: self, spender, amount });
  if (approval.status === 'approved' || approval.status === 'stuck') run.approveTxHash = approval.hash;
  record(run, 'approve', { token, amount, status: approval.status, txHash: run.approveTxHash });
  switch (approval.status) {
    case 'skipped':
    case 'approved':
      run.allowanceAfterApprove = amount;
      return undefined;
    case 'tx-pending':
      return abort(run, 'approve', 'a transaction from the wallet is pending');
    case 'stuck': {
      const cause = approval.cause === undefined ? '' : `: ${messageOf(approval.cause)}`;
      return abort(run, 'approve', `approve ${approval.hash} did not confirm the allowance${cause}`);
    }
  }
}

/**
 * REQUOTE: a quote with less than `minQuoteTtlSec + REQUOTE_MARGIN_SEC` left is replaced by one fresh quote for
 * the same request with us as the taker; the quote held here is the only one ever signed. Below `minPriceE18` it
 * aborts.
 */
async function requote(run: Run): Promise<Quote | Exit> {
  const { deps, intent } = run;
  const ttlSec = intent.quote.validUntil - deps.clock.serverNowSec();
  let quote = intent.quote;
  if (ttlSec < deps.checks.minQuoteTtlSec + REQUOTE_MARGIN_SEC) {
    const request = { ...intent.candidate.request, taker: run.self };
    const result = await deps.quotes.requestQuote(request, {
      timeoutMs: deps.timeouts.requoteMs,
      signal: deps.signal,
    });
    if (!result.ok) {
      record(run, 'requote', { ttlSec, requoted: true, error: result.error, message: result.message });
      return abort(run, 'requote', `re-quote failed (${result.error}): ${result.message}`);
    }
    record(run, 'requote', { ttlSec, requoted: true, quote: result.quote });
    quote = result.quote;
  } else {
    record(run, 'requote', { ttlSec, requoted: false });
  }
  const priceE18 = uintOf(quote.price);
  if (priceE18 === undefined || priceE18 < intent.minPriceE18) {
    return abort(run, 'price-floor', `price ${quote.price} below the floor ${intent.minPriceE18}`);
  }
  return quote;
}

/**
 * GAS: our full confirm body (spec §7.3) through `/api/gas`. Its `gasFee6` is the only gas fee used; an echo
 * that departs from the body aborts, and in live writes STOP.
 */
async function quoteGas(run: Run, quote: Quote): Promise<Gas | Exit> {
  const { deps } = run;
  const nonceMs = Math.max(Math.floor(deps.clock.nowMs()), deps.lastNonceMs.value + 1);
  const body = buildConfirmBody({ quote, taker: run.self, collateralAmount: run.collateralAmount, nonceMs });
  const gas = await deps.rest.gasFee(body);
  if (!gas.ok) {
    record(run, 'gas', { ok: false, reason: gas.reason, status: gas.status, message: gas.message });
    return abort(run, 'gas', `gas ${gas.reason} (HTTP ${gas.status}): ${gas.message}`);
  }
  const mismatches = echoMismatches(body, gas.echoed);
  record(run, 'gas', { ok: true, gasFee6: gas.gasFee6, echoed: gas.echoed, mismatches });
  if (mismatches.length > 0) {
    const reason = `gas echo mismatch: ${mismatches.join(', ')}`;
    const failures = deps.mode === 'live' ? stop(run, reason) : [];
    return abort(run, 'echo', [reason, ...failures].join('; '), { echoOk: false });
  }
  return { body, gasFee6: gas.gasFee6, echoed: gas.echoed };
}

/**
 * CHECKS: the pre-sign checklist (spec §7.2) on a second fresh state taken right before it. Dry-run ends here,
 * having exercised the body, the gas echo and every guard.
 */
async function check(run: Run, quote: Quote, gas: Gas): Promise<(Gas & { body: CheckedConfirmBody }) | Exit> {
  const { deps, intent } = run;
  const recoveredMaker = await deps.recoverMaker(quote).catch(() => null);
  const fresh = await deps.freshState();
  const result = runPreSignChecks({
    mode: deps.mode,
    intent,
    freshQuote: quote,
    body: gas.body,
    echoed: gas.echoed,
    gasFee6: gas.gasFee6,
    fresh,
    config: deps.checks,
    serverNowSec: deps.clock.serverNowSec(),
    nowMs: deps.clock.nowMs(),
    signerAddress: deps.signer?.address ?? null,
    usedQuoteNonces: deps.usedQuoteNonces,
    lastNonceMs: deps.lastNonceMs.value,
    stopFile: deps.guards.stopFile(),
    lockHeld: deps.guards.lockHeld(),
    inFlightExcludingSelf: deps.guards.inFlightExcludingSelf(),
    recoveredMaker,
  });
  record(run, 'checks', { ok: result.ok, results: result.results });
  if (!result.ok) {
    const { id, detail } = result.failed;
    return abort(run, 'guard', detail ?? `${id} failed`, { checkId: id });
  }
  if (deps.mode === 'dry-run') {
    // A mismatched echo already aborted at GAS.
    const message = 'dry-run: every check passed';
    return new Exit({
      status: 'aborted',
      stage: 'dry-run',
      message,
      echoOk: true,
      wouldApprove: run.wouldApprove,
    });
  }
  if (result.body === null) throw new Error('the checklist returned no body in live mode');
  return { ...gas, body: result.body, gasFee6: result.gasFee6 };
}

/**
 * SIGN: the message from the checked body and the checklist's gas fee. The quote nonce is spent and the
 * `trade-intent` written ahead before the signer is called.
 */
async function sign(run: Run, checked: Gas & { body: CheckedConfirmBody }): Promise<Signed> {
  const { deps } = run;
  if (deps.signer === null) throw new Error('no signer in live mode');
  const message = toConfirmationMessage(checked.body, checked.gasFee6);
  const typedDataHash = hashConfirmation(message);
  deps.usedQuoteNonces.add(checked.body.quoteNonce);
  deps.lastNonceMs.value = Number(message.nonce);
  record(run, 'trade-intent', {
    side: run.intent.side,
    typedDataHash,
    nonce: checked.body.nonce,
    gasFee6: message.gasFee,
    body: checked.body,
  });
  const signature = await deps.signer.signConfirmation(message);
  return { body: checked.body, echoed: checked.echoed, message, signature };
}

/**
 * CONFIRM: the vault counter is read, the signal checked, then the signed body sent once, never retried. The
 * side's cooldown starts when the frame is sent. Only a JSON-RPC error with a real code is a rejection; any
 * other failure to get a hash is `unknown`.
 */
async function confirm(run: Run, signed: Signed): Promise<Confirmed | Exit> {
  const { deps } = run;
  const prepared = await beforeSend(run, 'sign', async () => {
    const params = buildConfirmParams(signed.body, signed.echoed, signed.message.gasFee, signed.signature);
    const counterBefore = await deps.collateral.vaultCounter();
    return { params, counterBefore, atSec: deps.clock.serverNowSec() };
  });
  if (prepared instanceof Exit) return prepared;
  if (deps.signal.aborted) return abort(run, 'shutdown', 'shutdown before confirm');
  const attempt: Attempt = { atSec: prepared.atSec, sentAtSec: null };
  run.attempt = attempt;
  const reply = await send(run, attempt, prepared.params);
  if (reply instanceof Exit) return reply;
  if (reply === SHUTDOWN) {
    record(run, 'confirm-reply', { kind: 'abandoned' });
    return unknown(run, attempt, 'shutdown');
  }
  // A reply from the server, or a frame the socket reports written, proves the send even had `onSent` not fired.
  if (reply.kind !== 'no-reply' || reply.sent) markSent(run, attempt, attempt.atSec);
  record(run, 'confirm-reply', { ...reply });
  switch (reply.kind) {
    case 'hash':
      return { txHash: reply.txHash, counterBefore: prepared.counterBefore, attempt };
    case 'rejected':
      // Code 0 is no JSON-RPC error code: a malformed error frame proves nothing about the confirm.
      if (reply.code === 0) return unknown(run, attempt, 'bad-result');
      bookkeep(run, 'onConfirmCleared', () => deps.onConfirmCleared(run.intent.side));
      return abort(run, 'confirm-rejected', `confirm rejected (${reply.code}): ${reply.message}`);
    case 'bad-result':
      return unknown(run, attempt, 'bad-result');
    case 'no-reply':
      return unknown(run, attempt, reply.reason === 'timeout' ? 'confirm-timeout' : 'socket-closed');
  }
}

/** The one `confirm` call; a throw is `unknown` (the frame may have been sent). */
async function send(
  run: Run,
  attempt: Attempt,
  params: ConfirmParams,
): Promise<ConfirmReply | typeof SHUTDOWN | Exit> {
  const { deps } = run;
  try {
    const onSent = (): void => markSent(run, attempt, deps.clock.serverNowSec());
    return await untilShutdown(
      deps.rpc.confirm(params, { timeoutMs: deps.timeouts.confirmMs, onSent }),
      deps.signal,
    );
  } catch (error) {
    markSent(run, attempt, attempt.atSec);
    record(run, 'confirm-reply', { kind: 'error', message: messageOf(error) });
    return unknown(run, attempt, 'bad-result');
  }
}

/** Starts the side's cooldown once, when the confirm frame is sent. */
function markSent(run: Run, attempt: Attempt, atSec: number): void {
  if (attempt.sentAtSec !== null) return;
  attempt.sentAtSec = atSec;
  bookkeep(run, 'onConfirmSent', () => run.deps.onConfirmSent(run.intent.side, atSec));
  record(run, 'confirm-sent', { sentAtSec: atSec });
}

/** RECEIPT: up to `timeouts.receiptMs`. A revert is definitive (collateral unmoved); no receipt is `unknown`. */
async function awaitReceipt(run: Run, confirmed: Confirmed): Promise<TransactionReceipt | Exit> {
  const { deps } = run;
  const { txHash, attempt } = confirmed;
  let receipt: TransactionReceipt | null | typeof SHUTDOWN;
  try {
    receipt = await untilShutdown(
      deps.collateral.waitForReceipt(txHash, deps.timeouts.receiptMs),
      deps.signal,
    );
  } catch (error) {
    record(run, 'receipt', { txHash, error: messageOf(error) });
    return unknown(run, attempt, 'receipt-timeout', txHash);
  }
  if (receipt === SHUTDOWN) {
    record(run, 'receipt', { txHash, status: 'abandoned' });
    return unknown(run, attempt, 'shutdown', txHash);
  }
  if (receipt === null) {
    record(run, 'receipt', { txHash, status: 'timeout' });
    return unknown(run, attempt, 'receipt-timeout', txHash);
  }
  const { status, blockNumber, gasUsed } = receipt;
  record(run, 'receipt', { txHash, status, blockNumber, gasUsed });
  if (status === 'reverted') {
    bookkeep(run, 'onConfirmCleared', () => deps.onConfirmCleared(run.intent.side));
    return new Exit({ status: 'reverted', txHash, ...approveHashOf(run), ...bookkeepingOf(run) });
  }
  return receipt;
}

/**
 * Verifies the mined fill against what we signed (spec §5.4), then CHAIN_VERIFIED: the vault counter moved by
 * one and the allowance APPROVE left decreased by the collateral. Any mismatch, or a failed read, writes STOP.
 */
async function verify(
  run: Run,
  quote: Quote,
  signed: Signed,
  confirmed: Confirmed,
  receipt: TransactionReceipt,
): Promise<TradeResult> {
  const { deps, self, token, collateralAmount } = run;
  const { txHash, counterBefore, attempt } = confirmed;
  const failed = (reason: string): TradeResult => {
    stop(run, reason);
    return unknown(run, attempt, 'verify-failed', txHash).result;
  };
  try {
    const { quantity: quantityE18, price: priceE18, gasFee: gasFee6 } = signed.message;
    const gross6 = premium6(quantityE18, priceE18);
    const fill = deps.verifyReceipt(receipt, {
      self,
      collateralToken: token,
      collateralAmount,
      premium6: gross6,
      gasFee6,
      counterBefore,
      quantityE18,
    });
    if (!fill.ok) return failed(`fill verification failed: ${fill.problems.join(', ')}`);
    const expectedNet6 = gross6 - gasFee6;
    if (fill.premiumReceived6 < expectedNet6) {
      record(run, 'premium-shortfall', { txHash, premiumReceived6: fill.premiumReceived6, expectedNet6 });
    }

    const counterAfter = await deps.collateral.vaultCounter();
    const allowanceAfter = await deps.collateral.allowance(token, self, ADDRESSES.marginPool);
    if (counterAfter !== counterBefore + 1n) {
      return failed(`vault counter ${counterAfter} after the fill, expected ${counterBefore + 1n}`);
    }
    const allowanceBefore = run.allowanceAfterApprove;
    if (allowanceBefore === undefined || allowanceBefore - allowanceAfter !== collateralAmount) {
      return failed(
        `allowance ${allowanceAfter} after the fill did not decrease by ${collateralAmount} from ${allowanceBefore}`,
      );
    }
    record(run, 'verified', {
      txHash,
      vaultId: fill.vaultId,
      premiumReceived6: fill.premiumReceived6,
      counterBefore,
      counterAfter,
      allowanceAfter,
    });
    return {
      status: 'filled',
      txHash,
      ...approveHashOf(run),
      quote,
      premium6: gross6,
      gasFee6,
      ...bookkeepingOf(run),
    };
  } catch (error) {
    return failed(`fill verification failed: ${messageOf(error)}`);
  }
}

/** Settles with `promise`, or with `SHUTDOWN` once `signal` aborts (waits after the confirm may be abandoned). */
function untilShutdown<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof SHUTDOWN> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(SHUTDOWN);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Runs one bookkeeping write; its failure as `<operation>: <message>`, or `null`. */
function tryWrite(operation: string, write: () => void): string | null {
  try {
    write();
    return null;
  } catch (error) {
    return `${operation}: ${messageOf(error)}`;
  }
}

/**
 * Bookkeeping (records, cooldown callbacks). Before the confirm is sent a failure aborts the run, so a failed
 * write-ahead stops the trade. After it the outcome outranks its bookkeeping: a failure never changes the
 * result, and is listed in the result's `bookkeepingErrors`.
 */
function bookkeep(run: Run, operation: string, write: () => void): void {
  if (run.attempt === null) {
    write();
    return;
  }
  const failure = tryWrite(operation, write);
  if (failure !== null) run.bookkeepingErrors.push(failure);
}

function record(run: Run, step: string, detail: Record<string, unknown>): void {
  bookkeep(run, `record(${step})`, () => run.deps.record({ execId: run.execId, step, detail }));
}

/**
 * Writes `data/STOP` (a fatal event) and records why. Never throws, so a STOP that cannot be written never hides
 * the event that called for it: the failures are returned and, after the send, listed in the result.
 */
function stop(run: Run, reason: string): string[] {
  const failures = [
    tryWrite('writeStop', () => run.deps.writeStop(reason)),
    tryWrite('record(stop)', () => run.deps.record({ execId: run.execId, step: 'stop', detail: { reason } })),
  ].filter((failure) => failure !== null);
  if (run.attempt !== null) run.bookkeepingErrors.push(...failures);
  return failures;
}

/** The result field every outcome after the send carries. */
function bookkeepingOf(run: Run): { bookkeepingErrors: string[] } {
  return { bookkeepingErrors: [...run.bookkeepingErrors] };
}

function approveHashOf(run: Run): { approveTxHash?: Hex } {
  return run.approveTxHash === undefined ? {} : { approveTxHash: run.approveTxHash };
}

function abort(
  run: Run,
  stage: Aborted['stage'],
  message: string,
  extra: Pick<Aborted, 'checkId' | 'echoOk'> = {},
): Exit {
  const afterSend = run.attempt === null ? {} : bookkeepingOf(run);
  return new Exit({ status: 'aborted', stage, message, ...extra, ...approveHashOf(run), ...afterSend });
}

function unknown(run: Run, attempt: Attempt, reason: UnknownReason, txHash?: Hex): Exit {
  return new Exit({
    status: 'unknown',
    reason,
    confirmSentAtSec: attempt.sentAtSec ?? attempt.atSec,
    ...(txHash === undefined ? {} : { txHash }),
    ...approveHashOf(run),
    ...bookkeepingOf(run),
  });
}

/**
 * An error's message for a record or a result. Never throws, so it is safe inside every `catch`: a value whose
 * conversion to a string throws (an object without a prototype, a throwing getter) reads as a placeholder.
 */
function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return 'unprintable error';
  }
}
