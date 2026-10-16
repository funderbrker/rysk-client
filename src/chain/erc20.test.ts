import { getAddress, type Hex, maxUint256, pad, type TransactionReceipt } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ADDRESSES, TOKENS } from '../domain/index.ts';
import { ChainError, type HyperEvmPublicClient, type HyperEvmWalletClient } from './clients.ts';
import { type ApproveDeps, approveExact, createApproveDeps } from './erc20.ts';

const OWNER = getAddress('0x000000000000000000000000000000000000beef');
const TOKEN = TOKENS.USDC.address;
const SPENDER = ADDRESSES.marginPool;
const AMOUNT = 1962500000n;
const HASH: Hex = pad('0xa990');
const RECEIPT = { status: 'success', transactionHash: HASH } as TransactionReceipt;
const ARGS = { token: TOKEN, owner: OWNER, spender: SPENDER, amount: AMOUNT };

type FakeOptions = {
  allowances: bigint[];
  nonces?: { pending: number; latest: number };
  receipt?: TransactionReceipt | null;
};

function fakeDeps({ allowances, nonces = { pending: 5, latest: 5 }, receipt = RECEIPT }: FakeOptions) {
  const allowance = vi.fn<ApproveDeps['allowance']>();
  for (const value of allowances) allowance.mockResolvedValueOnce(value);
  return {
    allowance,
    approve: vi.fn<ApproveDeps['approve']>(async () => HASH),
    waitForReceipt: vi.fn<ApproveDeps['waitForReceipt']>(async () => receipt),
    nonces: vi.fn<ApproveDeps['nonces']>(async () => nonces),
  } satisfies ApproveDeps;
}

describe('approveExact', () => {
  it('skips when the allowance already equals the amount', async () => {
    const deps = fakeDeps({ allowances: [AMOUNT] });

    expect(await approveExact(deps, ARGS)).toEqual({ status: 'skipped' });
    expect(deps.allowance).toHaveBeenCalledExactlyOnceWith(TOKEN, OWNER, SPENDER);
    expect(deps.approve).not.toHaveBeenCalled();
  });

  it('overwrites a stale larger allowance with exactly the amount', async () => {
    const deps = fakeDeps({ allowances: [AMOUNT + 1n, AMOUNT] });

    expect(await approveExact(deps, ARGS)).toEqual({ status: 'approved', hash: HASH });
    expect(deps.approve).toHaveBeenCalledExactlyOnceWith(TOKEN, SPENDER, AMOUNT);
    expect(deps.waitForReceipt).toHaveBeenCalledExactlyOnceWith(HASH, 60_000);
    expect(deps.allowance).toHaveBeenCalledTimes(2);
  });

  it('raises a smaller allowance to the amount', async () => {
    const deps = fakeDeps({ allowances: [0n, AMOUNT] });

    expect(await approveExact(deps, { ...ARGS, waitMs: 5_000 })).toEqual({ status: 'approved', hash: HASH });
    expect(deps.approve).toHaveBeenCalledExactlyOnceWith(TOKEN, SPENDER, AMOUNT);
    expect(deps.waitForReceipt).toHaveBeenCalledExactlyOnceWith(HASH, 5_000);
  });

  it('refuses while another transaction is pending', async () => {
    const deps = fakeDeps({ allowances: [0n], nonces: { pending: 6, latest: 5 } });

    expect(await approveExact(deps, ARGS)).toEqual({ status: 'tx-pending' });
    expect(deps.nonces).toHaveBeenCalledExactlyOnceWith(OWNER);
    expect(deps.allowance).not.toHaveBeenCalled();
    expect(deps.approve).not.toHaveBeenCalled();
  });

  it('reports stuck with the hash when no receipt arrives in time', async () => {
    const deps = fakeDeps({ allowances: [0n], receipt: null });

    expect(await approveExact(deps, ARGS)).toEqual({ status: 'stuck', hash: HASH });
    expect(deps.allowance).toHaveBeenCalledTimes(1);
  });

  it('reports stuck when the mined approve left a different allowance', async () => {
    const deps = fakeDeps({ allowances: [0n, 0n] });

    expect(await approveExact(deps, ARGS)).toEqual({ status: 'stuck', hash: HASH });
    expect(deps.allowance).toHaveBeenCalledTimes(2);
  });

  it('keeps the hash when waiting for the receipt rejects', async () => {
    const deps = fakeDeps({ allowances: [0n] });
    const cause = new Error('rpc unavailable');
    deps.waitForReceipt.mockRejectedValueOnce(cause);

    expect(await approveExact(deps, ARGS)).toEqual({ status: 'stuck', hash: HASH, cause });
  });

  it('keeps the hash when re-reading the allowance rejects', async () => {
    const deps = fakeDeps({ allowances: [0n] });
    const cause = new Error('rpc unavailable');
    deps.allowance.mockRejectedValueOnce(cause);

    expect(await approveExact(deps, ARGS)).toEqual({ status: 'stuck', hash: HASH, cause });
    expect(deps.allowance).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['maxUint256', maxUint256],
    ['2^255', 2n ** 255n],
    ['zero', 0n],
    ['negative', -1n],
  ])('refuses an approval of %s without touching the chain', async (_label, amount) => {
    const deps = fakeDeps({ allowances: [0n] });

    await expect(approveExact(deps, { ...ARGS, amount })).rejects.toThrow(ChainError);
    expect(deps.nonces).not.toHaveBeenCalled();
    expect(deps.approve).not.toHaveBeenCalled();
  });
});

describe('createApproveDeps', () => {
  const publicClient = { readContract: vi.fn(async () => 7n) } as unknown as HyperEvmPublicClient;

  function fakeWallet() {
    const writeContract = vi.fn(async (_args: Record<string, unknown>) => HASH);
    return { writeContract, client: { writeContract } as unknown as HyperEvmWalletClient };
  }

  it('sends the approve with the configured fee cap', async () => {
    const wallet = fakeWallet();
    const deps = createApproveDeps(publicClient, wallet.client, { maxFeePerGas: 5_000_000_000n });

    expect(await deps.approve(TOKEN, SPENDER, AMOUNT)).toBe(HASH);
    expect(wallet.writeContract).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        address: TOKEN,
        functionName: 'approve',
        args: [SPENDER, AMOUNT],
        maxFeePerGas: 5_000_000_000n,
      }),
    );
  });

  it("leaves the fee to viem's estimate without a cap", async () => {
    const wallet = fakeWallet();
    await createApproveDeps(publicClient, wallet.client).approve(TOKEN, SPENDER, AMOUNT);

    expect(wallet.writeContract.mock.calls[0]?.[0].maxFeePerGas).toBeUndefined();
  });

  it('reads without a wallet client and refuses to approve', async () => {
    const deps = createApproveDeps(publicClient, undefined);

    expect(await deps.allowance(TOKEN, OWNER, SPENDER)).toBe(7n);
    await expect(deps.approve(TOKEN, SPENDER, AMOUNT)).rejects.toThrow(ChainError);
  });
});
