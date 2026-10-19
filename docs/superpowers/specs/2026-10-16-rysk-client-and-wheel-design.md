# Rysk Client and Bidirectional Wheel — Design

Date: 2026-10-16
Status: Approved for implementation (reviews: strategy ideation, architecture review, protocol spike; the
user delegated design approval to reviewer agents). Implemented; synced with the code on 2026-10-16.
Protocol reference: `docs/rysk-protocol.md`

> **Sync note.** This document was edited in place to match the implementation. Appendix A (core types and
> signatures) reflects the code as of the commit that last changed this file, and the rulings made during
> implementation are folded into the sections they changed. Where the original design and the code differ, the
> text describes the code and says so.

## 1. Goal

Build a TypeScript client for Rysk V12 on HyperEVM that can discover products, request quotes, sell
covered calls and cash-secured puts, and read positions and settlement history. On top of it, build one
strategy: a bidirectional wheel on HYPE/USDC that sells cash-secured puts with idle USDC and covered calls
with idle WHYPE, chasing a minimum target APR, with the constraint that HYPE is sold at or above its
weighted-average acquisition price. The same binary doubles as a research tool: in dry-run mode it requests
real quotes, exercises the whole trade path up to the signature, and records everything without trading.

### 1.1 In scope (v1)

- `domain`: pure protocol knowledge: constants, types, unit conversions, inventory and position parsing,
  cap matching, APR math. No IO.
- `chain`: Foundry keystore decryption, viem clients for HyperEVM, one batched read per tick, ERC-20 approve.
- `rysk`: REST client, WebSocket JSON-RPC client, taker methods (`request`, `confirm`), EIP-712 signing.
- `execution`: the seller trade flow as a guarded state machine with receipt verification.
- `strategy/wheel`: pure state derivation (positions, capital, basis ledger), gates, candidate planning,
  quote evaluation, DCA allocation.
- `daemon`: fixed-delay tick loop, dry-run (default) and live modes, research sampler, append-only JSONL
  recording, status file, kill switch, single-instance lock, structured logs, small CLI.
- Docs: protocol reference, this spec, an implementation plan, a README with run and production notes.

### 1.2 Out of scope (v1)

