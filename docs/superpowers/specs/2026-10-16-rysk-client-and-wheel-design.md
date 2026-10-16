# Rysk Client and Bidirectional Wheel — Design

Date: 2026-10-16
Status: approved for implementation (user delegated section approval to reviewer agents)
Protocol reference: `docs/rysk-protocol.md`

## 1. Goal

Build a TypeScript client for Rysk V12 on HyperEVM that can discover products, request quotes, sell
covered calls and cash-secured puts, and read positions and settlement history. On top of it, build one
strategy: a bidirectional wheel on HYPE/USDC that sells cash-secured puts with idle USDC and covered calls
with idle WHYPE, chasing a minimum target APR, with the constraint that HYPE is sold at or above its
weighted-average acquisition price. The same binary doubles as a research tool: in dry-run mode it requests
real quotes and records them without trading.

### 1.1 In scope (v1)

- `chain` layer: Foundry keystore decryption, viem clients for HyperEVM, ERC-20 approve/balances.
- `rysk` layer: REST and WebSocket JSON-RPC clients, typed domain model, unit conversions, EIP-712
  signing, and the complete seller trade flow with safety checks.
- `strategy/wheel`: pure state derivation, candidate selection, quote evaluation, DCA allocation.
- `daemon`: tick loop, dry-run (default) and live modes, wide quote scan for research, append-only JSONL
  recording, structured logs, small CLI.
- Docs: protocol reference, this spec, an implementation plan, a README with run instructions.

### 1.2 Out of scope (v1)

- Trading with USDT0 or USDH products, or with liquid-staking collateral (kHYPE, wstHYPE, LHYPE). The
  wide scan records their quotes; the strategy trades only USDC + WHYPE.
- Wrapping native HYPE to WHYPE. The wallet already holds WHYPE.
- Persistent database, dashboard, push alerts, multi-wallet, testnet, other underlyings.
- Early close or rolling (Rysk has no secondary market).

## 2. Verified protocol facts the design depends on

Full detail is in `docs/rysk-protocol.md`. The facts that shape this design:

- Rysk is request-for-quote. The seller is the taker. A `request` on `wss://v12.rysk.finance/taker`
  returns one best quote after a ~2 s auction. Anyone may request, even with the zero address as taker;
  the web app does so constantly (about 8 requests/s observed), so quote sampling is ordinary traffic.
- Selling requires exactly one on-chain transaction from the seller: ERC-20 `approve(MarginPool, amount)`
  on the collateral token. The trade itself is submitted by Rysk's relayer after the seller signs an
  EIP-712 `Confirmation` and sends `confirm`. The result is the relayer's transaction hash.
- A `gasFee` (6-dp USD) is deducted from the premium and is part of the signed message. It is fetched by
  `POST /api/gas` with the confirmation body, and the response is spread into the `confirm` params.
- Quotes carry `validUntil`; there is no cancel. JSON-RPC `id` equals the method name.
- For HYPE on chain 999: underlying asset is WHYPE; calls pay premium in USDC and accept WHYPE, kHYPE,
  wstHYPE or LHYPE as collateral; puts exist as USDC/USDC and USDT0/USDT0 products. Min size 25 HYPE,
  max 5000 HYPE per trade, quantities in e18 "contracts" and multiples of the minimum.
- The inventory publishes strikes, expiries, server-computed indicative `apy` and `delta` per listing,
  but `bid`/`ask` are zero for HYPE. Real prices only come from quotes.
- `GET /api/user/positions?address=` returns every position, open and settled, with payout fields that
  identify the settlement outcome exactly (see §6.2). Settlement is automatic, about two hours after the
  Friday 08:00 UTC expiry. The seller has nothing to do at expiry.
- The seller receives the full quoted premium. The published fee is charged to the maker.

## 3. Architecture

Single TypeScript package, four layers, one-way dependencies, a pure core with an imperative shell:

```
cli ──► daemon ──► strategy/wheel (pure)
          │  └──► rysk ──► chain
          └──────► rysk ──► chain
```

