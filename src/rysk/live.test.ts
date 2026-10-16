import { readFileSync } from 'node:fs';
import { isAddressEqual } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCaps } from '../domain/caps.ts';
import { CHAIN_ID, TOKENS, TRADED_PRODUCTS, ZERO_ADDRESS } from '../domain/constants.ts';
import { hypeAsset, parseAssets, parseInventory } from '../domain/inventory.ts';
import type { Listing, Quote, QuoteRequest } from '../domain/types.ts';
import { gasPreviewBody } from '../execution/body.ts';
import { makerSignatureOk, recoverQuoteSigner } from './eip712.ts';
import { RyskRest } from './rest.ts';
import { JsonRpcSocket } from './socket.ts';
import { RyskTaker } from './taker.ts';

// Opt-in smoke tests against the production Rysk API (spec §11), run by `pnpm test:live`: read-only REST, one
// zero-address RFQ and one gas preview. Nothing is signed and `confirm` is never called.

const example = JSON.parse(readFileSync(new URL('../../config.example.json', import.meta.url), 'utf8')) as {
  rysk: { restUrl: string; wsUrl: string };
};
const QUANTITY_E18 = 25n * 10n ** 18n;
const RFQ_TIMEOUT_MS = 15_000;
const MAX_QUOTE_TTL_SEC = 3_600;
const TARGET_ABS_DELTA = 0.25;
const NETWORK_TEST_MS = 30_000;
/** The RFQ server's refusal of a strike it no longer lists, for a taker without custom-strike volume (doc §5.3). */
const CUSTOM_STRIKE_REFUSAL = /custom strikes require/i;

/** Opt-in: `RYSK_LIVE_TESTS=1` (`pnpm test:live`); any other value leaves the network alone. */
const LIVE = process.env.RYSK_LIVE_TESTS === '1';

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** The nearest expiry's USDC put whose `|delta|` is nearest 0.25. */
function nearestQuarterDeltaPut(listings: Listing[]): Listing {
  const puts = listings.filter(
    (listing) =>
      listing.isPut &&
      listing.products.some(
        (product) =>
          isAddressEqual(product.strikeAsset, TRADED_PRODUCTS.put.strikeAsset) &&
          isAddressEqual(product.collateralAsset, TRADED_PRODUCTS.put.collateralAsset),
      ),
  );
  const nearestSec = Math.min(...puts.map((listing) => listing.expirySec));
  const distance = (listing: Listing): number => Math.abs(Math.abs(listing.delta) - TARGET_ABS_DELTA);
  const [best] = puts.filter((l) => l.expirySec === nearestSec).sort((a, b) => distance(a) - distance(b));
  if (best === undefined) throw new Error('no listed HYPE put in USDC');
  return best;
}

describe.skipIf(!LIVE)('Rysk production API (read-only; never confirms)', () => {
  const rest = new RyskRest({ baseUrl: example.rysk.restUrl });
  const socket = new JsonRpcSocket({ url: example.rysk.wsUrl });
  const taker = new RyskTaker(socket, { nowSec, nowMs: () => Date.now() });
  let quote: Quote | undefined;

  /** The HYPE listings as the inventory lists them now. */
  async function currentListings(): Promise<Listing[]> {
    const inventory = parseInventory(await rest.inventory(), {
      underlyingSymbol: 'HYPE',
      underlying: TOKENS.WHYPE.address,
      observedAtSec: nowSec(),
    });
    return inventory.listings;
  }

  afterAll(() => socket.close());

  it(
    'parses every asset, listing and cap',
    async () => {
      const [assetsJson, inventoryJson, capsJson] = await Promise.all([
        rest.assets(),
        rest.inventory(),
        rest.caps(),
      ]);
      const assets = parseAssets(assetsJson, CHAIN_ID);
      const inventory = parseInventory(inventoryJson, {
        underlyingSymbol: 'HYPE',
        underlying: TOKENS.WHYPE.address,
        observedAtSec: nowSec(),
      });
      const caps = parseCaps(capsJson);
      expect({ assets: assets.dropped, listings: inventory.dropped, caps: caps.dropped }).toEqual({
        assets: 0,
        listings: 0,
        caps: 0,
      });
      expect(hypeAsset(assets.assets).minTradeSizeE18).toBe(QUANTITY_E18);
      expect(inventory.listings.length).toBeGreaterThan(0);
      expect(caps.caps.length).toBeGreaterThan(0);
    },
    NETWORK_TEST_MS,
  );

  it(
    'answers a zero-address RFQ for the nearest ~0.25-delta put with a maker-signed quote, or times out',
    async (ctx) => {
      // Read just before the RFQ: Rysk re-lists strikes about once a minute, and the server refuses an unlisted
      // one from the zero address as a custom strike.
      const listing = nearestQuarterDeltaPut(await currentListings());
      const request: QuoteRequest = {
        asset: TOKENS.WHYPE.address,
        assetName: TOKENS.WHYPE.symbol,
        chainId: CHAIN_ID,
        expiry: listing.expirySec,
        isPut: true,
        quantity: QUANTITY_E18.toString(),
        strike: listing.strikeE8.toString(),
        taker: ZERO_ADDRESS,
        usd: TOKENS.USDC.address,
        collateralAsset: TOKENS.USDC.address,
        isEIP1271: false,
      };
      const result = await taker.requestQuote(request, { timeoutMs: RFQ_TIMEOUT_MS });
      if (!result.ok && result.error === 'rpc-error' && CUSTOM_STRIKE_REFUSAL.test(result.message)) {
        ctx.skip(`the strike was de-listed between the inventory read and the RFQ: ${result.message}`);
      }
      if (!result.ok) {
        expect(result.error).toBe('timeout');
        return;
      }
      const atSec = nowSec();
      expect(result.quote.validUntil).toBeGreaterThan(atSec);
      expect(result.quote.validUntil).toBeLessThanOrEqual(atSec + MAX_QUOTE_TTL_SEC);
      expect(await makerSignatureOk(result.quote, recoverQuoteSigner)).toBe(true);
      quote = result.quote;
    },
    NETWORK_TEST_MS,
  );

  it(
    "previews the quote's gas fee",
    async (ctx) => {
      if (quote === undefined) ctx.skip();
      const gas = await rest.gasFee(gasPreviewBody(quote as Quote));
      expect(gas.ok).toBe(true);
    },
    NETWORK_TEST_MS,
  );
});
