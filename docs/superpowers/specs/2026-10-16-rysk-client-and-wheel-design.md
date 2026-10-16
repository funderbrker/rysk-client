# Rysk Client and Bidirectional Wheel — Design

Date: 2026-10-16
Status: Approved for implementation (reviews: strategy ideation, architecture review, protocol spike; the
user delegated design approval to reviewer agents)
Protocol reference: `docs/rysk-protocol.md`

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
  sampler records their quotes; the strategy trades only USDC + WHYPE.
- Wrapping native HYPE to WHYPE (the wallet already holds WHYPE), early close, other underlyings.
- Database, dashboard, push alerts, multi-wallet, multi-host, testnet, chains other than 999.
- The items in §13 Future work.

## 2. Verified facts the design depends on

Provenance tags: **live** (observed on the wire on 2026-10-16), **bundle** (read from the app's
JavaScript), **docs** (Rysk documentation), **inferred**. Detail in `docs/rysk-protocol.md`.

- Rysk is request-for-quote; the seller is the taker. A `request` on `wss://v12.rysk.finance/taker` returns
  one best quote after a ~2 s auction. **live**: three zero-address requests from Node (no `Origin`
  header) were answered in 2.2–2.4 s with real maker quotes; `validUntil` is unix seconds, with TTLs of
  45, 66 and 93 s; `nonce` is a decimal string of 13 or 19 digits; `premiumAsset` is `""`; `apy` is a
  percent. The web app fires such requests for every visitor (about 8/s observed), so sampling is
  ordinary traffic.
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
- The inventory's indicative `apy` understates real quotes by 1.4× to 2.6×, unevenly (**live**, five
  fills and three quotes). It can rank candidates; it must never be used to apply the APR floor.
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
          │  └──► execution ──► rysk ──► domain
          │           └──────► chain (through ports)
          └──────► rysk, chain (snapshot gathering)
```

| Layer | Responsibility | May import | Side effects |
|---|---|---|---|
| `domain` | Constants, types, units, parsing of inventory/positions/caps, APR math | nothing but viem types | none |
| `chain` | Keystore, viem clients, multicall snapshot, approve, receipts, vault counter | `domain` | RPC |
| `rysk` | REST, WebSocket JSON-RPC, taker `request`/`confirm`, EIP-712 | `domain` | HTTP, WS |
| `execution` | Guarded sell state machine | `domain`, `rysk`, chain **ports** | signing, txs |
| `strategy/wheel` | State derivation, gates, planning, evaluation | `domain` | none |
| `daemon` | Loop, snapshot, sampler, recorder, status, lock, config, logging | all | files, stdout |
| `cli` | Argument parsing, commands | `daemon` | process |

Rules, enforced in code where possible:

- `domain` and `strategy` have no IO, no `node:` imports, never read a clock, and are deterministic and
  invariant to row order and duplicates. `test/architecture.test.ts` globs their sources and fails on any
  import outside `domain/` or `strategy/`.
- On-wire integers are `bigint` with the unit in the name (`strikeE8`, `quantityE18`, `priceE18`,
  `amount6`). Timestamps carry their unit (`expirySec`, `nowSec`, `tsMs`). APRs are fractions internally
  (`0.75`), converted from Rysk's percent at the parse boundary. Decimal strings are converted by string
  arithmetic, never through floats. Addresses are checksummed at parse time so internal `===` is safe;
  wire data is compared with `isAddressEqual`.
- Nothing from a server response can change which token is approved, which contract is the spender, or
  which domain is signed. These are pinned constants.
- No strategy state is stored across ticks. In-process memory holds only: the execution lock, per-key RFQ
  backoff, used quote nonces, per-side cooldown, and dry-run simulated deployments. All of it may be lost
  on restart; chain evidence and a startup quiet period cover the gap (§7.6).
- Public repo hygiene: keystore directory, `config.json`, `data/` and `*.password` are gitignored in the
  first commit; a `check:secrets` script fails on tracked `"ciphertext"` or 64-hex strings outside
  `test/fixtures/`; fixtures use obviously fake addresses and hashes; the RPC URL is redacted from logs.
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
  docs/  rysk-protocol.md  superpowers/specs/…  superpowers/plans/…
  src/
    lib/        json.ts  time.ts  result.ts
    domain/     constants.ts  types.ts  units.ts  apr.ts  inventory.ts  positions.ts  caps.ts  index.ts
    chain/      keystore.ts  clients.ts  snapshot.ts  erc20.ts  receipts.ts  index.ts
    rysk/       rest.ts  socket.ts  taker.ts  eip712.ts  errors.ts  index.ts
    execution/  types.ts  checks.ts  echo.ts  body.ts  sell.ts  index.ts
    strategy/wheel/  config.ts  types.ts  classify.ts  basis.ts  state.ts  gates.ts  tranche.ts  candidates.ts  evaluate.ts  index.ts
    daemon/     config.ts  snapshot.ts  loop.ts  sampler.ts  recorder.ts  status.ts  lock.ts  logger.ts  version.ts  index.ts
    cli/        main.ts  run.ts  state.ts  quote.ts  history.ts  wallet.ts  basis.ts
    **/*.test.ts  (colocated)
  test/
    architecture.test.ts
    fixtures/   keystore-anvil0.json  positions.json  inventory.json  assets.json  caps.json  history.json
                receipt.json  ws-request-*.json  gas-*.json  config.example.test.ts
```

