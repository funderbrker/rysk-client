import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { ConfirmBody, Quote } from '../domain/index.ts';
import { buildConfirmBody, buildConfirmParams, gasPreviewBody } from './body.ts';

const capture = JSON.parse(
  readFileSync(new URL('../../test/fixtures/spike-capture.json', import.meta.url), 'utf8'),
) as {
  requests: [{ reply: { result: Quote } }, ...unknown[]];
  gas: { full: { sent: ConfirmBody; body: string } };
};
const quote = capture.requests[0].reply.result;
const sent = capture.gas.full.sent;
const echoed = JSON.parse(capture.gas.full.body) as Record<string, unknown>;

const TAKER: Address = '0x00000000000000000000000000000000000000a1';
const NONCE_MS = 1792146600000;
const SIGNATURE: Hex = '0x01';

describe('buildConfirmBody', () => {
  it('builds the spike body from the spike put quote, with our taker and nonce', () => {
    const body = buildConfirmBody({ quote, taker: TAKER, collateralAmount: 1950000000n, nonceMs: NONCE_MS });

    expect(body.taker).toBe(TAKER);
    expect(body.nonce).toBe(String(NONCE_MS));
    expect({ ...body, taker: sent.taker, nonce: sent.nonce }).toEqual(sent);
  });
});

describe('gasPreviewBody', () => {
  it('has exactly the nine preview fields', () => {
    expect(Object.keys(gasPreviewBody(quote)).sort()).toEqual(
      [
        'assetAddress',
        'chainId',
        'collateralAsset',
        'expiry',
        'isPut',
        'price',
        'quantity',
        'strike',
        'usd',
      ].sort(),
    );
  });
});

describe('buildConfirmParams', () => {
  it('sends our body, the echoed extras, our gas fee and our signature', () => {
    const params = buildConfirmParams(sent, echoed, 0n, SIGNATURE);

    expect(params).toEqual({ ...echoed, ...sent, gasFee: '0', isEIP1271: false, signature: SIGNATURE });
    expect(params.isPremium).toBe(false);
  });

  it('spreads the echoed extras first and our body over them', () => {
    // A body field the echo also carries as an extra keeps our value.
    const body = { ...sent, vaultId: 'ours' } as ConfirmBody;
    const params = buildConfirmParams(body, { ...echoed, vaultId: 'echoed' }, 0n, SIGNATURE);

    expect(params.vaultId).toBe('ours');
    const keys = Object.keys(params);
    expect(keys.indexOf('fees')).toBeLessThan(keys.indexOf('assetAddress'));
  });

  it('takes only allowlisted extras from the echo', () => {
    const params = buildConfirmParams(sent, { ...echoed, price: '1', foo: 1, gasFee: '9' }, 7n, SIGNATURE);

    expect(params.price).toBe(sent.price);
    expect(params.gasFee).toBe('7');
    expect(params).not.toHaveProperty('foo');
  });
});
