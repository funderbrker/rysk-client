import { isAddressEqual } from 'viem';
import { CHAIN_ID, TOKENS, TRADED_PRODUCTS } from '../../domain/constants.ts';
import type { Position, Product } from '../../domain/types.ts';
import type { Phase, RowClass } from './types.ts';

/**
 * A position's class and phase at `nowSec` (spec §8.2). A position on one of the `TRADED_PRODUCTS` is `managedPut`
 * or `managedCall`. Puts on WHYPE deliver WHYPE when assigned, so every other put on WHYPE is basis-relevant as
 * `whypePutOtherUsd`. Calls are basis-relevant only when they lock WHYPE: a WHYPE-collateral call on another strike
 * asset is `whypeCallOtherUsd`; a call on any other collateral (kHYPE, LHYPE, wstHYPE) locks none of our WHYPE and
 * is `hypeForeignCollateral`.
 */
export function classifyRow(p: Position, nowSec: number): { cls: RowClass; phase: Phase } {
  return { cls: classOf(p), phase: phaseOf(p, nowSec) };
}

/** The rows that move our WHYPE: their settlements enter the basis ledger and their pending settlement holds. */
export function isBasisRelevant(cls: RowClass): boolean {
  return isManaged(cls) || cls === 'whypePutOtherUsd' || cls === 'whypeCallOtherUsd';
}

/** The rows on the traded products, whose capital and deployments the wheel counts. */
export function isManaged(cls: RowClass): boolean {
  return cls === 'managedPut' || cls === 'managedCall';
}

function classOf(p: Position): RowClass {
  if (p.chainId !== CHAIN_ID) return 'otherChain';
  if (!isAddressEqual(p.underlying, TOKENS.WHYPE.address)) return 'foreign';
  if (isProduct(p, TRADED_PRODUCTS.put)) return 'managedPut';
  if (isProduct(p, TRADED_PRODUCTS.call)) return 'managedCall';
  if (p.isPut) return 'whypePutOtherUsd';
  if (!isAddressEqual(p.collateral, TOKENS.WHYPE.address)) return 'hypeForeignCollateral';
  return 'whypeCallOtherUsd';
}

/** Whether the position is on `product`: its side, underlying, strike asset and collateral. */
function isProduct(p: Position, product: Product): boolean {
  return (
    p.isPut === product.isPut &&
    isAddressEqual(p.underlying, product.underlying) &&
    isAddressEqual(p.usd, product.strikeAsset) &&
    isAddressEqual(p.collateral, product.collateralAsset)
  );
}

/** An open row whose expiry has passed (`expirySec ≤ nowSec`) is awaiting settlement. */
function phaseOf(p: Position, nowSec: number): Phase {
  if (p.status === 'settled') return 'settled';
  if (p.status === 'unknown') return 'unknown';
  return p.expirySec <= nowSec ? 'pendingSettlement' : 'open';
}
