import { erc20Abi, getAddress } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ADDRESSES, TOKENS } from '../domain/index.ts';
import { multicall3Abi, vaultStoreAbi } from './abi.ts';
import { createChainClients } from './clients.ts';
import { type ChainReader, readChainSnapshot } from './snapshot.ts';

const SELF = getAddress('0x000000000000000000000000000000000000beef');

function fakeReader(overrides: Partial<ChainReader> = {}): ChainReader {
  return {
    multicall: vi.fn(async () => [
      100n * 10n ** 18n,
      5000_000000n,
      0n,
      0n,
      0n,
      87n,
      2n * 10n ** 18n,
      1000n,
      1792144000n,
    ]),
    getTransactionCount: vi.fn(async () => 12),
    ...overrides,
  };
}

describe('readChainSnapshot', () => {
  it('maps the multicall results and nonces onto the snapshot', async () => {
    const snapshot = await readChainSnapshot(fakeReader(), SELF);

    expect(snapshot).toEqual({
      blockNumber: 1000n,
      blockTs: 1792144000,
      nativeHypeE18: 2n * 10n ** 18n,
      whypeE18: 100n * 10n ** 18n,
      usdc6: 5000_000000n,
      usdt06: 0n,
      allowanceUsdc6: 0n,
      allowanceWhypeE18: 0n,
      vaultCounter: 87n,
      pendingNonce: 12,
      latestNonce: 12,
    });
    expect(snapshot.vaultCounter).toBe(87n);
    expect(snapshot.blockNumber).toBe(1000n);
    expect(snapshot.blockTs).toBe(1792144000);
  });

  it('issues one multicall in a fixed order and reads pending and latest nonces', async () => {
    const reader = fakeReader({
      multicall: vi.fn(async () => [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]),
      getTransactionCount: vi.fn(async ({ blockTag }) => (blockTag === 'pending' ? 13 : 12)),
    });

    const snapshot = await readChainSnapshot(reader, SELF);

    expect(reader.multicall).toHaveBeenCalledExactlyOnceWith({
      allowFailure: false,
      contracts: [
        { address: TOKENS.WHYPE.address, abi: erc20Abi, functionName: 'balanceOf', args: [SELF] },
        { address: TOKENS.USDC.address, abi: erc20Abi, functionName: 'balanceOf', args: [SELF] },
        { address: TOKENS.USDT0.address, abi: erc20Abi, functionName: 'balanceOf', args: [SELF] },
        {
          address: TOKENS.USDC.address,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [SELF, ADDRESSES.marginPool],
        },
        {
          address: TOKENS.WHYPE.address,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [SELF, ADDRESSES.marginPool],
        },
        {
          address: ADDRESSES.vaultStore,
          abi: vaultStoreAbi,
          functionName: 'getAccountVaultCounter',
          args: [SELF],
        },
        {
          address: ADDRESSES.multicall3,
          abi: multicall3Abi,
          functionName: 'getEthBalance',
          args: [SELF],
        },
        { address: ADDRESSES.multicall3, abi: multicall3Abi, functionName: 'getBlockNumber', args: [] },
        {
          address: ADDRESSES.multicall3,
          abi: multicall3Abi,
          functionName: 'getCurrentBlockTimestamp',
          args: [],
        },
      ],
    });
    expect(reader.getTransactionCount).toHaveBeenCalledTimes(2);
    expect(reader.getTransactionCount).toHaveBeenCalledWith({ address: SELF, blockTag: 'pending' });
    expect(reader.getTransactionCount).toHaveBeenCalledWith({ address: SELF, blockTag: 'latest' });
    expect(snapshot).toMatchObject({
      whypeE18: 1n,
      usdc6: 2n,
      usdt06: 3n,
      allowanceUsdc6: 4n,
      allowanceWhypeE18: 5n,
      vaultCounter: 6n,
      nativeHypeE18: 7n,
      blockNumber: 8n,
      blockTs: 9,
      pendingNonce: 13,
      latestNonce: 12,
    });
  });

  it.each(['multicall', 'getTransactionCount'] as const)('rejects when %s rejects', async (method) => {
    const reader = fakeReader({
      [method]: vi.fn(async () => {
        throw new Error('rpc unavailable');
      }),
    });

    await expect(readChainSnapshot(reader, SELF)).rejects.toThrow('rpc unavailable');
  });

  it('rejects a multicall result that is not a uint', async () => {
    const reader = fakeReader({ multicall: vi.fn(async () => [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]) });

    await expect(readChainSnapshot(reader, SELF)).rejects.toThrow('block timestamp');
  });

  it('accepts a viem public client as its reader', () => {
    const reader: ChainReader = createChainClients({ rpcUrl: 'http://127.0.0.1:8545' }).publicClient;

    expect(typeof reader.multicall).toBe('function');
  });
});
