import { hypeAsset } from '../../domain/inventory.ts';
import type { Side } from '../../domain/types.ts';
import { collateralForPut, floorToIncrement, fractionToBps, UnitError } from '../../domain/units.ts';
import type { WheelConfig } from './config.ts';
import type { Snapshot, WheelState } from './types.ts';

const BPS = 10_000n;

/**
 * The DCA tranche for `side` in contracts (18 dp), always a whole number of lots (spec §8.5). A lot is the WHYPE
 * asset's `minTradeSizeE18`. In the side's collateral units (USDC 6 dp for puts, WHYPE 18 dp for calls):
 *
 * ```
 * lotCost = unit × lot / 10^18 with unit(put) = K_e8 / 100 and unit(call) = 10^18: for a put the USDC one lot
 *           locks at `strikeE8` (`collateralForPut`, rounding once), for a call the lot itself
 * room    = max(0, min(budget − (locked + pending), free))
 * target  = budget × trancheFraction
 * lots    = floor(min(target, room) / lotCost), or 1 when that is 0, allowSingleLot is on and lotCost ≤ room
 * qty     = min(lots × lot, maxTradeSizeE18, maxContractsPerTradeE18, capacityE18), rounded down to whole lots
 * ```
 *
 * `capacityE18` is the caps headroom with the soft margin already applied (`remainingCapacityE18` with
 * `CAP_SOFT_MARGIN_BPS`); it is only rounded down to whole lots here, and `null` (no cap applies) skips it.
 * `strikeE8` is ignored for calls. Returns `0n` below one lot. Throws when the snapshot has no WHYPE asset, and
 * `UnitError` for a put strike at which a lot locks nothing or a `trancheFraction` outside 0 to 1.
 */
export function trancheQuantityE18(
  side: Side,
  st: WheelState,
  strikeE8: bigint,
  s: Snapshot,
  c: WheelConfig,
  capacityE18: bigint | null,
): bigint {
  const { minTradeSizeE18: lotE18, maxTradeSizeE18 } = hypeAsset(s.market.assets);
  const lotCost = side === 'put' ? collateralForPut(lotE18, strikeE8) : lotE18;
  if (lotCost <= 0n) throw new UnitError(`a lot at strike ${strikeE8} (e8) locks no collateral`);

  const { free, locked, pending, budget } = st.capital[side];
  const room = max(0n, min(budget - (locked + pending), free));
  const target = (budget * fractionToBps(c[side].trancheFraction)) / BPS;
  let lots = min(target, room) / lotCost;
  if (lots === 0n && c.tranche.allowSingleLot && lotCost <= room) lots = 1n;

  let quantityE18 = min(lots * lotE18, min(maxTradeSizeE18, c[side].maxContractsPerTradeE18));
  if (capacityE18 !== null) quantityE18 = min(quantityE18, capacityE18);
  return floorToIncrement(quantityE18, lotE18);
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