- Trading USDT0 or USDH products, or liquid-staking collateral (kHYPE, wstHYPE, LHYPE). The research
  sampler records USDT0 put quotes; the liquid-staking call legs are not sampled (dropped 2026-10-19 on the
  operator's ruling that no makers quote them); the strategy trades only USDC + WHYPE.
- Wrapping native HYPE to WHYPE (the wallet already holds WHYPE), early close, other underlyings.
- Database, dashboard, push alerts, multi-wallet, multi-host, testnet, chains other than 999.
- The items in §13 Future work.

Known limitations of v1, found while implementing and validating it:

- **Custom strikes need trading volume.** The RFQ server refuses a strike that is not in its current inventory
  for that expiry (JSON-RPC error `-32603`) unless the taker wallet has at least 250 000 USD of notional trading
  volume ("custom strikes require >= 250000 notional volume (have 0)", **live**). For a fresh wallet
  `call.fallback.customStrikeFirst` costs one refused RFQ each time the custom strike's backoff lapses (a refused
  RFQ backs its key off, §8.7; the listed `K*` candidate is still quoted), and the zero-address sampler cannot
  quote such strikes.
  A strike refused while unlisted was quoted once the inventory listed it again; a few strikes were still
  quoted shortly after they left the inventory (presumably the server's refresh lag); a wallet with volume had
  an unlisted strike quoted. Because a full sweep takes about 25 minutes at 6 RFQ/min while the listed strikes
  change about once a minute, 37 of the validation run's 100 RFQs (all sampler legs on strikes de-listed by then)
  were refused this way and recorded as `error`.
- **Startup settlement hold.** A fresh process holds both sides on G3 for `settlementGraceSec` (900 s) after its
  first settlement-free tick, so its first strategy RFQ comes about 15 minutes after startup; in live G7's
  `startupQuietSec` (600 s) runs at the same time. The sampler starts at once.
- **Lock staleness assumes pids are not reused.** `live.lock` is stale when its pid is not running; in a container
  the daemon is often pid 1 on every start, so a crash leaves a lock that looks held. systemd is the supported
  runner. Two instances started at the same moment against a stale lock can both take it.
- **The execution requote is outside the RFQ buckets** (waiting for a token would spend the quote's TTL). The
  config keeps `strategyRfqPerMin + samplerRfqPerMin ≤ 18` under the 20/min hard cap; there is at most one
  requote per execution.
- **No approve fee bump.** The one replacement at +30 % after 5 min (§5.3) is not implemented: an unmined approve
  aborts the trade (`approve`, `stuck`) and G8's `tx-pending` holds while it is pending.
- **The inventory stream changes about once a minute.** The listed strike set is regenerated as spot moves, so
  the sampler writes a small `changed` difference record about once a minute and a ~45 KB full record only every
  `inventoryEveryMin` (§9.2, §9.3).

## 2. Verified facts the design depends on

Provenance tags: **live** (observed on the wire on 2026-10-16), **bundle** (read from the app's
JavaScript), **docs** (Rysk documentation), **inferred**. Detail in `docs/rysk-protocol.md`.

- Rysk is request-for-quote; the seller is the taker. A `request` on `wss://v12.rysk.finance/taker` returns
  one best quote after a ~2 s auction. **live**: three zero-address requests from Node (no `Origin`
  header) were answered in 2.2–2.4 s with real maker quotes; `validUntil` is unix seconds, with TTLs of
  45, 66 and 93 s; `nonce` is a decimal string of 13 or 19 digits; `premiumAsset` is `""`; `apy` is a
  percent. The validation run (63 quotes from five makers) saw TTLs of 35–90 s at arrival, nearly constant per
  maker (about 35, 42, 42, 63 and 90 s), and response times of 2.1–3.7 s. The web app fires such requests for
  every visitor (about 8/s observed), so sampling is ordinary traffic.
- Selling requires one on-chain transaction from the seller: ERC-20 `approve(MarginPool, amount)` on the
  collateral token for the exact amount. The trade is submitted by Rysk's relayer after the seller signs an
  EIP-712 `Confirmation` and sends `confirm`; the result is the relayer's transaction hash. **live**: in the
  observed fill the exact allowance was fully consumed and the seller received exactly `quantity × price`;
  the maker fee was charged to the maker.
- `POST /api/gas` with the full confirmation body echoes every sent field unchanged (same string forms)
  plus exactly these extra keys: `fees`, `gasFee`, `isEIP1271`, `isPremium`, `premiumAsset`,
  `settlementCollateralPayout`, `settlementPayout`, `settlementPayoutAsset`, `signature`, `status`,
  `txHash`, `vaultId`. **live**: `gasFee` was `"0"` for every probe, including a price of 1 wei; errors
  for other cases are non-2xx with a text body (**bundle**). The app signs its own body and sends the
  spread echo (**bundle**).
- JSON-RPC `id` equals the method name, so replies are matched by method and content, not by a correlation
  id. There is no cancel. The maker `Quote` struct has no taker field, so a quote is a bearer offer until
  `validUntil`.
- For HYPE on chain 999 the RFQ `asset` is always WHYPE; calls pay premium in USDC and accept WHYPE,
  kHYPE, wstHYPE or LHYPE as collateral; puts exist as USDC/USDC and USDT0/USDT0 products. Minimum size 25,
  maximum 5000 contracts per trade, e18 quantities in multiples of the minimum. Inventory strikes are
  delta buckets (about 0.07/0.10/0.22/0.30/0.35/0.40 per side) regenerated as spot moves, over four
  expiries. Expiries are usually Friday 08:00 UTC but are read from data, never assumed.
- Rysk's displayed APR is `price / strike × 365.25 / T` for puts and `price / spot × 365.25 / T` for calls,
  `T` in days to expiry. **live**: with a 365.25-day year our formula reproduces `quote.apy` on all three
  spike quotes (75.3297 vs 75.3300) and the real fill's 62.83 %.
- The inventory's indicative `apy` understates real quotes, unevenly: real over indicative APR was 1.05–2.82×,
  mean 1.46, in the dry-run validation run (**live**; README "Research data streams"). It can rank candidates;
  it must never be used to apply the APR floor.
  Inventory `bid`/`ask` are zero for HYPE.
- `GET /api/user/positions?address=` returns every position, open and settled, with payout fields that
  identify the outcome exactly (§6.5). The row's `symbol` is the collateral symbol; the underlying is
  `address`. Chain-1 rows for the same address are included.
- An Opyn-Gamma-style vault store at `0x84d84e481b49b8bc5a55f17aaf8181c21a29b212` answers
  `getAccountVaultCounter(owner)`; for the sampled seller it equals the number of chain-999 rows
  (**live**). This is chain truth for how many positions exist, independent of the API.
- The public HyperEVM RPC allows 100 requests/min, has no WebSocket, and rejected one of six sequential
  calls with "Request exceeds defined limit." (**live**). Multicall3 is deployed and known to viem.
- Settlement is automatic for the seller, about two hours after expiry. The seller has nothing to do.

## 3. Architecture

Single TypeScript package. Layers with one-way dependencies; a pure core fed by an imperative shell.

```
cli ──► daemon ──► strategy/wheel ──► domain
 │        │  └──► execution ──► rysk ──► domain
 │        │           └──────► chain (through ports)
 │        └──────► rysk, chain (snapshot gathering)
 └──► chain, rysk, execution, strategy, domain (the one-shot commands: quote, wallet, state, basis)
```

| Layer | Responsibility | May import | Side effects |
|---|---|---|---|
| `domain` | Constants, types, units, parsing of inventory/positions/caps, APR math | nothing but viem types | none |
| `chain` | Keystore, viem clients, multicall snapshot, approve, receipts, vault counter | `domain` | RPC |
| `rysk` | REST, WebSocket JSON-RPC, taker `request`/`confirm`, EIP-712 | `domain` | HTTP, WS |
| `execution` | Guarded sell state machine | `domain`, `rysk`, chain **ports** | signing, txs |
| `strategy/wheel` | State derivation, gates, planning, evaluation | `domain` | none |
| `daemon` | Loop, snapshot, sampler, recorder, status, lock, config, logging | all | files, stdout |
| `cli` | Argument parsing, commands | `daemon` and below (thin one-shot commands call `chain`, `rysk`, `execution`, `strategy` and `domain` directly) | process |

Rules, enforced in code where possible:

- `domain` and `strategy` have no IO, no `node:` imports, never read a clock, and are deterministic and
  invariant to row order and duplicates. `test/architecture.test.ts` globs their sources (failing on an empty
  directory) and fails on any import outside `domain/` or `strategy/` other than `viem`, `lib/json.ts` and type-only
  imports of `lib/time.ts`, and on any `Date.now(`, `new Date(`, `Math.random(`, `setTimeout(`, `performance.` or
  `process.`.
- On-wire integers are `bigint` with the unit in the name (`strikeE8`, `quantityE18`, `priceE18`,
  `amount6`). Timestamps carry their unit (`expirySec`, `nowSec`, `tsMs`). APRs are fractions internally
  (`0.75`), converted from Rysk's percent at the parse boundary. Decimal strings are converted by string
  arithmetic, never through floats. Addresses are checksummed at parse time so internal `===` is safe;
  wire data is compared with `isAddressEqual`.
- Nothing from a server response can change which token is approved, which contract is the spender, or
  which domain is signed. These are pinned constants.
- No strategy state is stored across ticks. In-process memory (`daemon/memo.ts`) holds only: the in-flight
  flag that serializes executions, per-key RFQ backoff and the per-side re-plan time, used quote nonces and the
  last confirm nonce, per-side cooldowns and last confirm times, dry-run simulated deployments, G3's start of the
  current settlement-free run, the confirm-error, revert and APR-echo counts, the waits for a fill's visibility
  or an `unknown` result's evidence, and the live halt flag. All of it may be lost on restart; chain evidence
  and the startup quiet periods cover the gap (§7.6).
- Public repo hygiene: keystore directory, `config.json`, `data/` and `*.password` are gitignored in the
  first commit, later also `config.*.json` (but `config.example.json`), `*.key`, `*.pem` and `.env.*`; a
  `check:secrets` script fails on a tracked keystore `ciphertext` JSON key or a 64-hex string (with or without `0x`)
  outside `test/fixtures/`, and on any file it cannot read; fixtures are derived from a third-party seller's public
  on-chain activity with its address, transaction hashes and block hash replaced by fake ones (amounts and timestamps
  are real market data); the RPC URL is redacted from logs and records.
- The official `ryskv12` SDKs are not used: they are maker-side wrappers around a Go binary.

## 4. Toolchain and repository layout

- Node ≥ 22.22 (`.nvmrc`), run as `node src/cli/main.ts` using Node's native type stripping (verified in the
  sandbox). Consequences: `"type": "module"`, `module`/`moduleResolution: NodeNext`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly`, `allowImportingTsExtensions` + `noEmit`, `strict`,
  `noUncheckedIndexedAccess`; relative imports carry `.ts`; no enums, namespaces or parameter properties.
  `tsc --noEmit` typechecks; `vitest` tests; `biome` lints and formats; pnpm.
- Runtime dependencies: `viem` (chain, multicall, typed-data sign and recover, `hyperEvm`), `zod` (config
  and response validation, used only in `daemon` and `rysk`), `pino` (logs), `read` (hidden prompt).
- Dev dependencies: `typescript`, `vitest`, `@biomejs/biome`, `ws` (mock server), `@types/node`, `pino-pretty`.
- `src/lib/json.ts` exports `stringifyBig` (bigint → decimal string). The recorder uses it; pino gets a
  `formatters.log` that maps bigint to string (pino otherwise emits bare numbers that lose precision).
- `NODE_USE_ENV_PROXY=1` is a sandbox environment setting, never set in code.

```
rysk-client/
  package.json  tsconfig.json  biome.json  vitest.config.ts  .nvmrc  .gitignore  README.md
  config.example.json                  # committed; config.json is gitignored
  keystore/  data/                     # gitignored
  scripts/    check-secrets.mjs
  docs/  rysk-protocol.md  superpowers/specs/…  superpowers/plans/…
  src/
    lib/        json.ts  time.ts
    domain/     constants.ts  types.ts  units.ts  apr.ts  parse.ts  inventory.ts  positions.ts  caps.ts  index.ts
    chain/      abi.ts  keystore.ts  clients.ts  snapshot.ts  erc20.ts  receipts.ts  index.ts
    rysk/       rest.ts  socket.ts  taker.ts  eip712.ts  errors.ts  index.ts
    execution/  types.ts  checks.ts  echo.ts  body.ts  sell.ts  index.ts
    strategy/wheel/  config.ts  types.ts  classify.ts  basis.ts  state.ts  gates.ts  tranche.ts  candidates.ts  evaluate.ts  index.ts
    daemon/     config.ts  snapshot.ts  loop.ts  memo.ts  cooldown.ts  records.ts  trade.ts  bucket.ts  sampler.ts
                recorder.ts  status.ts  lock.ts  logger.ts  version.ts  wire.ts  index.ts
    cli/        main.ts  args.ts  format.ts  run.ts  state.ts  quote.ts  history.ts  wallet.ts  basis.ts
    **/*.test.ts  (colocated; src/rysk/live.test.ts is the opt-in live smoke test)
  test/
    architecture.test.ts
    helpers/    wheelSnapshot.ts
    fixtures/   keystore-anvil0.json  positions.json  inventory.json  assets.json  caps.json  history.json
                receipt.json  spike-capture.json
```

`daemon/memo.ts` holds the in-memory state, `cooldown.ts` applies trade results and the halt rules,
`records.ts` builds the stream records, `trade.ts` the pure `executionConfig` and `freshStateOf`, `bucket.ts` the
RFQ token buckets, and `wire.ts` builds every client and dependency from the config. The config example is
tested in `daemon/config.test.ts`.

## 5. Chain layer

### 5.1 Keystore

`decryptKeystore(json, password): Hex` implements Web3 Secret Storage v3 for Foundry's parameters
(scrypt, aes-128-ctr) with `node:crypto` (`scryptSync` with a generous `maxmem`, `createDecipheriv`) and
viem `keccak256` for the MAC. It accepts files without `address` and hex without `0x`.
`loadAccount(path, password)` returns a viem `PrivateKeyAccount`. The password is not stored after
decryption; the key is never logged or serialized.

Password resolution: hidden prompt on stderr when stdin is a TTY (`read`, `silent`); otherwise the file
named by `KEYSTORE_PASSWORD_FILE`, refused if group- or world-readable, less one trailing line break; otherwise fail. A
`KEYSTORE_PASSWORD` environment variable is deliberately unsupported. Only live mode loads the keystore;
startup asserts the decrypted address equals `config.account.address` and that `getCode(address)` is
empty (we hard-code `isEIP1271: false`). Startup also warns if `git ls-files keystore` lists anything.

### 5.2 Clients and the chain snapshot

`createChainClients({ rpcUrl, account? })` returns a viem public client (and wallet client when an
account is given) on `hyperEvm` over one `http(rpcUrl, { batch: true })` transport; startup asserts
`eth_chainId === 999` in both modes.

`readChainSnapshot(client, self)` issues **one** `multicall` returning, at a single block: block number
and timestamp (Multicall3's `getBlockNumber` and `getCurrentBlockTimestamp`, so they are the multicall's own
block), native HYPE, WHYPE, USDC and USDT0 balances, `allowance(self, MarginPool)` for USDC and WHYPE, and
`getAccountVaultCounter(self)` on the vault store; plus `getTransactionCount` for `pending` and `latest` in the
same HTTP batch. Any failed read fails the snapshot and the tick holds (never decide on partial data). The
public RPC is flaky; the README recommends a provider URL.

### 5.3 ERC-20 approve

`approve(token, spender, amount): Promise<Hex>` returns the hash; `waitForReceipt(hash, timeoutMs)` is a
separate call so a timed-out approve still has a recorded hash. Rules: approve exactly `amount` whenever
`allowance ≠ amount` (an approve overwrites a stale allowance); refuse if `pendingNonce ≠ latestNonce` (one transaction in flight, far from the 8-nonce mempool limit);
viem EIP-1559 defaults with a configurable `maxFeePerGasGwei` cap (`createApproveDeps(publicClient,
walletClient | undefined, { maxFeePerGas })`; without a wallet client, in dry-run, the reads work and `approve`
rejects); wait 60 s; otherwise `stuck`. Once `approve` has returned a hash, every later failure is `stuck` with
that hash, so it is never lost. Re-read the allowance after mining. Never unlimited approvals: an amount
≥ 2^255 is refused before any read. **Not implemented in v1:** after 5 min unmined, one replacement at the same
nonce with +30 % fees (§1.2, §13).

### 5.4 Receipts

`verifyFillReceipt(receipt, expected)` decodes logs and checks: `status == 1`; `to == Rysk`; an ERC-20
`Transfer` of the collateral token from `self` to `MarginPool` for exactly `collateralAmount`; a
`Transfer` of USDC from `MMarket` to `self` for `premium6 − gasFee6` (±1 unit, warn if lower);
`VaultOpened(owner = self)` from the vault store with `vaultId == counterBefore + 1`; `ShortOtokenMinted(owner =
self)` from the Gamma controller (`0x577b…`) with amount `== quantityE18 / 10^10` into that vault; and no other
`Transfer` from `self`. Structure and both emitters verified on a real fill.

## 6. Domain and Rysk layers

### 6.1 Constants

`CHAIN_ID = 999`; `ADDRESSES`: `rysk`, `marginPool`, `mmarket`, `vaultStore`, `multicall3`; `TOKENS`:
USDC, USDT0, USDH, WHYPE, kHYPE, wstHYPE, LHYPE with decimals and symbols; `PRODUCTS`: the traded
products (`put: USDC/USDC`, `call: USDC/WHYPE`) and the sampled ones. `EIP712_DOMAIN` is pinned.
Only chain 999 is encoded; a protocol-version tripwire (§9.5) watches for drift.

### 6.2 Types

Defined in Appendix A: `Product`, `Listing`, `Asset`, `Cap`, `QuoteRequest`, `Quote`, `ConfirmBody`,
`Position`, `Settlement`.

### 6.3 Units and APR

All conversions live in `domain/units.ts` and are tested against the real fill (25 WHYPE put @ 78.5 →
collateral `1962500000`, premium `47486300`, APR 62.83 %) and the spike quotes:

- `strikeE8FromKey(key)` parses the inventory combination key by string arithmetic (`"86.500000-…"`),
  asserting it equals `round(strike × 1e8)`; the per-expiry `strikes` arrays are not used (they drop `.5`).
- `floorToIncrement(qE18, stepE18)` never clamps up (the app's helper does; a 10 HYPE deposit must yield 0).
- `collateralForCall(qE18, decimals) = qE18 / 10^(18 − decimals)`; `collateralForPut(qE18, strikeE8) = qE18 × strikeE8 / 10^20`.
- `putQuantityFromUsd(usd6, strikeE8) = usd6 × 10^20 / strikeE8`.
- `premium6(qE18, priceE18) = qE18 × priceE18 / 10^30` (floor; equals the API's `premium`).
- `aprFraction(net6, collateral6, nowSec, expirySec) = net6 / collateral6 × 31_557_600 / (expirySec − nowSec)`
  (a 365.25-day year, which is what Rysk uses),
  with `collateral6 = qE18 × strikeE8 / 10^20` (put) or `qE18 × spotE8 / 10^20` (call).
- `minPriceE18ForApr(aprFloor, collateral6, qE18, nowSec, expirySec, gasFee6)`: the price at which the net
  APR equals the floor (same 365.25-day year); used by execution as the REQUOTE screen (§7.1), not as the
  final floor check, which C8 re-applies with the real gas fee.

### 6.4 Inventory, assets, caps parsing

Per-item parsing: an invalid combination, asset or cap is dropped with a counted warning; the tick does not
fail. `Listing.products[].collateralAsset` comes from the product entry's `asset`/`collateralAsset`; the RFQ
asset is the underlying from `assets`. `spotE8` is `assets[WHYPE].price` scaled, and the inventory `index`
is recorded for display. `remainingCapacityE18(caps, { underlyingSymbol, asset, isPut }, notionalPriceE8,
marginBps = 10_000)` returns the minimum headroom over `GLOBAL`, the underlying symbol (`HYPE`, not `WHYPE`), the
asset address and `address-isPut`, each as `cap × marginBps / 10 000 − usage` (never negative), or `null` when no
cap applies. NOTIONAL caps are converted to contracts at `notionalPriceE8`, which the wheel sets to **spot for
both sides** (the app's behaviour; more conservative than strike for OTM puts). Entries with `cap == 0` are not
enforced and are skipped (`domain/caps.ts`, tested on captured caps). The wheel's soft pre-check passes
`CAP_SOFT_MARGIN_BPS = 9_500` (§8.5).

### 6.5 Positions and settlement

Rows on chain 999 with underlying WHYPE are parsed **strictly**: any invalid such row fails the parse and
the tick holds (a dropped row would corrupt locked capital and the basis). All other rows (`foreign`,
`otherChain`) are parsed only for `chainId` and the row key, enough for the vault-counter comparison; their
oddities are warnings, never holds. They are de-duplicated by key (one warning per duplicated key), as the strategy
de-duplicates positions, so a repeated foreign row cannot lift `apiCount999` above the vault counter. `parsePosition(row)` converts to `bigint` (asserting e18 strikes are
exact multiples of 1e10 and `premium` is an exact 6-dp value), checksums addresses, and sets:

- `status`: `'open'` (`""`), `'settled'` (`"SETTLED"`), `'unknown'` (anything else, or `isBuy !== true`).
- `settlement` for settled rows, from payout fields only: `payout == 0 && collateralReturned > 0` →
  `expiredOtm`; put with `payout > 0 && collateralReturned == 0` → `assigned` (payoutAsset is the
  underlying, payout equals quantity); call with `payout > 0 && collateralReturned == 0` → `exercised`
  (payoutAsset equals `usd`, payout equals `quantity × strike / 10^20`); else `anomaly`.
- Row key for de-duplication: `txHash|isPut|strikeE8|expirySec|collateral|quantityE18`.

The phase relative to time (`open`, `pendingSettlement`) is computed in the strategy from `nowSec`.

### 6.6 REST client

`RyskRest(baseUrl, { fetch, clock })`: 15 s timeout, three retries with exponential backoff on network
errors and 5xx (never on 4xx), zod parsing. Methods: `assets`, `inventory`, `caps`, `userPositions`,
`publicHistory(from, to)`, `gasFee(body)` returning `{ ok: true, gasFee6, echoed } | { ok: false, reason:
'exceeds-premium' | 'http', status, message }` (text matching `/gas fee more than premium/i` maps to
`exceeds-premium`, tested on the whole body); an error message carries at most the first 300 characters of the
response body; a network error or timeout throws, which the callers treat as a failed preview
(`gas.ok: false, reason: 'http'`) or `aborted('gas')`. Every response's `Date` header updates the measured server
skew (§8.3 G5).

### 6.7 WebSocket JSON-RPC client

`JsonRpcSocket({ url, createWebSocket, timers, random, logger, connectTimeoutMs = 10_000, idleCloseMs =
30_000, backoff })` with injectable socket factory and timers so unit tests run on fake timers.

- Connect on demand; at most one underlying socket; states `idle → connecting → open → closed`; every
  handler checks it belongs to the current socket; each connection has an id. Open is declared 500 ms
  after `onopen`, which also resets the backoff. Reconnect backoff `1 s × 2ⁿ`, cap 30 s, ±25 % jitter. No
  heartbeat and no watchdog: per-call deadlines detect dead connections, and the socket closes after
  `idleCloseMs` with nothing pending or queued.
- `call(method, params, { timeoutMs, accept?, signal? })`: because `id === method`, calls are serialized
  per method; `timeoutMs` covers queue wait, connect and response, and a queued call whose deadline passes
  is dropped unsent. A reply whose `result` fails `accept` is logged and ignored, and waiting continues
  (late replies to a previous request have the same id). `error` → `RyskRpcError(code, message)`, except that
  while a sent call of the method was abandoned unanswered on the connection, one `error` reply to a call with
  `accept` is taken as that abandoned call's late answer and ignored (an error names no terms to match); close
  while pending → `SocketClosedError`; errors with `id: null` are logged. The caller never retries blindly.
- `SocketClosedError` and `CallTimeoutError` carry `sent: boolean` (whether the frame reached the socket), and
  `CallOptions.onSent()` fires synchronously once a frame is written. A sent call abandoned unanswered marks its
  method on that connection: a later call of that method without `accept` (i.e. `confirm`) is held and the
  connection recycled, so a stale reply can never settle it.

`RyskTaker(socket, { nowSec, nowMs, minGapMs = 250 })` (`nowSec` is server-aligned):

- `requestQuote(req, { timeoutMs = rfqTimeoutMs (15 000), signal })`: `QuoteResult` (Appendix A; the daemon's
  quote dependency adds `makerSigOk` and the gas preview to make a `QuoteOutcome`). `accept` matches
  `assetAddress`, `chainId`, `expiry`, `isPut`, `quantity`, `strike`, `usd`, `collateralAsset` against the
  request; a matching frame then must have `isTakerBuy === false`, an integer `validUntil` with
  `nowSec < validUntil ≤ nowSec + 3600` (catches a seconds/milliseconds mix-up) and a 65-byte hex signature
  (`/^0x[0-9a-fA-F]{130}$/`), else `mismatch`. One request in flight per socket, 250 ms gap.
- `confirm(params, { timeoutMs = confirmTimeoutMs (60 000), onSent })`: `ConfirmReply` — `hash`, `rejected`
  (a JSON-RPC `error`), `bad-result` (a non-error reply whose `result` does not match `/^0x[0-9a-f]{64}$/i`, never
  a rejection) or `no-reply` (`timeout` or `socket-closed`, with `sent`). Sent without `accept`.

### 6.8 EIP-712

`EIP712_DOMAIN = { name: 'rysk', version: '0.0.0', chainId: 999, verifyingContract: ADDRESSES.rysk }`,
pinned, never read from a server `typeDataDomain`. `CONFIRMATION_TYPES` (17 fields, verbatim from the
bundle) and `QUOTE_TYPES` (13 fields). `signConfirmation(account, message)` via viem `signTypedData`;
`recoverQuoteSigner(quote)` via `recoverTypedDataAddress`; `makerSignatureOk(quote, recover)` returns `true` when
it recovers the maker, `false` for anyone else or a rejection, `null` without a recoverer. It is recorded on every
quote as `makerSigOk` and enforced only when `verifyMakerSig: 'enforce'` (the example's default). Contract-maker
(EIP-1271) signatures are not accepted in v1: the taker classifies a quote whose signature is not 65 bytes of hex
as `mismatch` (§6.7), so it is never priced or executed in either mode. A 65-byte signature that does not recover
the maker is `makerSigOk: false`: C5 rejects it only under `'enforce'`; under `'warn'` it is logged and the quote
may trade, so a live run is refused at config load unless `'enforce'` is set (§9.1). **live**: every captured maker signature recovers (the three spike
quotes and every quote of the validation run), so the pinned domain is the makers' domain too. Tests:
sign-and-recover with the key derived from the committed keystore fixture (no raw private key in the
repo), and signer recovery on captured real quotes.

## 7. Execution

`sellOption(deps, intent): Promise<TradeResult>` (types in Appendix A) is the only code path that
signs. One instance in flight per process (the loop runs executions one at a time and sets `memo.inFlight`
around them, so `guards.inFlightExcludingSelf` is always false) and per host (`data/live.lock`, `O_EXCL`, pid,
stale takeover). `sellOption` is designed never to throw; should it throw anyway, the loop treats the outcome as
`unknown('bad-result')`.

### 7.1 Steps

```
PRECHECK → APPROVE → REQUOTE → GAS → CHECKS → [dry-run stops here] → SIGN → CONFIRM
   → RECEIPT → CHAIN_VERIFIED → done (API visibility is observed by the loop, not awaited here)
exits: aborted(stage) | reverted | unknown
```

Every result after the confirm was sent (`filled`, `reverted`, `unknown`, and `aborted('confirm-rejected')`)
carries `bookkeepingErrors: string[]`: a failed record write, cooldown callback or STOP write never changes the
outcome, so each failure is listed, and the daemon logs them at error level (a failed STOP write halts live in
memory).

1. **PRECHECK** (before the approve transaction): the mode is `live` or `dry-run` (any other value fails
   closed); not shutting down; in live the signer is the wallet, no `STOP` and the lock held; the candidate's side
   is the intent's; its `strikeE8`, `expirySec` and `quantityE18` equal the request's `strike`, `expiry` and
   `quantity` (the wire strings parsed as strict uints) and the request's `taker` is the wallet
   (`isAddressEqual`); the collateral token is the side's pinned one and the collateral amount equals the
   recomputed one; then one `freshState()`: no gate holds and the fresh tranche equals the intent's quantity. Any
   failure → `aborted('precheck')`.
2. **APPROVE**: `collateralAmount` depends only on strike, quantity and decimals, so approve before the
   executable quote and do not burn its TTL. Approve exactly `collateralAmount` whenever `allowance ≠
   collateralAmount` (an approve overwrites a stale larger allowance); `approve` + `waitForReceipt`;
   `stuck` → `aborted('approve')`. In dry-run this step only reads the allowance and records `wouldApprove`.
3. **REQUOTE**: if `quote.validUntil − serverNowSec < minQuoteTtlSec + REQUOTE_MARGIN_SEC` (15 + 10 s), request
   one fresh quote for the same request with `taker = self` (timeout `timeouts.requoteMs`, no RFQ bucket token).
   The 10 s margin leaves the held quote enough TTL to clear C6 after the gas POST and the second fresh state
   that come before the checklist. Only a quote held at this step is ever signed. If `price <
   intent.minPriceE18` → `aborted('price-floor')`. No other price tolerance exists.
4. **GAS**: build our own `ConfirmBody` (§7.3) with `nonce = max(now, lastNonceMs + 1)`, `gasFee(body)`;
   `exceeds-premium`, `http` or a throw → `aborted('gas')`. An echo that departs from the body →
   `aborted('echo', { echoOk: false })`, and in live `STOP`. The `GasResult.gasFee6` is the only gas fee used
   from here on (the echo is never re-parsed for it).
5. **CHECKS**: a second `freshState()` immediately before the checklist (§7.2, C2 requires it ≤ 10 s old). Any
   failure → `aborted('guard')` with the check id. In dry-run mode
   the function returns `aborted('dry-run', { echoOk, wouldApprove })` here, having exercised body
   building, the gas echo and every guard against real data; C1 and the allowance clause of C13 are recorded
   `n/a` in dry-run, every other check runs. The daemon records the simulated deployment (§8.8) only after
   this result is returned, so the DCA gate inside C2 does not block the dry-run path.
6. **SIGN**: the message from the checked body and the checklist's gas fee; the quote nonce joins
   `usedQuoteNonces` and `lastNonceMs` advances; a `trade-intent` record (typed-data hash, nonce, body) is
   appended (write-ahead); then `signConfirmation`. Any failure here (a throwing message builder, a failed
   write-ahead, a signer error) → `aborted('sign')`.
7. **CONFIRM**: `signal` checked synchronously immediately before sending (aborted → `aborted('shutdown')`); the
   side's cooldown starts and `memo.lastConfirmSec[side]` is set **when the message is sent** (`onConfirmSent`,
   from the socket's `onSent`); `confirm` is sent at most once per signed body and never retried. Timeout
   `timeouts.confirmMs` (60 s). Reply with a JSON-RPC `error` → `aborted('confirm-rejected')` (which clears
   `lastConfirmSec` via `onConfirmCleared`), except a malformed error frame (code 0) → `unknown('bad-result')`; a
   non-error reply failing the hash regex or a throwing `confirm` → `unknown('bad-result')`; no reply →
   `unknown('confirm-timeout')`, socket closed → `unknown('socket-closed')`, shutdown while waiting →
   `unknown('shutdown')`.
8. **RECEIPT**: wait `timeouts.receiptMs` (120 s). `status 0` → `reverted` (definitive, collateral unmoved;
   clears `lastConfirmSec`). Success → verify (§5.4); any mismatch → write `data/STOP`, fatal log, and return
   `unknown('verify-failed')`. Timeout → `unknown('receipt-timeout')`. A premium received below
   `premium6 − gasFee6` is recorded as `premium-shortfall` and the result is still `filled`.
9. **CHAIN_VERIFIED**: vault counter `== before + 1` and allowance after the fill lower than after the approve by
   exactly `collateralAmount` → `filled`; otherwise (a read error included) `STOP` and `unknown('verify-failed')`.
   The daemon also halts live in memory on any `verify-failed`, whether or not the STOP write succeeded.

### 7.2 Pre-sign checklist

| id | check |
|---|---|
| C1 | Live mode, no `data/STOP`, lock held, signer address == `config.account.address`, `isEIP1271 = false`. |
| C2 | Fresh state (`nowMs − fetchedAtMs ≤ 10 s`) passes all gates, evaluating G8 with the calling execution excluded; in live `nativeHype ≥ minNativeHype`; recomputed tranche quantity equals the intent. |
| C3 | Pinned allowlist: `assetAddress` WHYPE; `usd` USDC; `collateralAsset` USDC (put) or WHYPE (call); `chainId 999`; `isPut` matches the side; `isTakerBuy false`; `taker == self`. A put in any mode other than `normal` fails (fallback is calls only). |
| C4 | Quote echoes the request on every term field (§6.7). |
| C5 | `maker ∉ {zero, self}`; `quoteNonce` not previously **signed** in-process (a nonce joins the used set at SIGN); `recoverQuoteSigner == maker` when `verifyMakerSig: 'enforce'` (under `'warn'` a 65-byte signature that does not recover passes with a recorded warning). A signature that is not 65 bytes (an EIP-1271 contract signature) never reaches the checklist: the taker records it as `mismatch` (§6.8). |
| C6 | `minQuoteTtlSec ≤ validUntil − serverNowSec ≤ maxQuoteTtlSec (600)`, and `validUntil < expiry`. |
| C7 | `price > 0`; `price / strike` (put) or `price / spot` (call) ≤ `maxPremiumFractionOfCollateral` (0.15); `quote.apy` finite; our APR (gas 0) within `aprEchoTolerancePp` (1.0 percentage point) of `quote.apy` for a put, and for a call within the larger of that and `aprEchoToleranceRelPct` (5 % of `quote.apy`). A put's collateral is its strike, which both sides price alike (the validation run's puts agreed exactly); a call's APR is priced at fresh spot while the maker priced `apy` moments earlier, so its tolerance scales with the APR: at 100 % a 1 pp disagreement is a 1 % move. |
| C8 | Normal mode: `aprFraction(premium6 − gasFee6 from the GAS step, collateral6, serverNowSec, expiry) ≥ minApr`. Fallback: `net6 ≥ call.fallback.minNetPremium6`. Both: `net6 ≥ safety.minNetPremium6`. (`minPriceE18` is only the REQUOTE screen.) |
| C9 | Gas echo (§7.3): every sent field equal by kind; extra keys ⊆ the known set with their expected values; `gasFee` a non-negative integer string with `gasFee6 × 10000 ≤ premium6 × maxGasFeeBps`, `gasFee6 ≤ maxGasFee6` (= `safety.maxGasFeeUsd` as 6 dp) and `gasFee6 ≤ intent.maxGasFee6` (the decision's bound). |
| C10 | Strike vs fresh spot: put `K ∈ [0.6 S, S (1 − minOtmPct)]`, call `K ∈ [S (1 + minOtmPct), 1.4 S]` (the band is `STRIKE_BAND_MIN_BPS`/`STRIKE_BAND_MAX_BPS` in `domain/constants.ts`, which the planner also applies); `K % strikePrecision == 0`; `K` listed for that expiry in listings at most 5 min old (`nowMs − listingsAtMs ≤ 300 s`) unless the intent is a custom fallback strike. |
| C11 | Expiry in the current inventory and within the tenor window (fallback: ≥ `minHoursToExpiry`). |
| C12 | `qty % minTradeSize == 0`; `minTradeSize ≤ qty ≤ min(maxTradeSize, maxContractsPerTrade)`. |
| C13 | `collateralAmount` equals the required collateral and is ≤ free balance − reserve; in live `allowance == collateralAmount`. In dry-run the result is recorded `n/a` once the collateral clauses pass. |
| C14 | Caps soft check (§8.5): `capHeadroomE18 === null` or `qty ≤ capHeadroomE18` (the provider applies the 0.95 margin), and `qty ≤` the fresh cap-bounded tranche. |
| C15 | Domain pinned; `nonce = String(max(Date.now(), lastNonceMs + 1))`, above `lastNonceMs` and within 5 s of the local clock. |
| C16 | Daily limits including this trade. |
| C17 | The body carries exactly the checked quote's 13 term fields, and the message builds from it; the signer accepts only the branded `CheckedConfirmBody` that `checks.ts` returns in live (`null` in dry-run). |
| C18 | Calls only, on the fresh state: `basis.reliable` and defined; normal mode `K ≥ basisE8 × (1 + minStrikeOverBasisPct)`; fallback modes: the fresh `basisEligible` set is still empty and a fresh `K*` exists; `basis-fallback`: `K` equals the fresh `K*` and is below the basis threshold (fallback mode only sells below it); `basis-fallback-custom`: `K` is the candidate's custom strike, above the fresh `K*`. |

### 7.3 Confirm body and gas echo

```ts
const body: ConfirmBody = {
  assetAddress: WHYPE, chainId: 999, expiry, isPut, isTakerBuy: false,
  maker: q.maker, price: q.price, quantity, quoteNonce: q.nonce, quoteSignature: q.signature,
  quoteValidUntil: q.validUntil, validUntil: q.validUntil,     // both the quote's validUntil (bundle); neither is signed
  strike, taker: self, usd: USDC, collateralAsset, collateralAmount, nonce,
};
```

Echo equality by field kind (`echo.ts`): **address**: both `isAddress` and `isAddressEqual`; **uint**: the
echo is `/^\d+$/` or a safe integer and `BigInt` equal; **bool**: strict; **hex**: case-insensitive; a missing
field is a mismatch. Extra keys must be a subset of `GAS_ECHO_EXTRA_KEYS` = {`fees`, `gasFee`, `isEIP1271`,
`isPremium`, `premiumAsset`, `settlementCollateralPayout`, `settlementPayout`, `settlementPayoutAsset`,
`signature`, `status`, `txHash`, `vaultId`} (from the spike); any other key aborts in live mode and is
recorded. Every extra key except `gasFee`, `signature` and `isEIP1271` must carry its spike value (`""`, or
`false` for `isPremium`); otherwise `aborted('echo')`, recorded, and `STOP` in live. `gasFee` missing or
`""` means `"0"`.

**Sign** `toConfirmationMessage(body, gasFee6)` — from our body, never from the echo. **Send**
`{ ...echoedExtras, ...body, gasFee, isEIP1271: false, signature }` (the body over the extras, so no echoed
value can replace a body field) where `echoedExtras` are the
allowlisted extra keys with their echoed values and `signature` replaced by ours. This carries exactly
what the app sends while guaranteeing the signed fields are ours. `referralCode` is never sent.

### 7.4 Gas preview

Evaluation uses the app's 9-field preview body (`assetAddress, chainId, isPut, collateralAsset, expiry,
strike, usd, price, quantity`). The full body is used only inside `sellOption`.

### 7.5 Cooldown

| result | cooldown on the side |
|---|---|
| `aborted` before confirm | none |
| `aborted('confirm-rejected')`, `reverted` | 60 s; `memo.lastConfirmSec[side]` is cleared so the DCA interval is not consumed; three confirm errors (rejections and reverts) per hour or two reverts per 24 h → halt live. A rejection is also watched (`memo.rejectedWatches`) for `unknownMaxWaitSec`, by position only (another trade may move the counter): a row with its terms and `createdAt ≥ confirmSentAtSec` is a fill the error reply denied, which went through no receipt verification, so it is recorded as `rejected-filled` and halts live (§10). The watch holds nothing and ends silently, or at the next sent confirm on the same trade (side and terms), whose row it must not take; a second rejection of the same trade replaces it, keeping the earlier send. |
| `filled` | until the txHash appears in the positions API (max `unknownMaxWaitSec`, 1800); the cooldown is set to `sentAt + unknownMaxWaitSec` when the confirm is sent and lifted when the row is visible (`visible` record with the latency) |
| `unknown` | until evidence: a matching row with `createdAt ≥ confirmSentAtSec`, or the vault counter increased (then verify); after `unknownMaxWaitSec` log error and unblock; never re-sign meanwhile |

### 7.6 Restart and double deployment

Evidence at startup is stateless:

| evidence | interpretation | action |
|---|---|---|
| `counter == apiCount999`, allowance 0 | idle, or a confirm accepted just before a crash and not yet mined | live sends nothing for `startupQuietSec` (600) |
| `counter > apiCount999` | a trade executed; API lagging | gate `api-lag` holds until the API catches up |
| allowance > 0, counter unchanged | approve done, trade not executed | quiet period; the exact allowance is reusable and spendable only with our signature |
| `pendingNonce > latestNonce` | our approve is in the mempool | hold `tx-pending` |

The DCA interval derives from `createdAt` (1 s after the block in the observed fill) and the in-memory
last confirm time, so re-deployment is blocked as soon as the API shows the row, and the `api-lag` gate
blocks it before that. The lock is per data directory, not per host: a second live instance on the same data
directory is refused by it, while instances on different data directories (or hosts) trading one wallet are
unsupported and documented.

## 8. Wheel strategy (pure)

### 8.1 Inputs

`Snapshot` is defined in Appendix A; `WheelConfig` is the zod output of Appendix B (§8.9). `nowSec` is the
chain block timestamp; `localNowMs` is the process clock. The daemon applies the `replanSec` timer before
calling `planSide` and removes backed-off candidates from the plan **after** it: `planSide` always sees the full
listings, so a backoff never shifts the fallback strike `K*` lower or flips a call side from an `apr-floor`
hold into the fallback. A plan emptied by backoff holds `apr-floor` without an RFQ. The pure core never sees the
backoff.

### 8.2 State derivation

`deriveState(snapshot, config): WheelState`, deterministic and order-invariant:

1. De-duplicate rows by key (collapse identical rows with a warning; the same key with different content is
   also an anomaly, keeping the lowest copy by content for order invariance). A settled row without a
   settlement, or with an `anomaly` settlement, is an anomaly. Classify each row:
   `managedPut` (chain 999, underlying WHYPE, put, usd USDC, collateral USDC), `managedCall` (call, usd
   USDC, collateral WHYPE), `whypeCallOtherUsd` (call, collateral WHYPE, other stable: locks our WHYPE,
   affects basis), `whypePutOtherUsd` (put on WHYPE, other stable: delivers WHYPE, affects basis),
   `hypeForeignCollateral` (kHYPE/LHYPE/wstHYPE collateral), `foreign` (other underlying), `otherChain`.
   Phase from `nowSec`: `open`, `pendingSettlement` (status open, `expiry ≤ now`), `settled`, `unknown`.
2. Chain cross-check: `apiCount999 = |rows with chainId 999|` (all underlyings). `counter ==` → `'ok'`;
   `>` → `'api-lag'`; `<` → `'inconsistent'` (anomaly).
3. Capital per side:

   | | put (USDC 6 dp) | call (WHYPE 18 dp) |
   |---|---|---|
   | `free` | `max(0, usdc − reserveUsdc)` | `max(0, whype − reserveWhype)` |
   | `locked` | Σ `qty × strike / 10^20` over `managedPut ∧ open` | Σ `qty` over `(managedCall ∪ whypeCallOtherUsd) ∧ open` |
   | `pending` | same over `pendingSettlement` | same |
   | `total` | free + locked + pending | free + locked + pending |
   | `budget` | `min(total, maxCapitalUsdc ?? ∞)` | `min(total, maxCapitalWhype ?? ∞)` |

   USDT0 and native HYPE are never capital; USDC locked in `foreign` puts reduces `free` without adding to
   `total`, so a dedicated wallet or `maxCapitalUsdc` is recommended.
4. HYPE basis ledger (§8.4).
5. `lastDeployTs[side]` = max over that side's managed rows' `createdAt`, `memo.lastConfirmSec[side]` (set when
   a confirm is sent, cleared on `confirm-rejected` and `reverted`), and (dry-run only) simulated deployments.
6. `deploymentsLast24h` and `notionalLast24h6` from managed rows (rolling 24 h, both sides, including
   manual trades, which errs conservative).
7. Output `WheelState` (Appendix A) including `anomalies[]` and `warnings[]`.

### 8.3 Gates

| id | scope | rule | default |
|---|---|---|---|
| G1 | global | no anomalies and no `unknown` rows | |
| G2 | global | consistency `'ok'` (`api-lag` or `inconsistent` hold) | |
| G3 | global | no managed or basis-relevant row is `pendingSettlement`, and `settlementGraceSec` (900) has passed since `memo.lastNoPendingSeenSec`, the first tick (in memory) of the current settlement-free run; `null` after a restart, so a fresh process holds for the grace from its first tick | |
| G4 | global | rows fetched this tick; block age ≤ 30 s; inventory age ≤ 120 s | |
| G5 | global | `|local − serverNow| ≤ maxClockSkewMs` (3000) (server time from REST `Date` headers and the block timestamp) | |
| G6 | global | WHYPE asset active, `marketStatus.isOpen !== false`, HYPE listings present | |
| G7 | live | uptime ≥ `startupQuietSec` (600) | |
| G8 | global | no execution in flight; `pendingNonce == latestNonce` (`tx-pending`); side not in cooldown | |
| G9 | live | `nativeHype ≥ minNativeHype` (0.05) | |
| G10 | live / global | `data/STOP` absent — **live only**: dry-run continues past STOP (§9.4); global: `enabled` (`disabled`), and frontend version unchanged or `pauseOnFrontendChange` off (`frontend-changed`) | |
| G11 | live | `deploymentsLast24h < maxDeploymentsPer24h` (4); `notionalLast24h6 < maxNotionalPer24h6` (20 000 USD) | |
| S1 | side | side enabled | |
| S2 | side | `now − lastDeployTs[side] ≥ minIntervalHours` (24) | |
| S3 | side | tranche yields ≥ one lot (§8.5), puts sized at spot; `cap` when the caps headroom alone leaves less than a lot, else `below-min-lot` | |
| S4 | call | basis reliable and defined | |
| S5 | put | HYPE exposure ≤ `maxHypeExposurePct` when set (off) | |

`checkGates` returns `{ hold, results }`: every gate that applies is evaluated, even after one fails (G7, G9 and
G11 in live only, S4 for calls, S5 for puts when set), `results` lists them with a `detail` for each failure, and
`hold` is the first failing gate's reason in table order (`null` when all pass). Hold reasons use the
`HoldReason` names (G2 → `api-lag` or `inconsistent`, S1 → `disabled`). G4 has no "fetched this tick" flag: the
snapshot contract is that positions are fetched and parsed on every tick, never reused.

### 8.4 HYPE basis ledger

Config `basis: { anchor: { ts, qtyWhype, basisUsd }, externalFlows?: [{ ts, qtyWhype (signed), basisUsd? }],
residualPolicy: 'absorb' | 'block-calls', residualToleranceWhype }`, normalized to
`anchor: { ts, qtyE18, basisE8 }`, `externalFlows: [{ ts, qtyE18, basisE8? }]` and `residualToleranceE18`.
`anchor.qtyWhype` is the HYPE owned at `anchor.ts`: wallet WHYPE plus WHYPE locked in calls open at that
instant. When `call.enabled`, loading the config for `run` fails unless `anchor.ts > 0` and
`anchor.basisUsd > 0` (a zero anchor would disable the basis rule); the read-only commands load it with
`ConfigFlags.requireAnchor: false`, so `basis suggest-anchor` works before the anchor exists. The example ships
a zero anchor, which `run` refuses field by field while `call.enabled` (a half-filled anchor, `ts` and `qtyWhype`
copied but `basisUsd` still 0, fails on `basisUsd`), so calls are never priced off a made-up basis. If `anchor.ts` falls inside `[expiry, expiry + 6 h]` of any basis-relevant
row, the basis is unreliable with reason `anchor-in-settlement-window`. `rysk basis suggest-anchor` prints `{ ts: blockTs,
qtyWhype: H_obs }` so the user supplies only the price.

Events: settled ITM rows with underlying WHYPE and `expiry > anchor.ts`: assigned puts (`managedPut`,
`whypePutOtherUsd`) **add** `payout` at `strike`; exercised calls (`managedCall`, `whypeCallOtherUsd`)
**remove** `quantity`; `externalFlows` with `ts > anchor.ts` add at their price (default anchor price) or
remove (removals ignore `basisUsd`). A settled row's event `ts` is its `expirySec`. Order: `ts` ascending;
at equal `ts`, adds before removes; within the same `ts` and direction, row events before flows, rows by
`createdAt` then `txHash`, flows in config order.

Replay in exact `bigint` (cost in e8-USD × e18-HYPE): `q = Q0, cost = Q0 × B0`; add → `q += n, cost += n ×
price`; remove → if `n > q` → the basis is unreliable with reason `basis-negative` (anchor wrong or an
unrecorded deposit) and a warning is emitted, not an anomaly, so calls hold (S4) while puts continue; else `cost = cost × (q − n) / q; q −= n` (removal at average leaves the average
unchanged). Compare `H_ledger = q` with `H_obs = whype + WHYPE locked in open calls` (only when no
basis-relevant row is pending): `R = H_obs − H_ledger`; `|R| ≤ tol` → ok; `R > tol` with `absorb` → re-run
with `Q0' = Q0 + R` (external WHYPE at the anchor price, placed at the anchor so later removals do not
re-order it); `R < −tol` with `absorb` → a final removal of `|R|` at the average, warning
`external-withdrawal`; `block-calls` → unreliable until the user records the flow. `basisE8 = ceil(cost / q)`
(rounded up: conservative for the ≥ rule), `null` when `q = 0`. Premiums are not netted. Legacy USDT0
rows that moved WHYPE must be in the ledger (five of the eight exercised calls in the sample wallet were).

### 8.5 Tranche sizing

```
unit(put, K) = K_e8 / 100 (USDC 6 dp per contract);  unit(call) = 10^18
room   = min(budget − (locked + pending), free)
target = budget × trancheFraction
lots   = floor(min(target, room) / (unit × 25))
if lots == 0 && allowSingleLot && unit × 25 ≤ room → lots = 1     // else the wheel stalls after a 25-lot assignment
qty    = min(lots × 25, maxTradeSize, maxContractsPerTrade, remainingCapacity rounded down to 25)
```

Caps are a soft pre-check (`usage` semantics are unclear; the server is authoritative): require
`usage + need ≤ 0.95 × cap` for every matching entry. The margin is applied in one place,
`remainingCapacityE18(…, CAP_SOFT_MARGIN_BPS = 9_500)`, by both the strategy and the execution's fresh-state
provider; `trancheQuantityE18(side, st, strikeE8, s, c, capacityE18)` receives the margin-applied headroom and
only rounds it down to whole lots. NOTIONAL caps are priced at spot on both sides. A put lot's cost is
`collateralForPut(25e18, K)` (S3 sizes it at spot, the costliest OTM strike; the planner re-sizes at each
candidate's strike). Fractions scale bigints through whole basis points (`fractionToBps`), never through floats.

### 8.6 Candidates, basis rule, fallback

Candidate listings per side: HYPE, `isPut` by side, traded product present, tenor `minHoursToExpiry ≤ tte ≤
maxDaysToExpiry`, `|delta| ∈ [minAbsDelta, maxAbsDelta]`, moneyness `K ≤ S (1 − minOtmPct)` (put) or
`K ≥ S (1 + minOtmPct)` (call) inside C10's band `0.6 S ≤ K ≤ 1.4 S`, quantity ≥ one lot, in live C16's notional
clause (`notionalLast24h6` plus this trade's notional, strike × qty for a put and spot × qty for a call, below
`maxNotionalPer24h6`), `indicativeApr ≥ minApr × prefilterRatio` (0.5), where `minApr` is the fraction form of
`minAprPct`. Calls also require `K ≥ basis × (1 + minStrikeOverBasisPct)`. A plan emptied by the notional clause
alone holds `daily-limit`. Rank by `indicativeApr` desc, then shorter tenor,
then lower `|delta|`. Quote plan per due side, up to `quotesPerSide` (3), diversified: best; best in another
expiry; best with `|delta| ≤ 0.25`. Strategy requests use `taker = config.account.address` in both modes.

Call fallback (user decision): `basisEligible` = call listings with `K ≥ basisE8 × (1 + minStrikeOverBasisPct)`
passing tenor, product, moneyness and size (not APR, delta or the notional clause). Non-empty → normal path; none
clears the floor → `hold('apr-floor')`. The fallback answers a basis problem only: it fires when the tenor window
holds at least one call listing that passes product, tenor, moneyness and size but none of them clears the basis
threshold; a window with no such listing holds `no-candidates` (never a fallback), as does a disabled fallback.
A strike above basis but outside the 0.6–1.4 × spot band is not sellable (C10) and does not count as
basis-eligible; the fallback then applies. Operators cap how far below basis the fallback may sell with
`call.fallback.maxDiscountToBasisPct` (recommended whenever the fallback is enabled). Then `e*` = shortest expiry with `tte ≥ minHoursToExpiry`, `K*` = highest listed call strike at `e*`. Fallback
mode only sells below the basis threshold: a `K*` that clears it is planned as a normal candidate (mode
`normal`, the APR floor applies; only the window's upper tenor bound relaxed for it, as under `all-listed`) and
the plan's `detail` records why. Otherwise optional `maxDiscountToBasisPct` holds if `K* < basis (1 − d)`, and
optional `customStrikeFirst` requests a custom strike `min(basis, 1.4 S × 0.995)` rounded up to 0.5 USD
(rounded down instead when rounding up would pass 1.4 S) at `e*` first, only when it is above `K*`, and takes it
if `net6 ≥ minNetPremium6`. The fallback ignores the APR floor and delta band, keeps every other gate and check
(the notional clause included), and the decision records `lossIfExercisedUsd`. Basis eligibility is scoped to
the tenor window (`fallback.scope: 'window'`, default) because the strategy tends to short duration;
`'all-listed'` routes a far-dated strike above basis to the normal path.

As implemented:

- **Prefilter bypass.** The APR prefilter (`indicativeApr ≥ minApr × prefilterRatio`) trims the ranked set, but
  when it would empty a set that passed every other filter, the diversified top `quotesPerSide` are quoted anyway
  and the plan records `prefilterBypassed: true` (indicative APRs understate real quotes: 1.05–2.82×, mean 1.46,
  in the validation run; the floor applies to the real quotes). Each filtered listing is recorded in
  `SidePlan.excluded` with the first filter it failed (`product`, `tenor`, `moneyness`, `basis`, `size`, `delta`,
  `daily-limit` (live only), `apr-prefilter`).
- **Thresholds in basis points.** Moneyness and the basis rule compare in bigint: put `K × 10 000 ≤ S × (10 000 −
  otmBps)`; call `K × 10 000 ≥ S × (10 000 + otmBps)` and `K × 10 000 ≥ basis × (10 000 + overBasisBps)`; both
  `S × 6 000 ≤ K × 10 000 ≤ S × 14 000` (`STRIKE_BAND_MIN_BPS`, `STRIKE_BAND_MAX_BPS`, shared with C10).
- **Fallback.** `basisEligible(listings, basisE8, st, s, c)` and `fallbackStrike(listings, nowSec, c)` are exported
  so the execution's fresh state recomputes them (C18). An empty eligible set with the fallback disabled, or with
  no call listing in the window passing product, tenor, moneyness and size, holds `no-candidates`; basis-eligible
  calls that fail only the delta band also hold `no-candidates` (no fallback), and those that fail only the
  notional clause hold `daily-limit`. `customFallbackStrikeE8` rounds to `CUSTOM_STRIKE_PRECISION_E8` (0.5 USD):
  up, or down when up would leave C10's band, so it never exceeds 1.4 × spot. The custom candidate is planned only
  when it is above `K*` (C18 requires the same against the fresh `K*`), so it never quotes a worse strike than the
  highest listed one. The fallback plan (at most two candidates) is not cut to `quotesPerSide`. The custom strike
  needs custom-strike volume on the wallet (§1.2). With the planner's filters a `K*` that clears the basis and
  passes them is basis-eligible already, so the normal-path branch for it is reached only by a `K*` above
  1.4 × spot and always holds today; it guards the rule if the filters ever diverge.
- **`all-listed`.** Eligibility lifts the tenor window's upper bound to `max(366 d, maxDaysToExpiry)`
  (`ALL_LISTED_MAX_TENOR_DAYS`, exported by the strategy), and an eligible far-dated listing enters the normal path;
  the wiring sets the call side's C11 maximum tenor to the same bound. Puts keep their window.
- **RFQ `assetName`.** As the app sends it: the collateral's symbol for calls (`WHYPE`, `kHYPE`, …) and `WHYPE` for
  puts. The RFQ server accepts checksummed addresses (**live**), so requests carry them as parsed.

### 8.7 Evaluating quotes

For each quote: `premium6`, `net6 = premium6 − gasFee6` (preview), `aprNet`. Choose the maximum
`aprNet ≥ minApr` (fallback skips the floor) with `net6 ≥ minNetPremium6`; ties: shorter tenor, lower
`|delta|` (a null delta sorts last), earlier response. The `Decision` carries `minPriceE18` and `maxGasFee6`.
None qualifies → `hold('apr-floor')` with the best seen. Live executes at most one intent per tick: the side
with the larger `aprNet − minApr` (`pickSide`; a tie goes to the put).

As implemented:

- **Net floor.** Normal mode: `safety.minNetPremium6`. Fallback modes: `max(call.fallback.minNetPremium6,
  safety.minNetPremium6)`, matching C8.
- **Skipped quotes.** A quote whose previewed gas is negative, above `maxGasFee6`, or above `maxGasFeeBps` of the
  premium is answered but not priced (hold `gas` when nothing else qualifies; never the best seen). Under
  `verifyMakerSig: 'enforce'` a quote with `makerSigOk !== true` is skipped before pricing and does not count as
  answered (all such → `no-quotes`); under `'warn'` nothing is skipped. A failed gas preview is not priced.
- **Custom first wins outright.** Among qualifying fallback quotes a `basis-fallback-custom` quote wins over
  `basis-fallback` (the custom strike is higher, so its premium and APR are lower); otherwise `K*`. Mode rank:
  normal → custom → `K*`.
- **`minPriceE18`** is the lowest price passing C8 and C9: the maximum of the mode's floor price
  (`minPriceE18ForApr` in normal mode, the inverse of the net floor in fallback), the inverse of the applicable
  net floor, and the gas-bps guard price `ceilDiv(ceilDiv(gasFee6 × 10 000, maxGasFeeBps) × 10^30, q)`, every
  division rounded up.

Anti-spam: a key (`side|strikeE8|expirySec`) backs off `min(60 min, 5 min × 2^(n−1))` after a below-floor
quote, an RFQ failure (anything but a closed socket), a failed gas preview, or an execution of it that aborted
before the confirm on its quote (`requote`, `price-floor`, `gas`, or a `guard` check other than C2, the fresh state,
and C10, the strike against spot), reset when spot moves > 2 % or its indicative apr rises > 25 %. A custom strike
backs off under the same key (its strike is known), and the post-plan filter drops it like a listed one; it has no
indicative APR, so only a spot move resets it. A due side whose floor is
unmet re-plans every `replanSec` (300); meanwhile its decision record repeats the hold with `replanDueSec`.
Token buckets: strategy 12 RFQ/min, sampler 6 RFQ/min, each combined with a shared hard cap of 20/min
(`combinedBucket`: a token is taken only when every bucket has one). The execution's requote takes no token;
the config therefore requires `strategyRfqPerMin + samplerRfqPerMin ≤ 18`.

### 8.8 Dry-run cadence (see §8.9 for config)

In dry-run, after `sellOption` returns `aborted('dry-run')` for the chosen intent, the daemon records a
simulated deployment in memory so the DCA clock advances and the decision log matches live cadence.
Simulated deployments are lost on restart.

### 8.9 WheelConfig

`WheelConfig` is the zod output of `config.example.json` (Appendix B) with units normalized at the boundary:
`*Pct` fields become fractions (`minOtmPct: 1` → `0.01`); only `minAprPct` is also renamed, to `minApr` (`40` →
`0.4`), while `minOtmPct`, `minStrikeOverBasisPct`, `maxDiscountToBasisPct` and `maxHypeExposurePct` keep their
names and hold fractions. `*Usd` and `*Usdc` strings become `bigint` 6-dp fields suffixed `6` (`reserveUsdc` →
`reserve6`, `maxCapitalUsdc` → `maxCapital6`, `minNetPremiumUsd` → `minNetPremium6`, `maxGasFeeUsd` →
`maxGasFee6`, `maxNotionalPer24hUsd` → `maxNotionalPer24h6`); `*Whype` and `*Hype` strings become `bigint` e18
fields suffixed `E18` (`reserveE18`, `maxCapitalE18`, `minNativeHypeE18`); `qtyWhype` becomes `qtyE18`; `basisUsd`
becomes `basisE8`; `maxContractsPerTrade` becomes `maxContractsPerTradeE18`; `null` becomes `undefined`.
Validation is strict: unknown keys fail; decimal strings are bounded in places and non-negative (except a flow's
signed `qtyWhype`); `*Pct` fields that scale bigints must be whole basis points from 0 to 100 %; deltas lie in
[0, 1]; `minAbsDelta ≤ maxAbsDelta`; `minHoursToExpiry ≤ maxDaysToExpiry`; `minQuoteTtlSec ≤ maxQuoteTtlSec`;
rates and timeouts are positive integers, `safety.maxFeePerGasGwei` and `safety.unknownMaxWaitSec` included;
`tickSeconds ≥ 5`; `sampler.putStables` names only USD stables (USDC, USDT0, USDH) and `sampler.callCollaterals`
only WHYPE; mixed-case addresses must checksum; a live run refuses the
zero address. Notional amounts
(`notionalLast24h6`, `maxNotionalPer24h6`) are `bigint` 6 dp: strike × qty for puts, spot × qty for calls.

## 9. Daemon

### 9.1 Loop

Fixed delay: `while (!signal.aborted) { await tick(); await sleep(tickSeconds, signal) }` (60 s), so a
multi-minute trade never overlaps a tick. Tick: snapshot (one multicall; REST positions, inventory,
assets, caps in parallel; parser drops and warnings logged as one warning) → resolve the filled and `unknown`
waits → `deriveState` → G3's run start (`memo.lastNoPendingSeenSec`) → overdue-settlement warnings →
`STATUS.json` → a `state` record → per side, unless it waits for `replanDueSec`: `planSide` on the full snapshot
→ backed-off candidates dropped → serialized `requestQuote` + gas preview + maker-signature check (a `quotes`
record each) → `evaluate` → a `decisions` record → `pickSide`'s trade executed once: in live unless halted or
STOP is present (re-read right before), in dry-run always (STOP included), where `aborted('dry-run')` records
the simulated deployment (exercises body, echo, guards) → the `executions` result record (with `sellOption`'s
`execId` and any key backoff, §8.7) → the cooldowns and halts (§7.5) → `STATUS.json` again, on the memo the
execution left. Any failed read holds the tick (STATUS shows `stale-data`); three consecutive failures escalate to
error level.

Halting live is an in-memory flag (`memo.haltedLive`; live never executes again in this process, STATUS shows
`halted`) set by a `verify-failed` result, three confirm errors within an hour, two reverts within 24 h, a quote
error matching `/geo|forbidden|restricted/i`, two C7 APR-echo disagreements within an hour, a rejected confirm whose
fill appears in the positions anyway (`rejected-filled`, §7.5), an `aborted('echo')` in live, or
a failed STOP write among a result's `bookkeepingErrors`; each of the others also writes `STOP` and logs one
`fatal` line. In dry-run the same events only log what live would do.

Modes: default dry-run. Live requires `--live` **and** `mode: "live"` in config, a non-zero `account.address` and
`safety.verifyMakerSig: "enforce"`; `--live` with `mode: "dry-run"` exits with an error, as does `--live` under
`"warn"`; `mode: "live"` without `--live` runs dry-run with a warning.
`--max-trades N` exits (code 0) after N completed executions for supervised early runs: in live every result whose
confirm was sent (`filled`, `unknown` for any reason, `reverted`, `aborted('confirm-rejected')`), so a first
`--max-trades 1` never sends a second confirm whatever the outcome of the first; in dry-run every
`aborted('dry-run')` result. The exit is decided as soon as the execution returns, before its bookkeeping (the
result record, cooldowns, the post-execution `STATUS.json` derivation), so a failure there is logged and the run
still ends. Dry-run never loads the keystore.

### 9.2 Research sampler

A separate loop per stream with its **own** `JsonRpcSocket` (serialization is per connection), with its own
token bucket combined with the hard cap it shares with the strategy; fixed-delay scheduling (the next run
starts `*EveryMin` after the previous one ends; `*EveryMin: 0` turns a stream off); `requestTimeoutMs` 6000; paused while any `sellOption` runs (`memo.inFlight`,
both modes); never confirms. RFQ groups (one listing's legs, the taker pair) go to the socket back to back, one
group at a time across the streams; the RFQ streams and the inventory stream wait for the first listings.
Defaults:

- **Hourly sweep**: every listed HYPE combination, both sides, 25 contracts, `taker = zero`, pair legs
  back-to-back in random order: puts USDC then USDT0; calls WHYPE. The sweep is built
  from the listings at its start; at 6 RFQ/min its ~70 legs take about 12 minutes while the listed strikes change
  about once a minute, so each leg is checked against `deps.listings()` when its turn comes and skipped (no RFQ, no
  token) when its instrument is no longer listed (the server would refuse it as a custom strike for the zero taker,
  §1.2). A finished sweep writes one `{ purpose: 'sweep-summary', run, legs, sent, skippedUnlisted }` record to
  `quotes`.
- **Pinned series**: up to 4 instruments (default the ~0.10 and ~0.25 delta strikes of the nearest expiry,
  both sides), every 5 min for their lifetime (as custom strikes once de-listed, which the server refuses for
  the zero taker while the strike is not listed, §1.2), re-picked once they expire. Pinned and taker-pair RFQs use the traded products only (USDC puts, WHYPE calls).
- **Taker pair**: hourly, the first pinned instrument quoted with `taker = self` and `taker = zero` back-to-back.
- **Inventory snapshot**: the parsed HYPE listings and the HYPE-relevant caps (`GLOBAL`, `HYPE`, and the WHYPE
  and sampled tokens' address entries), checked every minute. A full record is written first and every
  `inventoryEveryMin` (5) after the last full one; in between, a change of content writes a `changed` record with
  only the difference from the previous record. The content covers only what is listed (each listing's side,
  strike, expiry and products) and each cap's name, type and limit, never the volatile delta, APR, index or cap
  usage. **Validation:** the listed strike set itself changes about once a minute (the delta buckets follow
  spot); before the difference records a ~45 KB full record was written about once a minute.
- **Public fills**: `publicHistory` hourly over a window that starts 5 min before the previous one ended (the
  first at startup − 5 min), recorded once per `txHash` within the run; offline readers de-duplicate across
  runs and files by lowercase `txHash`.

Sampler `quotes` records take spot from the loop's latest snapshot (the WHYPE asset price, `spotSource: 'asset'`)
and fall back to the listings' index (`'index'`) before the first snapshot, or `spotE8: null` with
`spotSource: 'none'` when neither is a price; their TTL is on the local clock. The config restricts
`sampler.putStables` to USD stables (USDC, USDT0, USDH) and `sampler.callCollaterals` to WHYPE.

### 9.3 Recorder

Append-only JSONL under `data/<stream>/YYYY-MM-DD.jsonl` (UTC days) via `appendFileSync` per line
(O_APPEND, crash-safe, no handles). Envelope `{ v: 1, kind, tsMs, runId, mode, codeRev, configHash }`
(`codeRev` is `git describe --always --dirty`); every `*E18`, `*E8` and `*6` field is a decimal string. The
envelope fields win over record keys of the same name. Every record of every stream passes through one redacting
recorder (`wire.ts`, the loop's own call kept as a second guard): the logger's redaction (`redactRecord`, §9.5) at
any depth, because the research data is meant to be shared. The sampler's `quotes` (but the taker pair's `self`
legs), `inventory` and `public-fills` are market data; `state`, `decisions`, `executions` and the strategy's
`quotes` describe the wallet (README "Sharing").
Streams:

- `state`: one record per tick: the chain reads, spot, inventory time, consistency, both sides' capital, the
  basis, `lastDeployTs`, the 24 h counts, row counts by phase, anomalies, warnings and the memo summary.
- `quotes`: one record per RFQ including failures: `purpose` (`candidate | fallback-custom | sweep | pinned |
  taker-pair`; the execution's requote is recorded in `executions`), `side`, the strategy's `tick` or the sampler
  stream's `run`, `instrument` (key `side|strikeE8|expirySec`,
  strike, expiry, quantity, `usd`, `collateralAsset`; the sampler adds `usdSymbol`, `collateralSymbol` and
  `listed`, the strategy `candidateMode` and `rank`), `takerKind` (`zero | self`), `context` (spot, inventory ts,
  indicative apr and delta, tenor, weekday, hour; the sampler adds `spotSource: 'asset' | 'index' | 'none'`),
  request/response times, `outcome` (`quote | error | timeout | mismatch | socket-closed`, with `error` and
  `message`), quote fields (maker, priceE18, validUntil, `ttlSec` at arrival on the server clock, nonce, server
  apy), `makerSigOk`, `premium6`, `aprGross` (before gas) and, for the strategy, the gas preview and `aprNet`;
  `aprGrossOverIndicative` and (strategy) `aprNetOverIndicative` are each APR over the listing's indicative one.
  There is no connection id (the taker result carries none). A finished sweep adds one
  `{ purpose: 'sweep-summary', run, legs, sent, skippedUnlisted }` record (§9.2), which has no `outcome`.
- `decisions`: per side per tick: gate results, capital, basis, floor, backed-off keys, the plan (hold reason or
  `prefilterBypassed`, with its `detail`), candidates with ranks, `excluded` listings with their reasons, quotes obtained, and the
  result (the trade's terms and `minPriceE18`, or the hold's reason and best seen). A side waiting for
  `replanDueSec` writes `{ replanDueSec, result }` only.
- `executions`: one record per state-machine step (`{ execId, step, detail }`: `precheck`, `approve` with
  `wouldApprove` in dry-run, `requote`, `gas` with the echo verbatim and its mismatches, `checks` with every C1–C18
  result, then in live `trade-intent` (typed-data hash, nonce, body), `confirm-sent`, `confirm-reply`, `receipt`,
  `premium-shortfall`, `verified`, `stop`), the loop's `{ tick, step: 'result', execId, side, intent, result,
  backoff }` per execution (`backoff` is `{ key, untilSec, n }` or `null`, §8.7), and later `visible` (visibility
  latency), `visibility-timeout`, `unknown-resolved`, `unknown-expired`.
- `inventory`: full `{ trigger: 'first' | 'interval', contentHash, inventoryTs, listings, caps, droppedCaps }`, or
  between them `{ trigger: 'changed', contentHash, inventoryTs, added, removed, productsChanged, capsChanged }`:
  the instrument keys added and removed, the keys whose products changed, and each cap whose limit changed as
  `{ name, type, capE18, previousCapE18 }` (`null` for a cap that is new or gone) (§9.2).
- `public-fills`: `{ fromSec, toSec, fill }`, the `/api/history` row as returned.

Settlement history and daily summaries are derived offline from the positions API; no stream is needed.
The daemon never rotates files itself. Record sizes **measured** in the validation run, scaled to the default 60 s
tick with the sampler on: about 25–30 MB/day — inventory ≈ 14 MB (a ~45 KB full record every 5 min plus a `changed`
record of well under 1 KB about once a minute, §9.2; computed, the difference records came after the run), quotes
≈ 5 MB (~1 KB a record, ~190 RFQs an hour), state and decisions 5–10 MB, public fills under 1 MB. The original
estimate of 10 MB/day assumed a stable listed set; full inventory records on every change cost about 75–80 MB/day.

### 9.4 Status, kill switch, lock, shutdown

`data/STATUS.json` rewritten each tick and again after each execution, atomically (temp file and rename): `{ tsMs,
health: 'ok' | 'holding' | 'halted', holdReasons (per side), halted, lastTradeAtSec, completed, tick, mode,
frontendSha, frontendChanged }`; hold reasons are the gates' (plan-level holds appear only in `decisions`; after an
execution they are re-derived on the memo it left, so a new cooldown or interval shows), and a failed snapshot
writes `stale-data` for both sides. `completed` is the `--max-trades` count (§9.1) and `lastTradeAtSec` the chain
time at the end of the last such execution; `frontendSha` is the tripwire's latest `sha` (`null` while it is
inactive) and `frontendChanged` its latch (§9.5). `data/STOP` present → no execution (live halts, dry-run
continues); the check fails closed (`statSync(path, { throwIfNoEntry: false })`: absent is no STOP, any other
error counts as present). Fatal events (§9.1's halt list) write `STOP` (a timestamped reason line, appended; the
reason, which can carry server text, is collapsed to one line of at most 500 characters) and log one `fatal`
line. `data/live.lock` in live mode only: `{ pid, startedAtMs }`,
created `O_EXCL`, taken over once when its pid is not running (ESRCH), refused when held or unreadable; `Lock.held`
turns false on `release()`, which removes only this process's own record and runs on every exit path.
`SIGINT`/`SIGTERM`: abort the loop's signal and close both sockets at once (a queued frame is dropped);
`sellOption` checks the signal right before `confirm`; waits after `confirm` may be abandoned and recorded as
`unknown`; hard deadline 20 s, then exit code 3. The handlers are installed before the lock and the keystore, so
a signal during startup stops it (exit 0, lock released). `unhandledRejection`/`uncaughtException` log fatal
and exit 1.

Exit codes: `0` done (a clean stop, `--max-trades` reached, or a signal during startup); `1` failed (an
invalid config, a startup check — lock, keystore, address, chain id, EOA — or the command); `2` usage error;
`3` forced exit when a stop does not finish within 20 s.

### 9.5 Logging, version tripwire, secrets

`pino` JSON to stdout (pipe through `pino-pretty` in dev). The logger's `formatters.log` redacts the configured
RPC URL, its `new URL(rpcUrl).href` (which may differ by a trailing slash or the host's case), its path and query on
their own when they carry a credential-like run of 16 or more `[A-Za-z0-9_-]` (an Infura `/v3/<key>` or QuickNode
`/<token>/` key, whatever the host in front; a plain path such as the public RPC's `/evm` is no secret and stays
elsewhere in the text) and any `/v2/[A-Za-z0-9_-]{16,}` segment in every string at any depth (messages, errors and `toJSON()`
results such as a `URL` included) and writes bigints as decimal strings; child-logger bindings are written as
pino writes them, so only plain strings are bound. Startup logs the RPC host only, plus mode, chain check,
address, `runId`, `codeRev`, `configHash`, the frontend `sha`, balances, derived state and a config summary
without secrets. `version.ts` fetches `https://app.rysk.finance/api/version/` (`{ sha, timestamp }`, **live**)
at startup and hourly; the first successful `sha` is the baseline, and a later different one latches `changed`:
with `pauseOnFrontendChange` (default true) G10 holds new trades, in both modes, until restart. While no poll has
succeeded (`sha === null`) the tripwire is inactive and startup says so.

### 9.6 CLI

`node:util parseArgs` with the subcommand in `positionals[0]`: `run [--live] [--max-trades N] [--config
path] [--no-sampler]`, `state`, `quote --side put|call --strike 78.5 --expiry <sec> [--qty 25] [--collateral
whype] [--usd usdc|usdt0]` (one RFQ with `taker = account.address`, gas preview and maker
check, no trade), `history --from --to --out`, `wallet` (address, balances, allowances, vault counter, nonces),
`basis suggest-anchor`. Script `"rysk": "node src/cli/main.ts"`. Every command takes `--config` (default
`config.json`). `parseCli` is pure and strict (stray positionals and unknown flags are usage errors, exit 2;
decimal flags are converted by string arithmetic); `configFlags(command)` loads the config with `live` only for
`run --live` and the anchor rule only for `run`. The one-shot commands call the lower layers directly (§3).

### 9.7 Running in production

README section: systemd unit with `Restart=on-failure`, `RestartSec=30`, `TimeoutStopSec=30`; password
file location and permissions (`0600`); logs to stdout/journald; one live instance per wallet; keep the public
RPC for dry-run only; the ~15-minute startup hold; systemd rather than Docker (pid reuse defeats the lock's
staleness check); data growth (measured, §9.3); and the go-live order before enabling the unit: dry-run, then
`mode: "live"`, then a supervised `run --live --max-trades 1` on a TTY, then `systemctl enable`.

## 10. Error handling

| Situation | Handling |
|---|---|
| No quote within 15 s; RPC error; late or mismatched reply | Recorded with its outcome; candidate skipped; key backoff. Cap or "cannot quote" errors → hold with reason; text suggesting geo or forbidden → halt live, continue dry-run. |
| Socket closes mid-auction | Pending call rejects `socket-closed`; results from the old connection are discarded; reconnect with backoff. |
| TTL out of bounds; `quote.apy` disagrees with our APR; maker signature does not recover | Not executable; recorded. Two APR disagreements within an hour → halt live. |
| Executable re-quote below `minPriceE18` | `aborted('price-floor')`; allowance stays (harmless, exact, needs our signature); key backoff (§8.7). |
| Execution aborts before the confirm on its quote (`requote`, `gas`, a guard but C2 and C10) | No side cooldown (nothing was sent); key backoff (§8.7), a custom strike's included, recorded in the `executions` result record. |
| Gas: exceeds premium; echo mismatch; unknown extra key or value; fee over bound | Candidate skipped with key backoff, no side cooldown (nothing was sent); **echo mismatch or unknown key halts live**; fee over bound → hold `gas`. |
| `confirm` rejected | Never retry the same quote or nonce; 60 s cooldown; three per hour → halt live. Watched for `unknownMaxWaitSec` for a row the reply denied: one appearing → `rejected-filled`, halt live (§7.5). |
| Relayer tx reverts | Collateral unmoved; 60 s cooldown; two per 24 h → halt live. |
| No confirm reply, socket closed, or receipt timeout | `unknown`: hold the side; resolve by API row or vault counter; after 1800 s log error and unblock; never re-sign meanwhile. |
| Receipt amounts differ | Fatal: `STOP`, halt live. |
| Approve stuck | ≤ 1 pending tx; `aborted('approve')` with the hash kept; `tx-pending` gate while it is pending. The one replacement after 5 min at +30 % is not implemented in v1 (§1.2). |
| RPC rate limit, sporadic rejects, stale block | One multicall per tick; any failed read holds; block age > 30 s holds. |
| Expiry settlement window and overdue settlement (> 6 h) | G3 holds both sides (+ 15 min grace); an overdue row logs a warning every tick. |
| Positions API outage or partial list; invalid row; unknown status | Strict parse fails → hold; counter mismatch → `api-lag`/`inconsistent`; unknown status → G1 holds. |
| Revised settlement on a settled row | Re-derivation absorbs it; logged; calls held one tick. |
| External WHYPE deposit, withdrawal, wrap or unwrap | Residual policy (§8.4); `externalFlows` recommended. |
| Anchor misconfigured | `basis-negative` → calls held; puts continue. |
| Spot moves between plan and sign | C10 fails → abort; re-plan next tick. |
| Frontend version changed | Warn; pause new confirms when configured. |
| Native gas below reserve; wrong password; address mismatch | Live refused; dry-run allowed. Never auto-unwrap WHYPE. |
| Fallback writes a call below basis while a put is open | Allowed (neutral stance); `lossIfExercisedUsd` recorded. |
| Payout in an unexpected asset | Anomaly → hold all. |

## 11. Testing

- Colocated `vitest` unit tests: units against the real fill and spike quotes; keystore against the
  committed Foundry fixture (public Anvil #0 key, derived in-test for EIP-712 tests); EIP-712 sign/recover
  for `Confirmation` and `Quote`, plus maker recovery on captured quotes; inventory parsing (key-string
  strikes, dropped invalid items); position parsing and settlement classification on anonymized rows
  (the seller's address, transaction hashes and block hash replaced); basis replay (adds, removes, residual both signs, negative anomaly, ordering
  ties) with hand-computed numbers; state derivation invariant under permutation and duplication; gates;
  tranche (single-lot rule, caps, sizes, `floorToIncrement` 10 → 0); candidates (basis rule, fallback window
  vs all-listed, custom strike); evaluation (floor, ties, gas bounds, `minPriceE18`); `JsonRpcSocket` on a
  fake socket with fake timers (serialization, late-reply ignore, deadlines, connect timeout, backoff
  reset, idle close) plus one real `ws` integration test; `echo.ts` on captured gas responses; `sellOption`
  against fakes (happy path, each check failing, requote floor, echo mismatch, reverted, unknown, dry-run
  stop); receipt verification on the anonymized real receipt; recorder and `stringifyBig`; config example
  parses; architecture test (imports, clock, randomness, timers and `process`, non-empty guarded directories).
- Live smoke tests in `src/rysk/live.test.ts`, opt-in with exactly `RYSK_LIVE_TESTS=1` (`pnpm test:live`): `assets`,
  `inventory` and `caps` parse with nothing dropped; one zero-address `request` for the nearest-expiry ~0.25-delta
  USDC put of an inventory read just before it returns a quote whose `validUntil` is within an hour and whose maker
  signature recovers, or times out (skipped when the server refuses the strike as a custom strike);
  one gas preview of that quote succeeds. Never `confirm`.
- Acceptance before handover: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm check:secrets` green;
  `rysk run` in dry-run on mainnet for several ticks from the sandbox produces quote, decision and
  execution records with `echoOk: true`; `rysk quote` returns a real quote. Done on 2026-10-16 (README,
  "Validation").

## 12. Open questions settled by the first supervised live trade

1. Whether `confirm` accepts our body plus the allowlisted extras (the app sends the spread echo).
2. Semantics of `validUntil` vs `quoteValidUntil`; whether the relayer enforces `validUntil`.
3. Whether concurrent RFQs on one socket are allowed or last-wins; whether makers price `taker = self`
   differently from zero; whether the server validates `nonce` recency; cap `usage` semantics;
   settlement-lag distribution; what else the Gamma controller `0x577b…` does (in the verified fill it emitted
   `ShortOtokenMinted`, which §5.4 pins to it, while the vault store emitted `VaultOpened`).
4. Whether HyperEVM's `pending` block tag reflects mempool transactions. If it does not, `pendingNonce` always
   equals `latestNonce` and G8's `tx-pending` never fires (the exact-allowance rule keeps a repeated approve
   harmless).
5. The exact custom-strike rule. Observed: for a wallet without 250 000 USD of notional volume, strikes not in
   the current inventory are refused, the same strike is quoted once it is listed again, and a few strikes were
   quoted shortly after leaving the inventory; a wallet with volume gets unlisted strikes quoted. How long a
   de-listed strike stays quotable is not known.

## 13. Future work (deliberately deferred)

Provisional positions from vault views during API lag; FIFO lots report with underwater quantity;
code-hash pinning of Rysk contracts; per-expiry laddering limits; burst sampling; calibration table from
indicative to realized APR; `premiumAdjust` basis mode; maker allowlist; halting on foreign-collateral
positions; secondary RPC; on-chain `Transfer` scan for recent deployments; settlement and daily-summary
streams; LST collateral and USDT0 trading; wrapping; alerts. From the implementation: the approve fee bump
(§5.3); a lock that also compares its `startedAtMs` with the process start (container pid reuse); per-pid
`STATUS.json` temp names; compacting the inventory record (each listing repeats its products' addresses) or
rate-limiting its change trigger; skipping sweep legs whose strike has left the inventory by the time of their
RFQ (§9.2); a connection id in `quotes`.

## 14. Milestones

1. Scaffold (toolchain, gitignore first, secrets check), `lib`, `domain` (constants, types, units, APR,
   parsing, caps) with fixtures from captures.
2. `chain` (keystore, clients, multicall snapshot, approve, receipts) and `rysk` REST.
3. `rysk` socket, taker, EIP-712 (fake-timer tests + one `ws` integration test).
4. `execution` state machine with checks, echo and receipt verification against fakes.
5. `strategy/wheel`.
6. `daemon` (loop, sampler, recorder, status, lock, version tripwire, config) and `cli`.
7. README and production notes, live dry-run validation from the sandbox, review, handover.

## Appendix A: core types

This appendix reflects the implementation as of the commit that last changed this document: the types are
copied from the sources (doc comments shortened), and the signatures are the exported ones.

```ts
// domain/types.ts
export type Side = 'put' | 'call';
export type Product = { underlying: Address; strikeAsset: Address; collateralAsset: Address; isPut: boolean };
export type Listing = { strikeE8: bigint; expirySec: number; isPut: boolean; delta: number;
  indicativeApr: number /* fraction */; indexUsd: number; products: Product[]; observedAtSec: number };