## 5. Chain layer

### 5.1 Keystore

`decryptKeystore(json, password): Hex` implements Web3 Secret Storage v3 for Foundry's parameters
(scrypt, aes-128-ctr) with `node:crypto` (`scryptSync` with a generous `maxmem`, `createDecipheriv`) and
viem `keccak256` for the MAC. It accepts files without `address` and hex without `0x`.
`loadAccount(path, password)` returns a viem `PrivateKeyAccount`. The password is not stored after
decryption; the key is never logged or serialized.

Password resolution: hidden prompt on stderr when stdin is a TTY (`read`, `silent`); otherwise the file
named by `KEYSTORE_PASSWORD_FILE`, refused if group- or world-readable; otherwise fail. A
`KEYSTORE_PASSWORD` environment variable is deliberately unsupported. Only live mode loads the keystore;
startup asserts the decrypted address equals `config.account.address` and that `getCode(address)` is
empty (we hard-code `isEIP1271: false`). Startup also warns if `git ls-files keystore` lists anything.

### 5.2 Clients and the chain snapshot

`createChainClients({ rpcUrl, account? })` returns a viem public client (and wallet client when an
account is given) on `hyperEvm` with the configured RPC URL; startup asserts `eth_chainId === 999`.

`readChainSnapshot(client, self)` issues **one** `multicall` returning, at a single block: block number
and timestamp, native HYPE, WHYPE, USDC and USDT0 balances, `allowance(self, MarginPool)` for USDC and
WHYPE, and `getAccountVaultCounter(self)` on the vault store; plus `getTransactionCount` for `pending`
and `latest`. Any failed read fails the snapshot and the tick holds (never decide on partial data). The
public RPC is flaky; the README recommends a provider URL.

### 5.3 ERC-20 approve

`approve(token, spender, amount): Promise<Hex>` returns the hash; `waitForReceipt(hash, timeoutMs)` is a
separate call so a timed-out approve still has a recorded hash. Rules: approve exactly `amount` whenever
`allowance ≠ amount` (an approve overwrites a stale allowance); refuse if `pendingNonce ≠ latestNonce` (one transaction in flight, far from the 8-nonce mempool limit);
viem EIP-1559 defaults with a configurable `maxFeePerGasGwei` cap; wait 60 s; after 5 min unmined, one
replacement at the same nonce with +30 % fees; otherwise `stuck`. Re-read the allowance after mining.
Never unlimited approvals.

### 5.4 Receipts

`verifyFillReceipt(receipt, expected)` decodes logs and checks: `status == 1`; `to == Rysk`; an ERC-20
`Transfer` of the collateral token from `self` to `MarginPool` for exactly `collateralAmount`; a
`Transfer` of USDC from `MMarket` to `self` for `premium6 − gasFee6` (±1 unit, warn if lower);
`VaultOpened(owner = self)` from the vault store with `vaultId == counterBefore + 1`; `ShortOtokenMinted`
amount `== quantityE18 / 10^10`; and no other `Transfer` from `self`. Structure verified on a real fill.

## 6. Domain and Rysk layers

### 6.1 Constants

`CHAIN_ID = 999`; `ADDRESSES`: `rysk`, `marginPool`, `mmarket`, `vaultStore`, `multicall3`; `TOKENS`:
USDC, USDT0, USDH, WHYPE, kHYPE, wstHYPE, LHYPE with decimals and symbols; `PRODUCTS`: the traded
products (`put: USDC/USDC`, `call: USDC/WHYPE`) and the sampled ones. `EIP712_DOMAIN` is pinned.
Only chain 999 is encoded; a protocol-version tripwire (§9.5) watches for drift.

### 6.2 Types

Defined in Appendix A: `Product`, `Listing`, `Asset`, `Cap`, `QuoteRequest`, `Quote`, `ConfirmBody`,
`Position`, `Settlement`, `Fill`.

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
is recorded for display. `remainingCapacityE18(caps, { symbol, asset, isPut }, notionalPriceE8)` returns the
minimum headroom over `GLOBAL`, the underlying symbol (`HYPE`, not `WHYPE`), the asset address and
`address-isPut`, pricing puts at strike and calls at spot; entries with `cap == 0` are not enforced and are
skipped (`domain/caps.ts`, tested on captured caps).

### 6.5 Positions and settlement

Rows on chain 999 with underlying WHYPE are parsed **strictly**: any invalid such row fails the parse and
the tick holds (a dropped row would corrupt locked capital and the basis). All other rows (`foreign`,
`otherChain`) are parsed only for `chainId` and the row key, enough for the vault-counter comparison; their
oddities are warnings, never holds. `parsePosition(row)` converts to `bigint` (asserting e18 strikes are
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
`exceeds-premium`). Every response's `Date` header updates the measured server skew (§8.3 G5).

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
  (late replies to a previous request have the same id). `error` → `RyskRpcError(code, message)`; close
  while pending → `SocketClosedError`; errors with `id: null` are logged. The caller never retries blindly.

`RyskTaker(socket, chainId)`:

