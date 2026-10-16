import { readFileSync } from 'node:fs';
import { type Hex, isAddress, isAddressEqual, recoverAddress, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { decryptKeystore } from '../chain/keystore.ts';
import type { ConfirmBody, Quote } from '../domain/index.ts';
import {
  CONFIRMATION_TYPES,
  EIP712_DOMAIN,
  hashConfirmation,
  makerSignatureOk,
  normalizeV,
  QUOTE_TYPES,
  recoverQuoteSigner,
  signConfirmation,
  toConfirmationMessage,
} from './eip712.ts';

const account = privateKeyToAccount(
  decryptKeystore(
    readFileSync(new URL('../../test/fixtures/keystore-anvil0.json', import.meta.url), 'utf8'),
    'hunter2',
  ),
);

const capture = JSON.parse(
  readFileSync(new URL('../../test/fixtures/spike-capture.json', import.meta.url), 'utf8'),
) as { requests: { reply: { result: Quote } }[] };
const spikeQuotes = capture.requests.slice(0, 3).map(({ reply }) => reply.result);
const [putQuote] = spikeQuotes;
if (putQuote === undefined) throw new Error('spike-capture.json has no quotes');

const body: ConfirmBody = {
  assetAddress: putQuote.assetAddress,
  chainId: 999,
  expiry: putQuote.expiry,
  isPut: putQuote.isPut,
  isTakerBuy: false,
  maker: putQuote.maker,
  price: putQuote.price,
  quantity: putQuote.quantity,
  quoteNonce: putQuote.nonce,
  quoteSignature: putQuote.signature,
  quoteValidUntil: putQuote.validUntil,
  validUntil: putQuote.validUntil,
  strike: putQuote.strike,
  taker: account.address,
  usd: putQuote.usd,
  collateralAsset: putQuote.collateralAsset,
  collateralAmount: '1950000000',
  nonce: '1792146516346',
};

describe('EIP-712 definitions', () => {
  it('pins the rysk domain (protocol doc §9)', () => {
    expect(account.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(EIP712_DOMAIN).toEqual({
      name: 'rysk',
      version: '0.0.0',
      chainId: 999,
      verifyingContract: '0x8C8bcb6D2c0E31c5789253EcC8431cA6209B4E35',
    });
  });

  it('lists the 17 Confirmation fields in bundle order', () => {
    expect(CONFIRMATION_TYPES).toEqual({
      Confirmation: [
        { name: 'maker', type: 'address' },
        { name: 'assetAddress', type: 'address' },
        { name: 'chainId', type: 'uint256' },
        { name: 'expiry', type: 'uint64' },
        { name: 'isPut', type: 'bool' },
        { name: 'nonce', type: 'uint64' },
        { name: 'price', type: 'uint256' },
        { name: 'quantity', type: 'uint256' },
        { name: 'quoteNonce', type: 'uint64' },
        { name: 'quoteSignature', type: 'bytes' },
        { name: 'strike', type: 'uint256' },
        { name: 'taker', type: 'address' },
        { name: 'isTakerBuy', type: 'bool' },
        { name: 'usd', type: 'address' },
        { name: 'collateralAsset', type: 'address' },
        { name: 'collateralAmount', type: 'uint256' },
        { name: 'gasFee', type: 'uint256' },
      ],
    });
  });

  it('lists the 13 Quote fields in maker order', () => {
    expect(QUOTE_TYPES).toEqual({
      Quote: [
        { name: 'assetAddress', type: 'address' },
        { name: 'chainId', type: 'uint256' },
        { name: 'isPut', type: 'bool' },
        { name: 'strike', type: 'uint256' },
        { name: 'expiry', type: 'uint64' },
        { name: 'maker', type: 'address' },
        { name: 'nonce', type: 'uint64' },
        { name: 'price', type: 'uint256' },
        { name: 'quantity', type: 'uint256' },
        { name: 'isTakerBuy', type: 'bool' },
        { name: 'validUntil', type: 'uint64' },
        { name: 'usd', type: 'address' },
        { name: 'collateralAsset', type: 'address' },
      ],
    });
  });
});

describe('toConfirmationMessage', () => {
  it('maps the body to the 17 signed fields with bigint numerics and our gas fee', () => {
    expect(toConfirmationMessage(body, 1234n)).toEqual({
      maker: putQuote.maker,
      assetAddress: putQuote.assetAddress,
      chainId: 999n,
      expiry: 1792742400n,
      isPut: true,
      nonce: 1792146516346n,
      price: 1109494507915005812n,
      quantity: 25000000000000000000n,
      quoteNonce: 1792146507232583277n,
      quoteSignature: putQuote.signature,
      strike: 7800000000n,
      taker: account.address,
      isTakerBuy: false,
      usd: putQuote.usd,
      collateralAsset: putQuote.collateralAsset,
      collateralAmount: 1950000000n,
      gasFee: 1234n,
    });
  });

  it.each([
    ['nonce', ''],
    ['quoteNonce', ''],
    ['collateralAmount', ''],
    ['price', '1.5e18'],
    ['quantity', ' 25'],
    ['strike', '0x1d0'],
    ['collateralAmount', '-1'],
  ] as const)('refuses a body whose %s is %j instead of a decimal uint string', (field, value) => {
    expect(() => toConfirmationMessage({ ...body, [field]: value }, 0n)).toThrow(field);
  });
});

describe('signConfirmation', () => {
  const message = toConfirmationMessage(body, 0n);

  it('produces a signature that verifies for the keystore address under the pinned domain', async () => {
    const signature = await signConfirmation(account, message);

    await expect(
      verifyTypedData({
        address: account.address,
        domain: EIP712_DOMAIN,
        types: CONFIRMATION_TYPES,
        primaryType: 'Confirmation',
        message,
        signature,
      }),
    ).resolves.toBe(true);
    expect(signature).toMatch(/^0x[0-9a-f]{128}(1b|1c)$/);
  });

  it('signs exactly the hash that hashConfirmation reports', async () => {
    const signature = await signConfirmation(account, message);

    await expect(recoverAddress({ hash: hashConfirmation(message), signature })).resolves.toBe(
      account.address,
    );
  });

  it('binds the gas fee: the signature does not verify for another gasFee', async () => {
    const signature = await signConfirmation(account, message);

    await expect(
      verifyTypedData({
        address: account.address,
        domain: EIP712_DOMAIN,
        types: CONFIRMATION_TYPES,
        primaryType: 'Confirmation',
        message: toConfirmationMessage(body, 1n),
        signature,
      }),
    ).resolves.toBe(false);
  });
});

describe('hashConfirmation', () => {
  it('is stable across calls and changes with the gas fee', () => {
    const hash = hashConfirmation(toConfirmationMessage(body, 0n));

    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashConfirmation(toConfirmationMessage(body, 0n))).toBe(hash);
    expect(hashConfirmation(toConfirmationMessage(body, 1n))).not.toBe(hash);
  });
});

describe('recoverQuoteSigner', () => {
  // All three captured makers recover exactly, which validates the pinned domain and the Quote type.
  it.each(spikeQuotes.map((quote, i) => [i, quote] as const))(
    'recovers the maker of spike quote %i',
    async (_i, quote) => {
      const signer = await recoverQuoteSigner(quote);

      expect(isAddress(signer)).toBe(true);
      expect(isAddressEqual(signer, quote.maker)).toBe(true);
    },
  );

  it('recovers someone else when a signed field is altered', async () => {
    const signer = await recoverQuoteSigner({ ...putQuote, price: `${BigInt(putQuote.price) + 1n}` });

    expect(isAddress(signer)).toBe(true);
    expect(isAddressEqual(signer, putQuote.maker)).toBe(false);
  });

  it('refuses a quote whose nonce is not a decimal uint string', async () => {
    await expect(recoverQuoteSigner({ ...putQuote, nonce: '' })).rejects.toThrow('quote nonce');
  });
});

describe('makerSignatureOk', () => {
  it('is true for a captured quote its maker signed', async () => {
    expect(await makerSignatureOk(putQuote, recoverQuoteSigner)).toBe(true);
  });

  it('is false when a signed field was altered or recovery rejects', async () => {
    const altered = { ...putQuote, price: `${BigInt(putQuote.price) + 1n}` };
    expect(await makerSignatureOk(altered, recoverQuoteSigner)).toBe(false);
    expect(await makerSignatureOk({ ...putQuote, nonce: '' }, recoverQuoteSigner)).toBe(false);
  });

  it('is null without a way to recover the signer', async () => {
    expect(await makerSignatureOk(putQuote, undefined)).toBeNull();
  });
});

describe('normalizeV', () => {
  const rs = `0x${'ab'.repeat(64)}`;

  it.each([
    ['00', '1b'],
    ['01', '1c'],
    ['1b', '1b'],
    ['1c', '1c'],
  ])('maps a trailing v of 0x%s to 0x%s', (v, expected) => {
    expect(normalizeV(`${rs}${v}` as Hex)).toBe(`${rs}${expected}`);
  });

  it('leaves a signature that is not 65 bytes unchanged', () => {
    const compact = `0x${'ab'.repeat(63)}00` as Hex;

    expect(normalizeV(compact)).toBe(compact);
  });
});
