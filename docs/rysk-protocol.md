# Rysk V12 protocol reference (seller / taker, HyperEVM)

This is a reference for integrating with **Rysk V12 on HyperEVM (chain 999) as an option seller** ("taker"), written for maintainers of this repository and for anyone implementing the TypeScript client.

Rysk publishes no taker API spec. Most of what follows was reverse-engineered from the production web app and checked against live read-only traffic on **2026-10-16**. Read it as a map, not a contract. Before relying on anything marked `inferred` with real funds, verify it.

## Provenance tags

| Tag | Meaning |
|---|---|
| `docs` | Official Rysk docs at docs.rysk.finance (read 2026-10-16) |
| `bundle` | Reverse-engineered from the app.rysk.finance production JS bundle: Vercel deployment `dpl_FkTjweSkCa3qo6eh4iVWoEayUKpt`, commit `6b13834452f228d8e772f9f8d019f6eba8ae96d4` |
| `live` | Observed live on 2026-10-16 through read-only REST GETs, read-only WS methods and public RPC reads. Nothing was signed or submitted during this research. A later dry-run validation the same day added `request` RFQs, gas previews and full-body `/api/gas` calls from this repository's client; it signed nothing and never sent `confirm`. |
| `inferred` | Our own reasoning from the sources above; not confirmed |
| `hyperliquid` | HyperEVM chain facts from Hyperliquid's documentation |

When one source covers a whole section, the tag is given once at the top of that section. App behaviour changes when the bundle changes, and `https://app.rysk.finance/api/version/` returns the deployed `sha`. If that `sha` stops matching the commit above, re-check the `bundle` facts here.

## 1. Protocol model

- Rysk V12 is a **request-for-quote (RFQ) market for selling European options**. It offers two products, covered calls (CC) and cash-secured puts (CSP). `docs`
- Users are **takers** (sellers). The buyers are market makers ("makers"), whitelisted for now. `docs`
- A taker RFQ opens an auction of about **2 s**. Makers submit EIP-712-signed quotes, and the taker receives **only the single best quote**. `docs` `bundle`
- Every position is **fully collateralised and physically settled**. Collateral stays locked in the Rysk MarginPool until expiry. There are no liquidations, no rehypothecation and **no early close** (a secondary market is planned but not available). `docs`
- The **premium is paid up front** in a stablecoin, in the same transaction that locks the collateral. `docs` `live`
- **Expiry is Friday 08:00 UTC.** Strikes and expiries mirror Deribit. `docs`
- **Settlement is automatic** and the seller does nothing. Funds usually arrive within about 2 h of expiry. The reference price is the Stork index, cross-checked against Pyth, followed by a 5-minute dispute window that the contract enforces. `docs`
- The options are Opyn/Rysk Gamma oTokens. The seller never holds them: they are minted and credited to the maker inside the MMarket accounting contract. `docs` `live`
- **Rysk's relayer submits the trade on-chain.** The seller signs an EIP-712 `Confirmation`, and the backend sends the transaction and returns its hash. The only transaction a seller ever sends is an ERC-20 `approve` of the collateral to the MarginPool. `bundle` `live`
- **There is no authentication**: no API keys, no sessions, no SIWE. Write actions are authorised only by EIP-712 signatures. `bundle` `live`

| At expiry | Covered call (collateral = underlying) | Cash-secured put (collateral = strike x qty in stablecoin) |
|---|---|---|
| OTM | Underlying collateral returned | Stablecoin collateral returned |
| ITM | Seller receives strike x qty in the stablecoin; the collateral goes to the buyer | Seller receives qty of the underlying (WHYPE); the stablecoin goes to the buyer |

The seller keeps the premium either way. Only the price at expiry matters; touching the strike earlier has no effect. `docs`

## 2. Products on HyperEVM

A product is the tuple (underlying, `isPut`, collateral token, premium stablecoin `usd`). The `usd` token is also the strike currency. The HYPE products below come from `/api/assets`, `/api/products` and the inventory `products` arrays. `live`

| Side | RFQ `asset` | `collateralAsset` | `usd` | State |
|---|---|---|---|---|
| Call | WHYPE | WHYPE | USDC | active |
| Call | WHYPE | kHYPE | USDC | active |
| Call | WHYPE | wstHYPE | USDC | active |
| Call | WHYPE | LHYPE | USDC | active |
| Call | WHYPE | kHYPE-PT, kHYPE-PT-19MAR26 | USDC | asset entries `active: false` |
| Put | WHYPE | USDC | USDC | active |
| Put | WHYPE | USDT0 | USDT0 | active |

- With alternative collateral (kHYPE, wstHYPE, LHYPE), the strike is still USD per underlying, but physical delivery happens in the collateral asset. The docs say the premium is expected to reflect this. `docs`
- Settled positions show that HYPE calls once also used USDT0 as `usd`. Today HYPE calls are USDC only. `live`
- The HYPE inventory at probe time had **4 expiries** (3 weeklies and the 27NOV26 monthly) and **12 strikes per expiry**: 6 OTM puts below spot and 6 OTM calls above it, on a $0.50 grid. Spot was about $81.5. `live`
- Other HyperEVM underlyings (BTC, ETH, SOL, PURR, PUMP, XRP, ZEC) are listed in §12. Ethereum mainnet (chain 1) also runs V12 and is out of scope here.

## 3. Units and number formats

Large numbers travel as **decimal strings**. Parse them to `bigint` and never route amounts through JS floats. The floats in `inventory` (strike, apy, delta, index) are for display only.

| Quantity | Unit | Where | Example |
|---|---|---|---|
| `quantity` | **e18 contracts**. 1 contract = 1 unit of underlying, whatever the token's decimals | RFQ, Quote, Confirmation, positions | `"25000000000000000000"` = 25 |
| `strike` | **e8 USD** | RFQ, Quote, Confirmation | `"7850000000"` = $78.50 |
| `strike` | **e18 USD** | positions, taker-history and history APIs | `"78500000000000000000"` = $78.50 |
| `price` | e18 USD **per contract** | Quote, Confirmation, positions | `"1900000000000000000"` = $1.90 |
| `premium` | e18-scaled USD, **truncated to 6 dp** (the amount actually transferred) | positions, history | `"47500000000000000000"` |
| `income` | e18 USD, full precision (`quantity x price / 1e18`) | taker-history | `"35169380164060983000"` |
| `collateralAmount` | call: collateral token base units; put: **6-dp stablecoin units** | Confirmation, approve | `"1962500000"` = 1962.5 USDC |
| `gasFee` | 6-dp USD | `/api/gas`, Confirmation | `"0"` |
| `fees` | 6-dp USD paid by the **maker** (`"0"` in user positions) | `/api/history` | `"5937500"` |
| Expiry prices | **1e8 USD** strings; `"0"` = not published | `/api/expiry-prices` | `"8118577121"` = $81.18577121 |
| `expiry`, `createdAt`, `validUntil` | unix **seconds** | everywhere | `1793347200` |
| `auctionDeadline` | unix **milliseconds** | public RFQ channel | `1792143326721` |
| `nonce` (Confirmation) | ms timestamp as a decimal string (uint64) | Confirmation | `String(Date.now())` |
| `quoteNonce` | maker's uint64 as a string | Quote `nonce` | |
| Asset `price` | e18 USD (spot) | `assets` | `"81520940680000000000"` |
| Caps `cap` / `usage` | e18 (contracts, or USD notional) | `caps`, `/api/products` | |
| `apr` | percent string with 2 dp | positions | `"63.15"` |
| `apy` | percent number | inventory, Quote | `7.2167` |
| oToken amounts | 8 decimals (Gamma convention) | on-chain only | `2500000000` = 25 |