- `requestQuote(req, { timeoutMs = rfqTimeoutMs (15 000), signal })`: `QuoteOutcome` (Appendix A). `accept` matches
  `assetAddress`, `chainId`, `expiry`, `isPut`, `quantity`, `strike`, `usd`, `collateralAsset` against the
  request; a matching frame then must have `isTakerBuy === false` and `nowSec < validUntil ≤ nowSec + 3600`
  (catches a seconds/milliseconds mix-up), else `mismatch`. One request in flight per socket, 250 ms gap.
- `confirm(params, { timeoutMs = confirmTimeoutMs (60 000) })`: a JSON-RPC `error` is a rejection; a non-error
  reply whose `result` does not match `/^0x[0-9a-f]{64}$/i` is `unknown('bad-result')`, never a rejection.

### 6.8 EIP-712

`EIP712_DOMAIN = { name: 'rysk', version: '0.0.0', chainId: 999, verifyingContract: ADDRESSES.rysk }`,
pinned, never read from a server `typeDataDomain`. `CONFIRMATION_TYPES` (17 fields, verbatim from the
bundle) and `QUOTE_TYPES` (13 fields). `signConfirmation(account, message)` via viem `signTypedData`;
`recoverQuoteSigner(quote)` via `recoverTypedDataAddress`, recorded on every quote as `makerSigOk` and
enforced only when `verifyMakerSig: 'enforce'` (default `'warn'`; makers may sign via EIP-1271). Tests:
sign-and-recover with the key derived from the committed keystore fixture (no raw private key in the
repo), and signer recovery on captured real quotes.

## 7. Execution

`sellOption(deps, intent): Promise<TradeResult>` (types in Appendix A) is the only code path that
signs. One instance in flight per process (mutex) and per host (`data/live.lock`, `O_EXCL`, pid,
stale takeover).

### 7.1 Steps

```
PRECHECK → APPROVE → REQUOTE → GAS → CHECKS → [dry-run stops here] → SIGN → CONFIRM
   → RECEIPT → CHAIN_VERIFIED → done (API visibility is observed by the loop, not awaited here)
exits: aborted(stage) | reverted | unknown
```

1. **PRECHECK** (C1–C2): fresh snapshot and state, all gates pass, recomputed quantity equals the intent.
2. **APPROVE**: `collateralAmount` depends only on strike, quantity and decimals, so approve before the
   executable quote and do not burn its TTL. Approve exactly `collateralAmount` whenever `allowance ≠
   collateralAmount` (an approve overwrites a stale larger allowance); `approve` + `waitForReceipt`;
   `stuck` → `aborted('approve')`. In dry-run this step only reads the allowance and records `wouldApprove`.
3. **REQUOTE**: if `quote.validUntil − serverNowSec < minQuoteTtlSec` (15), request one fresh quote for the
   same request with `taker = self`. Only a quote held at this step is ever signed. If
   `price < intent.minPriceE18` → `aborted('price-floor')`. No other price tolerance exists.
4. **GAS**: build our own `ConfirmBody` (§7.3), `gasFee(body)`; `exceeds-premium` or `http` → `aborted('gas')`.
5. **CHECKS**: the checklist (§7.2). Any failure → `aborted('guard')` with the check id. In dry-run mode
   the function returns `aborted('dry-run', { echoOk, wouldApprove })` here, having exercised body
   building, the gas echo and every guard against real data; C1 and the allowance clause of C13 are recorded
   `n/a` in dry-run, every other check runs. The daemon records the simulated deployment (§8.8) only after
   this result is returned, so the DCA gate inside C2 does not block the dry-run path.
6. **SIGN**: typed-data hash logged; `signConfirmation`. A `trade-intent` record is appended (write-ahead);
   a failed write aborts.
7. **CONFIRM**: `signal` checked immediately before sending; the side's cooldown starts and
   `memo.lastConfirmSec[side]` is set **when the message is sent**; `confirm` is sent at most once per signed
   body and never retried. Timeout 60 s. Reply with a JSON-RPC `error` → `aborted('confirm-rejected')` (which
   clears `lastConfirmSec`); a non-error reply failing the hash regex → `unknown('bad-result')`; no reply,
   socket closed or shutdown → `unknown`.
8. **RECEIPT**: wait 120 s. `status 0` → `reverted` (definitive, collateral unmoved; clears
   `lastConfirmSec`). Success → verify (§5.4); any mismatch → write `data/STOP`, fatal log, and return
   `unknown('verify-failed')`. Timeout → `unknown('receipt-timeout')`.
9. **CHAIN_VERIFIED**: vault counter `== before + 1` and allowance decreased by the amount → `filled`;
   otherwise `STOP` and `unknown('verify-failed')`.

### 7.2 Pre-sign checklist

