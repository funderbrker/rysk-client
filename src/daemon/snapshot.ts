import type { Address } from 'viem';
import { type ChainReader, readChainSnapshot } from '../chain/snapshot.ts';
import { parseCaps } from '../domain/caps.ts';
import { CHAIN_ID, TOKENS } from '../domain/constants.ts';
import { hypeAsset, parseAssets, parseInventory } from '../domain/inventory.ts';
import { parsePositions } from '../domain/positions.ts';
import type { Clock } from '../lib/time.ts';
import type { RyskRest } from '../rysk/rest.ts';
import type { Snapshot } from '../strategy/wheel/types.ts';
import type { Log } from './logger.ts';
import type { Memo } from './memo.ts';

export type SnapshotSources = {
  chain: ChainReader;
  rest: Pick<RyskRest, 'userPositions' | 'inventory' | 'assets' | 'caps'>;
  self: Address;
  clock: Clock;
  memo: Memo;
  mode: 'live' | 'dry-run';
  /** Where the parsers' warnings and dropped entries are reported. */
  log: Log;
};

/** An 18-dp asset price as an 8-dp spot. */
const E10 = 10n ** 10n;

/**
 * One tick's snapshot (spec §9.1): the chain multicall and nonces, the positions, the inventory, the assets and
 * the caps, read in parallel. Any failed read or strict parse rejects (the loop then holds the tick); the
 * positions are fetched and parsed on every call, never reused. `nowSec` is the block timestamp, `localNowMs` the
 * process clock once every read is back, `inventoryTs` (and each listing's `observedAtSec`) the second the
 * inventory arrived; spot is the WHYPE asset's price (a missing WHYPE asset rejects). Only chain-999 rows count
 * as other rows. Parser warnings and dropped entries are logged as one warning with their counts.
 *
 * Fills the memo's `uptimeSec` and `serverSkewMs` before copying it into the snapshot; the loop owns its other
 * fields (`lastNoPendingSeenSec` is set from the derived state, after this).
 */
export async function gatherSnapshot(src: SnapshotSources): Promise<Snapshot> {
  const { clock, memo, self } = src;
  const [chain, positionsJson, inventory, assetsJson, capsJson] = await Promise.all([
    readChainSnapshot(src.chain, self),
    src.rest.userPositions(self),
    src.rest.inventory().then((json) => ({ json, atMs: clock.nowMs() })),
    src.rest.assets(),
    src.rest.caps(),
  ]);
  const localNowMs = clock.nowMs();
  const inventoryTs = Math.floor(inventory.atMs / 1000);

  const positions = parsePositions(positionsJson, { underlying: TOKENS.WHYPE.address, chainId: CHAIN_ID });
  const { listings, dropped: listingsDropped } = parseInventory(inventory.json, {
    underlyingSymbol: 'HYPE',
    underlying: TOKENS.WHYPE.address,
    observedAtSec: inventoryTs,
  });
  const { assets, dropped: assetsDropped } = parseAssets(assetsJson, CHAIN_ID);
  const { caps, dropped: capsDropped } = parseCaps(capsJson);
  if (positions.warnings.length > 0 || listingsDropped + assetsDropped + capsDropped > 0) {
    src.log.warn(
      { positionWarnings: positions.warnings, listingsDropped, assetsDropped, capsDropped },
      'snapshot: the parsers skipped or warned about entries',
    );
  }
  const spotE8 = hypeAsset(assets).priceE18 / E10;

  memo.uptimeSec = Math.floor((localNowMs - memo.startedAtMs) / 1000);
  memo.updateServerSkew(localNowMs, chain.blockTs);
  return {
    nowSec: chain.blockTs,
    localNowMs,
    mode: src.mode,
    self,
    chain: {
      blockNumber: chain.blockNumber,
      blockTs: chain.blockTs,
      whypeE18: chain.whypeE18,
      usdc6: chain.usdc6,
      usdt06: chain.usdt06,
      nativeHypeE18: chain.nativeHypeE18,
      allowanceUsdc6: chain.allowanceUsdc6,
      allowanceWhypeE18: chain.allowanceWhypeE18,
      vaultCounter: chain.vaultCounter,
      pendingNonceGap: chain.pendingNonce - chain.latestNonce,
    },
    positions: positions.positions,
    otherRowCount: positions.otherRows.filter((row) => row.chainId === CHAIN_ID).length,
    market: { assets, listings, caps, spotE8, inventoryTs },
    memo: memo.snapshotMemo(),
  };
}
