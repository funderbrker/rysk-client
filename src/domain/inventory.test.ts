import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { TOKENS } from './constants.ts';
import { hypeAsset, parseAssets, parseInventory } from './inventory.ts';

const E18 = 10n ** 18n;
const OBSERVED_AT_SEC = 1792146930;
const HYPE_OPTS = {
  underlyingSymbol: 'HYPE',
  underlying: TOKENS.WHYPE.address,
  observedAtSec: OBSERVED_AT_SEC,
} as const;

type Json = Record<string, unknown>;

function fixture(name: string): Json {
  return JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')) as Json;
}

const CALL_105 = '105.000000-1795766400';

/** The fixture's HYPE combinations (mutable) and a copy of its 105 call to derive variants from. */
function hypeCombinations(inventory: Json): { combinations: Record<string, unknown>; base: Json } {
  const { combinations } = inventory.HYPE as { combinations: Record<string, unknown> };
  return { combinations, base: { ...(combinations[CALL_105] as Json) } };
}

describe('parseAssets', () => {
  const { assets, dropped } = parseAssets(fixture('assets.json'));

  it('parses every chain-999 asset', () => {
    expect(dropped).toBe(0);
    expect(assets).toHaveLength(13);
  });

  it('parses the WHYPE asset with e18 sizes and the default strike precision', () => {
    const whype = assets.find((asset) => asset.symbol === 'WHYPE');
    expect(whype).toEqual({
      symbol: 'WHYPE',
      address: TOKENS.WHYPE.address,
      underlying: TOKENS.WHYPE.address,
      decimals: 18,
      minTradeSizeE18: 25n * E18,
      maxTradeSizeE18: 5000n * E18,
      active: true,
      priceE18: 81480320440000000000n,
      strikePrecisionE8: 1_000_000n,
      marketOpen: true,
    });
  });

  it('checksums addresses, including the underlying', () => {
    const khype = assets.find((asset) => asset.symbol === 'kHYPE');
    expect(khype?.address).toBe(TOKENS.KHYPE.address);
    expect(khype?.underlying).toBe(TOKENS.WHYPE.address);
    for (const asset of assets) expect(asset.address).toBe(getAddress(asset.address));
  });

  it('selects another chain and reads marketStatus', () => {
    const chain1 = parseAssets(fixture('assets.json'), 1);
    expect(chain1.dropped).toBe(0);
    expect(chain1.assets).toHaveLength(6);
    expect(chain1.assets.find((asset) => asset.symbol === 'XAUT')?.marketOpen).toBe(true);
  });

  it('honours a closed market and an explicit strike precision', () => {
    const json = fixture('assets.json');
    const rows = json['999'] as Json[];
    json['999'] = rows.map((row) =>
      row.symbol === 'WHYPE' ? { ...row, marketStatus: { isOpen: false }, strikePrecision: 50_000_000 } : row,
    );
    const whype = hypeAsset(parseAssets(json).assets);
    expect(whype.marketOpen).toBe(false);
    expect(whype.strikePrecisionE8).toBe(50_000_000n);
  });

  it('drops and counts invalid assets, keeping the rest', () => {
    const json = fixture('assets.json');
    const rows = json['999'] as Json[];
    const whype = rows.find((row) => row.symbol === 'WHYPE') as Json;
    json['999'] = [
      ...rows,
      { ...whype, address: '0x123' },
      { ...whype, minTradeSize: '25.5' },
      { ...whype, maxTradeSize: '1' },
      { ...whype, price: 81.48 },
      { ...whype, decimals: 18.5 },
      { ...whype, active: 'yes' },
      { ...whype, chainId: 1 },
      { ...whype, marketStatus: { isOpen: 'no' } },
      { ...whype, strikePrecision: 0 },
      null,
    ];
    const parsed = parseAssets(json);
    expect(parsed.dropped).toBe(10);
    expect(parsed.assets).toHaveLength(13);
  });

  it('throws only on a malformed top level', () => {
    for (const json of [null, 'assets', [], { '999': {} }, {}]) {
      expect(() => parseAssets(json), JSON.stringify(json)).toThrow();
    }
  });
});

describe('hypeAsset', () => {
  it('returns the WHYPE entry', () => {
    expect(hypeAsset(parseAssets(fixture('assets.json')).assets).symbol).toBe('WHYPE');
  });

  it('throws when WHYPE is absent', () => {
    const { assets } = parseAssets(fixture('assets.json'));
    expect(() => hypeAsset(assets.filter((asset) => asset.symbol !== 'WHYPE'))).toThrow(/WHYPE/);
  });
});