| id | check |
|---|---|
| C1 | Live mode, no `data/STOP`, lock held, signer address == `config.account.address`, `isEIP1271 = false`. |
| C2 | Fresh state (≤ 10 s) passes all gates, evaluating G8 with the calling execution excluded; recomputed tranche quantity equals the intent. |
| C3 | Pinned allowlist: `assetAddress` WHYPE; `usd` USDC; `collateralAsset` USDC (put) or WHYPE (call); `chainId 999`; `isTakerBuy false`; `taker == self`. |
| C4 | Quote echoes the request on every term field (§6.7). |
| C5 | `maker ∉ {zero, self}`; `quoteNonce` not previously **signed** in-process (a nonce joins the used set at SIGN); `recoverQuoteSigner == maker` when `verifyMakerSig: 'enforce'`. |
| C6 | `minQuoteTtlSec ≤ validUntil − serverNowSec ≤ maxQuoteTtlSec (600)`, and `validUntil < expiry`. |
| C7 | `price > 0`; `price / strike` (put) or `price / spot` (call) ≤ `maxPremiumFractionOfCollateral` (0.15); our APR (gas 0) within `aprEchoTolerancePp` (1.0 percentage point) of `quote.apy`. |
| C8 | Normal mode: `aprFraction(premium6 − gasFee6 from the GAS step, collateral6, serverNowSec, expiry) ≥ minApr`. Fallback: `net6 ≥ call.fallback.minNetPremium6`. Both: `net6 ≥ safety.minNetPremium6`. (`minPriceE18` is only the REQUOTE screen.) |
| C9 | Gas echo (§7.3): every sent field equal by kind; extra keys ⊆ the known set with their expected values; `gasFee` a non-negative integer string with `gasFee6 × 10000 ≤ premium6 × maxGasFeeBps` and `gasFee6 ≤ maxGasFee6` (= `safety.maxGasFeeUsd` as 6 dp). |
| C10 | Strike vs fresh spot: put `K ∈ [0.6 S, S (1 − minOtmPct)]`, call `K ∈ [S (1 + minOtmPct), 1.4 S]`; `K % strikePrecision == 0`; `K` listed for that expiry within 5 min unless the intent is a custom fallback strike. |
| C11 | Expiry in the current inventory and within the tenor window (fallback: ≥ `minHoursToExpiry`). |
| C12 | `qty % minTradeSize == 0`; `minTradeSize ≤ qty ≤ min(maxTradeSize, maxContractsPerTrade)`. |
| C13 | `collateralAmount` ≤ free balance − reserve and `allowance == collateralAmount` (`n/a` in dry-run). |
| C14 | Caps soft check (§8.5). |
| C15 | Domain pinned; `nonce = String(max(Date.now(), lastNonceMs + 1))`, within 5 s of server time. |
| C16 | Daily limits including this trade. |
| C17 | The message is built from a branded `CheckedConfirmBody` that only `checks.ts` can produce. |
| C18 | Calls only, on the fresh state: `basis.reliable`; normal mode `K ≥ basisE8 × (1 + minStrikeOverBasisPct)`; fallback mode: the fresh `basisEligible` set is still empty and `K` equals the fresh `K*` (or the custom strike). |

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
`{ ...body, ...echoedExtras, gasFee, isEIP1271: false, signature }` where `echoedExtras` are the
allowlisted extra keys with their echoed values and `signature` replaced by ours. This carries exactly
what the app sends while guaranteeing the signed fields are ours. `referralCode` is never sent.

### 7.4 Gas preview

