import type { Address, ContractFunctionParameters } from 'viem';
import { ADDRESSES, TOKENS } from '../domain/index.ts';
import { erc20Abi, multicall3Abi, vaultStoreAbi } from './abi.ts';
import { ChainError } from './clients.ts';

export type ChainSnapshot = {
  blockNumber: bigint;
  blockTs: number;
  nativeHypeE18: bigint;
  whypeE18: bigint;
  usdc6: bigint;
  usdt06: bigint;
  allowanceUsdc6: bigint;
  allowanceWhypeE18: bigint;
  vaultCounter: bigint;
  pendingNonce: number;
  latestNonce: number;
};

/** The subset of a viem public client the snapshot uses; loose enough for a plain fake in tests. */
export type ChainReader = {
  multicall(args: {
    allowFailure: false;
    contracts: readonly ContractFunctionParameters[];
  }): Promise<readonly unknown[]>;
  getTransactionCount(args: { address: Address; blockTag: 'pending' | 'latest' }): Promise<number>;
};

function snapshotContracts(self: Address): ContractFunctionParameters[] {
  const marginPool = ADDRESSES.marginPool;
  return [
    { address: TOKENS.WHYPE.address, abi: erc20Abi, functionName: 'balanceOf', args: [self] },
    { address: TOKENS.USDC.address, abi: erc20Abi, functionName: 'balanceOf', args: [self] },
    { address: TOKENS.USDT0.address, abi: erc20Abi, functionName: 'balanceOf', args: [self] },
    { address: TOKENS.USDC.address, abi: erc20Abi, functionName: 'allowance', args: [self, marginPool] },
    { address: TOKENS.WHYPE.address, abi: erc20Abi, functionName: 'allowance', args: [self, marginPool] },
    {
      address: ADDRESSES.vaultStore,
      abi: vaultStoreAbi,
      functionName: 'getAccountVaultCounter',
      args: [self],
    },
    {
      address: ADDRESSES.multicall3,
      abi: multicall3Abi,
      functionName: 'getEthBalance',
      args: [self],
    },
    // The block comes from the same multicall, so every value above is read at this block.
    { address: ADDRESSES.multicall3, abi: multicall3Abi, functionName: 'getBlockNumber', args: [] },
    { address: ADDRESSES.multicall3, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp', args: [] },
  ];
}

function uint(value: unknown, field: string): bigint {
  if (typeof value !== 'bigint') throw new ChainError(`snapshot ${field} is not a uint`);
  return value;
}

/**
 * Balances, MarginPool allowances and vault counter for `self` with their block number and timestamp, all
 * from one multicall at a single block, plus the pending and latest nonces. Any failed read rejects: never
 * decide on partial data.
 */
export async function readChainSnapshot(client: ChainReader, self: Address): Promise<ChainSnapshot> {
  const [results, pendingNonce, latestNonce] = await Promise.all([
    client.multicall({ allowFailure: false, contracts: snapshotContracts(self) }),
    client.getTransactionCount({ address: self, blockTag: 'pending' }),
    client.getTransactionCount({ address: self, blockTag: 'latest' }),
  ]);
  const [whype, usdc, usdt0, allowanceUsdc, allowanceWhype, vaultCounter, nativeHype, blockNumber, blockTs] =
    results;
  return {
    blockNumber: uint(blockNumber, 'block number'),
    blockTs: Number(uint(blockTs, 'block timestamp')),
    nativeHypeE18: uint(nativeHype, 'native HYPE balance'),
    whypeE18: uint(whype, 'WHYPE balance'),
    usdc6: uint(usdc, 'USDC balance'),
    usdt06: uint(usdt0, 'USDT0 balance'),
    allowanceUsdc6: uint(allowanceUsdc, 'USDC allowance'),
    allowanceWhypeE18: uint(allowanceWhype, 'WHYPE allowance'),
    vaultCounter: uint(vaultCounter, 'vault counter'),
    pendingNonce,
    latestNonce,
  };
}