| Layer | Responsibility | Depends on | Side effects |
|---|---|---|---|
| `chain` | Keystore, viem public/wallet clients, ERC-20 reads and approve, receipts | viem | RPC |
| `rysk` | Protocol constants, domain types, units, REST, WebSocket JSON-RPC, EIP-712, trade flow | `chain` | HTTP, WS, signing |
| `strategy/wheel` | Derive state, plan candidates, evaluate quotes, allocate tranches | types only | none |
| `daemon` | Tick loop, snapshot gathering, execution, recording, logging, config | all above | files, stdout |
| `cli` | Argument parsing, commands | `daemon` | process |

Design rules:

- Everything that decides is a pure function of a `Snapshot` and `WheelConfig`. Everything that talks to
  the network lives in `rysk`, `chain`, or `daemon` and is injected into the loop through small interfaces,
  so the loop and the strategy are testable with fakes.
- On-wire integers are `bigint` with the unit in the name (`strikeE8`, `quantityE18`, `priceE18`,
  `amount6`). Human-facing ratios (APR, fractions) are `number` and are never used for on-chain amounts.
- No module stores state across ticks except an in-memory post-trade cooldown and the recorder's file
  handles. All strategy state is derived each tick.
- No secrets in the repo: keystore directory, config file, and data directory are gitignored. The config
  example contains placeholders.

## 4. Toolchain and repository layout

- Node ≥ 22 (global `WebSocket`, `fetch`), pnpm, TypeScript strict ESM, `tsx` to run, `tsc --noEmit` to
  typecheck, `vitest` for tests, `biome` for lint and format.
- Runtime dependencies: `viem` (chain, EIP-712 typed-data signing, ABI, `hyperEvm` chain), `zod` (config
  and API response validation), `pino` (structured logs), `read` (hidden password prompt).
- Dev dependencies: `vitest`, `typescript`, `tsx`, `@biomejs/biome`, `ws` (mock WebSocket server for
  tests), `@types/node`.

```
rysk-client/
  package.json  tsconfig.json  biome.json  vitest.config.ts  .gitignore  README.md
  config.example.json                 # committed; real config.json is gitignored
  keystore/                           # gitignored; cast keystore files
  data/                               # gitignored; JSONL outputs
  docs/
    rysk-protocol.md
    superpowers/specs/…  superpowers/plans/…
  src/
    chain/      keystore.ts  client.ts  erc20.ts  index.ts
    rysk/       constants.ts  types.ts  units.ts  rest.ts  socket.ts  taker.ts  eip712.ts  trade.ts  positions.ts  index.ts
    strategy/wheel/  types.ts  state.ts  basis.ts  candidates.ts  evaluate.ts  allocate.ts  plan.ts  index.ts
    daemon/     config.ts  snapshot.ts  loop.ts  execute.ts  scan.ts  recorder.ts  logger.ts  index.ts
    cli/        main.ts  commands/run.ts  commands/state.ts  commands/quote.ts  commands/history.ts
  test/
    fixtures/   keystore-anvil0.json  positions.json  inventory.json  assets.json  caps.json  history.json
    …           *.test.ts colocated with sources or under test/
```

## 5. Chain layer

### 5.1 Keystore

`decryptKeystore(json, password): Hex` implements Web3 Secret Storage v3 for the parameters Foundry writes
(scrypt, aes-128-ctr) using `node:crypto` (`scryptSync` with a generous `maxmem`, `createDecipheriv`) and
viem's `keccak256` for the MAC check. It accepts files without an `address` field and hex fields without
`0x`. `loadAccount(path, password)` returns a viem `PrivateKeyAccount`. The private key never appears in
logs; the password buffer is not retained.

Password resolution order: interactive hidden prompt when stdin is a TTY; otherwise the file named by
`KEYSTORE_PASSWORD_FILE`; otherwise fail with a clear message. No password in config or argv.

### 5.2 Clients

`createChainClients({ rpcUrl, chainId, account })` returns a viem public client and wallet client on the
`hyperEvm` chain definition with a custom RPC URL. Startup asserts the RPC's `eth_chainId` equals the
configured chain id.

