// The wheel strategy's public surface: pure functions of one tick's snapshot and the normalized config.
export type { BasisEvent, BasisResult, BasisUnreliableReason } from './basis.ts';
export { basisEvents, computeBasis } from './basis.ts';
export {
  ALL_LISTED_MAX_TENOR_DAYS,
  basisEligible,
  CUSTOM_STRIKE_PRECISION_E8,
  customFallbackStrikeE8,
  fallbackStrike,
  planSide,
} from './candidates.ts';
export { classifyRow, isBasisRelevant, isManaged } from './classify.ts';
export type * from './config.ts';
export { evaluate, pickSide } from './evaluate.ts';
export type { GateCheck } from './gates.ts';
export { checkGates } from './gates.ts';
export { deriveState } from './state.ts';
export { trancheQuantityE18 } from './tranche.ts';
export type * from './types.ts';
