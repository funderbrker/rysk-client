import { describe, expectTypeOf, it } from 'vitest';
import type { ExecutionConfig } from '../../execution/checks.ts';
import type {
  ExecutionCandidate,
  HoldReason as ExecutionHoldReason,
  FreshState,
} from '../../execution/types.ts';
import type { CallConfig, SafetyConfig, SideConfig } from './config.ts';
import type { Candidate, HoldReason, SideCapital, Snapshot, WheelState } from './types.ts';

// Execution never imports the strategy; these compile-time checks keep the structural copies in step.
type ExecutionSafetyKeys =
  | 'maxGasFee6'
  | 'maxGasFeeBps'
  | 'minNetPremium6'
  | 'minQuoteTtlSec'
  | 'maxQuoteTtlSec'
  | 'maxPremiumFractionOfCollateral'
  | 'aprEchoTolerancePp'
  | 'verifyMakerSig'
  | 'maxDeploymentsPer24h'
  | 'maxNotionalPer24h6'
  | 'minNativeHypeE18';
type ExecutionSideKeys =
  | 'minApr'
  | 'minOtmPct'
  | 'maxContractsPerTradeE18'
  | 'minHoursToExpiry'
  | 'maxDaysToExpiry';

describe('strategy types against execution', () => {
  it('passes a strategy Candidate and HoldReason where execution expects its own', () => {
    expectTypeOf<Candidate>().toExtend<ExecutionCandidate>();
    expectTypeOf<HoldReason>().toExtend<ExecutionHoldReason>();
  });

  it('normalizes safety and side limits to the names and units of ExecutionConfig', () => {
    expectTypeOf<Pick<SafetyConfig, ExecutionSafetyKeys>>().toEqualTypeOf<
      Pick<ExecutionConfig, ExecutionSafetyKeys>
    >();
    expectTypeOf<Pick<SideConfig, ExecutionSideKeys>>().toEqualTypeOf<
      Pick<ExecutionConfig, ExecutionSideKeys>
    >();
    expectTypeOf<CallConfig['minStrikeOverBasisPct']>().toEqualTypeOf<
      ExecutionConfig['minStrikeOverBasisPct']
    >();
    expectTypeOf<CallConfig['fallback']['minNetPremium6']>().toEqualTypeOf<
      ExecutionConfig['fallbackMinNetPremium6']
    >();
  });

  it('holds in the state and snapshot what FreshState copies from them', () => {
    expectTypeOf<HoldReason | null>().toExtend<FreshState['gateHold']>();
    expectTypeOf<WheelState['basis']['basisE8']>().toEqualTypeOf<FreshState['basisE8']>();
    expectTypeOf<WheelState['basis']['reliable']>().toEqualTypeOf<FreshState['basisReliable']>();
    expectTypeOf<SideCapital['free']>().toEqualTypeOf<FreshState['freeCollateral']>();
    expectTypeOf<WheelState['deploymentsLast24h']>().toEqualTypeOf<FreshState['deploymentsLast24h']>();
    expectTypeOf<WheelState['notionalLast24h6']>().toEqualTypeOf<FreshState['notionalLast24h6']>();
    expectTypeOf<Snapshot['market']['spotE8']>().toEqualTypeOf<FreshState['spotE8']>();
    expectTypeOf<Snapshot['chain']['nativeHypeE18']>().toEqualTypeOf<FreshState['nativeHypeE18']>();
    expectTypeOf<Snapshot['localNowMs']>().toEqualTypeOf<FreshState['fetchedAtMs']>();
  });
});
