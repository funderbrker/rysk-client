import type { Address, Hex } from 'viem';
import { CHAIN_ID } from '../domain/constants.ts';
import type { ConfirmBody, ConfirmParams, GasPreviewBody, Quote } from '../domain/types.ts';
import { GAS_ECHO_EXTRA_KEYS } from './echo.ts';

/**
 * Our confirm body for selling `quote` (spec §7.3). `quoteValidUntil` and `validUntil` are both the quote's
 * `validUntil`, as the app sends; neither is signed.
 */
export function buildConfirmBody(a: {
  quote: Quote;
  taker: Address;
  collateralAmount: bigint;
  nonceMs: number;
}): ConfirmBody {
  const { quote, taker, collateralAmount, nonceMs } = a;
  return {
    assetAddress: quote.assetAddress,
    chainId: CHAIN_ID,
    expiry: quote.expiry,
    isPut: quote.isPut,
    isTakerBuy: false,
    maker: quote.maker,
    price: quote.price,
    quantity: quote.quantity,
    quoteNonce: quote.nonce,
    quoteSignature: quote.signature,
    quoteValidUntil: quote.validUntil,
    validUntil: quote.validUntil,
    strike: quote.strike,
    taker,
    usd: quote.usd,
    collateralAsset: quote.collateralAsset,
    collateralAmount: collateralAmount.toString(),
    nonce: String(nonceMs),
  };
}

/** The app's 9-field gas preview body (spec §7.4), used when evaluating a quote. */
export function gasPreviewBody(quote: Quote): GasPreviewBody {
  return {
    assetAddress: quote.assetAddress,
    chainId: CHAIN_ID,
    isPut: quote.isPut,
    collateralAsset: quote.collateralAsset,
    expiry: quote.expiry,
    strike: quote.strike,
    usd: quote.usd,
    price: quote.price,
    quantity: quote.quantity,
  };
}

/** The echo's known extra keys with their echoed values; nothing else from the echo is kept. */
function allowlistedExtras(echoed: Record<string, unknown>): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const key of GAS_ECHO_EXTRA_KEYS) {
    if (Object.hasOwn(echoed, key)) extras[key] = echoed[key];
  }
  return extras;
}

/**
 * The `confirm` params: the echo's allowlisted extras as the app sends them, then our body over them (so every
 * signed field is ours and no echoed value can replace a body field), then our gas fee, `isEIP1271: false` and
 * our signature.
 */
export function buildConfirmParams(
  body: ConfirmBody,
  echoed: Record<string, unknown>,
  gasFee6: bigint,
  signature: Hex,
): ConfirmParams {
  return { ...allowlistedExtras(echoed), ...body, gasFee: gasFee6.toString(), isEIP1271: false, signature };
}
