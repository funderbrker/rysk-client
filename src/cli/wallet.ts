import { formatUnits } from 'viem';
import { createChainClients } from '../chain/clients.ts';
import { readChainSnapshot } from '../chain/snapshot.ts';
import type { AppConfig } from '../daemon/index.ts';
import { ADDRESSES } from '../domain/constants.ts';
import type { WalletCommand } from './args.ts';
import { printFields } from './format.ts';

/**
 * `rysk wallet`: the configured account's balances, its allowances to the MarginPool, its vault counter and nonces,
 * all from the chain snapshot's one multicall at one block.
 */
export async function walletCommand(_cmd: WalletCommand, config: AppConfig): Promise<number> {
  const { publicClient } = createChainClients({ rpcUrl: config.rpcUrl });
  const self = config.account.address;
  const s = await readChainSnapshot(publicClient, self);
  printFields([
    ['address', self],
    ['block', `${s.blockNumber} at ${s.blockTs} (${new Date(s.blockTs * 1000).toISOString()})`],
    ['nativeHype', formatUnits(s.nativeHypeE18, 18)],
    ['whype', formatUnits(s.whypeE18, 18)],
    ['usdc', formatUnits(s.usdc6, 6)],
    ['usdt0', formatUnits(s.usdt06, 6)],
    ['marginPool', ADDRESSES.marginPool],
    ['allowanceUsdc', formatUnits(s.allowanceUsdc6, 6)],
    ['allowanceWhype', formatUnits(s.allowanceWhypeE18, 18)],
    ['vaultCounter', s.vaultCounter.toString()],
    ['nonces', `pending ${s.pendingNonce}, latest ${s.latestNonce}`],
  ]);
  return 0;
}
