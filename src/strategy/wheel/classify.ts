import { isAddressEqual } from 'viem';
import { CHAIN_ID, TOKENS } from '../../domain/constants.ts';
import type { Position } from '../../domain/types.ts';
import type { Phase, RowClass } from './types.ts';

/**
 * A position's class and phase at `nowSec` (spec §8.2). Puts on WHYPE deliver WHYPE when assigned, so every put
 * on WHYPE is basis-relevant: `managedPut` when both the strike asset and the collateral are USDC, otherwise
 * `whypePutOtherUsd`. Calls are basis-relevant only when they lock WHYPE: `managedCall` with a USDC strike asset,
 * otherwise `whypeCallOtherUsd`; a call on any other collateral (kHYPE, LHYPE, wstHYPE) locks none of our WHYPE
 * and is `hypeForeignCollateral`.
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
  const usdcStrike = isAddressEqual(p.usd, TOKENS.USDC.address);
  if (p.isPut) {
    return usdcStrike && isAddressEqual(p.collateral, TOKENS.USDC.address)
      ? 'managedPut'
      : 'whypePutOtherUsd';
  }
  if (!isAddressEqual(p.collateral, TOKENS.WHYPE.address)) return 'hypeForeignCollateral';
  return usdcStrike ? 'managedCall' : 'whypeCallOtherUsd';
}

/** An open row whose expiry has passed (`expirySec ≤ nowSec`) is awaiting settlement. */
function phaseOf(p: Position, nowSec: number): Phase {
  if (p.status === 'settled') return 'settled';
  if (p.status === 'unknown') return 'unknown';
  return p.expirySec <= nowSec ? 'pendingSettlement' : 'open';
}
