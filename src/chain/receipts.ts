import {
  type Address,
  type DecodeEventLogReturnType,
  decodeEventLog,
  isAddressEqual,
  type Log,
  pad,
  type TransactionReceipt,
  toEventSelector,
} from 'viem';
import { ADDRESSES, TOKENS } from '../domain/index.ts';
import { shortOtokenMintedEventAbi, transferEventAbi, vaultOpenedEventAbi } from './abi.ts';

export type FillExpectation = {
  self: Address;
  collateralToken: Address;
  collateralAmount: bigint;
  premium6: bigint;
  gasFee6: bigint;
  counterBefore: bigint;
  quantityE18: bigint;
};

export type FillProblem =
  | 'reverted'
  | 'wrong-to'
  | 'collateral-transfer'
  | 'premium-transfer'
  | 'vault-opened'
  | 'short-minted'
  | 'extra-transfer-from-self';

export type FillVerification =
  | { ok: true; vaultId: bigint; premiumReceived6: bigint }
  | { ok: false; problems: FillProblem[] };

type Transfer = { log: Log; token: Address; from: Address; to: Address; value: bigint };
type VaultOpened = { emitter: Address; accountOwner: Address; vaultId: bigint };
type ShortMinted = { emitter: Address; accountOwner: Address; vaultId: bigint; amount: bigint };
type FillEvents = { transfers: Transfer[]; vaultsOpened: VaultOpened[]; shortsMinted: ShortMinted[] };

const FILL_EVENTS_ABI = [...transferEventAbi, ...vaultOpenedEventAbi, ...shortOtokenMintedEventAbi];
/** Shared by ERC-20 and ERC-721 `Transfer`: indexing does not change the selector. */
const TRANSFER_SELECTOR = toEventSelector(transferEventAbi[0]);
/** oTokens carry 8 decimals; quantities carry 18. */
const OTOKEN_SCALE = 10n ** 10n;
/** Rounding slack, in USDC units, between the quoted net premium and the transferred one. */
const PREMIUM_TOLERANCE6 = 1n;

/**
 * Checks a mined fill against what the seller signed (spec §5.4): the transaction went to Rysk, `self`
 * paid exactly the collateral into the MarginPool and nothing else, received the net premium in USDC,
 * opened vault `counterBefore + 1` (the vault store's event) and had the Gamma controller mint the matching
 * short into it. Every problem is collected,
 * except that a revert is reported alone. Logs that decode as none of the expected events are ignored, but
 * any log carrying the `Transfer` selector with `from == self` counts toward `extra-transfer-from-self`,
 * whatever its layout.
 */
export function verifyFillReceipt(receipt: TransactionReceipt, expected: FillExpectation): FillVerification {
  if (receipt.status !== 'success') return { ok: false, problems: ['reverted'] };
  const { self } = expected;
  const problems: FillProblem[] = [];
  const { transfers, vaultsOpened, shortsMinted } = decodeFillEvents(receipt.logs);

  if (receipt.to === null || !isAddressEqual(receipt.to, ADDRESSES.rysk)) problems.push('wrong-to');

  const collateralTransfers = transfers.filter(
    (t) =>
      isAddressEqual(t.token, expected.collateralToken) &&
      isAddressEqual(t.from, self) &&
      isAddressEqual(t.to, ADDRESSES.marginPool),
  );
  const collateral = only(collateralTransfers);
  if (collateral === undefined || collateral.value !== expected.collateralAmount) {
    problems.push('collateral-transfer');
  }

  const premium = only(
    transfers.filter(
      (t) =>
        isAddressEqual(t.token, TOKENS.USDC.address) &&
        isAddressEqual(t.from, ADDRESSES.mmarket) &&
        isAddressEqual(t.to, self),
    ),
  );
  const netPremium6 = expected.premium6 - expected.gasFee6;
  if (premium === undefined || abs(premium.value - netPremium6) > PREMIUM_TOLERANCE6) {
    problems.push('premium-transfer');
  }

  const vault = only(
    vaultsOpened.filter(
      (v) => isAddressEqual(v.emitter, ADDRESSES.vaultStore) && isAddressEqual(v.accountOwner, self),
    ),
  );
  if (vault === undefined || vault.vaultId !== expected.counterBefore + 1n) problems.push('vault-opened');

  const short = only(
    shortsMinted.filter(
      (s) => isAddressEqual(s.emitter, ADDRESSES.controller) && isAddressEqual(s.accountOwner, self),
    ),
  );
  // Without a single opened vault `vault-opened` already fails the fill, so only the amount is judged then.
  if (
    short === undefined ||
    short.amount !== expected.quantityE18 / OTOKEN_SCALE ||
    (vault !== undefined && short.vaultId !== vault.vaultId)
  ) {
    problems.push('short-minted');
  }

  // The collateral-shaped transfers are judged above; anything else leaving `self` is unexpected. Raw logs
  // are scanned so a `Transfer` that strict decoding rejects (an NFT, an indexed `value`) is still caught.
  const collateralLogs = new Set(collateralTransfers.map((t) => t.log));
  const extras = receipt.logs.filter((log) => isTransferFrom(log, self) && !collateralLogs.has(log));
  if (extras.length > 0) problems.push('extra-transfer-from-self');

  if (problems.length > 0 || premium === undefined || vault === undefined) return { ok: false, problems };
  return { ok: true, vaultId: vault.vaultId, premiumReceived6: premium.value };
}

function decodeFillEvents(logs: readonly Log[]): FillEvents {
  const events: FillEvents = { transfers: [], vaultsOpened: [], shortsMinted: [] };
  for (const log of logs) {
    let decoded: DecodeEventLogReturnType<typeof FILL_EVENTS_ABI>;
    try {
      decoded = decodeEventLog({ abi: FILL_EVENTS_ABI, data: log.data, topics: log.topics });
    } catch {
      continue; // another contract's event, or one whose layout differs from ours
    }
    switch (decoded.eventName) {
      case 'Transfer':
        events.transfers.push({ log, token: log.address, ...decoded.args });
        break;
      case 'VaultOpened':
        events.vaultsOpened.push({
          emitter: log.address,
          accountOwner: decoded.args.accountOwner,
          vaultId: decoded.args.vaultId,
        });
        break;
      case 'ShortOtokenMinted':
        events.shortsMinted.push({
          emitter: log.address,
          accountOwner: decoded.args.AccountOwner,
          vaultId: decoded.args.vaultId,
          amount: decoded.args.amount,
        });
        break;
    }
  }
  return events;
}

/** Matches on the raw topics, so it holds for any `Transfer` layout whose `from` is indexed first. */
function isTransferFrom(log: Log, address: Address): boolean {
  const [selector, from] = log.topics;
  return selector?.toLowerCase() === TRANSFER_SELECTOR && from?.toLowerCase() === pad(address).toLowerCase();
}

/** The single element, or `undefined` when there are none or several. */
function only<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}
