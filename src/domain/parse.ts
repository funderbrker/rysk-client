import { type Address, getAddress, isAddress } from 'viem';

// Hand-written validators shared by the domain's API parsers (the domain does not use zod). Each returns
// `undefined` for an invalid value so callers decide whether to drop, warn or throw.

export type JsonObject = Record<string, unknown>;

export const UINT = /^[0-9]+$/;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function uintOf(value: unknown): bigint | undefined {
  return typeof value === 'string' && UINT.test(value) ? BigInt(value) : undefined;
}

/** Checksummed with `getAddress`; any input casing is accepted. */
export function addressOf(value: unknown): Address | undefined {
  return typeof value === 'string' && isAddress(value, { strict: false }) ? getAddress(value) : undefined;
}