Evaluation uses the app's 9-field preview body (`assetAddress, chainId, isPut, collateralAsset, expiry,
strike, usd, price, quantity`). The full body is used only inside `sellOption`.

### 7.5 Cooldown

| result | cooldown on the side |
|---|---|
| `aborted` before confirm | none |
| `aborted('confirm-rejected')`, `reverted` | 60 s; `memo.lastConfirmSec[side]` is cleared so the DCA interval is not consumed; three confirm errors per hour or two reverts per 24 h → halt live |
| `filled` | until the txHash appears in the positions API (max `unknownMaxWaitSec`, 1800) |
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
blocks it before that. A second live instance on the same host is refused by the lock; two hosts on one
wallet are unsupported and documented.

## 8. Wheel strategy (pure)

### 8.1 Inputs

`Snapshot` is defined in Appendix A; `WheelConfig` is the zod output of Appendix B (§8.9). `nowSec` is the
chain block timestamp; `localNowMs` is the process clock. The daemon applies per-key backoff and the
`replanSec` timer before calling `planSide`, so the pure core never sees them.

### 8.2 State derivation

`deriveState(snapshot, config): WheelState`, deterministic and order-invariant:

1. De-duplicate rows by key (collapse identical keys with a warning). Classify each row:
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
| G3 | global | no managed or basis-relevant row is `pendingSettlement`, and `settlementGraceSec` (900) has passed since the first tick (in-memory) that saw no pending basis-relevant row; after a restart `startupQuietSec` covers the gap | |
| G4 | global | rows fetched this tick; block age ≤ 30 s; inventory age ≤ 120 s | |
| G5 | global | `|local − serverNow| ≤ maxClockSkewMs` (3000) (server time from REST `Date` headers and the block timestamp) | |
| G6 | global | WHYPE asset active, `marketStatus.isOpen !== false`, HYPE listings present | |
| G7 | live | uptime ≥ `startupQuietSec` (600) | |
| G8 | global | no execution in flight; `pendingNonce == latestNonce` (`tx-pending`); side not in cooldown | |
| G9 | live | `nativeHype ≥ minNativeHype` (0.05) | |
| G10 | global | `data/STOP` absent; `enabled`; frontend version unchanged or `pauseOnFrontendChange` off | |
| G11 | live | `deploymentsLast24h < maxDeploymentsPer24h` (4); `notionalLast24h6 < maxNotionalPer24h6` (20 000 USD) | |
| S1 | side | side enabled | |
| S2 | side | `now − lastDeployTs[side] ≥ minIntervalHours` (24) | |
| S3 | side | tranche yields ≥ one lot (§8.5) | |
| S4 | call | basis reliable and defined | |
| S5 | put | HYPE exposure ≤ `maxHypeExposurePct` when set (off) | |

### 8.4 HYPE basis ledger

Config `basis: { anchor: { ts, qtyWhype, basisUsd }, externalFlows?: [{ ts, qtyWhype (signed), basisUsd? }],
residualPolicy: 'absorb' | 'block-calls', residualToleranceWhype }`. `anchor.qtyWhype` is the HYPE owned at
`anchor.ts`: wallet WHYPE plus WHYPE locked in calls open at that instant. When `call.enabled`, config load
fails unless `anchor.ts > 0` and `anchor.basisUsd > 0` (the example's zero anchor is a placeholder that would
otherwise disable the basis rule). If `anchor.ts` falls inside `[expiry, expiry + 6 h]` of any basis-relevant
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
`usage + need ≤ 0.95 × cap` for every matching entry.

### 8.6 Candidates, basis rule, fallback

Candidate listings per side: HYPE, `isPut` by side, traded product present, tenor `minHoursToExpiry ≤ tte ≤
maxDaysToExpiry`, `|delta| ∈ [minAbsDelta, maxAbsDelta]`, moneyness `K ≤ S (1 − minOtmPct)` (put) or
`K ≥ S (1 + minOtmPct)` (call), quantity ≥ one lot, `indicativeApr ≥ minApr × prefilterRatio` (0.5), where `minApr` is the fraction form of `minAprPct`. Calls
also require `K ≥ basis × (1 + minStrikeOverBasisPct)`. Rank by `indicativeApr` desc, then shorter tenor,
then lower `|delta|`. Quote plan per due side, up to `quotesPerSide` (3), diversified: best; best in another
expiry; best with `|delta| ≤ 0.25`. Strategy requests use `taker = config.account.address` in both modes.

Call fallback (user decision): `basisEligible` = call listings with `K ≥ basisE8 × (1 + minStrikeOverBasisPct)`
passing tenor, product, moneyness and size (not APR or delta). Non-empty → normal path; none clears the floor →
`hold('apr-floor')`. Empty and `fallback.enabled` → `e*` = shortest expiry with `tte ≥ minHoursToExpiry`,
`K*` = highest listed call strike at `e*`; optional `customStrikeFirst` requests a custom strike
`ceil(min(basis, 1.4 S × 0.995))` at `e*` first and takes it if `net6 ≥ minNetPremium6`; optional
`maxDiscountToBasisPct` holds if `K* < basis (1 − d)`. The fallback ignores the APR floor and delta band,
keeps every other gate and check, and the decision records `lossIfExercisedUsd`. Basis eligibility is
scoped to the tenor window (`fallback.scope: 'window'`, default) because the strategy tends to short
duration; `'all-listed'` routes a far-dated strike above basis to the normal path.

### 8.7 Evaluating quotes

For each quote: `premium6`, `net6 = premium6 − gasFee6` (preview), `aprNet`. Choose the maximum
`aprNet ≥ minApr` (fallback skips the floor) with `net6 ≥ minNetPremium6`; ties: shorter tenor, lower
`|delta|`, earlier response. The `Decision` carries `minPriceE18` (the price at which `aprNet == minApr`,
or for a fallback the lowest price passing the gas guards) and `maxGasFee6`. None qualifies →
`hold('apr-floor')` with the best seen. Live executes at most one intent per tick: the side with the larger
`aprNet − minApr`.

Anti-spam: a key backs off `min(60 min, 5 min × 2^(n−1))` after a below-floor quote, reset when spot moves
> 2 % or its indicative apr rises > 25 %; a due side whose floor is unmet re-plans every `replanSec` (300).
Token buckets: strategy 12 RFQ/min, sampler 6 RFQ/min, hard cap 20/min.

### 8.8 Dry-run cadence (see §8.9 for config)

In dry-run, after `sellOption` returns `aborted('dry-run')` for the chosen intent, the daemon records a
simulated deployment in memory so the DCA clock advances and the decision log matches live cadence.
Simulated deployments are lost on restart.

### 8.9 WheelConfig

`WheelConfig` is the zod output of `config.example.json` (Appendix B) with units normalized at the boundary:
`*Pct` fields become fractions without the suffix (`minAprPct: 40` → `minApr: 0.4`); `*Usd` and `*Usdc`
strings become `bigint` 6-dp fields suffixed `6`; `*Whype` and `*Hype` strings become `bigint` e18 fields
suffixed `E18`; `basisUsd` becomes `basisE8`; `null` becomes `undefined`. Notional amounts
(`notionalLast24h6`, `maxNotionalPer24h6`) are `bigint` 6 dp: strike × qty for puts, spot × qty for calls.

## 9. Daemon

### 9.1 Loop

Fixed delay: `while (!signal.aborted) { await tick(); await sleep(tickSeconds, signal) }` (60 s), so a
multi-minute trade never overlaps a tick. Tick: snapshot (one multicall; REST positions, inventory,
assets, caps in parallel) → `deriveState` → `STATUS.json` → per due side: plan → serialized
`requestQuote` + gas preview → `evaluate` → record → live: `sellOption` for at most one intent; dry-run:
`sellOption` in dry-run mode for the chosen intent (exercises body, echo, guards). Any failed read holds
the tick; three consecutive failures escalate to error level.

Modes: default dry-run. Live requires `--live` **and** `mode: "live"` in config; `--live` with
`mode: "dry-run"` exits with an error; `mode: "live"` without `--live` runs dry-run with a warning.
`--max-trades N` exits after N completed executions for supervised early runs. Dry-run never loads the
keystore.

### 9.2 Research sampler

A separate loop with its **own** `JsonRpcSocket` (serialization is per connection), sharing only the token
bucket; fixed-delay scheduling (next sweep starts `intervalSeconds` after the previous one ends);
`requestTimeoutMs` 6000; paused while a live `sellOption` runs; never trades. Defaults:

- **Hourly sweep**: every listed HYPE combination, both sides, 25 contracts, `taker = zero`, pair legs
  back-to-back in random order: puts USDC then USDT0; calls WHYPE, kHYPE, LHYPE, wstHYPE.
- **Pinned series**: up to 4 instruments (default the ~0.10 and ~0.25 delta strikes of the nearest expiry,
  both sides), every 5 min for their lifetime (as custom strikes once de-listed).
- **Taker pair**: hourly, one instrument quoted with `taker = self` and `taker = zero` back-to-back.
- **Inventory snapshot**: HYPE listings and caps every 5 min or on content change.
- **Public fills**: `publicHistory` hourly, de-duplicated by `txHash`.

### 9.3 Recorder

Append-only JSONL under `data/<stream>/YYYY-MM-DD.jsonl` (UTC days) via `appendFileSync` per line
(O_APPEND, crash-safe, no handles). Envelope `{ v: 1, kind, tsMs, runId, mode, codeRev, configHash }`;
every `*E18`, `*E8` and `*6` field is a decimal string. Streams:

- `quotes`: one record per RFQ including failures: purpose (`candidate | exec-requote | sweep | pinned |
  taker-pair | fallback-custom`), instrument, taker kind, context (spot, inventory ts, indicative apr and
  delta, tenor, weekday, hour, connection id), request/response times, outcome (`quote | error | timeout |
  mismatch | socket-closed`), quote fields (maker, priceE18, validUntil, ttl, nonce, server apy,
  `makerSigOk`), derived premium and APR, and `aprOverIndicative`.
- `decisions`: per side per tick: gate results, capital, basis, candidates with exclusions and ranks,
  quotes obtained, floor, result (intent or hold with reason and best seen).
- `executions`: one record per state-machine step: the gas echo verbatim, every check result, the
  typed-data hash and nonce, the `trade-intent` write-ahead line, tx hash, receipt summary, visibility latency.
- `inventory`, `public-fills`.

Settlement history and daily summaries are derived offline from the positions API; no stream is needed.
Expect roughly 10 MB/day with the sampler on; the daemon never rotates files itself.

### 9.4 Status, kill switch, lock, shutdown

`data/STATUS.json` rewritten each tick: health, hold reasons, halted, last trade, counts. `data/STOP`
present → no execution (live halts, dry-run continues); fatal events (receipt mismatch, gas-echo mismatch,
repeated confirm errors, APR echo disagreement twice) write `STOP` and log one `fatal` line. `data/live.lock`
in live mode. `SIGINT`/`SIGTERM`: abort the loop's signal; `sellOption` checks it right before `confirm`;
waits after `confirm` may be abandoned and recorded as `unknown`; hard deadline 20 s.
`unhandledRejection`/`uncaughtException` log fatal and exit 1.

### 9.5 Logging, version tripwire, secrets

`pino` JSON to stdout (pipe through `pino-pretty` in dev). An error serializer redacts the configured RPC
URL and any `/v2/[A-Za-z0-9_-]{16,}` segment; startup logs the RPC host only, plus mode, chain check,
address, balances, derived state and a config summary without secrets. `version.ts` fetches
`https://app.rysk.finance/api/version/` at startup and hourly; on a changed `sha` it warns and, with
`pauseOnFrontendChange` (default true in live), blocks new confirms until restart.

