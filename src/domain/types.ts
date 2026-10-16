import type { Address, Hex } from 'viem';

export type Side = 'put' | 'call';
export type Product = { underlying: Address; strikeAsset: Address; collateralAsset: Address; isPut: boolean };
export type Listing = {
  strikeE8: bigint;
  expirySec: number;
  isPut: boolean;
  delta: number;
  indicativeApr: number /* fraction */;
  indexUsd: number;
  products: Product[];
  observedAtSec: number;
};
export type Asset = {
  symbol: string;
  address: Address;
  underlying: Address;
  decimals: number;
  minTradeSizeE18: bigint;
  maxTradeSizeE18: bigint;
  active: boolean;
  priceE18: bigint;
  strikePrecisionE8: bigint;
  marketOpen: boolean;
};
export type Cap = { name: string; type: 'CONTRACTS' | 'NOTIONAL'; capE18: bigint; usageE18: bigint };
export type QuoteRequest = {
  asset: Address;
  assetName: string;
  chainId: 999;
  expiry: number;
  isPut: boolean;
  quantity: string;
  strike: string;
  taker: Address;
  usd: Address;
  collateralAsset: Address;
  isEIP1271: false;
};
export type Quote = {
  assetAddress: Address;
  chainId: number;
  expiry: number;
  isPut: boolean;
  isTakerBuy: boolean;
  quantity: string;
  strike: string;
  maker: Address;
  nonce: string;
  price: string;
  validUntil: number;
  signature: Hex;
  usd: Address;
  collateralAsset: Address;
  apy: number;
};
export type ConfirmBody = {
  assetAddress: Address;
  chainId: 999;
  expiry: number;
  isPut: boolean;
  isTakerBuy: false;
  maker: Address;
  price: string;
  quantity: string;
  quoteNonce: string;
  quoteSignature: Hex;
  quoteValidUntil: number;
  validUntil: number;
  strike: string;
  taker: Address;
  usd: Address;
  collateralAsset: Address;
  collateralAmount: string;
  nonce: string;
};
export type Settlement =
  | { outcome: 'expiredOtm'; collateralReturned: bigint }
  | { outcome: 'assigned'; receivedUnderlyingE18: bigint }
  | { outcome: 'exercised'; receivedStable6: bigint }
  | { outcome: 'anomaly'; detail: string };
export type Position = {
  key: string;
  underlying: Address;
  chainId: number;
  isPut: boolean;
  strikeE8: bigint;
  quantityE18: bigint;
  priceE18: bigint;
  premium6: bigint;
  usd: Address;
  collateral: Address;
  /** Rysk asset-entry symbol: the collateral token's symbol for calls (e.g. kHYPE), WHYPE for puts. */
  assetSymbol: string;
  createdAtSec: number;
  expirySec: number;
  txHash: Hex;
  status: 'open' | 'settled' | 'unknown';
  settlement: Settlement | null;
};
export type Fill = {
  txHash: Hex;
  chainId: number;
  underlying: Address;
  symbol: string;
  isPut: boolean;
  strikeE8: bigint;
  expirySec: number;
  quantityE18: bigint;
  priceE18: bigint;
  premium6: bigint;
  aprRysk: number;
  usd: Address;
  collateral: Address;
  makerFee6: bigint;
  createdAtSec: number;
};

/** The app's 9-field gas preview body (spec §7.4); the full `ConfirmBody` is used only when selling. */
export type GasPreviewBody = {
  assetAddress: Address;
  chainId: 999;
  isPut: boolean;
  collateralAsset: Address;
  expiry: number;
  strike: string;
  usd: Address;
  price: string;
  quantity: string;
};
/** JSON-RPC `confirm` params: our signed body plus the allowlisted echoed extras and our signature. */
export type ConfirmParams = ConfirmBody & {
  gasFee: string;
  isEIP1271: false;
  signature: Hex;
} & Record<string, unknown>;
