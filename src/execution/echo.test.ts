import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConfirmBody } from '../domain/index.ts';
import { echoMismatches, parseGasFee } from './echo.ts';

const capture = JSON.parse(
  readFileSync(new URL('../../test/fixtures/spike-capture.json', import.meta.url), 'utf8'),
) as { gas: { full: { sent: ConfirmBody; body: string } } };
const sent = capture.gas.full.sent;

/** A fresh copy of the spike's `/api/gas` echo of `sent`. */
function echo(): Record<string, unknown> {
  return JSON.parse(capture.gas.full.body) as Record<string, unknown>;
}

/** Uppercases an address's hex digits, keeping the `0x` prefix. */
function upperDigits(value: unknown): string {
  return `0x${String(value).slice(2).toUpperCase()}`;
}

describe('echoMismatches', () => {
  it('accepts the spike echo of the spike body', () => {
    expect(echoMismatches(sent, echo())).toEqual([]);
  });

  it('names a field whose echoed value differs', () => {
    expect(echoMismatches(sent, { ...echo(), price: '1' })).toEqual(['price']);
  });

  it('names an address, hex or non-string field that differs', () => {
    expect(echoMismatches(sent, { ...echo(), maker: '0x000000000000000000000000000000000000cafe' })).toEqual([
      'maker',
    ]);
    expect(echoMismatches(sent, { ...echo(), quoteSignature: '0x00' })).toEqual(['quoteSignature']);
    expect(echoMismatches(sent, { ...echo(), taker: 0 })).toEqual(['taker']);
  });

  it('compares addresses case-insensitively', () => {
    const echoed = echo();
    for (const key of ['assetAddress', 'maker', 'taker', 'usd', 'collateralAsset']) {
      echoed[key] = upperDigits(echoed[key]);
    }
    expect(echoMismatches(sent, echoed)).toEqual([]);
  });

  it('compares the quote signature case-insensitively', () => {
    expect(echoMismatches(sent, { ...echo(), quoteSignature: upperDigits(sent.quoteSignature) })).toEqual([]);
  });

  it('compares uints by value, from a decimal string or a safe integer only', () => {
    expect(
      echoMismatches(sent, { ...echo(), expiry: String(sent.expiry), nonce: Number(sent.nonce) }),
    ).toEqual([]);
    expect(
      echoMismatches(sent, {
        ...echo(),
        price: Number(sent.price),
        quantity: '25e18',
        strike: '-7800000000',
      }),
    ).toEqual(['price', 'quantity', 'strike']);
  });

  it('compares bools strictly', () => {
    expect(echoMismatches(sent, { ...echo(), isPut: 'true', isTakerBuy: 0 })).toEqual([
      'isPut',
      'isTakerBuy',
    ]);
  });

  it('treats a missing field as a mismatch', () => {
    const echoed = echo();
    delete echoed.nonce;
    expect(echoMismatches(sent, echoed)).toEqual(['nonce']);
  });

  it('names an unknown extra key', () => {
    expect(echoMismatches(sent, { ...echo(), foo: 1 })).toEqual(['extra:foo']);
  });

  it('names a known extra key with an unexpected value', () => {
    expect(echoMismatches(sent, { ...echo(), isPremium: true })).toEqual(['extra-value:isPremium']);
    expect(echoMismatches(sent, { ...echo(), txHash: '0x01' })).toEqual(['extra-value:txHash']);
  });

  it('does not check the values of gasFee, signature and isEIP1271', () => {
    expect(echoMismatches(sent, { ...echo(), gasFee: '1234', signature: '0x01', isEIP1271: true })).toEqual(
      [],
    );
  });
});

describe('parseGasFee', () => {
  it('reads a decimal uint string, with an empty or missing fee as zero', () => {
    expect(parseGasFee({ gasFee: '0' })).toBe(0n);
    expect(parseGasFee({ gasFee: '1234' })).toBe(1234n);
    expect(parseGasFee({ gasFee: '' })).toBe(0n);
    expect(parseGasFee({})).toBe(0n);
  });

  it('returns null for any other fee', () => {
    expect(parseGasFee({ gasFee: '1.5' })).toBeNull();
    expect(parseGasFee({ gasFee: 12 })).toBeNull();
    expect(parseGasFee({ gasFee: null })).toBeNull();
  });
});