### 9.6 CLI

`node:util parseArgs` with the subcommand in `positionals[0]`: `run [--live] [--max-trades N] [--config
path] [--no-sampler]`, `state`, `quote --side put|call --strike 78.5 --expiry <sec> [--qty 25] [--collateral
whype|khype|lhype|wsthype] [--usd usdc|usdt0]` (one RFQ, no trade), `history --from --to --out`, `wallet`
(address, balances, allowances, vault counter), `basis suggest-anchor`. Script `"rysk": "node src/cli/main.ts"`.

### 9.7 Running in production

README section: systemd unit with `Restart=on-failure`, `RestartSec=30`, `TimeoutStopSec=30`; password
file location and permissions; logs to stdout/journald; one live instance per wallet; keep the public RPC
for dry-run only; data growth.

## 10. Error handling

| Situation | Handling |
|---|---|
| No quote within 15 s; RPC error; late or mismatched reply | Recorded with its outcome; candidate skipped; key backoff. Cap or "cannot quote" errors → hold with reason; text suggesting geo or forbidden → halt live, continue dry-run. |
| Socket closes mid-auction | Pending call rejects `socket-closed`; results from the old connection are discarded; reconnect with backoff. |
| TTL out of bounds; `quote.apy` disagrees with our APR; maker signature does not recover | Not executable; recorded. Two APR disagreements → halt live. |
| Executable re-quote below `minPriceE18` | `aborted('price-floor')`; allowance stays (harmless, exact, needs our signature). |
| Gas: exceeds premium; echo mismatch; unknown extra key or value; fee over bound | Candidate skipped with key backoff, no side cooldown (nothing was sent); **echo mismatch or unknown key halts live**; fee over bound → hold `gas`. |
| `confirm` rejected | Never retry the same quote or nonce; 60 s cooldown; three per hour → halt live. |
| Relayer tx reverts | Collateral unmoved; 60 s cooldown; two per 24 h → halt live. |
| No confirm reply, socket closed, or receipt timeout | `unknown`: hold the side; resolve by API row or vault counter; after 1800 s log error and unblock; never re-sign meanwhile. |
| Receipt amounts differ | Fatal: `STOP`, halt live. |
| Approve stuck | ≤ 1 pending tx; one replacement after 5 min at +30 %; then halt live; `tx-pending` gate meanwhile. |
| RPC rate limit, sporadic rejects, stale block | One multicall per tick; any failed read holds; block age > 30 s holds. |
| Expiry settlement window and overdue settlement (> 6 h) | G3 holds both sides (+ 15 min grace); overdue logs hourly errors. |
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
  (fake addresses and hashes); basis replay (adds, removes, residual both signs, negative anomaly, ordering
  ties) with hand-computed numbers; state derivation invariant under permutation and duplication; gates;
  tranche (single-lot rule, caps, sizes, `floorToIncrement` 10 → 0); candidates (basis rule, fallback window
  vs all-listed, custom strike); evaluation (floor, ties, gas bounds, `minPriceE18`); `JsonRpcSocket` on a
  fake socket with fake timers (serialization, late-reply ignore, deadlines, connect timeout, backoff
  reset, idle close) plus one real `ws` integration test; `echo.ts` on captured gas responses; `sellOption`
  against fakes (happy path, each check failing, requote floor, echo mismatch, reverted, unknown, dry-run
  stop); receipt verification on the anonymized real receipt; recorder and `stringifyBig`; config example
  parses; architecture test.