`erc20` helpers: `balanceOf`, `allowance`, `decimals`, and `approve(token, spender, amount)` which sends
the transaction and waits for the receipt (timeout 120 s). Approvals are for the exact collateral amount,
matching the web app. Native balance via `getBalance`.

## 6. Rysk layer

### 6.1 Constants and domain types

- `ADDRESSES[chainId]`: `rysk`, `marginPool`, `mmarket` for 999 (and 1, 998 for completeness).
- `TOKENS[999]`: USDC, USDT0, USDH, WHYPE, kHYPE, wstHYPE, LHYPE with decimals and symbols.
- `Product = { underlying: Address; strikeAsset: Address; collateralAsset: Address; isPut: boolean }`.
- `Listing = { underlyingSymbol; strikeE8; expiry; isPut; delta; indicativeApy; spot; products: Product[]; timestamp }`,
  normalized from an inventory combination.
- `Asset` (from `assets`): symbol, address, underlyingAssetAddress, decimals, minTradeSizeE18,
  maxTradeSizeE18, active, priceE18.
- `Cap = { name; type; capE18; usageE18 }`.
- `QuoteRequest` (taker `request` params) and `Quote` (result) exactly as the protocol reference.
- `Position`: normalized API row with `bigint` fields plus `settlement: Settlement | null` (§6.2).
- `Fill`: normalized public history row.

### 6.2 Positions and settlement outcome

`normalizePosition(row)` converts strings to `bigint` and classifies:

- `phase`: `open` (status empty, expiry > now), `pendingSettlement` (status empty, expiry ≤ now),
  `settled` (status `SETTLED`).
- `settlement.outcome` for settled rows, from payout fields only, never from price comparison:
  - `payout == 0` → `expiredOtm`, `collateralReturned = settlementCollateralPayout`.
  - put and `payout > 0` → `assigned`, `receivedUnderlyingE18 = payout` (WHYPE), collateral consumed.
  - call and `payout > 0` → `exercised`, `receivedStable6 = payout` (strike × qty), collateral delivered.

Scale notes: positions API `strike` is e18 (RFQ strike is e8), `quantity`/`price`/`premium` e18,
stablecoin payouts 6 dp, WHYPE payouts e18.

### 6.3 Units

`units.ts` holds every conversion so arithmetic is in one place and tested:

- `strikeE8FromNumber`, `strikeE8ToE18`, `strikeE18ToE8`, `formatStrike`.
- `quantityE18FromHype`, `roundQuantityToIncrement(qE18, minE18, maxE18)`.
- `collateralForCall(qE18, collateralDecimals)` = `qE18 / 10^(18 − decimals)`.
- `collateralForPut(qE18, strikeE8)` = `qE18 × strikeE8 × 10^10 / 10^30` (6 dp stable).
- `premiumE18(qE18, priceE18)` = `qE18 × priceE18 / 10^18`; `premium6 = premiumE18 / 10^12`.
- `annualizedReturn(premiumUsd, collateralUsd, now, expiry)` = `premium / collateral × 365 d / (expiry − now)`.
  For puts `collateralUsd = strike × qty`; for calls `collateralUsd = spot × qty`. Net variants subtract
  `gasFee`. Rysk's own `apy` is recorded alongside for comparison.

### 6.4 REST client

`RyskRest(baseUrl)` with `fetch`, a 15 s timeout, three retries with exponential backoff on network errors
and 5xx, and zod parsing that validates the fields we use and passes the rest through. Methods: `assets`,
`inventory`, `caps`, `products`, `userPositions(address)`, `takerHistory(address)`,
`publicHistory(from, to)`, `expiryPrices(chainId, underlying)`, `gasFee(body)` (POST).

### 6.5 WebSocket JSON-RPC client

`JsonRpcSocket(url)`:

- Connects lazily, reconnects with exponential backoff (1 s × 2ⁿ, cap 30 s, ±25 % jitter).
- Inactivity watchdog: if no frame for 30 s, close and reconnect. When no call is pending for 15 s it
  sends `caps` as a heartbeat so the server stays warm.