export type Asset = { symbol: string; address: Address; underlying: Address; decimals: number;
  minTradeSizeE18: bigint; maxTradeSizeE18: bigint; active: boolean; priceE18: bigint;
  strikePrecisionE8: bigint; marketOpen: boolean };
export type Cap = { name: string; type: 'CONTRACTS' | 'NOTIONAL'; capE18: bigint; usageE18: bigint };
export type QuoteRequest = { asset: Address; assetName: string; chainId: 999; expiry: number; isPut: boolean;
  quantity: string; strike: string; taker: Address; usd: Address; collateralAsset: Address; isEIP1271: false };
export type Quote = { assetAddress: Address; chainId: number; expiry: number; isPut: boolean; isTakerBuy: boolean;
  quantity: string; strike: string; maker: Address; nonce: string; price: string; validUntil: number;
  signature: Hex; usd: Address; collateralAsset: Address; apy: number /* wire percent, not a fraction */ };
export type ConfirmBody = { assetAddress: Address; chainId: 999; expiry: number; isPut: boolean; isTakerBuy: false;
  maker: Address; price: string; quantity: string; quoteNonce: string; quoteSignature: Hex;
  quoteValidUntil: number; validUntil: number; strike: string; taker: Address; usd: Address;
  collateralAsset: Address; collateralAmount: string; nonce: string };