- Live smoke tests, opt-in with `RYSK_LIVE_TESTS=1`: REST and WS reads parse; one zero-address `request`
  and one gas preview. Never `confirm`.
- Acceptance before handover: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm check:secrets` green;
  `rysk run` in dry-run on mainnet for several ticks from the sandbox produces quote, decision and
  execution records with `echoOk: true`; `rysk quote` returns a real quote.

## 12. Open questions settled by the first supervised live trade

1. Whether `confirm` accepts our body plus the allowlisted extras (the app sends the spread echo).
2. Semantics of `validUntil` vs `quoteValidUntil`; whether the relayer enforces `validUntil`.
3. Whether concurrent RFQs on one socket are allowed or last-wins; whether makers price `taker = self`
   differently from zero; whether the server validates `nonce` recency; cap `usage` semantics;
   settlement-lag distribution; what `0x577b…` is versus the vault store.

## 13. Future work (deliberately deferred)

Provisional positions from vault views during API lag; FIFO lots report with underwater quantity;
code-hash pinning of Rysk contracts; per-expiry laddering limits; burst sampling; calibration table from
indicative to realized APR; `premiumAdjust` basis mode; maker allowlist; halting on foreign-collateral
positions; secondary RPC; on-chain `Transfer` scan for recent deployments; settlement and daily-summary
streams; LST collateral and USDT0 trading; wrapping; alerts.

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
  signature: Hex; usd: Address; collateralAsset: Address; apy: number };
export type ConfirmBody = { assetAddress: Address; chainId: 999; expiry: number; isPut: boolean; isTakerBuy: false;
  maker: Address; price: string; quantity: string; quoteNonce: string; quoteSignature: Hex;
  quoteValidUntil: number; validUntil: number; strike: string; taker: Address; usd: Address;
  collateralAsset: Address; collateralAmount: string; nonce: string };
export type Settlement =
  | { outcome: 'expiredOtm'; collateralReturned: bigint }
  | { outcome: 'assigned'; receivedUnderlyingE18: bigint }
  | { outcome: 'exercised'; receivedStable6: bigint }
  | { outcome: 'anomaly'; detail: string };
export type Position = { key: string; underlying: Address; chainId: number; isPut: boolean; strikeE8: bigint;
  quantityE18: bigint; priceE18: bigint; premium6: bigint; usd: Address; collateral: Address; collateralSymbol: string;
  createdAtSec: number; expirySec: number; txHash: Hex; status: 'open' | 'settled' | 'unknown'; settlement: Settlement | null };
export type Fill = { txHash: Hex; chainId: number; underlying: Address; symbol: string; isPut: boolean; strikeE8: bigint;
  expirySec: number; quantityE18: bigint; priceE18: bigint; premium6: bigint; aprRysk: number; usd: Address;
  collateral: Address; makerFee6: bigint; createdAtSec: number };

// strategy/wheel/types.ts
export type Snapshot = {
  nowSec: number; localNowMs: number; mode: 'live' | 'dry-run'; self: Address;
  chain: { blockNumber: bigint; blockTs: number; whypeE18: bigint; usdc6: bigint; usdt06: bigint; nativeHypeE18: bigint;
           allowanceUsdc6: bigint; allowanceWhypeE18: bigint; vaultCounter: bigint; pendingNonceGap: number };
  positions: Position[];                 // strictly parsed, this tick
  market: { assets: Asset[]; listings: Listing[]; caps: Cap[]; spotE8: bigint; inventoryTs: number };
  memo: { lastConfirmSec: Partial<Record<Side, number>>; cooldownUntilSec: Partial<Record<Side, number>>;
          simulatedDeploySec: Partial<Record<Side, number>>; inFlight: boolean; uptimeSec: number;
          serverSkewMs: number; frontendChanged: boolean; stopFile: boolean };
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
  mode: 'normal' | 'basis-fallback' | 'basis-fallback-custom'; rank: number };
export type SidePlan = { kind: 'hold'; side: Side; reason: HoldReason; detail?: string }
  | { kind: 'quote'; side: Side; candidates: Candidate[] };
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
checkGates(side: Side, st: WheelState, s: Snapshot, c: WheelConfig): HoldReason | null;
planSide(side: Side, st: WheelState, s: Snapshot, c: WheelConfig): SidePlan;
evaluate(side: Side, qs: QuotedCandidate[], st: WheelState, s: Snapshot, c: WheelConfig): Decision;

// execution/types.ts
export type TradeIntent = { side: Side; candidate: Candidate; quote: Quote; minPriceE18: bigint; maxGasFee6: bigint };
export type TradeDeps = {
  mode: 'live' | 'dry-run'; signal: AbortSignal;
  freshState(): Promise<{ snapshot: Snapshot; state: WheelState }>;
  quotes: { requestQuote(r: QuoteRequest, o: { timeoutMs: number; signal?: AbortSignal }): Promise<QuoteOutcome> };
  rest: { gasFee(body: ConfirmBody): Promise<GasResult> };
  rpc: { confirm(p: ConfirmParams, o: { timeoutMs: number }): Promise<Hex> };
  collateral: { allowance(token: Address): Promise<bigint>; approve(token: Address, amount: bigint): Promise<Hex>;
                waitForReceipt(hash: Hex, timeoutMs: number): Promise<TransactionReceipt>; vaultCounter(): Promise<bigint> };
  signer: { address: Address; signConfirmation(m: ConfirmationMessage): Promise<Hex> } | null;  // null in dry-run
  clock: { serverNowSec(): number; nowMs(): number };
  record(e: ExecutionEvent): void;      // write-ahead before confirm; a failed write aborts
};
export type TradeResult =
  | { status: 'filled'; txHash: Hex; approveTxHash?: Hex; quote: Quote; premium6: bigint; gasFee6: bigint }
  | { status: 'reverted'; txHash: Hex; approveTxHash?: Hex }
  | { status: 'unknown'; reason: 'confirm-timeout' | 'socket-closed' | 'receipt-timeout' | 'shutdown' | 'bad-result' | 'verify-failed';
      confirmSentAtSec: number; txHash?: Hex; approveTxHash?: Hex }
  | { status: 'aborted'; stage: 'precheck' | 'approve' | 'requote' | 'price-floor' | 'gas' | 'echo' | 'guard'
      | 'confirm-rejected' | 'dry-run'; message: string; checkId?: string; approveTxHash?: Hex; echoOk?: boolean; wouldApprove?: bigint };
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
              "maxPremiumFractionOfCollateral": 0.15, "aprEchoTolerancePp": 1.0, "verifyMakerSig": "warn",
              "maxClockSkewMs": 3000, "startupQuietSec": 600, "settlementGraceSec": 900, "settlementOverdueHours": 6,
              "maxDeploymentsPer24h": 4, "maxNotionalPer24hUsd": "20000", "minNativeHype": "0.05",
              "maxFeePerGasGwei": 5, "confirmTimeoutMs": 60000, "unknownMaxWaitSec": 1800,
              "maxHypeExposurePct": null, "pauseOnFrontendChange": true },
  "sampler": { "enabled": true, "sweepEveryMin": 60, "pinned": 4, "pinnedEveryMin": 5, "takerPairEveryMin": 60,
               "inventoryEveryMin": 5, "publicFillsEveryMin": 60, "requestTimeoutMs": 6000,
               "putStables": ["usdc", "usdt0"], "callCollaterals": ["whype", "khype", "lhype", "wsthype"] }
}
```

Human units are decimal strings converted with `parseUnits` in the zod transform; `null` means unbounded;
percent fields are named `*Pct` and converted to fractions at the boundary.
