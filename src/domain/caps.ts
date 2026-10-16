import type { Address } from 'viem';
import { UINT } from './parse.ts';
import type { Cap } from './types.ts';
import { UnitError } from './units.ts';

type CapTarget = { underlyingSymbol: string; asset: Address; isPut: boolean };

const E8 = 10n ** 8n;
const BPS = 10_000n;

/** The wheel's caps soft pre-check keeps 5 % of every cap free: `usage + need ≤ 0.95 × cap` (spec §8.5). */
export const CAP_SOFT_MARGIN_BPS = 9_500;

/**
 * Parses the `caps` response. A row whose `type` is not CONTRACTS or NOTIONAL, or with any other invalid field, is
 * skipped and counted in `dropped`; only a top level that is not an array throws.
 */
export function parseCaps(json: unknown): { caps: Cap[]; dropped: number } {
  if (!Array.isArray(json)) throw new Error('caps: top level is not an array');
  const caps: Cap[] = [];
  for (const row of json) {
    const cap = parseCap(row);
    if (cap !== undefined) caps.push(cap);
  }
  return { caps, dropped: json.length - caps.length };
}

/**
 * Contracts (18 dp) that still fit under every cap on `target`: `GLOBAL`, the underlying symbol (`HYPE`), the
 * asset address and `<address>-<isPut>`. Each cap's headroom is `cap × marginBps / 10 000 − usage`, never
 * negative: the default margin keeps the whole cap, and the wheel's soft pre-check passes
 * `CAP_SOFT_MARGIN_BPS` (spec §8.5). NOTIONAL headroom is USD (18 dp), converted to contracts at
 * `notionalPriceE8` (the wheel prices both sides at spot). A zero cap is not enforced and is skipped; `null`
 * means no cap applies. Throws `UnitError` for a non-positive price or a margin that is not whole basis points
 * from 0 to 10 000.
 */
export function remainingCapacityE18(
  caps: Cap[],
  target: CapTarget,
  notionalPriceE8: bigint,
  marginBps = 10_000,
): bigint | null {
  if (notionalPriceE8 <= 0n) throw new UnitError(`invalid notional price ${notionalPriceE8} (e8)`);
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps > 10_000) {
    throw new UnitError(`invalid cap margin ${marginBps} bps`);
  }
  const margin = BigInt(marginBps);
  let remainingE18: bigint | null = null;
  for (const cap of caps) {
    if (cap.capE18 === 0n || !capApplies(cap.name, target)) continue;
    const allowedE18 = (cap.capE18 * margin) / BPS;
    const headroomE18 = allowedE18 > cap.usageE18 ? allowedE18 - cap.usageE18 : 0n;
    const contractsE18 = cap.type === 'CONTRACTS' ? headroomE18 : (headroomE18 * E8) / notionalPriceE8;
    if (remainingE18 === null || contractsE18 < remainingE18) remainingE18 = contractsE18;
  }
  return remainingE18;
}

function parseCap(row: unknown): Cap | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const { name, type, cap, usage } = row as Record<string, unknown>;
  if (typeof name !== 'string' || name === '' || (type !== 'CONTRACTS' && type !== 'NOTIONAL'))
    return undefined;
  if (typeof cap !== 'string' || !UINT.test(cap) || typeof usage !== 'string' || !UINT.test(usage)) {
    return undefined;
  }
  return { name, type, capE18: BigInt(cap), usageE18: BigInt(usage) };
}

/** Cap names carry addresses in any casing; `GLOBAL` and the underlying symbol match exactly. */
function capApplies(name: string, target: CapTarget): boolean {
  if (name === 'GLOBAL' || name === target.underlyingSymbol) return true;
  const lowerName = name.toLowerCase();
  const asset = target.asset.toLowerCase();
  return lowerName === asset || lowerName === `${asset}-${target.isPut}`;
}