export type GasPreviewBody = { assetAddress: Address; chainId: 999; isPut: boolean; collateralAsset: Address;
  expiry: number; strike: string; usd: Address; price: string; quantity: string };   // the app's 9 fields (§7.4)
export type ConfirmParams = ConfirmBody & { gasFee: string; isEIP1271: false; signature: Hex } & Record<string, unknown>;
export type Settlement =
  | { outcome: 'expiredOtm'; collateralReturned: bigint }
  | { outcome: 'assigned'; receivedUnderlyingE18: bigint }
  | { outcome: 'exercised'; receivedStable6: bigint }
  | { outcome: 'anomaly'; detail: string };
export type Position = { key: string; underlying: Address; chainId: number; isPut: boolean; strikeE8: bigint;
  quantityE18: bigint; priceE18: bigint; premium6: bigint; usd: Address; collateral: Address;
  assetSymbol: string /* the Rysk asset-entry symbol: the collateral's for calls (kHYPE), WHYPE for puts */;
  createdAtSec: number; expirySec: number; txHash: Hex; status: 'open' | 'settled' | 'unknown'; settlement: Settlement | null };

// domain parsers and caps (an invalid item is dropped and counted; a malformed top level throws)
parseAssets(json: unknown, chainId = 999): { assets: Asset[]; dropped: number };
hypeAsset(assets: Asset[]): Asset;                                    // the WHYPE entry; its price is HYPE spot
parseInventory(json: unknown, o: { underlyingSymbol: 'HYPE'; underlying: Address; observedAtSec: number }):
  { listings: Listing[]; dropped: number };