Token decimals: WHYPE 18, USDC 6, USDT0 6 (§12). The put collateral formula hard-codes 6 dp for the stablecoin. `bundle`

## 4. Endpoints

| URL | Purpose | Source |
|---|---|---|
| `wss://v12.rysk.finance/taker` | Taker JSON-RPC: reads, RFQ, confirm | `bundle` `live` |
| `wss://v12.rysk.finance/rfqs/<assetAddress>` | Public, server-pushed mirror of every RFQ for an asset (no prices) | `live` |
| `wss://v12.rysk.finance/maker` | Maker JSON-RPC; sellers do not use it | `bundle` `docs` |
| `https://v12.rysk.finance` | REST (§7) | `bundle` `live` |
| `https://premium.rysk.finance` | Rysk **Premium**, a separate vault product with a different EIP-712 domain. Not part of the V12 taker flow | `bundle` |
| `https://rpc.hyperliquid.xyz/evm` | HyperEVM public JSON-RPC (HTTP only, no WS) | `bundle` `hyperliquid` |
| `https://hyperevmscan.io` | Block explorer | `bundle` |

The bundle hard-codes the production base `https://v12.rysk.finance`. Chain 998 testnet constants exist, but the testnet WS base is not in this build, and testnet quoting is negligible. `bundle` `live`

## 5. Taker WebSocket

Sources: `bundle`, `live`.

### 5.1 Envelope and the `id` quirk

Every message is JSON-RPC 2.0. **The `id` of each client message is the method name itself**, and the server echoes it. The app's dispatcher switches on `id`, not on `method`.

```json
{"jsonrpc":"2.0","method":"caps","id":"caps","params":{}}
{"jsonrpc":"2.0","id":"caps","result":[ ... ]}
{"jsonrpc":"2.0","id":"probe","error":{"code":-32601,"message":"Method not found"}}
```

What this means for a client:

- Two in-flight calls of the same method cannot be told apart by `id`. Either keep **one outstanding `request` per socket**, or open several sockets for parallel scans (`inferred`).
- Check every Quote field against the RFQ that produced it: `assetAddress`, `chainId`, `expiry`, `isPut`, `strike`, `quantity`, `usd`, `collateralAsset`, and `isTakerBuy === false`. The app itself discards a quote whose `strike` is not the selected one. `bundle`
- Send `params: {}` for methods without parameters (verified live). The connection needs no headers, cookies or auth. `live`

### 5.2 Methods on `/taker`

This is the method enum from the bundle (module 70582). `live` marks methods answered during probing.

| Method | Params | Result | Seller use |
|---|---|---|---|
| `assets` | `{}` | `Assets` | Yes: sizes, decimals, addresses (`live`) |
| `inventory` | `{}` | `Inventory` | Yes: listed strikes and expiries, indicative APY (`live`) |
| `caps` | `{}` | `Cap[]` | Yes: capacity pre-check (`live`) |
| `request` | `QuoteParams` | `Quote` | Yes: RFQ, answered once with the best quote |
| `confirm` | `ConfirmParams` | tx hash (`Hex`) | Yes: execute the trade |
| `positions` | `{ address }` | `Position[]` | Yes: the same rows as `/api/user/positions` (`live`) |
| `is_referee` | `{ account }` | `boolean` | Optional (`live`) |
| `get_referral` | `{ account }` | referral code `string` | Optional (`live`) |
| `referees_count` | `{ account }` | count | No |
| `create_referral` | `{ account, code, chainId, signature }` (signed `Referral{code}`) | | No |
| `leaderboard`, `maker_leaderboard` | `{}` | ranked list | No (`live`) |
| `deposit`, `withdraw`, `will_redeem` | signed `Transfer` / `WillRedeem` | | Maker-side MMarket operations; a seller never needs them |

### 5.3 Zero-address RFQs

`request` works with `taker = 0x0000000000000000000000000000000000000000` and returns a real, maker-signed best quote. The web app does exactly this for every visitor with no wallet connected, so the public RFQ stream is mostly price discovery. `bundle` `live`

This makes zero-address RFQs fine for dry runs and quote recording. Before a live trade, though, re-request with the real taker address: the app does the same, because a change of taker triggers a fresh RFQ. The maker's `Quote` struct does not contain the taker (§9), but whether the server binds a quote to the requesting taker is unknown. `inferred`

Observed from Node in the validation run. `live`
- **Node works.** Node's built-in WebSocket (undici) works without an `Origin` header, cookies or any other header, both with the zero address and with a real taker. One sampler connection was dropped once with close code 1006 and reconnected; a sandbox proxy may explain it.
- **Checksummed addresses.** The server accepts EIP-55 checksummed addresses in `request` (the app sends lowercase), and `/api/gas` echoes them in the form sent.
- **Taker pricing.** One taker pair, the same instrument quoted for a real taker and for the zero address back to back, was priced by the same maker 0.000003 USD apart. That is one sample, not a rule.
- **Custom strikes.** A strike that is not in the current inventory for that expiry is a custom strike. For a taker without enough trading volume, `request` answers it with a JSON-RPC error: `{"code":-32603,"message":"custom strikes require >= 250000 notional volume (have 0)"}`. The volume is per taker address: a taker with enough volume was quoted an unlisted strike. The same strike was quoted from the zero address once the inventory listed it again. A few strikes were still quoted shortly after they left the inventory, presumably within the server's refresh lag. `inferred` for the exact rule.

### 5.4 Heartbeat, reconnect, cadence

