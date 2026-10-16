import { type Address, type Hex, hashTypedData, recoverTypedDataAddress } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { ADDRESSES, CHAIN_ID } from '../domain/constants.ts';
import { UINT } from '../domain/parse.ts';
import type { ConfirmBody, Quote } from '../domain/types.ts';

// Protocol doc §9. The domain is pinned here and never read from a server `typeDataDomain` (whose extra
// `salt: ""` is not part of the domain type). Makers sign quotes under the same domain.
export const EIP712_DOMAIN = {
  name: 'rysk',
  version: '0.0.0',
  chainId: CHAIN_ID,
  verifyingContract: ADDRESSES.rysk,
} as const;

/** The taker's trade confirmation, verbatim from the app bundle; field order is part of the type hash. */
export const CONFIRMATION_TYPES = {
  Confirmation: [
    { name: 'maker', type: 'address' },
    { name: 'assetAddress', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
    { name: 'isPut', type: 'bool' },
    { name: 'nonce', type: 'uint64' },
    { name: 'price', type: 'uint256' },
    { name: 'quantity', type: 'uint256' },
    { name: 'quoteNonce', type: 'uint64' },
    { name: 'quoteSignature', type: 'bytes' },
    { name: 'strike', type: 'uint256' },
    { name: 'taker', type: 'address' },
    { name: 'isTakerBuy', type: 'bool' },
    { name: 'usd', type: 'address' },
    { name: 'collateralAsset', type: 'address' },
    { name: 'collateralAmount', type: 'uint256' },
    { name: 'gasFee', type: 'uint256' },
  ],
} as const;

/** The maker's quote; it has no taker field. */
export const QUOTE_TYPES = {
  Quote: [
    { name: 'assetAddress', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'isPut', type: 'bool' },
    { name: 'strike', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
    { name: 'maker', type: 'address' },
    { name: 'nonce', type: 'uint64' },
    { name: 'price', type: 'uint256' },
    { name: 'quantity', type: 'uint256' },
    { name: 'isTakerBuy', type: 'bool' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'usd', type: 'address' },
    { name: 'collateralAsset', type: 'address' },
  ],
} as const;

/** The signed `Confirmation`; field names are the EIP-712 ones (`strike` is e8, `price`/`quantity` e18). */
export type ConfirmationMessage = {
  maker: Address;
  assetAddress: Address;
  chainId: bigint;
  expiry: bigint;
  isPut: boolean;
  nonce: bigint;
  price: bigint;
  quantity: bigint;
  quoteNonce: bigint;
  quoteSignature: Hex;
  strike: bigint;
  taker: Address;
  isTakerBuy: false;
  usd: Address;
  collateralAsset: Address;
  collateralAmount: bigint;
  /** 6-dp USD from `/api/gas`. */
  gasFee: bigint;
};

/** `BigInt` alone would accept `''` (as 0), `' 1'`, `'0x1'` and `'-1'`; only decimal uint strings pass here. */
function uint(value: string, what: string): bigint {
  if (!UINT.test(value)) throw new Error(`${what} '${value}' is not a decimal uint string`);
  return BigInt(value);
}

/**
 * The message to sign, built only from our own body (never from a server echo) plus the gas fee. Throws
 * when a numeric body field is not a decimal uint string.
 */
export function toConfirmationMessage(body: ConfirmBody, gasFee6: bigint): ConfirmationMessage {
  return {
    maker: body.maker,
    assetAddress: body.assetAddress,
    chainId: BigInt(body.chainId),
    expiry: BigInt(body.expiry),
    isPut: body.isPut,
    nonce: uint(body.nonce, 'confirm body nonce'),
    price: uint(body.price, 'confirm body price'),
    quantity: uint(body.quantity, 'confirm body quantity'),
    quoteNonce: uint(body.quoteNonce, 'confirm body quoteNonce'),
    quoteSignature: body.quoteSignature,
    strike: uint(body.strike, 'confirm body strike'),
    taker: body.taker,
    isTakerBuy: false,
    usd: body.usd,
    collateralAsset: body.collateralAsset,
    collateralAmount: uint(body.collateralAmount, 'confirm body collateralAmount'),
    gasFee: gasFee6,
  };
}

/** The EIP-712 digest `signConfirmation` signs, for logging. */
export function hashConfirmation(message: ConfirmationMessage): Hex {
  return hashTypedData({
    domain: EIP712_DOMAIN,
    types: CONFIRMATION_TYPES,
    primaryType: 'Confirmation',
    message,
  });
}

/** Signs under the pinned domain; viem local accounts already emit `v` as 27/28, as the app sends. */
export function signConfirmation(account: PrivateKeyAccount, message: ConfirmationMessage): Promise<Hex> {
  return account.signTypedData({
    domain: EIP712_DOMAIN,
    types: CONFIRMATION_TYPES,
    primaryType: 'Confirmation',
    message,
  });
}

/**
 * The EOA whose signature `quote.signature` is over the quote's fields. A maker that signs through a contract
 * (EIP-1271) recovers to some other address. Rejects on a malformed signature or numeric field.
 */
export async function recoverQuoteSigner(quote: Quote): Promise<Address> {
  return recoverTypedDataAddress({
    domain: EIP712_DOMAIN,
    types: QUOTE_TYPES,
    primaryType: 'Quote',
    message: {
      assetAddress: quote.assetAddress,
      chainId: BigInt(quote.chainId),
      isPut: quote.isPut,
      strike: uint(quote.strike, 'quote strike'),
      expiry: BigInt(quote.expiry),
      maker: quote.maker,
      nonce: uint(quote.nonce, 'quote nonce'),
      price: uint(quote.price, 'quote price'),
      quantity: uint(quote.quantity, 'quote quantity'),
      isTakerBuy: quote.isTakerBuy,
      validUntil: BigInt(quote.validUntil),
      usd: quote.usd,
      collateralAsset: quote.collateralAsset,
    },
    signature: quote.signature,
  });
}

/** Maps a 65-byte signature's trailing `v` of 0/1 to 27/28; any other signature is returned unchanged. */
export function normalizeV(sig: Hex): Hex {
  if (sig.length !== 132) return sig;
  const v = sig.slice(-2);
  if (v === '00') return `0x${sig.slice(2, -2)}1b`;
  if (v === '01') return `0x${sig.slice(2, -2)}1c`;
  return sig;
}