parseCaps(json: unknown): { caps: Cap[]; dropped: number };
parsePositions(json: unknown, o: { underlying: Address; chainId: 999 }):     // strict for chain-999 WHYPE rows
  { positions: Position[]; otherRows: { chainId: number; key: string }[]; warnings: string[] };
remainingCapacityE18(caps: Cap[], target: { underlyingSymbol: string; asset: Address; isPut: boolean },
  notionalPriceE8: bigint, marginBps = 10_000): bigint | null;        // null: no cap applies; NOTIONAL at spot
export const CAP_SOFT_MARGIN_BPS = 9_500;                              // §8.5 soft pre-check margin

// strategy/wheel/types.ts
export type Snapshot = {
  nowSec: number; localNowMs: number; mode: 'live' | 'dry-run'; self: Address;
  chain: { blockNumber: bigint; blockTs: number; whypeE18: bigint; usdc6: bigint; usdt06: bigint; nativeHypeE18: bigint;
           allowanceUsdc6: bigint; allowanceWhypeE18: bigint; vaultCounter: bigint; pendingNonceGap: number };
  positions: Position[];                 // chain-999 WHYPE rows, strictly parsed, this tick
  otherRowCount: number;                 // chain-999 rows that are not WHYPE positions (for G2's apiCount999)
  market: { assets: Asset[]; listings: Listing[]; caps: Cap[]; spotE8: bigint; inventoryTs: number };
  memo: { lastConfirmSec: Partial<Record<Side, number>>; cooldownUntilSec: Partial<Record<Side, number>>;
          simulatedDeploySec: Partial<Record<Side, number>>; inFlight: boolean; uptimeSec: number;
          serverSkewMs: number; frontendChanged: boolean; stopFile: boolean;
          lastNoPendingSeenSec: number | null };   // G3: start of the current run of settlement-free ticks
};
export type RowClass = 'managedPut' | 'managedCall' | 'whypeCallOtherUsd' | 'whypePutOtherUsd'
  | 'hypeForeignCollateral' | 'foreign' | 'otherChain';
