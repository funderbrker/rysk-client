import { type Address, type Hex, type TransactionReceipt, WaitForTransactionReceiptTimeoutError } from 'viem';
import { erc20Abi } from './abi.ts';
import { ChainError, type HyperEvmPublicClient, type HyperEvmWalletClient } from './clients.ts';

export type ApproveDeps = {
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  /** Broadcasts and returns the hash; mining is awaited separately so a timed-out approve keeps its hash. */
  approve(token: Address, spender: Address, amount: bigint): Promise<Hex>;
  /** `null` when no receipt arrives within `timeoutMs`. */
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<TransactionReceipt | null>;
  nonces(owner: Address): Promise<{ pending: number; latest: number }>;
};

export type ApproveArgs = {
  token: Address;
  owner: Address;
  spender: Address;
  amount: bigint;
  waitMs?: number;
};

export type ApproveResult =
  | { status: 'skipped' }
  | { status: 'approved'; hash: Hex }
  | { status: 'tx-pending' }
  | { status: 'stuck'; hash: Hex; cause?: unknown };

const APPROVE_WAIT_MS = 60_000;
/** Amounts this large are "infinite" approvals in practice (`maxUint256` and friends); never send one. */
const UNLIMITED_APPROVAL_FLOOR = 2n ** 255n;

/**
 * Sets `owner`'s allowance for `spender` to exactly `amount`, overwriting a stale larger or smaller one.
 * Refuses while any transaction from `owner` is pending, and confirms the allowance after mining. Once the
 * approve is broadcast every outcome carries its hash; a later failure is `stuck` with the `cause`.
 */
export async function approveExact(deps: ApproveDeps, args: ApproveArgs): Promise<ApproveResult> {
  const { token, owner, spender, amount, waitMs = APPROVE_WAIT_MS } = args;
  if (amount >= UNLIMITED_APPROVAL_FLOOR) throw new ChainError('refusing unlimited approval');
  if (amount <= 0n) throw new ChainError(`refusing approval of non-positive amount ${amount}`);
  const { pending, latest } = await deps.nonces(owner);
  if (pending !== latest) return { status: 'tx-pending' };
  if ((await deps.allowance(token, owner, spender)) === amount) return { status: 'skipped' };

  const hash = await deps.approve(token, spender, amount);
  try {
    const receipt = await deps.waitForReceipt(hash, waitMs);
    if (receipt === null) return { status: 'stuck', hash };
    if ((await deps.allowance(token, owner, spender)) !== amount) return { status: 'stuck', hash };
    return { status: 'approved', hash };
  } catch (cause) {
    return { status: 'stuck', hash, cause };
  }
}

export type ApproveDepsOptions = {
  /** The EIP-1559 cap per gas (wei) on the approve transaction (`safety.maxFeePerGasGwei`); viem's estimate if unset. */
  maxFeePerGas?: bigint;
};

/**
 * `ApproveDeps` over viem clients; the wallet client's account signs and owns the approvals. Without a wallet
 * client (dry-run) the reads work and `approve` rejects.
 */
export function createApproveDeps(
  publicClient: HyperEvmPublicClient,
  walletClient: HyperEvmWalletClient | undefined,
  opts: ApproveDepsOptions = {},
): ApproveDeps {
  return {
    allowance: (token, owner, spender) =>
      publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [owner, spender],
      }),
    approve: async (token, spender, amount) => {
      if (walletClient === undefined) throw new ChainError('approve needs a wallet client (live mode)');
      return walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, amount],
        maxFeePerGas: opts.maxFeePerGas,
      });
    },
    waitForReceipt: async (hash, timeoutMs) => {
      try {
        return await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs });
      } catch (error) {
        if (error instanceof WaitForTransactionReceiptTimeoutError) return null;
        throw error;
      }
    },
    nonces: async (owner) => {
      const [pending, latest] = await Promise.all([
        publicClient.getTransactionCount({ address: owner, blockTag: 'pending' }),
        publicClient.getTransactionCount({ address: owner, blockTag: 'latest' }),
      ]);
      return { pending, latest };
    },
  };
}
