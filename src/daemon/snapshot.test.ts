import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { ChainReader } from '../chain/snapshot.ts';
import { Memo } from './memo.ts';
import { gatherSnapshot, type SnapshotSources } from './snapshot.ts';

const E18 = 10n ** 18n;
const SELF = getAddress('0x000000000000000000000000000000000000beef');
const BLOCK_TS = 1792144000;
const NOW_MS = BLOCK_TS * 1000 + 2500;
const STARTED_AT_MS = NOW_MS - 3_600_500;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8'));
}

function chain(blockTs = BLOCK_TS, nonces = { pending: 13, latest: 12 }): ChainReader {
  return {
    multicall: vi.fn(async () => [30n * E18, 5000_000000n, 7n, 1n, 2n, 87n, E18, 1000n, BigInt(blockTs)]),
    getTransactionCount: vi.fn(async ({ blockTag }) =>
      blockTag === 'pending' ? nonces.pending : nonces.latest,
    ),
  };
}

type Rest = SnapshotSources['rest'];

function rest(overrides: Partial<Rest> = {}): Rest {
  return {
    userPositions: vi.fn(async () => fixture('positions.json')),
    inventory: vi.fn(async () => fixture('inventory.json')),
    assets: vi.fn(async () => fixture('assets.json')),
    caps: vi.fn(async () => fixture('caps.json')),
    ...overrides,
  };
}

function log() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() };
}

function sources(patch: Partial<SnapshotSources> = {}): SnapshotSources {
  return {
    chain: chain(),
    rest: rest(),
    self: SELF,
    clock: { nowMs: () => NOW_MS },
    memo: new Memo(STARTED_AT_MS),
    mode: 'dry-run',
    log: log(),
    ...patch,
  };
}

describe('gatherSnapshot', () => {
  it('reads the chain and the four REST resources into one snapshot at the block time', async () => {
    const src = sources();
    const s = await gatherSnapshot(src);

    expect(s.nowSec).toBe(BLOCK_TS);
    expect(s.localNowMs).toBe(NOW_MS);
    expect(s.mode).toBe('dry-run');
    expect(s.self).toBe(SELF);
    expect(s.chain).toEqual({
      blockNumber: 1000n,
      blockTs: BLOCK_TS,
      whypeE18: 30n * E18,
      usdc6: 5000_000000n,
      usdt06: 7n,
      nativeHypeE18: E18,
      allowanceUsdc6: 1n,
      allowanceWhypeE18: 2n,
      vaultCounter: 87n,
      pendingNonceGap: 1,
    });
    expect(s.positions).toHaveLength(77);
    expect(s.otherRowCount).toBe(10);
    // The WHYPE asset's price, 81.48032044 USD in 18 dp, as an 8-dp spot.
    expect(s.market.spotE8).toBe(8148032044n);
    expect(s.market.assets.some((asset) => asset.symbol === 'WHYPE')).toBe(true);
    expect(s.market.caps.length).toBeGreaterThan(0);
    expect(s.market.listings.length).toBeGreaterThan(0);
    expect(s.market.inventoryTs).toBe(BLOCK_TS + 2);
    expect(s.market.listings.every((listing) => listing.observedAtSec === BLOCK_TS + 2)).toBe(true);
    expect(src.rest.userPositions).toHaveBeenCalledExactlyOnceWith(SELF);
  });

  it("fills the memo's uptime and skew and returns the memo as the snapshot sees it", async () => {
    const memo = new Memo(STARTED_AT_MS);
    memo.cooldownUntilSec.call = BLOCK_TS + 60;
    memo.observeServerDate(NOW_MS - 700, NOW_MS);
    const s = await gatherSnapshot(sources({ memo }));

    expect(memo.uptimeSec).toBe(3600);
    expect(memo.serverSkewMs).toBe(700);
    expect(s.memo).toEqual(memo.snapshotMemo());
    expect(s.memo.cooldownUntilSec).toEqual({ call: BLOCK_TS + 60 });
  });

  it('counts a block from the future as clock skew', async () => {
    const memo = new Memo(STARTED_AT_MS);
    memo.observeServerDate(NOW_MS - 300, NOW_MS);
    const s = await gatherSnapshot(sources({ memo, chain: chain(BLOCK_TS + 6) }));
    // The block is 3.5 s ahead of the process clock.
    expect(s.memo.serverSkewMs).toBe(-3500);
  });

  it('counts only chain-999 rows among the other rows', async () => {
    const rows = fixture('positions.json') as Record<string, unknown>[];
    const chain1 = { ...rows[0], chainId: 1, address: '0x0000000000000000000000000000000000000001' };
    const userPositions = vi.fn(async () => [...rows, chain1]);
    const s = await gatherSnapshot(sources({ rest: rest({ userPositions }) }));
    expect(s.otherRowCount).toBe(10);
    expect(s.positions).toHaveLength(77);
  });

  it('counts a duplicated foreign row once and warns about it', async () => {
    const rows = fixture('positions.json') as Record<string, unknown>[];
    const foreign = rows.find((row) => row.symbol === 'UBTC');
    const userPositions = vi.fn(async () => [...rows, foreign]);
    const src = sources({ rest: rest({ userPositions }) });
    const s = await gatherSnapshot(src);
    expect(s.otherRowCount).toBe(10);
    expect(src.log.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ positionWarnings: [expect.stringContaining('2 rows share the key')] }),
      expect.any(String),
    );
  });

  it('parses the positions afresh on every call', async () => {
    const rows = fixture('positions.json') as unknown[];
    const userPositions = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(rows.slice(1));
    const src = sources({ rest: rest({ userPositions }) });
    const first = await gatherSnapshot(src);
    const second = await gatherSnapshot(src);
    expect(first.positions).toHaveLength(77);
    expect(second.positions).toHaveLength(76);
    expect(second.positions).not.toBe(first.positions);
  });

  it('warns with the counts when a parser warns or drops entries', async () => {
    const assets = fixture('assets.json') as Record<string, unknown[]>;
    const withBad = { ...assets, 999: [...(assets['999'] ?? []), { chainId: 999, symbol: 'BAD' }] };
    const src = sources({ rest: rest({ assets: vi.fn(async () => withBad) }) });
    await gatherSnapshot(src);
    expect(src.log.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ assetsDropped: 1, listingsDropped: 0, capsDropped: 0, positionWarnings: [] }),
      expect.any(String),
    );
  });

  it('does not warn for a clean read', async () => {
    const src = sources();
    await gatherSnapshot(src);
    expect(src.log.warn).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the chain',
      { chain: { ...chain(), multicall: vi.fn(async () => Promise.reject(new Error('rpc down'))) } },
    ],
    ['the positions', { rest: rest({ userPositions: vi.fn(async () => Promise.reject(new Error('503'))) }) }],
    ['the inventory', { rest: rest({ inventory: vi.fn(async () => Promise.reject(new Error('503'))) }) }],
    ['the assets', { rest: rest({ assets: vi.fn(async () => Promise.reject(new Error('503'))) }) }],
    ['the caps', { rest: rest({ caps: vi.fn(async () => Promise.reject(new Error('503'))) }) }],
    ['a strict positions parse', { rest: rest({ userPositions: vi.fn(async () => ({})) }) }],
    ['an assets list without WHYPE', { rest: rest({ assets: vi.fn(async () => ({ 999: [] })) }) }],
  ] satisfies [string, Partial<SnapshotSources>][])('rejects when %s fails', async (_, patch) => {
    await expect(gatherSnapshot(sources(patch))).rejects.toThrow();
  });
});