- `call(method, params, { timeoutMs })`: because the protocol uses `id === method`, calls are serialized
  per method (a queue per method name); a reply with `error` rejects with `RyskRpcError(code, message)`;
  a close while pending rejects with `SocketClosedError`; the caller decides whether to retry.
- Unsolicited frames are passed to an optional listener and otherwise logged at debug level.

`RyskTaker(socket, rest, chainId)`:

- `requestQuote(req, { timeoutMs = 15_000 }): Promise<Quote>`; rejects with `NoQuoteError` on timeout
  or RPC error; validates that the quote's `strike`, `expiry`, `isPut`, `quantity`, `usd`,
  `collateralAsset`, `assetAddress`, `chainId` equal the request and that `isTakerBuy` is false and
  `validUntil` is in the future, otherwise rejects with `QuoteMismatchError`.
- `positions(address)`, `assets()`, `inventory()`, `caps()` over the socket.

### 6.6 EIP-712

`domain(chainId)` = `{ name: 'rysk', version: '0.0.0', chainId, verifyingContract: ADDRESSES[chainId].rysk }`.
`CONFIRMATION_TYPES` is the verbatim field list from the app bundle (maker, assetAddress, chainId, expiry,
isPut, nonce, price, quantity, quoteNonce, quoteSignature, strike, taker, isTakerBuy, usd, collateralAsset,
collateralAmount, gasFee). `signConfirmation(account, chainId, body)` uses viem `signTypedData`; viem
already yields `v ∈ {27, 28}`. A unit test signs a fixed body with the Anvil #0 key and recovers the
address with `verifyTypedData`.

### 6.7 Trade flow

`sellOption(deps, intent): Promise<TradeResult>` is the only code path that signs. Steps and invariants:

1. `requestQuote(req)` with `taker = account.address`. Quote validated as in §6.5.
2. Compute `collateralAmount` from the quote's `quantity` and the product.
3. If `allowance(collateral, MarginPool) < collateralAmount`, `approve` exactly `collateralAmount` and wait
   for the receipt. If the approval took longer than `validUntil − 20 s`, re-quote once; if the new quote
   differs in price by more than `maxRequoteSlippage` (config, default 10 %), abort.
4. Build the confirmation body: quote fields, `taker`, `collateralAmount`, `isTakerBuy: false`,
   `nonce = String(Date.now())`, `quoteNonce`, `quoteSignature`, `quoteValidUntil`, `validUntil`.
5. `POST /api/gas` with the body. The response is **not** trusted blindly: every field we sent must come
   back equal; only `gasFee` may be added. Otherwise abort with `GasEchoMismatchError`.
6. Guards before signing: `gasFee6 ≤ premium6 × maxGasFeeFraction` (default 0.2); `validUntil − now ≥ 10 s`;
   quantity within `[min, max]` and a multiple of min; strike within `[0.5, 2] × spot`; no other confirm in flight.
7. `signConfirmation`; send `confirm` with `{ ...gasResponse, gasFee, isEIP1271: false, signature }`.
8. On `result: txHash`: wait for the receipt (timeout 120 s). Then poll `userPositions` until a row with
   that `txHash` appears (timeout 120 s). Return `{ txHash, quote, premium6, gasFee6, position? }`.
   On a reverted receipt or missing position, return a `TradeResult` with `status: 'unconfirmed'` so the
   daemon enters cooldown and logs loudly; the next tick re-derives truth from balances and the API.

Dry-run executes step 1 only and records the quote.

## 7. Wheel strategy (pure)

### 7.1 Inputs

```ts
type Snapshot = {
  now: number;                   // unix seconds
  address: Address;
  balances: { whypeE18: bigint; usdc6: bigint; nativeHypeE18: bigint };
  positions: Position[];         // every row for the address, open and settled
  listings: Listing[];           // normalized inventory for HYPE
  assets: Asset[];
  caps: Cap[];
  spotE18: bigint;               // HYPE index price from assets/inventory
};
```

`WheelConfig` (validated with zod; defaults in parentheses):

