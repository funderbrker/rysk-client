import { isAddress, isAddressEqual, isHex } from 'viem';
import { UINT } from '../domain/parse.ts';
import type { ConfirmBody } from '../domain/types.ts';

// Spec §7.3: `/api/gas` echoes the full confirm body plus these extra keys (from the spike).
export const GAS_ECHO_EXTRA_KEYS = [
  'fees',
  'gasFee',
  'isEIP1271',
  'isPremium',
  'premiumAsset',
  'settlementCollateralPayout',
  'settlementPayout',
  'settlementPayoutAsset',
  'signature',
  'status',
  'txHash',
  'vaultId',
] as const;

/** The spike value every extra key must echo; `gasFee`, `signature` and `isEIP1271` are not checked. */
export const EXPECTED_EXTRA_VALUES: Record<string, '' | false> = {
  fees: '',
  isPremium: false,
  premiumAsset: '',
  settlementCollateralPayout: '',
  settlementPayout: '',
  settlementPayoutAsset: '',
  status: '',
  txHash: '',
  vaultId: '',
};

type FieldKind = 'address' | 'uint' | 'bool' | 'hex';

const FIELD_KINDS: Record<keyof ConfirmBody, FieldKind> = {
  assetAddress: 'address',
  chainId: 'uint',
  expiry: 'uint',
  isPut: 'bool',
  isTakerBuy: 'bool',
  maker: 'address',
  price: 'uint',
  quantity: 'uint',
  quoteNonce: 'uint',
  quoteSignature: 'hex',
  quoteValidUntil: 'uint',
  validUntil: 'uint',
  strike: 'uint',
  taker: 'address',
  usd: 'address',
  collateralAsset: 'address',
  collateralAmount: 'uint',
  nonce: 'uint',
};

const EXTRA_KEYS: ReadonlySet<string> = new Set(GAS_ECHO_EXTRA_KEYS);

/** A decimal uint string or a non-negative safe integer as a bigint; `undefined` for anything else. */
function uintValue(value: unknown): bigint | undefined {
  if (typeof value === 'string') return UINT.test(value) ? BigInt(value) : undefined;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
  return undefined;
}

function equalByKind(kind: FieldKind, sent: unknown, echoed: unknown): boolean {
  switch (kind) {
    case 'address':
      return (
        typeof sent === 'string' &&
        typeof echoed === 'string' &&
        isAddress(sent, { strict: false }) &&
        isAddress(echoed, { strict: false }) &&
        isAddressEqual(sent, echoed)
      );
    case 'uint': {
      const value = uintValue(sent);
      return value !== undefined && value === uintValue(echoed);
    }
    case 'bool':
      return typeof sent === 'boolean' && sent === echoed;
    case 'hex':
      return (
        typeof sent === 'string' &&
        typeof echoed === 'string' &&
        isHex(sent) &&
        isHex(echoed) &&
        sent.toLowerCase() === echoed.toLowerCase()
      );
  }
}

/**
 * Where the `/api/gas` echo departs from the body we sent, in order: each sent field missing or unequal by
 * kind (its name), then each echoed key outside the known extras (`extra:<key>`) and each known extra
 * with an unexpected value (`extra-value:<key>`). Empty when the echo is exactly what the spike showed.
 */
export function echoMismatches(sent: ConfirmBody, echoed: Record<string, unknown>): string[] {
  const mismatches: string[] = [];
  const sentFields: Record<string, unknown> = sent;
  for (const [key, kind] of Object.entries(FIELD_KINDS)) {
    // A missing field reads as `undefined`, which equals nothing.
    if (!equalByKind(kind, sentFields[key], echoed[key])) mismatches.push(key);
  }
  for (const [key, value] of Object.entries(echoed)) {
    if (Object.hasOwn(FIELD_KINDS, key)) continue;
    if (!EXTRA_KEYS.has(key)) mismatches.push(`extra:${key}`);
    else if (Object.hasOwn(EXPECTED_EXTRA_VALUES, key) && value !== EXPECTED_EXTRA_VALUES[key]) {
      mismatches.push(`extra-value:${key}`);
    }
  }
  return mismatches;
}
