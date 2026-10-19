import { type Address, getAddress, isAddressEqual } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ADDRESSES,
  SAMPLED_CALL_COLLATERALS,
  SAMPLED_PUT_STABLES,
  TOKENS,
  TRADED_PRODUCTS,
  tokenByAddress,
  tokenBySymbol,
} from './constants.ts';

const PINNED: { name: string; actual: Address; expected: Address }[] = [
  { name: 'rysk', actual: ADDRESSES.rysk, expected: '0x8c8bcb6d2c0e31c5789253ecc8431ca6209b4e35' },
  {
    name: 'marginPool',
    actual: ADDRESSES.marginPool,
    expected: '0x24a44f1dc25540c62c1196ffc297dfc951c91ab4',
  },
  { name: 'mmarket', actual: ADDRESSES.mmarket, expected: '0x691a5fc3a81a144e36c6c4fbca1fc82843c80d0d' },
  {
    name: 'vaultStore',
    actual: ADDRESSES.vaultStore,
    expected: '0x84d84e481b49b8bc5a55f17aaf8181c21a29b212',
  },
  {
    name: 'controller',
    actual: ADDRESSES.controller,
    expected: '0x577b846a95711015769452f7f29d8054cf087964',
  },
  {
    name: 'multicall3',
    actual: ADDRESSES.multicall3,
    expected: '0xca11bde05977b3631167028862be2a173976ca11',
  },
  { name: 'WHYPE', actual: TOKENS.WHYPE.address, expected: '0x5555555555555555555555555555555555555555' },
  { name: 'USDC', actual: TOKENS.USDC.address, expected: '0xb88339cb7199b77e23db6e890353e22632ba630f' },
  { name: 'USDT0', actual: TOKENS.USDT0.address, expected: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb' },
  { name: 'USDH', actual: TOKENS.USDH.address, expected: '0x111111a1a0667d36bd57c0a9f569b98057111111' },
  { name: 'KHYPE', actual: TOKENS.KHYPE.address, expected: '0xfd739d4e423301ce9385c1fb8850539d657c296d' },
  { name: 'WSTHYPE', actual: TOKENS.WSTHYPE.address, expected: '0x94e8396e0869c9f2200760af0621afd240e1cf38' },
  { name: 'LHYPE', actual: TOKENS.LHYPE.address, expected: '0x5748ae796ae46a4f1348a1693de4b50560485562' },
];

describe('domain constants', () => {
  it.each(PINNED)('pins $name to $expected', ({ actual, expected }) => {
    expect(isAddressEqual(actual, expected)).toBe(true);
  });

  it('pins every contract and token address', () => {
    expect(PINNED.map((row) => row.name).sort()).toEqual(
      [...Object.keys(ADDRESSES), ...Object.keys(TOKENS)].sort(),
    );
  });

  it('stores contract addresses checksummed', () => {
    expect(ADDRESSES.rysk).toBe(getAddress('0x8c8bcb6d2c0e31c5789253ecc8431ca6209b4e35'));
    for (const address of Object.values(ADDRESSES)) expect(address).toBe(getAddress(address));
    for (const token of Object.values(TOKENS)) expect(token.address).toBe(getAddress(token.address));
  });

  it('pins token decimals', () => {
    expect(TOKENS.USDC.decimals).toBe(6);
    expect(TOKENS.WHYPE.decimals).toBe(18);
  });

  it('trades WHYPE options struck in USDC, collateralised in USDC (put) and WHYPE (call)', () => {
    expect(TRADED_PRODUCTS.put).toEqual({
      underlying: TOKENS.WHYPE.address,
      strikeAsset: TOKENS.USDC.address,
      collateralAsset: TOKENS.USDC.address,
      isPut: true,
    });
    expect(TRADED_PRODUCTS.call).toEqual({
      underlying: TOKENS.WHYPE.address,
      strikeAsset: TOKENS.USDC.address,
      collateralAsset: TOKENS.WHYPE.address,
      isPut: false,
    });
  });

  it('samples USDC/USDT0 puts and WHYPE calls only', () => {
    expect(SAMPLED_PUT_STABLES).toEqual([TOKENS.USDC.address, TOKENS.USDT0.address]);
    expect(SAMPLED_CALL_COLLATERALS).toEqual([TOKENS.WHYPE.address]);
  });
});

describe('tokenByAddress', () => {
  it('finds a token from any address casing', () => {
    expect(tokenByAddress('0xb88339cb7199b77e23db6e890353e22632ba630f')?.symbol).toBe('USDC');
    expect(tokenByAddress('0xFD739D4E423301CE9385C1FB8850539D657C296D')?.symbol).toBe('kHYPE');
  });

  it('returns undefined for an unknown address', () => {
    expect(tokenByAddress('0x0000000000000000000000000000000000000001')).toBeUndefined();
  });

  it('returns undefined for malformed input instead of throwing', () => {
    for (const input of ['', '0x123', 'not an address', '0x5555555555555555555555555555555555555555-true']) {
      expect(tokenByAddress(input), input).toBeUndefined();
    }
  });
});

describe('tokenBySymbol', () => {
  it('finds a token case-insensitively', () => {
    expect(tokenBySymbol('usdt0')).toBe(TOKENS.USDT0);
    expect(tokenBySymbol('kHYPE')).toBe(TOKENS.KHYPE);
  });

  it('throws for an unknown symbol', () => {
    expect(() => tokenBySymbol('DOGE')).toThrow(/DOGE/);
  });
});
