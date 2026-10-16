import { type Address, formatUnits } from 'viem';
import type { AppConfig } from '../daemon/index.ts';
import { aprFraction, aprFractionFromRyskApy, collateral6For } from '../domain/apr.ts';
import { CHAIN_ID, TOKENS, tokenBySymbol } from '../domain/constants.ts';
import { hypeAsset, parseAssets } from '../domain/inventory.ts';
import type { Quote, QuoteRequest } from '../domain/types.ts';
import { formatStrike, premium6 } from '../domain/units.ts';
import { gasPreviewBody } from '../execution/body.ts';
import { makerSignatureOk, recoverQuoteSigner } from '../rysk/eip712.ts';
import { type GasResult, RyskRest } from '../rysk/rest.ts';
import { JsonRpcSocket } from '../rysk/socket.ts';
import { RyskTaker } from '../rysk/taker.ts';
import type { QuoteCommand } from './args.ts';
import { printFields } from './format.ts';

/** An 18-dp asset price as an 8-dp spot. */
const E10 = 10n ** 10n;

/**
 * `rysk quote` (spec §9.6): one RFQ for the instrument with the configured account as the taker, then its gas preview
 * and maker signature check. Prints the price, the premium, the gas, the TTL, our APR gross and net of gas (on the
 * strike for a put, on HYPE spot for a call) beside Rysk's, and the maker. Never signs or confirms.
 */
export async function quoteCommand(cmd: QuoteCommand, config: AppConfig): Promise<number> {
  const rest = new RyskRest({ baseUrl: config.rysk.restUrl });
  const socket = new JsonRpcSocket({ url: config.rysk.wsUrl });
  const nowSec = (): number => Math.floor(Date.now() / 1000);
  const taker = new RyskTaker(socket, { nowSec, nowMs: () => Date.now() });
  const request = quoteRequest(cmd, config.account.address);
  try {
    const [result, assets] = await Promise.all([
      taker.requestQuote(request, { timeoutMs: config.wheel.quoting.rfqTimeoutMs }),
      rest.assets(),
    ]);
    if (!result.ok) {
      process.stderr.write(`rysk quote: no quote (${result.error}): ${result.message}\n`);
      return 1;
    }
    const { quote } = result;
    const spotE8 = hypeAsset(parseAssets(assets).assets).priceE18 / E10;
    const [gas, makerSigOk] = await Promise.all([
      gasOf(rest, quote),
      makerSignatureOk(quote, recoverQuoteSigner),
    ]);
    printQuote(cmd, request, quote, { spotE8, gas, makerSigOk, nowSec: nowSec() });
    return 0;
  } finally {
    socket.close();
  }
}

/** The RFQ in the strategy's wire format; a call's `assetName` is its collateral's symbol (the app's). */
function quoteRequest(cmd: QuoteCommand, taker: Address): QuoteRequest {
  const collateral = tokenBySymbol(cmd.collateral);
  return {
    asset: TOKENS.WHYPE.address,
    assetName: cmd.side === 'put' ? TOKENS.WHYPE.symbol : collateral.symbol,
    chainId: CHAIN_ID,
    expiry: cmd.expirySec,
    isPut: cmd.side === 'put',
    quantity: cmd.quantityE18.toString(),
    strike: cmd.strikeE8.toString(),
    taker,
    usd: tokenBySymbol(cmd.usd).address,
    collateralAsset: collateral.address,
    isEIP1271: false,
  };
}

type Priced = { spotE8: bigint; gas: GasResult | Error; makerSigOk: boolean | null; nowSec: number };

function printQuote(cmd: QuoteCommand, request: QuoteRequest, quote: Quote, p: Priced): void {
  const priceE18 = BigInt(quote.price);
  const gross6 = premium6(cmd.quantityE18, priceE18);
  const collateral6 = collateral6For(cmd.side, cmd.quantityE18, cmd.strikeE8, p.spotE8);
  const aprOf = (net6: bigint): string =>
    percent(() => aprFraction(net6, collateral6, p.nowSec, quote.expiry));
  const gasFee6 = p.gas instanceof Error || !p.gas.ok ? null : p.gas.gasFee6;
  const gasText =
    p.gas instanceof Error
      ? `unavailable: ${p.gas.message}`
      : p.gas.ok
        ? `${formatUnits(p.gas.gasFee6, 6)} USD (preview)`
        : `unavailable: ${p.gas.reason} (HTTP ${p.gas.status})`;
  const net = gasFee6 === null ? '' : `, ${aprOf(gross6 - gasFee6)} net of gas`;
  printFields([
    ['side', cmd.side],
    ['strike', `${formatStrike(cmd.strikeE8)} USD`],
    ['expiry', `${quote.expiry} (${new Date(quote.expiry * 1000).toISOString()})`],
    ['quantity', `${formatUnits(cmd.quantityE18, 18)} contracts`],
    ['collateral', `${cmd.collateral} (usd ${cmd.usd})`],
    ['taker', request.taker],
    ['maker', quote.maker],
    ['makerSigOk', String(p.makerSigOk)],
    ['price', `${formatUnits(priceE18, 18)} USD a contract`],
    ['premium', `${formatUnits(gross6, 6)} USD`],
    ['gasFee', gasText],
    ['ttl', `${quote.validUntil - p.nowSec} s (validUntil ${quote.validUntil})`],
    ['apr', `${aprOf(gross6)} gross${net}; Rysk ${percent(() => aprFractionFromRyskApy(quote.apy))}`],
    ['spot', `${formatStrike(p.spotE8)} USD`],
    ['nonce', quote.nonce],
  ]);
}

async function gasOf(rest: RyskRest, quote: Quote): Promise<GasResult | Error> {
  try {
    return await rest.gasFee(gasPreviewBody(quote));
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** A fraction as a percentage for display, 2 decimals; `n/a` when it cannot be computed. */
function percent(fraction: () => number): string {
  try {
    return `${(fraction() * 100).toFixed(2)} %`;
  } catch {
    return 'n/a';
  }
}