export type Phase = 'open' | 'pendingSettlement' | 'settled' | 'unknown';
export type SideCapital = { free: bigint; locked: bigint; pending: bigint; total: bigint; budget: bigint };
export type WheelState = {
  consistency: 'ok' | 'api-lag' | 'inconsistent';
  rows: { position: Position; cls: RowClass; phase: Phase }[];
  capital: Record<Side, SideCapital>;
  basis: { basisE8: bigint | null; qtyE18: bigint; residualE18: bigint; reliable: boolean; reason?: string };
  lastDeployTs: Partial<Record<Side, number>>;
  deploymentsLast24h: number; notionalLast24h6: bigint;
  anomalies: string[]; warnings: string[];
};
export type HoldReason = 'disabled' | 'kill-switch' | 'anomaly' | 'api-lag' | 'inconsistent' | 'settlement-pending'
  | 'stale-data' | 'clock-skew' | 'market-closed' | 'frontend-changed' | 'quiet-period' | 'in-flight' | 'tx-pending'
  | 'cooldown' | 'gas-reserve' | 'daily-limit' | 'interval' | 'below-min-lot' | 'cap' | 'basis-unreliable'
  | 'exposure-cap' | 'no-candidates' | 'no-quotes' | 'apr-floor' | 'fallback-too-far-below-basis' | 'gas';
