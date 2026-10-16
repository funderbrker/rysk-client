import { type Address, type Hex, isAddressEqual, isHash } from 'viem';
import { addressOf, isObject, type JsonObject, uintOf } from './parse.ts';
import type { Position, Settlement } from './types.ts';
import { strikeE18ToE8, UnitError } from './units.ts';

export class PositionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PositionParseError';
  }
}

type PositionsOptions = { underlying: Address; chainId: 999 };
type OtherRow = { chainId: number; key: string };
type ParsedPositions = { positions: Position[]; otherRows: OtherRow[]; warnings: string[] };
type Terms = Omit<Position, 'key' | 'status' | 'settlement'>;
type Payout = { payout: bigint; returned: bigint; payoutAsset: Address | null };
type KeyParts = [
  txHash: unknown,
  isPut: unknown,
  strikeE8: unknown,
  expirySec: unknown,
  collateral: unknown,
  quantityE18: unknown,
];

const E12 = 10n ** 12n;
const E20 = 10n ** 20n;

/**
 * Parses `GET /api/user/positions`. Rows on `opts.chainId` whose underlying (`address`) is `opts.underlying` are
 * parsed strictly: any invalid field throws `PositionParseError`, because a dropped row would corrupt locked
 * capital and the basis. A row that cannot be told apart from those (not an object, or neither a valid other
 * `chainId` nor a valid other `address`) throws too. Every other row is kept only as `{ chainId, key }` for the
 * vault-counter comparison; an invalid field there is a warning, and the row is still counted with that field's
 * raw value in its key.
 */
export function parsePositions(json: unknown, opts: PositionsOptions): ParsedPositions {
  if (!Array.isArray(json)) throw new PositionParseError('positions: top level is not an array');
  const parsed: ParsedPositions = { positions: [], otherRows: [], warnings: [] };
  json.forEach((row: unknown, index) => {
    if (!isObject(row)) throw new PositionParseError(`positions: row ${index} is not an object`);
    if (isOwnRow(row, index, opts)) parsed.positions.push(parsePosition(row, index, opts.chainId));
    else parsed.otherRows.push(parseOtherRow(row, index, parsed.warnings));
  });
  return parsed;
}

/**
 * True for a row on `opts.chainId` with underlying `opts.underlying`, false for a row that is provably not one
 * (a valid other chain id or a valid other address). Anything else could be ours, so it fails closed: treating
 * it as foreign would silently drop a position.
 */
function isOwnRow(row: JsonObject, index: number, opts: PositionsOptions): boolean {
  const chainId = positiveIntOf(row.chainId);
  const underlying = addressOf(row.address);
  const sameChain = chainId === opts.chainId;
  const sameUnderlying = underlying !== undefined && isAddressEqual(underlying, opts.underlying);
  if (sameChain && sameUnderlying) return true;
  if ((chainId !== undefined && !sameChain) || (underlying !== undefined && !sameUnderlying)) return false;
  throw new PositionParseError(
    `positions: row ${index}: cannot tell whether it is a position (chainId ${shown(row.chainId)}, address ${shown(row.address)})`,
  );
}

function parsePosition(row: JsonObject, index: number, chainId: number): Position {
  function field<T>(name: string, parse: (value: unknown) => T | undefined): T {
    const value = parse(row[name]);
    if (value === undefined) {
      throw new PositionParseError(`positions: row ${index}: invalid ${name} ${shown(row[name])}`);
    }
    return value;
  }
  const terms: Terms = {
    underlying: field('address', addressOf),
    chainId,
    isPut: field('isPut', booleanOf),
    strikeE8: field('strike', strikeE8Of),
    quantityE18: field('quantity', positiveUintOf),
    priceE18: field('price', uintOf),
    premium6: field('premium', premium6Of),
    usd: field('usd', addressOf),
    collateral: field('collateral', addressOf),
    assetSymbol: field('symbol', symbolOf),
    createdAtSec: field('createdAt', positiveIntOf),
    expirySec: field('expiry', positiveIntOf),
    txHash: field('txHash', txHashOf),
  };
  const payout: Payout = {
    payout: field('payout', uintOf),
    returned: field('settlementCollateralPayout', uintOf),
    payoutAsset: field('payoutAsset', payoutAssetOf),
  };
  const status = statusOf(row.status, row.isBuy);
  return {
    key: rowKey([
      terms.txHash,
      terms.isPut,
      terms.strikeE8,
      terms.expirySec,
      terms.collateral.toLowerCase(),
      terms.quantityE18,
    ]),
    ...terms,
    status,
    settlement: status === 'settled' ? settlementOf(terms, payout) : null,
  };
}