- There is no application-level ping. The app runs a watchdog every 5 s: if nothing has arrived for **30 s**, it calls `close(4000, "heartbeat")` and reconnects. Its other close codes are `4001 "visibility"`, `4002 "online"` and `4003 "onerror"`. `bundle`
- The watchdog only works because the app polls (inventory every 2 s), which keeps responses flowing. A client that does not poll should send a cheap call such as `caps` on a timer and apply the same 30 s rule. Server-side idle timeouts are unknown. `inferred`
- Reconnect backoff is `min(30 s, 1 s * 2^n)` with ±25 % jitter. The connection is declared OPEN only 500 ms after `onopen`, which also resets the attempt counter. `bundle`
- `/taker` holds no session state (no auth, no subscriptions), so after a reconnect the client just resumes polling. An RFQ that was in flight is lost and must be re-sent. **A `confirm` that was in flight has an unknown outcome.** Reconcile against `positions` and the chain before requesting and confirming again; otherwise a double fill is possible. `inferred`
- App polling cadence: `assets` 5 s, `inventory` 2 s, `caps` 30 s, `positions` 30 s and again right after a `confirm` result. The server refreshes inventory content about every **30 s**. `bundle` `live`

### 5.5 How the app re-fires RFQs

This explains the public stream; sellers need not copy it. `bundle` The app sets `quoteParams` 400 ms (debounce) after any change of amount, strike, expiry, side or taker, and sends `request` whenever those params differ from the last ones sent. Every 3 s it re-sends if it has waited at least 15 s, has no quote, or `quote.validUntil - 20 s <= now`. **There is no cancel message**: a quote simply lapses at `validUntil` (`CancelRfq` and `CancelQuote` belong to the Premium product).

### 5.6 Public RFQ channel

`wss://v12.rysk.finance/rfqs/<assetAddress>` pushes one frame per RFQ, keyed by a server-generated UUID `id`. The sample showed about 7.6 RFQ/s for WHYPE over 12 s, every one with `taker = 0x0`. Frames carry no prices. `live`

```json
{"jsonrpc":"2.0","id":"9db05fc9-ac20-4b1a-aeed-edacfbb22a95","result":{"asset":"0x5555555555555555555555555555555555555555",
 "assetName":"WHYPE","chainId":999,"expiry":1793952000,"isPut":false,"isTakerBuy":false,"quantity":"500000000000000000000",
 "strike":"8650000000","taker":"0x0000000000000000000000000000000000000000","usd":"0xb88339cb7199b77e23db6e890353e22632ba630f",
 "collateralAsset":"0x5555555555555555555555555555555555555555","auctionDeadline":1792143326721,"isPremium":false,
 "premiumAsset":"0xb88339cb7199b77e23db6e890353e22632ba630f","isEIP1271":false,
 "typeDataDomain":{"name":"rysk","version":"0.0.0","chainId":"0x3e7","verifyingContract":"0x8c8bcb6d2c0e31c5789253ecc8431ca6209b4e35","salt":""}}}
```

The server adds `isTakerBuy: false`, `auctionDeadline` (in ms, about receipt + 2.0–2.6 s), `isPremium`, `premiumAsset` and `typeDataDomain`.

## 6. Message schemas

```ts
type Address = `0x${string}`;
type Hex = `0x${string}`;

type JsonRpcReq<M extends string, P> = { jsonrpc: "2.0"; method: M; id: M; params: P }; // id === method
type JsonRpcRes<T> = { jsonrpc: "2.0"; id: string; result?: T; error?: { code: number; message: string } };

// ---- request (client -> server)                                         bundle; shape matches live frames
type QuoteParams = {
  asset: Address;           // Asset.underlyingAssetAddress: WHYPE for every HYPE product (calls with kHYPE too)
  assetName: string;        // Asset.symbol of the selected asset entry ("WHYPE", "kHYPE", ...), informational
  chainId: number;          // 999
  expiry: number;           // unix s, Friday 08:00 UTC, taken from inventory
  isPut: boolean;
  quantity: string;         // e18 contracts, a multiple of minTradeSize, within [minTradeSize, maxTradeSize]
  strike: string;           // e8 USD
  taker: Address;           // seller address, or the zero address for price discovery
  usd: Address;             // premium/strike stablecoin (USDC on 999)
  collateralAsset: Address; // call: collateral token; put: the stablecoin (== usd)
  isEIP1271: boolean;       // true if the taker is a contract wallet (eth_getCode(taker) !== "0x")
};
// The docs' maker-side Request type also has isTakerBuy; the app omits it and the server adds false.

// ---- request result                                        docs (maker Quote type) + bundle usage
type Quote = {
  assetAddress: Address;    // == QuoteParams.asset
  chainId: number; expiry: number; isPut: boolean;
  isTakerBuy: boolean;      // false for sellers
  quantity: string;         // e18, == request quantity
  strike: string;           // e8, == request strike
  maker: Address;
  nonce: string;            // maker uint64 -> Confirmation.quoteNonce
  price: string;            // e18 USD per contract; premium_6dp = quantity * price / 1e30
  validUntil: number;       // unix s
  signature: Hex;           // maker's EIP-712 Quote signature -> Confirmation.quoteSignature
  usd: Address; collateralAsset: Address;
  apy: number;              // server-computed annualised %, shown as "APR"
};

// ---- POST /api/gas body before signing (exactly what the app sends)                   bundle
type GasRequest = {
  assetAddress: Address; chainId: number; expiry: number; isPut: boolean;
  isTakerBuy: false; maker: Address; price: string; quantity: string;
  quoteNonce: string;       // Quote.nonce
  quoteSignature: Hex;      // Quote.signature
  quoteValidUntil: number;  // Quote.validUntil
  validUntil: number;       // Quote.validUntil (same value)
  strike: string;           // e8
  taker: Address;           // the signing wallet
  usd: Address; collateralAsset: Address;
  collateralAmount: string; // §10
  nonce: string;            // String(Date.now()), ms
};
// live: every sent field comes back unchanged, in the same string forms (checksummed addresses stay checksummed),
// plus exactly these 12 keys. Observed values: gasFee "0", isEIP1271 false, isPremium false; fees, premiumAsset,
// settlementCollateralPayout, settlementPayout, settlementPayoutAsset, signature, status, txHash, vaultId "".
type GasResponse = GasRequest & {
  gasFee: string;           // 6-dp USD; "0" in every observation (the bundle treats "" as "0")
  fees: string; isEIP1271: boolean; isPremium: boolean; premiumAsset: string;
  settlementCollateralPayout: string; settlementPayout: string; settlementPayoutAsset: string;
  signature: string; status: string; txHash: string; vaultId: string;
};

// ---- confirm params                                                                  bundle
type ConfirmParams = GasResponse & {
  gasFee: string;           // gasResponse.gasFee || "0", exactly the value that was signed
  isEIP1271: boolean;
  signature: Hex;           // EIP-712 Confirmation signature, 65 bytes, v in {27, 28}
  referralCode?: string;    // only if !is_referee and a code is pending
};
type ConfirmResult = Hex;   // hash of the relayer's on-chain tx

// ---- reference data                                                                  live
type Assets = Record<string /* chainId */, Asset[]>;
type Asset = {
  underlying: string;              // "HYPE"
  underlyingAssetAddress: Address; // WHYPE 0x5555...5555 -> RFQ `asset`
  address: Address;                // this entry's token (the collateral token for calls)
  symbol: string;                  // "WHYPE" | "kHYPE" | ...
  decimals: number;                // decimals of `address`
  minTradeSize: string;            // e18 contracts
  maxTradeSize: string;            // e18 contracts
  chainId: number; active: boolean;
  price: string;                   // e18 USD spot
  multipliers: { value: string; name: string }[];       // points multipliers, e.g. kHYPE "1x Kinetiq"
  marketStatus?: { isOpen: boolean; opensAt: number; closesAt: number }; // e.g. XAUT; absent for HYPE (bundle)
  strikePrecision?: string;        // e8 custom-strike step, default 1e6 = $0.01 (bundle)
};

type Inventory = Record<string /* underlying, e.g. "HYPE" */, {
  expiries: number[];                        // unix s
  strikes: Record<string, number[]>;         // per expiry. WARNING: fractional strikes truncated (78.5 -> 78)
  combinations: Record<string, Combination>; // key `${strike.toFixed(6)}-${expiry}`, e.g. "78.500000-1793347200"
}>;
type Combination = {
  expiry: string;              // "27NOV26"
  expiration_timestamp: number;
  timeToExpiryDays: number;
  strike: number;              // display float; convert via the key string, not this number
  isPut: boolean;
  delta: number;               // server pricer
  bid: number; ask: number;    // 0 for every HYPE combination: no indicative bids are published
  index: number;               // spot
  apy: number;                 // indicative %, server-computed. Real prices only come from `request`
  timestamp: number;           // unix s of the last refresh (about every 30 s)
  products: { asset: Address /* entry address, NOT the RFQ asset */; strikeAsset: Address; collateralAsset: Address }[];
};

type Cap = {
  name: string;                // "GLOBAL" | underlying symbol | Asset.address | `${Asset.address}-${isPut}`
  type: "CONTRACTS" | "NOTIONAL";
  cap: string;                 // e18; "0" = not enforced
  usage: string;               // e18
};

type Product = {               // GET /api/products
  active: boolean; asset_address: Address /* entry address */; chainId: number; is_put: boolean;
  underlying_symbol: string; usd: Address; collateral: Address;
  notionalCap: string; contractsCap: string; // e18
};
```