- `minApr` (0.25) — floor on annualized net premium for both sides.
- `expiry.minDays` (1), `expiry.maxDays` (14) — window for candidate expiries.
- `quotesPerTick` (3) — candidates quoted per side per tick, ranked by indicative apy.
- `allocation.trancheFraction` (0.25) — share of a side's total capital (free + locked + pending) deployed
  per tranche; `allocation.minIntervalHours` (24) — minimum spacing between deployments on a side.
- `reserves.usdc6` (0), `reserves.nativeHypeE18` (0.5 HYPE) — untouchable balances; trading halts for
  both sides if native HYPE is below reserve (no gas for approvals).
- `basis.openingBasisUsd` (required) — acquisition price applied to WHYPE not attributable to Rysk
  assignments.
- `calls.fallback` (true) — when no listed call strike ≥ basis exists, write the highest listed strike at
  the nearest eligible expiry, ignoring `minApr`.
- `limits.maxTradesPerDay` (4), `limits.maxNotionalPerTradeUsd` (unbounded), `maxGasFeeFraction` (0.2),
  `maxRequoteSlippage` (0.1).
- `products`: fixed in v1 to `{ strikeAsset: USDC, putCollateral: USDC, callCollateral: WHYPE }`.

### 7.2 State derivation

`deriveState(snapshot, config): WheelState`

1. Keep positions with `chainId === 999` and `underlying === WHYPE`. Positions with other stablecoins
   still count for the HYPE basis (an assigned USDT0 put also delivered WHYPE) but not for USDC capital.
2. Classify each position (§6.2). Locked capital: open and pending calls lock `quantity` WHYPE; open and
   pending puts in USDC lock `strike × quantity` USDC.
3. HYPE basis by average-cost replay over settled rows ordered by `expiry`:
   - `totalHype = whypeFree + whypeLockedInCalls`.
   - `ryskNet = Σ assigned quantity − Σ exercised quantity`.
   - `external = max(0, totalHype − ryskNet)` carried at `openingBasisUsd`; a negative value means HYPE
     left the wallet outside Rysk and is logged as a warning.
   - Replay: start `qty = external, cost = external × openingBasis`; assigned put → `qty += q, cost += q × strike`;
     exercised call → `cost −= q × (cost / qty); qty −= q`. Result `basis = cost / qty` (undefined when
     `qty = 0`, in which case no calls are written anyway). Premiums are not netted into the basis.
4. `lastDeploymentAt[side]` = max `createdAt` over that side's positions (open or settled).
5. `tradesToday` = count of positions with `createdAt` in the last 24 h.
6. Output includes per-side `free`, `locked`, `pending`, `total`, plus `basisUsd`, and a `warnings[]` list.

External WHYPE or USDC deposited later simply raises `free` and, for WHYPE, joins the external lot at the
configured opening basis. Users who deposit at a materially different price update `openingBasisUsd`.

### 7.3 Planning candidates

`planSide(side, state, snapshot, config): SidePlan` returns either `{ kind: 'hold', reason }` or
`{ kind: 'quote', candidates: Candidate[], fallback: boolean }`.

Hold reasons, checked in order: `gas-reserve`, `trades-per-day`, `dca-interval`, `below-min-size`,
`no-listings`, `cap-exhausted`.

Tranche: `deployable = min(free − reserve, max(total × trancheFraction, minTradeValue))`, where
`minTradeValue` is 25 HYPE (calls) or 25 × lowest candidate strike (puts) so that a small first tranche is
still tradable. The intent is dollar-cost averaging across ticks, not a split within a tick.

Candidate listings: HYPE, `isPut` by side, expiry within `[minDays, maxDays]`, product matching the
configured stablecoin and collateral. Calls additionally require `strikeE8 ≥ basisE8`. Rank by
`indicativeApy` descending, then nearer expiry. Take the top `quotesPerTick`.

Quantity per candidate: calls `q = roundDown(deployableWhype, 25)`; puts `q = roundDown(deployableUsd /
strike, 25)`; clamp to `maxTradeSize` and to the remaining cap for the asset and side. Drop candidates
whose `q < minTradeSize`.