export type Candidate = { side: Side; listing: Listing | null /* null for a custom strike */; product: Product;
  strikeE8: bigint; expirySec: number; quantityE18: bigint; collateralAmount: bigint; request: QuoteRequest;
  mode: 'normal' | 'basis-fallback' | 'basis-fallback-custom'; rank: number;
  indicativeApr: number | null; delta: number | null };              // null for a custom strike
export type GateResult = { id: string; pass: boolean; detail?: string };
export type ExclusionReason =
  'product' | 'tenor' | 'moneyness' | 'basis' | 'size' | 'delta' | 'daily-limit' | 'apr-prefilter';
export type Exclusion = { strikeE8: bigint; expirySec: number; reason: ExclusionReason };
export type SidePlan =
  | { kind: 'hold'; side: Side; reason: HoldReason; detail?: string; gates: GateResult[]; excluded: Exclusion[] }
  | { kind: 'quote'; side: Side; candidates: Candidate[]; gates: GateResult[]; excluded: Exclusion[];
      prefilterBypassed: boolean; detail?: string };
export type QuoteOutcome =
  | { ok: true; quote: Quote; requestedAtMs: number; respondedAtMs: number; makerSigOk: boolean | null;
      gas: { ok: true; gasFee6: bigint } | { ok: false; reason: 'exceeds-premium' | 'http' } }
  | { ok: false; error: 'timeout' | 'rpc-error' | 'mismatch' | 'socket-closed'; message: string; requestedAtMs: number };
export type QuotedCandidate = { candidate: Candidate; outcome: QuoteOutcome };
export type Decision =
  | { kind: 'trade'; candidate: Candidate; quote: Quote; gasFee6: bigint; aprNet: number; aprRysk: number;
      minPriceE18: bigint; maxGasFee6: bigint; lossIfExercisedUsd?: number }
  | { kind: 'hold'; side: Side; reason: HoldReason; best?: { candidate: Candidate; aprNet: number } };