The `Position` schema is in §11.

## 7. REST endpoints

Base URL `https://v12.rysk.finance`. GETs need no auth. `live` unless noted otherwise.

| Path | Method | Response / notes |
|---|---|---|
| `/ping` | GET | `bong` |
| `/api/assets` | GET | `Assets` (the same as WS `assets`) |
| `/api/inventory` | GET | `Inventory` (the same as WS `inventory`, about 170 KB) |
| `/api/caps` | GET | `Cap[]` |
| `/api/products` | GET | `Product[]` |
| `/api/gas` | POST | Preview body `{assetAddress, chainId, isPut, collateralAsset, expiry, strike, usd, price, quantity}`, or the full `GasRequest` before signing → `{ gasFee, ... }`. Failures are non-2xx responses whose body text is the error; text matching `/gas fee more than premium/i` means the trade is not viable. GET returns 405. The app sends the body as a JSON string with no explicit `Content-Type` and allows 2 retries. `bundle`. **`live`:** with the full 18-field body the response is the body echoed unchanged plus exactly the 12 keys in §6's `GasResponse` (30 keys); a preview body is answered `200` too. `gasFee` was `"0"` every time, also with `Content-Type: application/json`. |
| `/api/expiry-prices/{chainId}/{underlyingAddress}` | GET | `Record<expiryUnixS, priceE8String>`. `"0"` = not yet published; the bundle also handles a `{price, verified}` form |
| `/api/user/positions?address=` | GET | `Position[]`, open and settled rows (§11) |
| `/api/taker-history?address=` | GET | JSON rows with `income` (§11). The app downloads `&type=csv`. Without `address` it returns `Invalid address` |
| `/api/user/settlement?address=&chainId=` | GET | Returned `[]` even for a wallet with settled positions; use positions instead |
| `/api/history?from=&to=` | GET | Public recent fills of all users, `Position`-shaped, with the maker `fees` (6-dp). The parameter semantics were not verified. `?address=` is the maker history (`[]` for a seller-only wallet) |
| `/api/otokens?id=` | GET | oToken details (`no id(s) passed for otoken details` without `id`) |
| `/api/maker/*`, `/api/redeem/self` | GET | Maker-side |

Outside the V12 API, the web app's own route `https://app.rysk.finance/api/version/` returns `{sha, timestamp}` (`live`: the 40-hex commit `sha` and a millisecond `timestamp`), which you can use to detect frontend redeploys. On 2026-10-16 it returned `sha` `b6fe173c52c3d7d5420b9c12586e9b1416c6d4b5`, a different commit from the one the `bundle` facts were read from, so re-check those before relying on them.

## 8. Seller trade flow

Sources: `bundle` for the app's sequence, `live` for the on-chain result.

```
seller                         Rysk /taker WS              Rysk REST           HyperEVM
  | assets / inventory / caps --> |                           |                    |
  | request(QuoteParams) -------> | ~2 s auction among makers |                    |
  | <------------- Quote (best)   |                           |                    |
  | approve(MarginPool, collateralAmount) ------------------------------------------>| (only seller tx)
  | POST /api/gas (GasRequest) ------------------------------>|                    |
  | <------------------------------------------- {..., gasFee}|                    |
  | sign EIP-712 Confirmation (local)                         |                    |
  | confirm(ConfirmParams) -----> | relayer submits trade tx ----------------------->|
  | <-------------- txHash        |                           |                    |
  | waitForTransactionReceipt(txHash) ---------------------------------------------->|
  | positions {address} --------> |                           |                    |
```