Call fallback: if no call listing has `strike ≥ basis` and `calls.fallback` is on, the single candidate is
the highest strike at the nearest eligible expiry, flagged `fallback: true`. The decision record states
that the strike is below basis. If listings above basis exist but none clears `minApr`, the side holds
with reason `apr-floor` (no fallback: that is not the downturn case the fallback is for).

### 7.4 Evaluating quotes

`evaluate(candidatesWithQuotes, snapshot, config): Decision`

- For each quote: `premiumE18`, `gasFee6` from a gas preview (one `POST /api/gas` per quote, same body
  the trade would use minus signature), `aprNet` per §6.3.
- Choose the highest `aprNet` among quotes with `aprNet ≥ minApr`, `premium6 > gasFee6`,
  and `gasFee6 ≤ premium6 × maxGasFeeFraction`. For a fallback candidate, skip the `minApr` test only.
- Result: `{ kind: 'trade', candidate, quote, aprNet, aprRysk }` or `{ kind: 'hold', reason: 'apr-floor' | 'no-quotes' | 'gas' }`.

### 7.5 Why these choices

- APR on collateral (strike × qty for puts, spot × qty for calls) is the yield on capital actually locked,
  which is what the user compares across sides.
- Ranking by indicative apy before quoting bounds RFQs to a few per side per tick, so the strategy's
  own traffic stays well under the web app's background rate.
- The DCA interval is derived from position timestamps, so it survives restarts without storage.

## 8. Daemon

### 8.1 Tick loop

Every `tickSeconds` (60):

1. Gather a `Snapshot` in parallel: balances (RPC), positions (REST), inventory, assets, caps (REST). Any
   failure skips the tick with a warning; three consecutive failures escalate to error level.
2. `deriveState`; log a one-line summary (free/locked per side, basis, open positions, warnings).
3. For the put side then the call side: `planSide` → request quotes for candidates sequentially (each
   auction ≈ 2 s) → gas previews → `evaluate` → record every quote and the decision.
4. If `decision.kind === 'trade'`: in live mode call `sellOption` and then re-gather the snapshot before
   planning the other side; in dry-run log `would-trade` with the full intent. At most one trade per side
   per tick, one confirm in flight globally.
5. After any live trade: in-memory cooldown of `cooldownSeconds` (180) on that side, cleared early once
   the position appears in the API.

Default mode is dry-run. Live trading requires the `--live` flag and `mode: "live"` in config, both.

### 8.2 Wide quote scan (research)

With `--scan` (or `scan.enabled` in config), every `scan.intervalSeconds` (300) the daemon requests a quote
for every HYPE listing across the configured product set (default: puts in USDC and USDT0; calls with
WHYPE, kHYPE, wstHYPE, LHYPE collateral) at `scan.quantityE18` (25 HYPE) with the zero address as taker,
sequentially with a 500 ms gap, recording each result (including `NoQuote`). This covers the USDC vs USDT0
and WHYPE vs LST pricing questions. The scan never trades.

### 8.3 Recorder

Append-only JSONL under `data/`, one file per day per stream; each line has `ts` (ms), `schema` version.

- `quotes-YYYYMMDD.jsonl`: `{ source: 'strategy' | 'scan', underlying, isPut, strikeE8, expiry,
  daysToExpiry, strikeAsset, collateralAsset, quantityE18, taker, requestedAt, respondedAt, latencyMs,
  ok, maker?, priceE18?, premium6?, validUntil?, aprRysk?, aprGross?, gasFee6?, aprNet?, spotE18,
  indicativeApy, indicativeDelta, error? }`.
- `decisions-YYYYMMDD.jsonl`: `{ side, kind, reason?, candidateCount, chosen?, fallback, basisUsd,
  free, locked, deployable, mode }`.
- `trades.jsonl`: `{ side, quote, premium6, gasFee6, aprNet, txHash, approveTxHash?, status }`.
- `state-YYYYMMDD.jsonl`: one derived-state summary per tick.

### 8.4 Logging and lifecycle

