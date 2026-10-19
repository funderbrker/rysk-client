import type { Address, Hex, TransactionReceipt } from 'viem';
import type { ApproveDeps } from '../chain/erc20.ts';
import type { FillExpectation, FillVerification } from '../chain/receipts.ts';
import type { ConfirmBody, ConfirmParams, Product, Quote, QuoteRequest, Side } from '../domain/types.ts';
import type { ConfirmationMessage } from '../rysk/eip712.ts';
import type { GasResult } from '../rysk/rest.ts';
import type { ConfirmReply, QuoteResult } from '../rysk/taker.ts';
import type { ExecutionConfig } from './checks.ts';

// Execution never imports the strategy: these are structural copies of the strategy's types, which are
// assignable to them.

/** A strategy gate's hold reason (the strategy's `HoldReason` union). */
export type HoldReason = string;

/** The fields of the strategy's `Candidate` that execution reads. */
export type ExecutionCandidate = {
  side: Side;
  strikeE8: bigint;
  expirySec: number;
  quantityE18: bigint;
  collateralAmount: bigint;
  request: QuoteRequest;
  mode: 'normal' | 'basis-fallback' | 'basis-fallback-custom';
  product: Product;
};

/** The strategy's view of the side being traded, recomputed from a fresh snapshot just before signing. */
export type FreshState = {
  gateHold: HoldReason | null;
  trancheQuantityE18: bigint;
  basisE8: bigint | null;
  basisReliable: boolean;
  basisEligibleEmpty: boolean;
  freshFallbackStrikeE8: bigint | null;
  freeCollateral: bigint;
  spotE8: bigint;
  listedStrikesE8ForExpiry: bigint[];
  expiriesSec: number[];
  deploymentsLast24h: number;
  notionalLast24h6: bigint;
  nativeHypeE18: bigint;
  allowance: bigint;
  /** When this fresh snapshot was taken (local clock). */
  fetchedAtMs: number;
  /** When the inventory behind `listedStrikesE8ForExpiry` and `expiriesSec` was observed (local clock). */
  listingsAtMs: number;
  /** Contracts (18 dp) still under every applicable cap, the 0.95 soft margin already applied; `null` = no cap. */
  capHeadroomE18: bigint | null;
};

export type ExecutionEvent = { execId: string; step: string; detail: Record<string, unknown> };

/** One pre-sign checklist item (spec §7.2); `na` marks a check that does not apply, such as in dry-run. */
export type CheckResult = { id: string; pass: boolean; na?: boolean; detail?: string };

export type TradeIntent = {
  side: Side;
  candidate: ExecutionCandidate;
  quote: Quote;
  minPriceE18: bigint;
  maxGasFee6: bigint;
};

export type TradeDeps = {
  mode: 'live' | 'dry-run';
  /** Aborted on shutdown: checked before anything is read and right before `confirm`; later waits are abandoned. */
  signal: AbortSignal;
  /** The configured account: in live it must be the signer's address; in dry-run (no signer) it owns the allowance read. */
  walletAddress: Address;
  freshState(): Promise<FreshState>;
  quotes: {
    requestQuote(r: QuoteRequest, o: { timeoutMs: number; signal?: AbortSignal }): Promise<QuoteResult>;
  };
  rest: { gasFee(body: ConfirmBody): Promise<GasResult> };
  rpc: { confirm(p: ConfirmParams, o: { timeoutMs: number; onSent?: () => void }): Promise<ConfirmReply> };
  collateral: ApproveDeps & { vaultCounter(): Promise<bigint> };
  /** `null` in dry-run. */
  signer: { address: Address; signConfirmation(m: ConfirmationMessage): Promise<Hex> } | null;
  clock: { serverNowSec(): number; nowMs(): number };
  /** Write-ahead before confirm; a failed write aborts. */
  record(e: ExecutionEvent): void;
  /** The pre-sign checklist's configuration for the traded side. */
  checks: ExecutionConfig;
  /** `verifyFillReceipt`. */
  verifyReceipt(receipt: TransactionReceipt, expected: FillExpectation): FillVerification;
  /** Writes `data/STOP` with the reason (a fatal event). */
  writeStop(reason: string): void;
  /** The REQUOTE request (`quoting.rfqTimeoutMs`), the confirm reply (`safety.confirmTimeoutMs`), the fill receipt (120 s). */
  timeouts: { requoteMs: number; confirmMs: number; receiptMs: number };
  /** Quote nonces signed in this process; a nonce joins at SIGN. */
  usedQuoteNonces: Set<string>;
  /** Our last signed confirm nonce (epoch ms), updated at SIGN. */
  lastNonceMs: { value: number };
  /** The confirm was sent: the side's cooldown starts and `memo.lastConfirmSec[side]` is set. */
  onConfirmSent(side: Side, atSec: number): void;
  /** A sent confirm definitely did not fill (`confirm-rejected`, `reverted`): clears `memo.lastConfirmSec[side]`. */
  onConfirmCleared(side: Side): void;
  /** Read when the checklist runs (C1, C2). */
  guards: { stopFile(): boolean; lockHeld(): boolean; inFlightExcludingSelf(): boolean };
  /** `recoverQuoteSigner`, or `null` when recovery rejects. */
  recoverMaker(q: Quote): Promise<Address | null>;
};

/**
 * Every result after the confirm was sent carries `bookkeepingErrors`: bookkeeping (records, cooldown callbacks,
 * the STOP file) never changes such an outcome, so each failure is listed as `<operation>: <message>` (`[]` when
 * clean). `aborted('confirm-rejected')` is the one abort after the send: it carries the list too, and
 * `confirmSentAtSec` for the daemon's watch on the fill the reply denied.
 */
export type TradeResult =
  | {
      status: 'filled';
      txHash: Hex;
      approveTxHash?: Hex;
      quote: Quote;
      premium6: bigint;
      gasFee6: bigint;
      bookkeepingErrors: string[];
    }
  | { status: 'reverted'; txHash: Hex; approveTxHash?: Hex; bookkeepingErrors: string[] }
  | {
      status: 'unknown';
      reason:
        | 'confirm-timeout'
        | 'socket-closed'
        | 'receipt-timeout'
        | 'shutdown'
        | 'bad-result'
        | 'verify-failed';
      confirmSentAtSec: number;
      txHash?: Hex;
      approveTxHash?: Hex;
      bookkeepingErrors: string[];
    }
  | {
      status: 'aborted';
      stage:
        | 'precheck'
        | 'approve'
        | 'requote'
        | 'price-floor'
        | 'gas'
        | 'echo'
        | 'guard'
        | 'sign'
        | 'shutdown'
        | 'dry-run';
      message: string;
      checkId?: string;
      approveTxHash?: Hex;
      echoOk?: boolean;
      wouldApprove?: bigint;
    }
  | {
      status: 'aborted';
      stage: 'confirm-rejected';
      message: string;
      /** Server seconds when the confirm was sent. */
      confirmSentAtSec: number;
      approveTxHash?: Hex;
      bookkeepingErrors: string[];
    };