1. **Discover.** From `assets`, choose the entry for your collateral token. Note `underlyingAssetAddress`, `address`, `decimals`, `minTradeSize` and `maxTradeSize`. From `inventory[underlying].combinations`, choose an `(expiry, strike, isPut)` and take the strike from the **key string** (`"78.500000"` → e8 `"7850000000"`) using decimal-string parsing such as `parseUnits(s, 8)`. Confirm that the product's `collateralAsset` and `strikeAsset` (= `usd`) appear in `combination.products`.
2. **Size.** Contracts in e18. For a call, contracts = collateral deposited in underlying units; for a put, contracts = USD deposit / strike. Round down to a multiple of `minTradeSize` and clamp to `[minTradeSize, maxTradeSize]`. Pre-check caps (§13).
3. **RFQ.** Send `{"jsonrpc":"2.0","method":"request","id":"request","params":QuoteParams}` and wait for a single response with `id: "request"`, either `result: Quote` or `error`. The app re-sends if nothing arrives within 15 s. Validate every echoed field (§5.1). Reject quotes with `validUntil` close to now: the app treats `validUntil - 20 s` as stale.
4. **Viability (optional).** Use the preview `POST /api/gas` for `gasFee`. If `quantity * price / 1e30 < gasFee` (both 6-dp), or the call errors with "gas fee more than premium", do not trade.
5. **Approve** the collateral token: `approve(MarginPool 0x24a44f1dc25540c62c1196FfC297dFC951C91aB4, collateralAmount)`, for the exact amount (the app never approves max). Skip it when `allowance >= amount`, and wait for the receipt. Native HYPE is not auto-wrapped; wrap it with WHYPE `deposit()` first.
6. **Re-quote if needed.** If the final quantity differs from `quote.quantity`, the app re-sends `request` with the new quantity and waits 3 s for the fresh quote, running this in parallel with the approve.
7. **Gas fee and nonce.** Build a `GasRequest` from the final quote (§6) with `nonce = String(Date.now())` and POST it to `/api/gas`.
8. **Sign** the EIP-712 `Confirmation` (§9), using `gasFee = gasResponse.gasFee || "0"`.
9. **Confirm.** Send `{"jsonrpc":"2.0","method":"confirm","id":"confirm","params":ConfirmParams}`. The app sends `{...gasResponse, gasFee, isEIP1271, signature}` and relies on the gas response echoing the body. A defensive client can send `{...gasRequest, ...gasResponse, gasFee, isEIP1271, signature}`, which is the same payload because the echo holds (`live`, §7). Whether the server accepts a `confirm` built that way has not been tried.
10. **Result.** `result` is the relayer tx hash. Wait for the receipt over RPC, then refresh `positions` and match on `txHash`. An `error` carries `{code, message}`; the app shows `message` verbatim and drops the quote. **Never re-send a `confirm` blindly** (§5.4).

The app's confirmation UI steps are Processing → Switching network → Awaiting approval → Approving → Refreshing quote → Awaiting signature → Creating position. `bundle`

## 9. EIP-712 signing

Source: `bundle` (types verbatim from module 41687; message construction from module 24221). The domain agrees with the live `typeDataDomain`.

```ts
const domain = {
  name: "rysk",
  version: "0.0.0",
  chainId: 999n,
  verifyingContract: "0x8C8bcb6D2c0E31c5789253EcC8431cA6209B4E35", // Rysk "transaction processor"
} as const;
// EIP712Domain = [name string, version string, chainId uint256, verifyingContract address].
// The server's typeDataDomain also carries `salt: ""`. It is NOT part of the domain type, so ignore it.

const types = {
  Confirmation: [ // field order matters
    { name: "maker", type: "address" },
    { name: "assetAddress", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "isPut", type: "bool" },
    { name: "nonce", type: "uint64" },           // = GasRequest.nonce (ms timestamp)
    { name: "price", type: "uint256" },          // e18
    { name: "quantity", type: "uint256" },       // e18
    { name: "quoteNonce", type: "uint64" },      // = Quote.nonce
    { name: "quoteSignature", type: "bytes" },   // = Quote.signature
    { name: "strike", type: "uint256" },         // e8 (NOT e18)
    { name: "taker", type: "address" },
    { name: "isTakerBuy", type: "bool" },        // false
    { name: "usd", type: "address" },
    { name: "collateralAsset", type: "address" },
    { name: "collateralAmount", type: "uint256" },
    { name: "gasFee", type: "uint256" },         // 6-dp USD from /api/gas, "0" when empty
  ],
} as const;

// The message is built from the GasRequest body `d` and the gas response `g` (all numerics BigInt):
const message = {
  maker: d.maker, assetAddress: d.assetAddress, chainId: BigInt(d.chainId), expiry: BigInt(d.expiry),
  isPut: d.isPut, nonce: BigInt(d.nonce), price: BigInt(d.price), quantity: BigInt(d.quantity),
  quoteNonce: BigInt(d.quoteNonce), quoteSignature: d.quoteSignature, strike: BigInt(d.strike),
  taker: d.taker, isTakerBuy: d.isTakerBuy, usd: d.usd, collateralAsset: d.collateralAsset,
  collateralAmount: BigInt(d.collateralAmount), gasFee: BigInt(g.gasFee || "0"),
};
// viem: account.signTypedData({ domain, types, primaryType: "Confirmation", message })
```

- The app signs with `eth_signTypedData_v4` through wagmi and then normalises `v` from 0/1 to 27/28. viem local accounts already emit `v` in {27, 28}.
- `isEIP1271` is `eth_getCode(taker) !== "0x"`, so it is false for an EOA. Contract-wallet verification on the server is untested.
- Note that `quoteValidUntil` and `validUntil` are sent in the confirm params but are **not** signed.
- The taker flow has **no login or SIWE step**.

The maker's `Quote` type is given for reference, since takers never sign it. It uses the same domain and contains **no taker field**. **Verified `live`:** every captured maker signature recovers to the quote's `maker` under this domain and type: the 3 spike quotes, the live smoke test's quote, and all 63 quotes of the validation run, from five makers.

```
Quote: [assetAddress address, chainId uint256, isPut bool, strike uint256, expiry uint64, maker address,
        nonce uint64, price uint256, quantity uint256, isTakerBuy bool, validUntil uint64, usd address,
        collateralAsset address]
```

The bundle defines other types too: `Transfer` and `WillRedeem` (maker deposit, withdraw and redeem), `Referral{code}`, `Authentication{nonce}`, and `OTCTrade`, `CreateRfq`, `CancelRfq` and `CancelQuote`, which belong to Premium and admin tooling. None of these is used in the seller flow. The `/mm` page signs with a different domain (`PremiumOptionHandler` / `1`) because it serves the Premium product.

## 10. Amount math and worked examples

### 10.1 Formulas

```ts
// collateralAmount, as in the bundle's approveAndConfirm (strike_e18 = strike_e8 * 1e10)
const callCollateral = (qtyE18: bigint, collateralDecimals: number) =>
  qtyE18 / 10n ** BigInt(18 - collateralDecimals);          // collateral token base units
const putCollateral = (qtyE18: bigint, strikeE8: bigint) =>
  (qtyE18 * strikeE8 * 10n ** 10n) / 10n ** 30n;              // 6-dp stablecoin units

const premium6dp = (qtyE18: bigint, priceE18: bigint) => (qtyE18 * priceE18) / 10n ** 30n;
const putQtyFromUsd = (usd6dp: bigint, strikeE8: bigint) =>   // e18 contracts, then round to minTradeSize
  (usd6dp * 10n ** 12n * 10n ** 18n) / (strikeE8 * 10n ** 10n);
```

For WHYPE (18 dp) a call's `collateralAmount` equals `quantity`. A hypothetical 0.05 UBTC call (8 dp) gives `0.05e18 / 1e10 = 5000000` UBTC base units. For a 50-contract WHYPE call, the collateral is `"50000000000000000000"` WHYPE wei.

### 10.2 Worked example: a HYPE put fill

