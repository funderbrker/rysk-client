import { type Address, isAddressEqual } from 'viem';
import { aprFractionFromRyskApy } from './apr.ts';
import { DEFAULT_STRIKE_PRECISION_E8, TOKENS } from './constants.ts';
import { addressOf, isObject, uintOf } from './parse.ts';
import type { Asset, Listing, Product } from './types.ts';
import { strikeE8FromKey, strikeE8FromNumber, UnitError } from './units.ts';

type InventoryOptions = { underlyingSymbol: 'HYPE'; underlying: Address; observedAtSec: number };

/**
 * Parses the `assets` response for one chain. An invalid asset is skipped and counted in `dropped`; only a
 * malformed top level (not an object, or no array for `chainId`) throws.
 */
export function parseAssets(json: unknown, chainId = 999): { assets: Asset[]; dropped: number } {
  if (!isObject(json)) throw new Error('assets: top level is not an object');
  const rows = json[String(chainId)];
  if (!Array.isArray(rows)) throw new Error(`assets: no asset array for chain ${chainId}`);
  const assets: Asset[] = [];
  for (const row of rows) {
    const asset = parseAsset(row, chainId);
    if (asset !== undefined) assets.push(asset);
  }
  return { assets, dropped: rows.length - assets.length };
}

/** The WHYPE asset, whose price is HYPE spot. */
export function hypeAsset(assets: Asset[]): Asset {
  const whype = assets.find((asset) => isAddressEqual(asset.address, TOKENS.WHYPE.address));
  if (whype === undefined) throw new Error('assets: no WHYPE entry');
  return whype;
}

/**
 * Parses the `inventory` response for one underlying into listings. The strike and expiry come from the
 * combination key and must agree with the body; only expiries the inventory lists are kept. An invalid
 * combination is skipped and counted in `dropped`; only a malformed top level throws.
 */
export function parseInventory(
  json: unknown,
  opts: InventoryOptions,
): { listings: Listing[]; dropped: number } {
  if (!isObject(json)) throw new Error('inventory: top level is not an object');
  const section = json[opts.underlyingSymbol];
  if (!isObject(section) || !Array.isArray(section.expiries) || !isObject(section.combinations)) {
    throw new Error(`inventory: no expiries and combinations for ${opts.underlyingSymbol}`);
  }
  const listedExpiries = new Set<unknown>(section.expiries);
  const listings: Listing[] = [];
  let dropped = 0;
  for (const [key, combination] of Object.entries(section.combinations)) {
    const listing = parseCombination(key, combination, opts);
    if (listing === undefined) dropped += 1;
    else if (listedExpiries.has(listing.expirySec)) listings.push(listing);
  }
  return { listings, dropped };
}

function parseAsset(row: unknown, chainId: number): Asset | undefined {
  if (!isObject(row) || row.chainId !== chainId) return undefined;
  const { symbol, decimals, active } = row;
  const address = addressOf(row.address);
  const underlying = addressOf(row.underlyingAssetAddress);
  const minTradeSizeE18 = uintOf(row.minTradeSize);
  const maxTradeSizeE18 = uintOf(row.maxTradeSize);
  const priceE18 = uintOf(row.price);
  const strikePrecisionE8 = strikePrecisionOf(row.strikePrecision);
  const marketOpen = marketOpenOf(row.marketStatus);
  if (
    typeof symbol !== 'string' ||
    symbol === '' ||
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    typeof active !== 'boolean' ||
    address === undefined ||
    underlying === undefined ||
    minTradeSizeE18 === undefined ||
    minTradeSizeE18 === 0n ||
    maxTradeSizeE18 === undefined ||
    maxTradeSizeE18 < minTradeSizeE18 ||
    priceE18 === undefined ||
    priceE18 === 0n ||
    strikePrecisionE8 === undefined ||
    marketOpen === undefined
  ) {
    return undefined;
  }
  return {
    symbol,
    address,
    underlying,
    decimals,
    minTradeSizeE18,
    maxTradeSizeE18,
    active,
    priceE18,
    strikePrecisionE8,
    marketOpen,
  };
}

function parseCombination(key: string, combination: unknown, opts: InventoryOptions): Listing | undefined {
  if (!isObject(combination)) return undefined;
  const { strike, expiration_timestamp: expirySec, isPut, delta, apy, index } = combination;
  const fromKey = unlessUnitError(() => strikeE8FromKey(key));
  const strikeE8 = typeof strike === 'number' ? unlessUnitError(() => strikeE8FromNumber(strike)) : undefined;
  if (
    fromKey === undefined ||
    strikeE8 !== fromKey.strikeE8 ||
    expirySec !== fromKey.expirySec ||
    typeof isPut !== 'boolean' ||
    !isFiniteNumber(delta) ||
    !isFiniteNumber(apy) ||
    !isFiniteNumber(index)
  ) {
    return undefined;
  }
  const products = parseProducts(combination.products, opts.underlying, isPut);
  if (products === undefined) return undefined;
  return {
    strikeE8: fromKey.strikeE8,
    expirySec: fromKey.expirySec,
    isPut,
    delta,
    indicativeApr: aprFractionFromRyskApy(apy),
    indexUsd: index,
    products,
    observedAtSec: opts.observedAtSec,
  };
}

/** Each entry's `asset` is a collateral token, not the RFQ underlying, so the underlying is supplied. */
function parseProducts(entries: unknown, underlying: Address, isPut: boolean): Product[] | undefined {
  if (!Array.isArray(entries)) return undefined;
  const products: Product[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) return undefined;
    const strikeAsset = addressOf(entry.strikeAsset);
    const collateralAsset = addressOf(entry.collateralAsset);
    if (strikeAsset === undefined || collateralAsset === undefined) return undefined;
    products.push({ underlying, strikeAsset, collateralAsset, isPut });
  }
  return products;
}

function strikePrecisionOf(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return DEFAULT_STRIKE_PRECISION_E8;
  const precisionE8 =
    typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : uintOf(value);
  return precisionE8 !== undefined && precisionE8 > 0n ? precisionE8 : undefined;
}

/** A market without `marketStatus` (or without `isOpen`) is open. */
function marketOpenOf(status: unknown): boolean | undefined {
  if (status === undefined || status === null) return true;
  if (!isObject(status)) return undefined;
  const isOpen = status.isOpen ?? true;
  return typeof isOpen === 'boolean' ? isOpen : undefined;
}

function unlessUnitError<T>(parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    if (error instanceof UnitError) return undefined;
    throw error;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