/**
 * Parses only `chainId`, `address` and the key fields; an invalid one is warned about, and a key field's raw
 * value is used in its place.
 */
function parseOtherRow(row: JsonObject, index: number, warnings: string[]): OtherRow {
  const invalid: string[] = [];
  function part(name: string, parse: (value: unknown) => unknown): unknown {
    const value = parse(row[name]);
    if (value !== undefined) return value;
    invalid.push(name);
    return row[name];
  }
  const chainId = positiveIntOf(row.chainId);
  if (chainId === undefined) invalid.push('chainId');
  if (addressOf(row.address) === undefined) invalid.push('address');
  const key = rowKey([
    part('txHash', txHashOf),
    part('isPut', booleanOf),
    part('strike', strikeE8Of),
    part('expiry', positiveIntOf),
    part('collateral', (value) => addressOf(value)?.toLowerCase()),
    part('quantity', positiveUintOf),
  ]);
  if (invalid.length > 0) {
    warnings.push(`positions: row ${index} is not a parsed position and has invalid ${invalid.join(', ')}`);
  }
  return { chainId: chainId ?? Number.NaN, key };
}

/** `txHash|isPut|strikeE8|expirySec|collateral|quantityE18`, with the hash and collateral in lowercase. */
function rowKey(parts: KeyParts): string {
  return parts.map(String).join('|');
}

function statusOf(status: unknown, isBuy: unknown): Position['status'] {
  if (isBuy !== true) return 'unknown';
  if (status === '') return 'open';
  if (status === 'SETTLED') return 'settled';
  return 'unknown';
}

/**
 * The outcome from payout fields only, never from prices: collateral back means it expired OTM; otherwise a put
 * must have delivered `quantity` underlying and a call `quantity × strike` stables. Anything else is an anomaly.
 */
function settlementOf(terms: Terms, { payout, returned, payoutAsset }: Payout): Settlement {
  if (payout === 0n && returned > 0n) return { outcome: 'expiredOtm', collateralReturned: returned };
  if (payout === 0n || returned > 0n) {
    return anomaly(`payout ${payout} with collateral returned ${returned}`);
  }
  const [expectedAsset, expectedPayout] = terms.isPut
    ? [terms.underlying, terms.quantityE18]
    : [terms.usd, (terms.quantityE18 * terms.strikeE8) / E20];
  if (payoutAsset === null || !isAddressEqual(payoutAsset, expectedAsset)) {
    return anomaly(`payout asset ${payoutAsset ?? 'none'}, expected ${expectedAsset}`);
  }
  if (payout !== expectedPayout) return anomaly(`payout ${payout}, expected ${expectedPayout}`);
  return terms.isPut
    ? { outcome: 'assigned', receivedUnderlyingE18: payout }
    : { outcome: 'exercised', receivedStable6: payout };
}

function anomaly(detail: string): Settlement {
  return { outcome: 'anomaly', detail };
}

function strikeE8Of(value: unknown): bigint | undefined {
  const strikeE18 = positiveUintOf(value);
  if (strikeE18 === undefined) return undefined;
  try {
    return strikeE18ToE8(strikeE18);
  } catch (error) {
    if (error instanceof UnitError) return undefined;
    throw error;
  }
}

/** The API's `premium` is 18 dp but must be an exact 6-dp USD amount. */
function premium6Of(value: unknown): bigint | undefined {
  const premiumE18 = uintOf(value);
  return premiumE18 !== undefined && premiumE18 % E12 === 0n ? premiumE18 / E12 : undefined;
}

function positiveUintOf(value: unknown): bigint | undefined {
  const n = uintOf(value);
  return n !== undefined && n > 0n ? n : undefined;
}

function positiveIntOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function symbolOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function txHashOf(value: unknown): Hex | undefined {
  return typeof value === 'string' && isHash(value) ? (value.toLowerCase() as Hex) : undefined;
}

/** A raw JSON value for an error message. */
function shown(value: unknown): string {
  return String(JSON.stringify(value));
}

/** `''` (no payout) becomes `null`. */
function payoutAssetOf(value: unknown): Address | null | undefined {
  return value === '' ? null : addressOf(value);
}
