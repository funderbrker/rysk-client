import {
  type Account,
  createPublicClient,
  createWalletClient,
  type HttpTransport,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { hyperEvm } from 'viem/chains';
import { CHAIN_ID } from '../domain/index.ts';

export class ChainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChainError';
  }
}

export type HyperEvmPublicClient = PublicClient<HttpTransport, typeof hyperEvm>;
export type HyperEvmWalletClient = WalletClient<HttpTransport, typeof hyperEvm, Account>;

export type ChainClients = { publicClient: HyperEvmPublicClient; walletClient?: HyperEvmWalletClient };

/**
 * Public client on HyperEVM, plus a wallet client signing with `account` when one is given. Both batch the
 * JSON-RPC calls made in the same tick into one HTTP request (the snapshot's multicall and its two nonce reads).
 */
export function createChainClients(opts: { rpcUrl: string; account?: Account }): ChainClients {
  const transport = http(opts.rpcUrl, { batch: true });
  const publicClient = createPublicClient({ chain: hyperEvm, transport });
  if (opts.account === undefined) return { publicClient };
  const walletClient = createWalletClient({ chain: hyperEvm, transport, account: opts.account });
  return { publicClient, walletClient };
}

/** Throws `ChainError` when the RPC serves a chain other than `expected`. */
export async function assertChainId(
  publicClient: { getChainId(): Promise<number> },
  expected: number = CHAIN_ID,
): Promise<void> {
  const actual = await publicClient.getChainId();
  if (actual !== expected) throw new ChainError(`RPC serves chain id ${actual}, expected ${expected}`);
}