Sources: `live` (the positions API and the on-chain receipt of real fills). The numbers below are illustrative, rounded from a real fill of these terms; the formulas reproduce the exact values of real fills. The RFQ is reconstructed from the resulting position (`inferred`).

The trade is a cash-secured put, **25 WHYPE @ $78.50**, expiry 2026-10-30 08:00 UTC (`1793347200`), sold 14 days before expiry with USDC as both collateral and premium token.

```json
{"jsonrpc":"2.0","method":"request","id":"request","params":{"asset":"0x5555555555555555555555555555555555555555",
 "assetName":"WHYPE","chainId":999,"expiry":1793347200,"isPut":true,"quantity":"25000000000000000000",
 "strike":"7850000000","taker":"0xYourAddress","usd":"0xb88339cb7199b77e23db6e890353e22632ba630f",
 "collateralAsset":"0xb88339cb7199b77e23db6e890353e22632ba630f","isEIP1271":false}}
```

| Item | Math | Value |
|---|---|---|
| quantity | 25 x 1e18 | `"25000000000000000000"` |
| strike in RFQ / Confirmation | 78.5 x 1e8 | `"7850000000"` |
| strike in positions API | 7850000000 x 1e10 | `"78500000000000000000"` |
| Quote `price` | $1.90 per contract | `"1900000000000000000"` |
| premium (6 dp) | 25e18 x 1.9e18 / 1e30 | `47500000` = **47.50 USDC** |
| `collateralAmount` | 25e18 x 78.5e18 / 1e30 | `1962500000` = **1962.5 USDC** |
| positions `premium` | 47.50 at e18 scale | `"47500000000000000000"` |
| yield on collateral | 47.50 / 1962.5 | 2.4204 % |
| time to expiry | (`expiry` − `createdAt`) / 86400 | 14 d |
| APR | 2.4204 % x 365.25 / 14 | **63.15 %**, which the positions API shows as `apr: "63.15"` |

The APR uses a 365.25-day year and the time from `createdAt` to expiry. Four real put fills reproduce the API's `apr` exactly, with denominator strike x qty. For calls, the denominator appears to be spot x qty at trade time. `inferred`

On-chain, a fill is one relayer transaction. Every transfer inside it is listed in §12.3.

## 11. Settlement and the positions API

### 11.1 Position row

Source: `live`, from the rows of a real seller wallet. WS `positions {address}` returns the same rows.

```ts
type Position = {
  address: Address;     // UNDERLYING asset (WHYPE for HYPE), not the collateral
  apr: string;          // "63.15" (%), see §10.2
  chainId: number;
  createdAt: number;    // unix s (trade block time)
  expiry: number;       // unix s
  isBuy: boolean;       // true on every seller row observed (maker-side "buy")
  isPut: boolean;
  quantity: string;     // e18 contracts
  strike: string;       // e18 USD (e8 in RFQ!)
  price: string;        // e18 USD per contract
  premium: string;      // e18-scaled, == trunc_6dp(quantity * price / 1e18) on every row observed
  txHash: Hex;          // relayer trade tx
  usd: Address;         // premium/strike stablecoin
  collateral: Address;  // collateral token
  fees: string;         // "0" here (the maker fee appears only in /api/history)
  status: "" | "SETTLED";
  symbol: string;       // asset-entry symbol: "WHYPE" (calls and puts on WHYPE), "kHYPE", "UBTC", ...
  settlementCollateralPayout: string; // collateral returned (OTM), collateral-token base units
  payout: string;       // ITM delivery amount, see below
  payoutAsset: Address | ""; // "" while open; after settlement = underlying (puts) or usd (calls), even when OTM
};
// /api/taker-history rows: address, apr, chainId, createdAt, expiry, isPut, quantity, strike, income,
// txHash, usd, collateral, settlementCollateralPayout, payout, payoutAsset (no price/premium/status/fees/symbol).
```

The endpoint returns **every** position, open and settled. Open rows have `status: ""`, `payout: "0"`, `settlementCollateralPayout: "0"` and `payoutAsset: ""`. Status probably stays `""` after expiry until the relayer settles, which usually takes up to about 2 h (`inferred`). A client therefore has to handle rows that have expired but are not yet settled.

### 11.2 How settlement is represented

Source: `live`. The examples are modelled on real rows, with dates and settlement prices left out; settlement prices come from `/api/expiry-prices/999/0x5555…5555`.

| Outcome | `settlementCollateralPayout` | `payout` | `payoutAsset` | Example |
|---|---|---|---|---|
| OTM put | collateral back, 6 dp | `"0"` | WHYPE | 25 @ 81, settled above the strike → `"2025000000"` (2025 USDC, strike x qty) |
| OTM call | collateral back, e18 for WHYPE | `"0"` | USDC | 25 @ 97.5, settled below the strike → `"25000000000000000000"` (25 WHYPE) |
| ITM put (assigned) | `"0"` | qty of underlying, e18 | WHYPE | 50 @ 80, settled below the strike → `"50000000000000000000"` (50 WHYPE) |
| ITM call (exercised) | `"0"` | strike x qty, stablecoin 6 dp | USDC/USDT0 (= `usd`) | 50 @ 90.5, settled above the strike → `"4525000000"` (4525 USDC) |

Rules for a client:

- **Derive the outcome from the payout fields, not from a price comparison.** If `status === "SETTLED"` and `payout !== "0"`, the option was ITM; if `status === "SETTLED"` and `payout === "0"`, it was OTM. `payoutAsset` is filled in for OTM rows as well, so it says nothing about the outcome.
- The tie rule (settle == strike) is undocumented. Deribit convention is ITM only when the price is strictly beyond the strike. The probability is negligible, and the payout fields resolve it anyway.
- Expiry prices: `GET /api/expiry-prices/999/<underlying>` → `{ "1792137600": "8118577121", ... }`, 1e8 USD. Future or unpublished expiries read `"0"`. The map also has a few timestamps that are not Friday 08:00 (for example `1784633400`, a Tuesday at 11:30 UTC), with unknown meaning. `live`
- `/api/user/settlement` returned `[]` even with settled rows present, so do not rely on it. `live`

## 12. Contracts and tokens

### 12.1 Contracts on HyperEVM (chain 999)

| Contract | Address | Role | Source |
|---|---|---|---|
| Rysk | `0x8C8bcb6D2c0E31c5789253EcC8431cA6209B4E35` | Transaction processor; EIP-712 `verifyingContract`; target of relayer txs | `docs` `bundle` `live` |
| MarginPool | `0x24a44f1dc25540c62c1196FfC297dFC951C91aB4` | Collateral storage; **`approve` spender** | `docs` `bundle` `live` |
| MMarket | `0x691a5fc3a81a144e36c6C4fBCa1fC82843c80d0d` | Maker accounting; pays premium; holds oTokens | `docs` `bundle` `live` |
| Gamma controller / self-redeem | `0x577b846a95711015769452f7f29d8054cf087964` | `redeemTimePeriod()`; emits `CollateralAssetDeposited` and `ShortOtokenMinted` in a fill | `bundle` `live` |
| Relayer EOA | `0x65802cc308aea8bb913882696c2df6bf23ff9e48` | Sender of the observed trade tx (pays its gas) | `live` |
| Maker-fee recipient | `0xfb69f38eae27705720eb4aabb04be9edbec5b555` | Received the maker fee in the observed fill | `live` |