`pino` JSON to stdout (pretty when TTY). Startup prints: mode, chain id check, account address, balances,
derived state, config summary (never secrets). `SIGINT`/`SIGTERM` finish the current tick without starting
a new confirm, flush files, exit.

### 8.5 CLI

`rysk run [--live] [--scan] [--config path]`, `rysk state` (derive and print once), `rysk quote --side
put|call --strike 78.5 --expiry 1793347200 [--qty 25]` (one-off RFQ, no trade), `rysk history --from
--to --out file` (public fills export), `rysk wallet` (address and balances). Implemented with
`node:util` `parseArgs`.

## 9. Error handling and safety

| Situation | Handling |
|---|---|
| No quote within 15 s, or RPC error on `request` | Candidate skipped; recorded as `ok: false`. |
| Quote fields differ from request | `QuoteMismatchError`; never signed; recorded. |
| `/api/gas` echo differs from body | Abort trade, error log. |
| `gasFee` > 20 % of premium, or ≥ premium | Hold with reason `gas`. |
| WebSocket drops mid-auction | Pending call rejects; candidate skipped; socket reconnects with backoff. |
| RPC rate limit or outage | Tick skipped; escalate after three in a row. Config should point at a provider RPC. |
| Approve stuck | 120 s receipt timeout → abort trade, cooldown; at most one approve in flight, so the 8-nonce mempool limit is never approached. |
| `confirm` returns tx hash but receipt reverts or the position never appears | `unconfirmed` result, cooldown, loud log; next tick re-derives from balances and API. |
| Restart during the post-trade window | Collateral already left the wallet in the trade tx, so `free` is correct from balances; `lastDeploymentAt` may lag a few seconds; cooldown is re-established if any position is younger than `cooldownSeconds`. |
| Friday 08:00–10:00 UTC settlement window | Expired positions are `pendingSettlement`: their capital is neither free nor deployable; nothing special to do. |
| Cap exhausted or size below minimum | Hold with reason. |
| Rysk halts on oracle divergence | Requests fail or time out; the loop keeps holding. |
| Clock skew | `nonce` is a millisecond timestamp; startup compares local time with the HTTP `Date` header and refuses to go live if skew > 60 s. |
| Fallback writes a call below basis | Allowed by config; decision record and log flag it explicitly. |

Invariants enforced in code, not by convention: a confirm is signed only after echo equality, guard checks
and quote validation all pass; only one confirm in flight; default mode is dry-run; live needs flag and config.

## 10. Testing

- Unit tests with `vitest` for: units (all conversions, with the real fill `25 WHYPE put @ 78.5 →
  1962.5 USDC collateral, 47.4863 USDC premium` as a worked example); keystore decryption against a
  committed Foundry keystore of the public Anvil #0 key; EIP-712 sign and recover; position normalization
  and settlement classification against anonymized real rows; basis replay (assigned, exercised, external,
  negative external); candidate planning (basis rule, fallback, DCA interval, tranche sizing, min/max,
  caps); evaluation (APR floor, gas guards); `JsonRpcSocket` against a local `ws` server (id-equals-method
  serialization, timeout, reconnect, watchdog); `sellOption` against a fake taker, fake REST and fake chain
  (happy path, echo mismatch, stale quote re-quote, gas guard, unconfirmed); recorder output.
- Live smoke tests, opt-in with `RYSK_LIVE_TESTS=1`: REST and WS read endpoints parse; one zero-address
  `request` returns a valid quote or `NoQuote`. Never `confirm`.
- Acceptance before handover: `pnpm typecheck`, `pnpm lint`, `pnpm test` green; `rysk run` in dry-run
  against mainnet for several ticks from the sandbox produces quote and decision records.

## 11. Milestones

1. Scaffold, toolchain, config schema, keystore and chain layer.
2. Rysk constants, types, units, REST client, positions normalization.
3. WebSocket client, taker client, EIP-712, trade flow with fakes.
4. Wheel strategy modules.
5. Daemon loop, dry-run, scan, recorder, CLI.
6. Docs, live dry-run validation, review and handover.