describe('parseInventory', () => {
  const { listings, dropped } = parseInventory(fixture('inventory.json'), HYPE_OPTS);

  it('parses every HYPE combination', () => {
    expect(dropped).toBe(0);
    expect(listings).toHaveLength(48);
    expect(listings.filter((listing) => listing.isPut)).toHaveLength(24);
  });

  it('parses the 105 call from its key, with one product per collateral, all struck in USDC', () => {
    const call = listings.find(
      (listing) => listing.strikeE8 === 10500000000n && listing.expirySec === 1795766400,
    );
    expect(call).toMatchObject({
      strikeE8: 10500000000n,
      isPut: false,
      expirySec: 1795766400,
      delta: 0.09948257166112223,
      indexUsd: 81.47056124000001,
      observedAtSec: OBSERVED_AT_SEC,
    });
    expect(call?.indicativeApr).toBeCloseTo(0.07019534013877234, 12);
    const byCollateral = (address: string) =>
      call?.products.find((product) => product.collateralAsset === address);
    expect(byCollateral(TOKENS.WHYPE.address)).toEqual({
      underlying: TOKENS.WHYPE.address,
      strikeAsset: TOKENS.USDC.address,
      collateralAsset: TOKENS.WHYPE.address,
      isPut: false,
    });
    expect(byCollateral(TOKENS.KHYPE.address)).toEqual({
      underlying: TOKENS.WHYPE.address,
      strikeAsset: TOKENS.USDC.address,
      collateralAsset: TOKENS.KHYPE.address,
      isPut: false,
    });
  });

  it('parses a put with USDC and USDT0 collateral products on the WHYPE underlying', () => {
    const put = listings.find(
      (listing) => listing.strikeE8 === 6200000000n && listing.expirySec === 1795766400,
    );
    expect(put?.isPut).toBe(true);
    expect(put?.products).toEqual(
      expect.arrayContaining([
        {
          underlying: TOKENS.WHYPE.address,
          strikeAsset: TOKENS.USDC.address,
          collateralAsset: TOKENS.USDC.address,
          isPut: true,
        },
        {
          underlying: TOKENS.WHYPE.address,
          strikeAsset: TOKENS.USDT0.address,
          collateralAsset: TOKENS.USDT0.address,
          isPut: true,
        },
      ]),
    );
  });

  it('drops a malformed combination and parses the rest', () => {
    const json = fixture('inventory.json');
    const { combinations, base } = hypeCombinations(json);
    combinations['99.000000-1795766400'] = { ...base, strike: 'x' };
    const parsed = parseInventory(json, HYPE_OPTS);
    expect(parsed.dropped).toBe(1);
    expect(parsed.listings).toHaveLength(48);
  });

  it('drops combinations whose key disagrees with the body or whose fields are invalid', () => {
    const json = fixture('inventory.json');
    const { combinations, base } = hypeCombinations(json);
    const products = base.products as Json[];
    combinations['106.000000-1795766400'] = { ...base };
    combinations['105.000000-1793952000'] = { ...base };
    combinations['105.0000x0-1795766400'] = { ...base };
    combinations['107.000000-1795766400'] = { ...base, strike: 107, isPut: 'false' };
    combinations['108.000000-1795766400'] = { ...base, strike: 108, apy: null };
    combinations['109.000000-1795766400'] = {
      ...base,
      strike: 109,
      products: [{ ...products[0], strikeAsset: '0x1' }],
    };
    combinations['111.000000-1795766400'] = 'not a combination';
    const parsed = parseInventory(json, HYPE_OPTS);
    expect(parsed.dropped).toBe(7);
    expect(parsed.listings).toHaveLength(48);
  });

  it('keeps only expiries the inventory lists, without counting the others as dropped', () => {
    const json = fixture('inventory.json');
    const { combinations, base } = hypeCombinations(json);
    combinations['105.000000-1799999999'] = { ...base, expiration_timestamp: 1799999999 };
    const parsed = parseInventory(json, HYPE_OPTS);
    expect(parsed.dropped).toBe(0);
    expect(parsed.listings).toHaveLength(48);
    expect(parsed.listings.some((listing) => listing.expirySec === 1799999999)).toBe(false);
  });

  it('throws only on a malformed top level', () => {
    for (const json of [
      null,
      [],
      'inventory',
      {},
      { HYPE: [] },
      { HYPE: { expiries: [], combinations: [] } },
    ]) {
      expect(() => parseInventory(json, HYPE_OPTS), JSON.stringify(json)).toThrow();
    }
  });
});