On Ethereum mainnet `docs`: Rysk `0x7A3dDEac7A0AE6dfA9391C764499A3564F3c2AAd`, MarginPool `0x684404F2AEBAD87a6803F13741B1d638Bfe2C671`, MMarket `0xc01c9EF5de5862354adD9501a29e8765cFF01c32`.

### 12.2 Tokens on HyperEVM

Source: `live` (`/api/assets`). Sizes are in contracts (e18 on the wire).

| Symbol | Address | Decimals | Underlying | Min / max trade |
|---|---|---|---|---|
| USDC | `0xb88339cb7199b77e23db6e890353e22632ba630f` | 6 | n/a | n/a |
| USDT0 | `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb` | 6 | n/a | n/a |
| USDH | `0x111111a1a0667d36bd57c0a9f569b98057111111` | n/a | stablecoin constant in the bundle; no HYPE product uses it | n/a |
| WHYPE | `0x5555555555555555555555555555555555555555` | 18 | HYPE (WETH9-style `deposit()` / `withdraw(uint)`) | 25 / 5000 |
| kHYPE | `0xfd739d4e423301ce9385c1fb8850539d657c296d` | 18 | HYPE | 25 / 5000 |
| wstHYPE | `0x94e8396e0869c9f2200760af0621afd240e1cf38` | 18 | HYPE | 25 / 5000 |
| LHYPE | `0x5748ae796ae46a4f1348a1693de4b50560485562` | 18 | HYPE | 25 / 5000 |
| kHYPE-PT (inactive) | `0x311db0fde558689550c68355783c95efdfe25329` | 18 | HYPE | 25 / 5000 |
| kHYPE-PT-19MAR26 (inactive) | `0xea84ca9849d9e76a78b91f221f84e9ca065fc9f5` | 18 | HYPE | 25 / 1000 |

Other underlyings on 999, as symbol `address` (decimals, min/max contracts): UBTC `0x9fdbda0a5e284c32744d2f17ee5c74b284993463` (8, 0.025/5), UETH `0xbe6727b535545c67d5caa73dea54865b92cf7907` (18, 0.5/100), USOL `0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29` (9, 10/500), PURR `0x9b498c3c8a0b8cd8ba1d9851d40d186f1872b44e` (18, 10000/1000000), UPUMP `0x27ec642013bcb3d80ca3706599d3cda04f6f4452` (6, 500000/50000000), fXRP `0xd70659a6396285bf7214d7ea9673184e7c72e07e` (6, 1000/100000), bZEC `0xbe068bb3c7ef5b56360655638f75bf5a6c5f8c10` (18, 5/100).

Oracle feeds `docs`: HYPE uses `STORK.HYPEUSD`, kHYPE uses `STORK.KHYPEUSD`, and wstHYPE uses a Pyth feed. Pendle assets are priced from the Pendle API.

### 12.3 Anatomy of the observed fill transaction

Source: `live`, the receipt of a real put fill of the §10.2 terms. Amounts are rounded except where they follow from the terms.

