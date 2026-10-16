import { type Address, getAddress, isAddress, isAddressEqual, zeroAddress } from 'viem';
import type { Product } from './types.ts';

// Only HyperEVM is encoded. Addresses are checksummed once here so internal `===` comparisons are safe;
// wire data is compared with `isAddressEqual`.
export const CHAIN_ID = 999 as const;

export const ZERO_ADDRESS: Address = zeroAddress;

export const ADDRESSES: {
  rysk: Address;
  marginPool: Address;
  mmarket: Address;
  vaultStore: Address;
  multicall3: Address;
} = {
  rysk: getAddress('0x8C8bcb6D2c0E31c5789253EcC8431cA6209B4E35'),
  marginPool: getAddress('0x24a44f1dc25540c62c1196FfC297dFC951C91aB4'),
  mmarket: getAddress('0x691a5fc3a81a144e36c6C4fBCa1fC82843c80d0d'),
  vaultStore: getAddress('0x84d84e481b49b8bc5a55f17aaf8181c21a29b212'),
  multicall3: getAddress('0xcA11bde05977b3631167028862bE2a173976CA11'),
};

export type TokenInfo = { address: Address; symbol: string; decimals: number };
export type TokenKey = 'USDC' | 'USDT0' | 'USDH' | 'WHYPE' | 'KHYPE' | 'WSTHYPE' | 'LHYPE';

function token(address: string, symbol: string, decimals: number): TokenInfo {
  return { address: getAddress(address), symbol, decimals };
}

export const TOKENS: Record<TokenKey, TokenInfo> = {
  USDC: token('0xb88339CB7199b77E23DB6E890353E22632Ba630f', 'USDC', 6),
  USDT0: token('0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', 'USDT0', 6),
  USDH: token('0x111111a1a0667d36bd57c0a9f569b98057111111', 'USDH', 6),
  WHYPE: token('0x5555555555555555555555555555555555555555', 'WHYPE', 18),
  KHYPE: token('0xfD739d4e423301CE9385c1fb8850539D657C296D', 'kHYPE', 18),
  WSTHYPE: token('0x94e8396e0869c9f2200760af0621afd240e1cf38', 'wstHYPE', 18),
  LHYPE: token('0x5748ae796ae46a4f1348a1693de4b50560485562', 'LHYPE', 18),
};

export const TRADED_PRODUCTS: { put: Product; call: Product } = {
  put: {
    underlying: TOKENS.WHYPE.address,
    strikeAsset: TOKENS.USDC.address,
    collateralAsset: TOKENS.USDC.address,
    isPut: true,
  },
  call: {
    underlying: TOKENS.WHYPE.address,
    strikeAsset: TOKENS.USDC.address,
    collateralAsset: TOKENS.WHYPE.address,
    isPut: false,
  },
};

export const SAMPLED_PUT_STABLES: Address[] = [TOKENS.USDC.address, TOKENS.USDT0.address];
export const SAMPLED_CALL_COLLATERALS: Address[] = [
  TOKENS.WHYPE.address,
  TOKENS.KHYPE.address,
  TOKENS.LHYPE.address,
  TOKENS.WSTHYPE.address,
];

/** $0.01 in 8-decimal strike units; used when an asset does not report its own strike precision. */
export const DEFAULT_STRIKE_PRECISION_E8 = 1_000_000n;

/** Case-insensitive lookup by symbol (`'usdc'`, `'kHYPE'`); throws for a token this client does not know. */
export function tokenBySymbol(symbol: string): TokenInfo {
  const found = Object.values(TOKENS).find((info) => info.symbol.toUpperCase() === symbol.toUpperCase());
  if (found === undefined) throw new Error(`unknown token symbol '${symbol}'`);
  return found;
}

/** Lookup by address in any casing; `undefined` for an unknown or malformed address. */
export function tokenByAddress(address: string): TokenInfo | undefined {
  if (!isAddress(address, { strict: false })) return undefined;
  return Object.values(TOKENS).find((info) => isAddressEqual(info.address, address));
}