deriveState(s: Snapshot, c: WheelConfig): WheelState;
checkGates(side: Side, st: WheelState, s: Snapshot, c: WheelConfig): { hold: HoldReason | null; results: GateResult[] };
planSide(side: Side, st: WheelState, s: Snapshot, c: WheelConfig): SidePlan;
basisEligible(listings: Listing[], basisE8: bigint, st: WheelState, s: Snapshot, c: WheelConfig): Listing[];
fallbackStrike(listings: Listing[], nowSec: number, c: WheelConfig): { listing: Listing; expirySec: number } | null;
trancheQuantityE18(side: Side, st: WheelState, strikeE8: bigint, s: Snapshot, c: WheelConfig,
  capacityE18: bigint | null /* margin already applied */): bigint;
evaluate(side: Side, qs: QuotedCandidate[], st: WheelState, s: Snapshot, c: WheelConfig): Decision;
pickSide(decisions: Decision[], c: WheelConfig): Decision | null;    // the larger aprNet − minApr

// rysk: taker, socket errors, signatures
export type QuoteResult =                                            // RyskTaker.requestQuote; the daemon adds
  | { ok: true; quote: Quote; requestedAtMs: number; respondedAtMs: number }   // makerSigOk and gas → QuoteOutcome
  | { ok: false; error: 'timeout' | 'rpc-error' | 'mismatch' | 'socket-closed'; message: string; requestedAtMs: number };
export type ConfirmReply =
  | { kind: 'hash'; txHash: Hex } | { kind: 'rejected'; code: number; message: string }
  | { kind: 'bad-result'; raw: unknown } | { kind: 'no-reply'; reason: 'timeout' | 'socket-closed'; sent: boolean };
new RyskTaker(socket: Pick<JsonRpcSocket, 'call'>, o: { nowSec(): number; nowMs(): number; minGapMs?: number /* 250 */ });
RyskTaker.requestQuote(r: QuoteRequest, o: { timeoutMs: number; signal?: AbortSignal }): Promise<QuoteResult>;
RyskTaker.confirm(p: ConfirmParams, o: { timeoutMs: number; onSent?(): void }): Promise<ConfirmReply>;
// SocketClosedError and CallTimeoutError carry `sent: boolean`; CallOptions has `accept?` and `onSent?`.
recoverQuoteSigner(q: Quote): Promise<Address>;
makerSignatureOk(q: Quote, recover: ((q: Quote) => Promise<Address>) | undefined): Promise<boolean | null>;
                                       // true: recovers the maker; false: anyone else or rejects; null: not checked

// execution/types.ts (structural copies of the strategy types; execution never imports the strategy)
export type ExecutionCandidate = { side: Side; strikeE8: bigint; expirySec: number; quantityE18: bigint;
  collateralAmount: bigint; request: QuoteRequest; mode: 'normal' | 'basis-fallback' | 'basis-fallback-custom'; product: Product };
export type TradeIntent = { side: Side; candidate: ExecutionCandidate; quote: Quote; minPriceE18: bigint; maxGasFee6: bigint };
export type FreshState = {                     // the side recomputed from a fresh snapshot just before signing
  gateHold: HoldReason | null; trancheQuantityE18: bigint; basisE8: bigint | null; basisReliable: boolean;
  basisEligibleEmpty: boolean; freshFallbackStrikeE8: bigint | null; freeCollateral: bigint; spotE8: bigint;
  listedStrikesE8ForExpiry: bigint[]; expiriesSec: number[]; deploymentsLast24h: number; notionalLast24h6: bigint;
  nativeHypeE18: bigint; allowance: bigint;
  fetchedAtMs: number;                         // C2: ≤ 10 s old
  listingsAtMs: number;                        // C10: ≤ 5 min old
  capHeadroomE18: bigint | null };             // C14: the 0.95 margin applied by the provider; null = no cap
export type ExecutionEvent = { execId: string; step: string; detail: Record<string, unknown> };
export type CheckResult = { id: string; pass: boolean; na?: boolean; detail?: string };
export type TradeDeps = {
  mode: 'live' | 'dry-run'; signal: AbortSignal;
  walletAddress: Address;                      // the configured account; owns the dry-run allowance read
  freshState(): Promise<FreshState>;
  quotes: { requestQuote(r: QuoteRequest, o: { timeoutMs: number; signal?: AbortSignal }): Promise<QuoteResult> };
  rest: { gasFee(body: ConfirmBody): Promise<GasResult> };
  rpc: { confirm(p: ConfirmParams, o: { timeoutMs: number; onSent?: () => void }): Promise<ConfirmReply> };
  collateral: ApproveDeps & { vaultCounter(): Promise<bigint> };
  signer: { address: Address; signConfirmation(m: ConfirmationMessage): Promise<Hex> } | null;  // null in dry-run
  clock: { serverNowSec(): number; nowMs(): number };
  record(e: ExecutionEvent): void;             // write-ahead before confirm; a failed write aborts
  checks: ExecutionConfig;                     // the checklist's config for the traded side
  timeouts: { requoteMs: number; confirmMs: number; receiptMs: number };
  guards: { stopFile(): boolean; lockHeld(): boolean; inFlightExcludingSelf(): boolean };
  recoverMaker(q: Quote): Promise<Address | null>;                   // null when recovery rejects
  verifyReceipt(receipt: TransactionReceipt, expected: FillExpectation): FillVerification;
  writeStop(reason: string): void;
  usedQuoteNonces: Set<string>;                // a nonce joins at SIGN
  lastNonceMs: { value: number };              // updated at SIGN
  onConfirmSent(side: Side, atSec: number): void;                    // starts the cooldown, sets lastConfirmSec
  onConfirmCleared(side: Side): void;                                // confirm-rejected, reverted
};
export type TradeResult =                      // every post-send result lists its bookkeeping failures
  | { status: 'filled'; txHash: Hex; approveTxHash?: Hex; quote: Quote; premium6: bigint; gasFee6: bigint;
      bookkeepingErrors: string[] }
  | { status: 'reverted'; txHash: Hex; approveTxHash?: Hex; bookkeepingErrors: string[] }
  | { status: 'unknown'; reason: 'confirm-timeout' | 'socket-closed' | 'receipt-timeout' | 'shutdown' | 'bad-result' | 'verify-failed';
      confirmSentAtSec: number; txHash?: Hex; approveTxHash?: Hex; bookkeepingErrors: string[] }
  | { status: 'aborted'; stage: 'precheck' | 'approve' | 'requote' | 'price-floor' | 'gas' | 'echo' | 'guard' | 'sign'
      | 'shutdown' | 'dry-run'; message: string; checkId?: string; approveTxHash?: Hex; echoOk?: boolean;
      wouldApprove?: bigint }                     // before the send: no bookkeeping yet
  | { status: 'aborted'; stage: 'confirm-rejected'; message: string; confirmSentAtSec: number; approveTxHash?: Hex;
      bookkeepingErrors: string[] };             // the one abort after the send (§7.5 watch)
sellOption(deps: TradeDeps, intent: TradeIntent): Promise<TradeResult>;
runPreSignChecks(ctx: CheckContext): { ok: true; body: CheckedConfirmBody | null /* null in dry-run */; gasFee6: bigint;
  results: CheckResult[] } | { ok: false; failed: CheckResult; results: CheckResult[] };

// chain
createChainClients(o: { rpcUrl: string; account?: Account }): ChainClients;     // http(rpcUrl, { batch: true })
createApproveDeps(publicClient, walletClient: HyperEvmWalletClient | undefined,  // undefined in dry-run: approve rejects
  o?: { maxFeePerGas?: bigint }): ApproveDeps;                                   // from safety.maxFeePerGasGwei

// daemon
export type ConfigFlags = { live: boolean; requireAnchor?: boolean /* default true; only `run` keeps it */ };
loadConfig(path: string, flags: ConfigFlags): AppConfig;
export type SnapshotSources = { chain: ChainReader; rest: Pick<RyskRest, 'userPositions' | 'inventory' | 'assets' | 'caps'>;
  self: Address; clock: Clock; memo: Memo; mode: 'live' | 'dry-run'; log: Log };
gatherSnapshot(src: SnapshotSources): Promise<Snapshot>;
export type LoopDeps = {
  snapshot(): Promise<Snapshot>; quote(c: Candidate): Promise<QuoteOutcome>;
  execute(i: TradeIntent, onExecId?: (execId: string) => void): Promise<TradeResult>; vaultCounter(): Promise<bigint>;
  recorder: Pick<Recorder, 'append'>; status(s: StatusFile): void;
  stopFile(): boolean; frontendChanged(): boolean; frontendSha(): string | null; writeStop(reason: string): void;
  clock: Clock; log: Log; memo: Memo; signal: AbortSignal; sleep: typeof sleep };
runLoop(deps: LoopDeps, config: AppConfig): Promise<void>;
applyTradeResult(memo: Memo, side: Side, result: TradeResult, nowSec: number, c: WheelConfig,
  ctx: { terms: TradeTerms; counterBefore: bigint; writeStop(reason: string): void; log: Log }): void;
runSampler(deps: SamplerDeps, cfg: SamplerConfig): Promise<void>;
export type RfqBucket = Pick<TokenBucket, 'take' | 'waitMs'>;
combinedBucket(...buckets: RfqBucket[]): RfqBucket;    // strategy 12/min or sampler 6/min, each with the shared 20/min
export type Lock = { readonly held: boolean; release(): void };
acquireLock(dataDir: string): Lock;                    // throws LockHeldError
// trade.ts (pure)
executionConfig(side: Side, c: WheelConfig, asset: Asset): ExecutionConfig;   // all-listed: call max tenor max(366 d, …)
freshStateOf(target: { side: Side; strikeE8: bigint; expirySec: number }, s: Snapshot, c: WheelConfig,
  reads: { allowance: bigint; stopFile: boolean; frontendChanged: boolean }): FreshState;
// wire.ts
export type WireOptions = { account: PrivateKeyAccount | null; log: Logger; signal: AbortSignal;
  lock?: Lock | null; configHash?: string; codeRev?: string };
export type Wired = { loopDeps: LoopDeps; samplerDeps: SamplerDeps; sockets: JsonRpcSocket[];
  version: FrontendVersionWatcher; tradeDeps(target: ExecutedInstrument, asset: Asset): TradeDeps;
  envelope: RecorderEnvelope };
wireDaemon(config: AppConfig, opts: WireOptions): Wired;
```

## Appendix B: `config.example.json`

```json
{
  "mode": "dry-run",
  "enabled": true,
  "account": { "address": "0x0000000000000000000000000000000000000000", "keystorePath": "keystore/wheel" },
  "rpcUrl": "https://rpc.hyperliquid.xyz/evm",
  "rysk": { "restUrl": "https://v12.rysk.finance", "wsUrl": "wss://v12.rysk.finance/taker", "appUrl": "https://app.rysk.finance" },
  "tickSeconds": 60,
  "dataDir": "data",
  "logLevel": "info",
  "put":  { "enabled": true, "minAprPct": 40, "minHoursToExpiry": 36, "maxDaysToExpiry": 16, "minAbsDelta": 0.05,
            "maxAbsDelta": 0.45, "minOtmPct": 1, "minIntervalHours": 24, "trancheFraction": 0.25,
            "maxContractsPerTrade": 25, "reserveUsdc": "0", "maxCapitalUsdc": null },
  "call": { "enabled": true, "minAprPct": 40, "minHoursToExpiry": 36, "maxDaysToExpiry": 16, "minAbsDelta": 0.05,
            "maxAbsDelta": 0.45, "minOtmPct": 1, "minIntervalHours": 24, "trancheFraction": 0.25,
            "maxContractsPerTrade": 25, "reserveWhype": "0", "maxCapitalWhype": null, "minStrikeOverBasisPct": 0,
            "fallback": { "enabled": true, "scope": "window", "customStrikeFirst": false, "maxDiscountToBasisPct": null, "minNetPremiumUsd": "1" } },
  "tranche": { "allowSingleLot": true },
  "basis": { "anchor": { "ts": 0, "qtyWhype": "0", "basisUsd": "0" }, "externalFlows": [],
             "residualPolicy": "absorb", "residualToleranceWhype": "0.000001" },
  "quoting": { "quotesPerSide": 3, "rfqTimeoutMs": 15000, "replanSec": 300, "prefilterRatio": 0.5,
               "strategyRfqPerMin": 12, "samplerRfqPerMin": 6 },
  "safety": { "maxGasFeeUsd": "0.5", "maxGasFeeBps": 200, "minNetPremiumUsd": "1", "minQuoteTtlSec": 15, "maxQuoteTtlSec": 600,
              "maxPremiumFractionOfCollateral": 0.15, "aprEchoTolerancePp": 1.0, "aprEchoToleranceRelPct": 5,
              "verifyMakerSig": "enforce",
              "maxClockSkewMs": 3000, "startupQuietSec": 600, "settlementGraceSec": 900, "settlementOverdueHours": 6,
              "maxDeploymentsPer24h": 4, "maxNotionalPer24hUsd": "20000", "minNativeHype": "0.05",
              "maxFeePerGasGwei": 5, "confirmTimeoutMs": 60000, "unknownMaxWaitSec": 1800,
              "maxHypeExposurePct": null, "pauseOnFrontendChange": true },
  "sampler": { "enabled": true, "sweepEveryMin": 60, "pinned": 4, "pinnedEveryMin": 5, "takerPairEveryMin": 60,
               "inventoryEveryMin": 5, "publicFillsEveryMin": 60, "requestTimeoutMs": 6000,
               "putStables": ["usdc", "usdt0"], "callCollaterals": ["whype"] }
}
```

Human units are decimal strings converted by string arithmetic in the zod transform; `null` means unbounded;
percent fields are named `*Pct` and converted to fractions at the boundary (§8.9). The anchor is zero, which the
read-only commands load and `run` refuses while calls are enabled (§8.4); fill it in with `rysk basis
suggest-anchor`'s output and the real `basisUsd`. The committed file is formatted by biome (one key per line); its
content is the above.