| # | Event | Amount |
|---|---|---|
| 1 | Tx: relayer EOA → Rysk contract; `gasUsed` about 0.7 M, paid by the relayer | n/a |
| 2 | USDC Transfer seller → MarginPool (pulls the seller's approval) | 1,962.5 USDC (`1962500000`) |
| 3 | Series oToken minted to the Rysk contract, then transferred to MMarket (the maker's account) | 25 oTokens (`2500000000`, 8 dp) |
| 4 | USDC Transfer MMarket → seller (premium) | about 47.5 USDC, exactly `quantity x price` truncated to 6 dp |
| 5 | USDC Transfer MMarket → fee recipient (maker fee) | about 5.9 USDC, 12.5 % of the premium |

The Gamma controller emits `CollateralAssetDeposited` and `ShortOtokenMinted(otoken, AccountOwner = seller, to, vaultId, amount)` for the seller's new vault; the vault store emits `VaultOpened`; the MarginPool and one other contract also emit events. A seller who already has the allowance sends no transaction for a trade at all.

## 13. Operational constraints

### 13.1 Sizes and strikes

- `quantity` must be a **multiple of `minTradeSize`** and lie within `[minTradeSize, maxTradeSize]`, both e18 contracts per asset entry. For HYPE that is 25 to 5000 (the inactive kHYPE-PT-19MAR26 allows up to 1000). The app's rounding is `floor((q - min) / min) * min + min`, capped at max. `bundle` `live`
- Listed strikes are the inventory combinations, all OTM, on a $0.50 grid for HYPE. The UI also allows custom strikes: calls in `[spot, 1.4 x spot]`, puts in `[0.6 x spot, spot]`, stepping by `strikePrecision` (default $0.01). Whether makers quote off-grid strikes competitively is untested. `bundle`
- Use the combination **keys** for strikes; the per-expiry `strikes` arrays drop the `.5`. `live`
- **The listed strikes move with spot.** Each side's six strikes per expiry are delta buckets, and spot moves of a few cents shift some of them to the neighbouring $0.50 strike. In the validation run the set of listed (strike, expiry, side) tuples changed about once a minute. `live`
- **Custom strikes need volume.** A strike outside the current inventory is a custom strike, refused for takers with less than 250 000 USD of notional trading volume (§5.3). `live`

### 13.2 Caps

Source: `bundle` (the check), `live` (the values).

The app blocks a trade ("CAP OVERFLOW") when any matching, non-zero cap would be exceeded. It looks up `GLOBAL`, then `underlying` (e.g. `HYPE`), then `Asset.address`, then `${Asset.address}-${isPut}`, and for each name applies:

- `CONTRACTS`: `usage + qty_e18 > cap`
- `NOTIONAL` (GLOBAL included): `usage + qty_e18 * Asset.price_e18 / 1e18 > cap`

HYPE values at probe time, in contracts or USD:

| Name | Type | Cap | Usage |
|---|---|---|---|
| `GLOBAL` | NOTIONAL | 4,000,000 | 1,083,582.5 |
| `HYPE` | CONTRACTS / NOTIONAL | 150,000 / 2,660,000 | 125 / 13,462.5 |
| `0x5555…5555` (WHYPE entry) | CONTRACTS / NOTIONAL | 150,000 / 2,660,000 | 125 / 13,462.5 |
| `0x5555…5555-false` (WHYPE calls) | CONTRACTS / NOTIONAL | 50,000 / 2,660,000 | 125 / 13,462.5 |
| `0x5555…5555-true` (HYPE puts, USDC and USDT0) | CONTRACTS / NOTIONAL | 500,000 / 1,000,000 | 0 / 0 |
| `0xfd73…296d` (kHYPE entry), and `-false` | CONTRACTS / NOTIONAL | 150,000 / 2,660,000 (50,000 for `-false`) | 0 |

The `usage` values are far below the volume of recent fills, so their semantics are unclear (§14). The caps are large relative to the HYPE maximum trade size of 5000.

### 13.3 Timing

| Item | Value | Source |
|---|---|---|
| Auction window | ~2 s (`auctionDeadline` 2.0–2.6 s after receipt) | `docs` `live` |
| App's wait for a quote before re-requesting | 15 s | `bundle` |
| Quote staleness margin used by the app | re-quote when `validUntil - 20 s <= now` | `bundle` |
| Expiry | Fridays 08:00 UTC (every observed position and listed expiry) | `docs` `live` |
| Settlement | automatic, usually within ~2 h of expiry; 5-min dispute window | `docs` |
| Observed | positions expiring 2026-10-16 08:00 were `SETTLED` when probed at about 09:53 UTC | `live` |
| Inventory refresh | about every 30 s; the listed strike set itself changed about once a minute | `live` |
| RFQ response | 2.1–3.7 s from send to the quote (mean 2.4 s, 63 quotes) | `live` |
| Quote TTL | `validUntil` 35–90 s after arrival (45–93 s after the request in the spike). Nearly constant per maker: five makers at about 35, 42, 42, 63 and 90 s | `live` |
| Early close | not possible | `docs` |

### 13.4 Rate limits and chain limits

- Rysk documents no API rate limits, and no limits were hit during light probing. For comparison, each open browser tab polls inventory every 2 s and re-fires RFQs at least every `validUntil - 20 s`, so the backend absorbs about 8 RFQ/s of public zero-address traffic. Staying at or below the app's cadence is a sensible ceiling; this client caps itself at a sustained 60 RFQ/min across the strategy and the sampler, with bursts of up to 60 (the bucket's capacity). `bundle` `live` `inferred`
- The app's own fetch helper retries 3 times with exponential backoff (100 ms up to 5 s) within a 30 s budget, and dedupes referral calls for 2 s. `bundle`
- The HyperEVM public RPC allows **100 requests/min per IP** and offers no WS. The mempool accepts only the next **8 nonces** per address. Small blocks arrive every 1 s with a 2M gas limit, which comfortably fits an ERC-20 approve. EIP-1559 applies and the gas token is HYPE (18 dp). `hyperliquid`

### 13.5 Fees and costs for the seller

- The docs give the maker fee as `MIN(0.01 x UnderlyingPrice, 0.125 x OptionPrice) x Quantity`, **charged to the maker**. `docs`
- In 34 public fills, `fees` was exactly **12.5 % of premium** for HYPE, kHYPE and SOL, and **7.5 %** for BTC and ETH. That implies per-asset parameters that differ from the docs. Either way the maker pays, and in the verified fill the seller received the full quoted premium. `live`
- The seller pays gas for the ERC-20 `approve`, plus whatever `gasFee` `/api/gas` returns for the relayed trade (6-dp USD, signed into the Confirmation). The app refuses the trade when premium < `gasFee`. How a non-zero `gasFee` is collected was not observed (§14). `bundle`

### 13.6 Client-side validations and error strings

Source: `bundle`. These messages are generated by the UI, but they show which checks a bot should replicate: `INVALID AMOUNT`, `DEPOSIT SIZE MUST BE BETWEEN <min> & <max>`, `INSUFFICIENT BALANCE`, `CAP OVERFLOW`, `GAS EXCEEDS PREMIUM`, `Cannot quote <SYM> at the moment, please try again later` (no combinations), and `approveAndConfirm: no quote after the refresh, order not placed`. Server errors arrive as JSON-RPC `error.message`. Observed so far: `-32601 Method not found`, and `-32603 custom strikes require >= 250000 notional volume (have 0)` for an unlisted strike (§5.3).

### 13.7 Access and terms

- The ToS exclude US persons, UK and Taiwan residents and sanctioned territories, and forbid VPN use by restricted persons. They also prohibit sybil, DoS and griefing attacks, front-running, wash trading and manipulative trading. The text found does not address automated clients explicitly; read the ToS before running one. `docs`
- Geo-blocking in the web app is a Vercel middleware cookie (`_geo`). Whether the WS or REST backend enforces geo rules independently is unknown. `bundle`
- Makers are whitelisted, and onboarding includes a testnet period. Sellers need no whitelisting. The app's `inviteOnly` flag is currently `false`. `docs` `bundle`

## 14. Open questions

1. **`/api/gas` response shape.** *Resolved `live`:* the response echoes the full body unchanged plus exactly 12 extra keys (§6, §7).
2. **How `gasFee` is collected.** The one verified fill paid the seller exactly `quantity x price`, so either `gasFee` was 0 or it is netted elsewhere. Capture a non-zero case.
3. **Quote lifetime.** *Partly resolved `live`:* `validUntil` lies 35–93 s ahead, fixed per maker (§13.3). Still open: whether `confirm` is rejected after it (very likely).
4. **Taker binding.** Whether a quote requested with `taker = 0x0` can be confirmed by a real taker, and whether the server checks the taker against the RFQ.
5. **Server limits.** Server-side rate limits or anti-spam rules for `request` and `confirm`, and any idle timeout on `/taker`.
6. **Nonce rules.** Whether `Confirmation.nonce` must be a recent ms timestamp, or only unique per taker.
7. **Retry safety.** What `confirm` returns on a duplicate or replay, and what the full set of error codes and messages is.
8. **Settlement edge cases.** The tie rule at settle == strike; the meaning of the non-Friday entries and `"0"` values in `expiry-prices`; and the ITM put `payout` units for underlyings that do not have 18 decimals.
9. **Cap usage.** What `caps.usage` actually counts, given values far below observed recent volume.
10. **Call APR.** Which denominator the call `apr` uses (spot at trade time is assumed).
11. **API geo-gating.** Whether the API enforces geo-blocking, and how contract-wallet (`isEIP1271`) signatures are verified.
12. **Custom-strike rule.** How long a strike stays quotable after it leaves the inventory, and how the 250 000 USD of volume is counted (§5.3).

## References

- Rysk docs: <https://docs.rysk.finance> ("How it works", "Products", "FAQ", "[Makers] How to integrate in the RFQ", "Oracle", "Important Contracts", "Terms of Service")
- Rysk maker clients, useful for cross-checking types and the Quote domain: <https://github.com/rysk-finance/ryskV12_ts>, <https://github.com/rysk-finance/ryskV12_py>, <https://github.com/rysk-finance/ryskV12-cli>
- HyperEVM explorer: <https://hyperevmscan.io>
