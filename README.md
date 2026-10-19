# rysk-client

A TypeScript client and trading daemon for [Rysk V12](https://docs.rysk.finance) options on HyperEVM (chain 999).

The client discovers products, requests quotes, sells covered calls and cash-secured puts, and reads positions and settlement history. One strategy runs on top of it: a **bidirectional wheel on HYPE/USDC**.
- It sells cash-secured puts with idle USDC and covered calls with idle WHYPE.
- Every trade must clear a minimum APR on a real maker quote, net of gas.
- Calls are only struck at or above the weighted-average price the wallet paid for its HYPE.

The same daemon is also a research tool. In dry-run mode, the default, it requests real quotes and runs the whole trade path up to the signature, including the gas echo and every pre-sign check. It records everything to JSONL files and never trades.

- Protocol reference (reverse-engineered, with provenance tags): [`docs/rysk-protocol.md`](docs/rysk-protocol.md)
- Design spec: [`docs/superpowers/specs/2026-10-16-rysk-client-and-wheel-design.md`](docs/superpowers/specs/2026-10-16-rysk-client-and-wheel-design.md)

> **Status.** Unaudited, and it has never placed a live trade. Rysk publishes no taker API. The first live trade should be a supervised `--max-trades 1` run (see [Limitations](#limitations-and-open-questions)).

## Contents

- [Safety model](#safety-model)
- [Setup](#setup)
- [Commands](#commands)
- [Configuration reference](#configuration-reference)
- [Running in production](#running-in-production)
- [Research data streams](#research-data-streams)
- [Validation](#validation)
- [Limitations and open questions](#limitations-and-open-questions)
- [Development](#development)

## Safety model

**Dry-run is the default.** A live run needs two things at once:
- the `--live` flag;
- `"mode": "live"` in the config.

These combinations fail safe:

| You pass | Result |
|---|---|
| `--live` with `"mode": "dry-run"` | Exits 1 with a config error. |
| `"mode": "live"` without `--live` | Runs dry-run and logs a warning. |
| `--live` with the zero address as `account.address` | Refused. |
| `--live` with `"verifyMakerSig": "warn"` | Refused: live needs `"enforce"`. |

Dry-run never opens the keystore.

**Live startup** stops at the first check that fails:
1. Takes `<dataDir>/live.lock`.
2. Decrypts the keystore.
3. Checks that the key's address equals `account.address`.
4. Checks that the RPC serves chain 999. Dry-run runs this check too.
5. Checks that the account has no contract code. It must be an EOA, because `isEIP1271` is pinned to `false`.

It also warns if git tracks anything under `keystore/`.

**Pinned constants.** No server response can change any of these:
- the token that is approved;
- the spender (the Rysk MarginPool);
- the EIP-712 domain that is signed.

All three are compiled-in constants. Approvals are always for the exact collateral amount and never unlimited.

**One signing path.** `sellOption` is the only code that signs. Its steps:

```
PRECHECK → APPROVE → REQUOTE → GAS → CHECKS → [dry-run stops here] → SIGN → CONFIRM → RECEIPT → CHAIN_VERIFIED
```

- In dry-run, APPROVE only reads the allowance and records `wouldApprove`.
- A `confirm` is sent at most once per signed body and never retried.
- After a fill, the receipt is checked against the expected transfers, vault and oToken amounts. The vault counter and the allowance are then re-read from the chain.
- Any mismatch writes `data/STOP`.

### Pre-sign checklist (C1–C18)

Every check runs against the fresh quote and a fresh snapshot taken just before signing. The first failure aborts the trade with that check's id. In dry-run, C1 and the allowance clause of C13 are recorded `n/a`. C18 is `n/a` for puts.

| id | check |
|---|---|
| C1 | Live mode; no `STOP` file; lock held; the signer is `account.address`; `isEIP1271` false. |
| C2 | The fresh state is at most 10 s old and passes every gate, with this execution excluded from G8. In live, native HYPE ≥ `minNativeHype`. The re-sized tranche equals the intent. |
| C3 | The pinned product: WHYPE underlying, USDC strike, and USDC (put) or WHYPE (call) collateral. Chain 999, a sell, `taker` is us. Fallback modes are for calls only. |
| C4 | The quote echoes the request on every term field. |
| C5 | The maker is neither zero nor us. The quote nonce was never signed in this process. The maker signature recovers when `verifyMakerSig: "enforce"` (else a recorded warning). |
| C6 | `minQuoteTtlSec ≤ validUntil − serverNow ≤ maxQuoteTtlSec`, and `validUntil < expiry`. |
| C7 | `price > 0`. `price / strike` (put) or `price / spot` (call) ≤ `maxPremiumFractionOfCollateral`. Our APR (gas 0) is within `aprEchoTolerancePp` of the quote's `apy` for a put, and within the larger of that and `aprEchoToleranceRelPct` for a call. A non-finite `apy` fails. |
| C8 | The net premium after the real gas fee clears `minAprPct` (normal) or the fallback floor. It is also always ≥ `safety.minNetPremiumUsd`. |
| C9 | `/api/gas` echoes our body exactly, plus only the known extra keys with their known values. The fee is ≤ `maxGasFeeBps` of the premium, ≤ `maxGasFeeUsd` and ≤ the bound the decision recorded in the intent. |
| C10 | The strike is in the OTM band around fresh spot: a put in `[0.6 S, S(1 − minOtmPct)]`, a call in `[S(1 + minOtmPct), 1.4 S]` (the planner applies the same band). It is on the strike grid, and listed in an inventory at most 5 min old (custom fallback strikes excepted). |
| C11 | The expiry is listed and inside the tenor window. Fallback trades check only `minHoursToExpiry`. |
| C12 | A whole number of 25-contract lots, within the asset's trade sizes and `maxContractsPerTrade`. |
| C13 | The collateral equals strike × quantity (put) or the quantity (call), and fits in free collateral after the reserve. In live, the allowance equals it exactly. |
| C14 | The quantity fits the caps headroom, with a 5 % soft margin. |
| C15 | The EIP-712 domain is the pinned one. The confirm nonce is above the last one and within 5 s of the clock. |
| C16 | The 24 h deployment count and notional stay under their limits with this trade included. |
| C17 | The signed body carries exactly the checked quote's terms. Only `checks.ts` can produce the branded body the signer accepts. |
| C18 | Calls only: the basis is reliable, and the strike ≥ basis × (1 + `minStrikeOverBasisPct`). In fallback, no listed strike may clear the basis on the fresh state, and the fallback strike is recomputed fresh: the listed fallback strike must not have changed and must be below the basis threshold; a custom strike must be above the fresh fallback strike. |

**The call fallback** sells below the basis only when calls in the tenor window pass every other filter but none clears the basis; an empty window holds instead. A strike above basis but outside the 0.6–1.4 × spot band (C10) is not sellable and does not count as clearing the basis, so in a downturn that leaves only such strikes above the basis the fallback applies. Set `call.fallback.maxDiscountToBasisPct` to cap how far below the basis it may sell.

### Strategy gates (G1–G11, S1–S5)

The gates are checked every tick before a side may request quotes. The decision record lists every gate that applies; the side's hold reason is the first failure.

| id | scope | holds when |
|---|---|---|
| G1 | global | any anomaly, or any position with an unknown status |
| G2 | global | the on-chain vault counter disagrees with the positions API (`api-lag` or `inconsistent`) |
| G3 | global | a WHYPE-moving position awaits settlement, or `settlementGraceSec` has not passed since the first tick that saw none |
| G4 | global | the block is > 30 s old or the inventory > 120 s old |
| G5 | global | the clock skew to the server (REST `Date` header, future blocks) exceeds `maxClockSkewMs` |
| G6 | global | the WHYPE asset is inactive or its market closed, or there are no HYPE listings |
| G7 | live | uptime < `startupQuietSec` |
| G8 | global | an execution is in flight, one of our transactions is unmined (`pending` > `latest` nonce, which relies on HyperEVM's `pending` tag reflecting the mempool; see [Limitations](#limitations-and-open-questions)), or the side is cooling down |
| G9 | live | native HYPE < `minNativeHype` |
| G10 | live / global | a `STOP` file is present (**live only**); the global clauses: `enabled: false`, or the frontend version changed while `pauseOnFrontendChange` is on |
| G11 | live | `maxDeploymentsPer24h` or `maxNotionalPer24hUsd` reached |
| S1 | side | the side is disabled |
| S2 | side | less than `minIntervalHours` since the side's last deployment |
| S3 | side | the tranche is below one 25-contract lot (`cap` when the caps alone cause it) |
| S4 | call | the HYPE basis is unreliable or undefined |
| S5 | put | HYPE exposure > `maxHypeExposurePct` (off by default) |

### Kill switch, lock and halts

**Kill switch.** Create `<dataDir>/STOP` (`touch data/STOP`) to block live executions. Live re-reads it each tick, right before an execution, and in PRECHECK and C1. Removing the file resumes trading. Dry-run keeps running and recording while it exists. The check fails closed: when the path cannot be checked (a permission or I/O error rather than a missing file), live treats `STOP` as present.

Fatal events **halt live in memory**: the process never executes again until it is restarted. They also append a timestamped one-line reason to `STOP` (whitespace collapsed, at most 500 characters, since RFQ error text from the server can reach it) and log one `fatal` line, so a restart stays blocked until you remove the file. The fatal events are:
- a fill receipt or chain-verification mismatch;
- a gas-echo mismatch (`aborted('echo')`);
- three confirm errors (rejected or reverted) within an hour;
- two reverts within 24 h;
- two C7 APR-echo disagreements within an hour;
- a rejected confirm whose fill appears in the positions anyway (`rejected-filled`), since that fill went through no receipt verification;
- an RFQ error whose text matches `geo|forbidden|restricted`.

A STOP write that fails after a send also halts live in memory, and the failure is logged at error level. `STATUS.json` then shows `health: "halted"`. Dry-run only logs what live would have done.

**Lock.** Live takes `<dataDir>/live.lock` exclusively (`O_EXCL`); the file holds the pid and start time.
- If the recorded pid is no longer running, the lock is taken over once.
- A running holder, or an unreadable lock file, refuses the start (exit 1). Remove an unreadable lock by hand once no instance is running.
- The lock is released on every exit path.

**Cooldowns and backoff.**

| event | effect |
|---|---|
| A sent confirm | Starts the side's cooldown. |
| `confirm-rejected` or `reverted` | 60 s cooldown. The DCA interval is not consumed. A rejection is also watched for `unknownMaxWaitSec`: a row with its terms created at or after the confirm is a fill the error reply denied, recorded as `rejected-filled`, and halts live. The watch holds nothing and ends silently, or at the next sent confirm on the same trade. |
| `filled` | Holds the side until the fill's `txHash` shows in the positions API, at most `unknownMaxWaitSec`. |
| `unknown` (no reply, socket closed, receipt timeout) | Holds the side until there is evidence: a matching position row, or the vault counter rising. After `unknownMaxWaitSec` it logs an error and unblocks. Nothing is re-signed meanwhile. |
| A below-floor or failed quote | The instrument backs off for `min(60 min, 5 min × 2^(n−1))`. This resets when spot moves more than 2 % or the indicative APR rises more than 25 %. |
| An execution that aborts before the confirm on its quote: `requote`, `price-floor`, `gas`, or a `guard` check other than C2 (fresh state) and C10 (strike against spot) | The executed instrument backs off the same way, so a deterministic abort is not retried every tick. The `executions` result record names the backoff. A custom fallback strike backs off like a listed one; having no indicative APR, it resets only on a spot move. |
| A side holds at the APR floor | It is re-planned after `replanSec`. |

**Shutdown.** SIGINT or SIGTERM aborts the loop. `sellOption` checks the signal right before it sends `confirm`, so a confirm it has not sent is never sent. Waits after a send are abandoned and recorded as `unknown`. The process exits within 20 s regardless; a forced exit uses code 3.

## Setup

You need Node ≥ 22.22 (`.nvmrc`) and pnpm. The daemon runs TypeScript directly, using Node's type stripping; there is no build step.

```sh
pnpm i
```

**1. Keystore.** Import the trading key with Foundry into the gitignored `keystore/` directory:
```sh
mkdir -p keystore
cast wallet import wheel --interactive --keystore-dir keystore   # writes keystore/wheel; note the address it prints
```
Use a dedicated wallet. USDC locked in positions the wheel does not manage reduces its free capital without adding to its budget.

**2. Config.** Copy `config.example.json` to `config.json` (gitignored) and set `account.address` to the keystore's address. Keep `config.json` at mode `0600` if `rpcUrl` carries a provider key.
```sh
cp config.example.json config.json
chmod 600 config.json
```

**3. Basis anchor.** Calls need the HYPE cost basis. The example ships a **zero** anchor, which `run` refuses while `call.enabled` is true. Fill it in:
```sh
pnpm rysk basis suggest-anchor          # prints {"ts":<block time>,"qtyWhype":"<WHYPE held + WHYPE locked in open calls>"}
```
- Copy `ts` and `qtyWhype` into `basis.anchor`.
- Set `basisUsd` to the average USD price you paid per HYPE, as a decimal string.

Only `run` requires a positive `ts` and `basisUsd` while `call.enabled` is true, so an anchor whose `ts` or `basisUsd` is still 0 is refused too. The read-only commands, `suggest-anchor` included, work with the zero anchor; so does `run` with `call.enabled: false`. Record later WHYPE deposits and withdrawals in `basis.externalFlows`; otherwise `residualPolicy` handles them (see the configuration reference).

**4. Look before running.**
```sh
pnpm rysk wallet      # balances, MarginPool allowances, vault counter, nonces
pnpm rysk state       # the derived wheel state and both sides' gates
pnpm rysk run         # dry-run: records to data/, never trades
```

**5. Password (live only).**

| How the daemon runs | Where the password comes from |
|---|---|
| On a TTY | A hidden prompt on stderr. |
| Otherwise | The file named by `KEYSTORE_PASSWORD_FILE`. |

The password file is refused unless it is owner-only: `chmod 600` (or `400`). One trailing line break is dropped (editors and `echo` add one); any other whitespace counts as part of the password. A `KEYSTORE_PASSWORD` environment variable is deliberately not supported. The password is not kept after decryption.

## Commands

Run every command as `pnpm rysk <command>`, or `node src/cli/main.ts <command>`. `--config` defaults to `config.json`.

| command | what it does |
|---|---|
| `run [--live] [--max-trades N] [--config path] [--no-sampler]` | Runs the daemon loop, plus the research sampler unless `--no-sampler` is given or `sampler.enabled` is false. Live needs `--live` and `mode: "live"`. `--max-trades N` exits after N completed executions. In live, that is every execution whose confirm was sent, whatever its outcome (`filled`, `unknown`, `reverted` or `confirm-rejected`), so `--max-trades 1` never sends a second confirm; in dry-run, the dry-run stop. |
| `state [--config path]` | Prints the derived state (capital, basis, consistency, counts) and both sides' gate results from one snapshot. A fresh process always shows G3 holding. |
| `quote --side put\|call --strike 78.5 --expiry <sec> [--qty 25] [--collateral whype\|khype\|lhype\|wsthype] [--usd usdc\|usdt0] [--config path]` | Requests one quote with `account.address` as the taker, then previews its gas and checks the maker signature. Prints price, premium, gas, TTL, our gross and net APR beside Rysk's, and spot. Never trades. A put's collateral is its `--usd`. |
| `history --from <sec> --to <sec> --out <file> [--config path]` | Writes Rysk's public fills in the window to a JSONL file, overwriting it. |
| `wallet [--config path]` | Balances (native HYPE, WHYPE, USDC, USDT0), MarginPool allowances, vault counter and nonces, from one multicall. |
| `basis suggest-anchor [--config path]` | Prints a basis anchor. Warns while a WHYPE-moving position awaits settlement. |

**Exit codes:**

| code | meaning |
|---|---|
| `0` | Done. For `run`: a clean stop, `--max-trades` reached, or a signal during startup. |
| `1` | Failed: an invalid config, a startup check (lock, keystore, address, chain id, EOA), or the command itself. |
| `2` | Usage error. |
| `3` | Forced exit: a SIGINT or SIGTERM did not finish within 20 s. |

## Configuration reference

The config is validated strictly: unknown keys, wrong units and inconsistent pairs are errors that name the JSON path. These are the unit conventions:

| form | meaning |
|---|---|
| Decimal string (`"0.5"`) | A token or USD amount, converted exactly, never through floats. |
| `*Pct` | A percentage: `1` means 1 %. |
| `null` | Unbounded or off. |
| Addresses | Lowercase or EIP-55 checksummed. |

| key | type and unit | meaning |
|---|---|---|
| `mode` | `"dry-run"` \| `"live"` | Live also needs `--live`. |
| `enabled` | boolean | `false` holds both sides (G10, both modes). |
| `account.address` | address | The trading wallet. It is the strategy's RFQ taker in both modes; live refuses the zero address. |
| `account.keystorePath` | path | The Foundry keystore file, read only in live. |
| `rpcUrl` | http(s) URL | The HyperEVM JSON-RPC. Redacted from logs and records: the URL as configured and as normalized, and its path and query on their own when they hold a key-like run of 16+ characters (a `/v3/<key>` or `/<token>/` provider key; a plain `/evm` is left alone), become `<rpc>`. Only its host is logged. |
| `rysk.restUrl` | http(s) URL | The Rysk REST API (`https://v12.rysk.finance`). |
| `rysk.wsUrl` | ws(s) URL | The Rysk taker WebSocket (`wss://v12.rysk.finance/taker`). |
| `rysk.appUrl` | http(s) URL | The Rysk app, polled hourly at `/api/version/` for the frontend tripwire. |
| `tickSeconds` | integer s, ≥ 5 | The delay after one tick ends before the next starts. |
| `dataDir` | path | Holds the record streams, `STATUS.json`, `STOP` and `live.lock`. |
| `logLevel` | pino level | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `put.enabled`, `call.enabled` | boolean | Side switch (S1). |
| `*.minAprPct` | % | The APR floor on real quotes, net of the gas preview, on a 365.25-day year. A put's APR is on strike × qty; a call's on spot × qty. |
| `*.minHoursToExpiry` | hours | The minimum tenor. |
| `*.maxDaysToExpiry` | days | The maximum tenor. |
| `*.minAbsDelta`, `*.maxAbsDelta` | fraction 0–1 | The \|delta\| band of the inventory's listings. |
| `*.minOtmPct` | %, whole bps | Puts need `K ≤ S(1 − x)`; calls need `K ≥ S(1 + x)`. |
| `*.minIntervalHours` | hours | DCA spacing between deployments on a side (S2). |
| `*.trancheFraction` | fraction 0–1, whole bps | The share of the side's budget per trade, rounded down to whole 25-contract lots (see `tranche.allowSingleLot`). |
| `*.maxContractsPerTrade` | integer contracts | The per-trade cap. Contracts are HYPE units; a lot is 25. |
| `put.reserveUsdc` | USDC string (≤ 6 dp) | USDC never deployed. |
| `put.maxCapitalUsdc` | USDC string \| null | The cap on the put budget (free + locked + pending). |
| `call.reserveWhype` | WHYPE string (≤ 18 dp) | WHYPE never deployed. |
| `call.maxCapitalWhype` | WHYPE string \| null | The cap on the call budget. |
| `call.minStrikeOverBasisPct` | %, whole bps | Calls need `K ≥ basis × (1 + x)`. |
| `call.fallback.enabled` | boolean | When calls in the tenor window pass the product, moneyness and size filters but none clears the basis, sell the highest listed strike at the shortest eligible expiry (K*). This ignores the APR floor and delta band, and records `lossIfExercisedUsd`. A window with no such call holds `no-candidates` rather than falling back. A strike above the basis but outside 0.6–1.4 × spot does not count as clearing it. A K* that clears the basis is never sold as a fallback; with today's filters that only happens when K* is above 1.4 × spot, and the side holds `no-candidates`. Pair it with `maxDiscountToBasisPct`. Disabled: hold `no-candidates`. |
| `call.fallback.scope` | `"window"` \| `"all-listed"` | Whether basis eligibility looks only inside the tenor window or at every listing. `all-listed` routes a far-dated strike above the basis to the normal path. |
| `call.fallback.customStrikeFirst` | boolean | First request a custom strike, `min(basis, 1.4 S × 0.995)` rounded up to 0.5 USD (down when up would pass 1.4 S), at the fallback expiry, and take it when its net premium clears the floor. It is requested only when it is above K*. Needs custom-strike volume (see [Limitations](#limitations-and-open-questions)). |
| `call.fallback.maxDiscountToBasisPct` | % \| null | Hold `fallback-too-far-below-basis` when the fallback strike < basis × (1 − x). Recommended whenever the fallback is enabled: it is the cap on how far below the basis the fallback may sell. |
| `call.fallback.minNetPremiumUsd` | USD string | The fallback's net premium floor. The effective floor is the larger of this and `safety.minNetPremiumUsd`. |
| `tranche.allowSingleLot` | boolean | Allow one 25-lot when the tranche rounds to zero but one lot fits. Without it the wheel stalls after a 25-lot assignment. |
| `basis.anchor.ts` | unix s | When `qtyWhype` was held. Must be > 0 for `run` while calls are enabled. |
| `basis.anchor.qtyWhype` | WHYPE string | The HYPE owned at `ts`: wallet WHYPE plus WHYPE locked in open calls. |
| `basis.anchor.basisUsd` | USD per HYPE string (≤ 8 dp) | The average cost of `qtyWhype`. Must be > 0 for `run` while calls are enabled. |
| `basis.externalFlows[]` | `{ ts, qtyWhype (signed), basisUsd? }` | WHYPE added (+) or removed (−) outside Rysk after the anchor. Additions without `basisUsd` use the anchor price. |
| `basis.residualPolicy` | `"absorb"` \| `"block-calls"` | What to do when the chain balance disagrees with the ledger. `absorb` adds the excess at the anchor price, or removes the shortfall at the average. `block-calls` holds calls until the flow is recorded. |
| `basis.residualToleranceWhype` | WHYPE string | The disagreement that is ignored. |
| `quoting.quotesPerSide` | integer ≥ 1 | Candidates quoted per side per plan. |
| `quoting.rfqTimeoutMs` | ms | The strategy RFQ timeout, also used for the execution requote. |
| `quoting.replanSec` | s | Re-plan delay after an `apr-floor` hold. |
| `quoting.prefilterRatio` | ratio | Quote only listings whose indicative APR ≥ `minApr × ratio`. When that would quote nothing, the top listings are quoted anyway. |
| `quoting.strategyRfqPerMin` | integer ≥ 1 | The strategy's token bucket. |
| `quoting.samplerRfqPerMin` | integer ≥ 1 | The sampler's token bucket. The sum of both must be ≤ 18 a minute (a hard cap of 20, minus 2 for requotes). |
| `safety.maxGasFeeUsd` | USD string | The highest `/api/gas` fee accepted. |
| `safety.maxGasFeeBps` | integer bps of premium | The highest gas fee as a share of the premium. |
| `safety.minNetPremiumUsd` | USD string | The net premium floor for every trade. |
| `safety.minQuoteTtlSec` | s | The minimum quote time left (C6). Below it plus a 10 s margin, the executable quote is re-requested, so it still clears C6 after the gas call. |
| `safety.maxQuoteTtlSec` | s | Implausibly long TTLs are refused. Must be ≥ `minQuoteTtlSec`. |
| `safety.maxPremiumFractionOfCollateral` | fraction 0–1 | C7's plausibility bound on `price / strike` (put) or `price / spot` (call). |
| `safety.aprEchoTolerancePp` | percentage points, positive | How far our APR may differ from the quote's `apy` (C7): the whole tolerance for a put, the floor of a call's. |
| `safety.aprEchoToleranceRelPct` | percent of the quote's `apy` | The relative half of C7's tolerance, calls only: the larger of the two applies. A call's APR is priced at fresh spot while the maker priced `apy` moments earlier, so at a 100 % APR the 1 pp floor alone would fail on a 1 % move. Puts, whose collateral is the strike, agreed exactly in the validation run and keep the absolute tolerance; the run's calls agreed within 0.07 pp. |
| `safety.verifyMakerSig` | `"warn"` \| `"enforce"` | Whether a 65-byte maker signature that does not recover blocks the trade (C5). Under `warn` it is logged and the quote may trade, so a live run is refused unless this is `enforce`; dry-run accepts either. A signature that is not 65 bytes (an EIP-1271 contract signature) is never accepted in v1: the quote is recorded as `mismatch` whatever this says. |
| `safety.maxClockSkewMs` | ms | G5. |
| `safety.startupQuietSec` | s | Live sends nothing for this long after startup (G7). |
| `safety.settlementGraceSec` | s | G3's wait after the last pending settlement, and on every fresh start. |
| `safety.settlementOverdueHours` | hours | A position this far past expiry and still unsettled logs a warning each tick. |
| `safety.maxDeploymentsPer24h` | integer | The rolling 24 h trade count: G11 in live, C16 in both modes. |
| `safety.maxNotionalPer24hUsd` | USD string | The rolling 24 h notional: strike × qty for puts, spot × qty for calls. In live the planner skips a candidate that would reach it with its own notional (C16), and holds `daily-limit` when none is left. |
| `safety.minNativeHype` | HYPE string | The native gas reserve (G9 and C2 in live). Never auto-unwraps WHYPE. |
| `safety.maxFeePerGasGwei` | integer gwei ≥ 1 | The `maxFeePerGas` cap of the approve transaction. |
| `safety.confirmTimeoutMs` | ms | The wait for a `confirm` reply. A timeout gives an `unknown` result. |
| `safety.unknownMaxWaitSec` | integer s ≥ 1 | The longest a side waits for evidence after a `filled` or `unknown` result. Also how long a rejected confirm is watched for the fill its reply denied, which halts live (`rejected-filled`). |
| `safety.maxHypeExposurePct` | % \| null | S5: hold puts while HYPE is more than this share of HYPE plus put capital. |
| `safety.pauseOnFrontendChange` | boolean | Hold every new trade, in both modes, after the Rysk frontend `sha` changes, until restart. |
| `sampler.enabled` | boolean | The research sampler. Also turned off by `run --no-sampler`. |
| `sampler.sweepEveryMin` | minutes, 0 = off | Every listed HYPE instrument, both sides, every product leg, from the zero address. A leg whose instrument is no longer listed when its turn comes is skipped (no RFQ, no token) and counted in the sweep's `sweep-summary` record. |
| `sampler.pinned` | integer | How many pinned instruments: the ~0.10 and ~0.25 delta of the nearest expiry, both sides. |
| `sampler.pinnedEveryMin` | minutes, 0 = off | The pinned series' cadence. Instruments are kept for their lifetime. |
| `sampler.takerPairEveryMin` | minutes, 0 = off | The first pinned instrument quoted from `account.address` and from the zero address, back to back. |
| `sampler.inventoryEveryMin` | minutes, 0 = off | A full record of the HYPE listings and HYPE caps at this interval. In between they are checked every minute, and a change of the listed set or a cap limit writes a small `changed` record with only the difference. |
| `sampler.publicFillsEveryMin` | minutes, 0 = off | Rysk's public fills since the last window. |
| `sampler.requestTimeoutMs` | ms | The sampler's RFQ timeout. |
| `sampler.putStables` | token symbols | The put legs of the sweep: USD stables only (`usdc`, `usdt0`, `usdh`). |
| `sampler.callCollaterals` | token symbols | The call legs of the sweep: HYPE collaterals only (`whype`, `khype`, `lhype`, `wsthype`). |

## Running in production

Run **one live instance per wallet**. The lock refuses a second instance on the same data directory. Two hosts trading one wallet are unsupported: nothing coordinates them, and the evidence rules would not stop a double deployment.

A systemd unit:

```ini
# /etc/systemd/system/rysk-wheel.service
[Unit]
Description=Rysk wheel daemon
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=rysk
WorkingDirectory=/opt/rysk-client
Environment=KEYSTORE_PASSWORD_FILE=/etc/rysk-wheel/keystore.password
ExecStart=/usr/bin/node src/cli/main.ts run --live --config /opt/rysk-client/config.json
Restart=on-failure
RestartSec=30
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**Going live.** Before enabling the unit:
1. Run dry-run (`pnpm rysk run`) until both sides plan, quote and simulate as you expect.
2. Set `"mode": "live"` in the config.
3. On a TTY (the password is prompted), run `pnpm rysk run --live --max-trades 1` and watch it. It exits after the first execution whose confirm was sent, whatever the outcome. Check the result with `pnpm rysk state` and the `executions` records.
4. Only then `systemctl enable --now rysk-wheel`.

**Exit codes under systemd.** A clean stop exits 0, and so does `--max-trades`, so neither is restarted. `Restart=on-failure` restarts after exit 1, after exit 3 (the forced exit), and after a crash. `TimeoutStopSec=30` is longer than the daemon's own 20 s hard deadline.

**Password file.** It is owned by the service user, with mode `0600`. The daemon refuses one that the group or others can read.
```sh
sudo install -d -m 700 -o rysk -g rysk /etc/rysk-wheel
sudo install -m 600 -o rysk -g rysk /dev/null /etc/rysk-wheel/keystore.password
sudoedit /etc/rysk-wheel/keystore.password      # one line: the keystore password
```

**Logs.** Logs are pino JSON on stdout, which journald keeps:
- read them with `journalctl -u rysk-wheel -o cat | pnpm exec pino-pretty`;
- the startup line has the mode, the RPC host, the account, its balances, the derived state and the config without secrets;
- fatal events log one `fatal` line;
- `<dataDir>/STATUS.json` is rewritten every tick, and again after each execution, with the health, hold reasons, the halt flag, `lastTradeAtSec` (the end of the last completed execution), `completed` (the `--max-trades` count), the tick, the mode, and the frontend tripwire: `frontendSha` (`null` while the tripwire is inactive) and `frontendChanged`.

**RPC.** Use a provider RPC for live. The public HyperEVM RPC allows about 100 requests a minute per IP, has no WebSocket, and rejects sporadic calls. A failed read holds the tick, so a flaky RPC only delays trading, but it delays it. Keep the public RPC for dry-run and research.

**Restarts.** After every start the strategy requests no quotes for about 15 minutes (the sampler starts at once). G3's `settlementGraceSec` (900 s) and live's G7 `startupQuietSec` (600 s) both count from startup, so the longer applies. In-memory state is lost on restart: cooldowns, backoffs, used quote nonces and dry-run simulated deployments. Chain evidence and those quiet periods cover the gap. A trade the API has not yet listed holds on G2 (`api-lag`), and an unmined approve holds on G8 (`tx-pending`), provided HyperEVM's `pending` nonce reflects the mempool (unverified; see [Limitations](#limitations-and-open-questions)).

**Docker.** The lock decides staleness by checking whether the recorded pid is running. That assumes pids are not reused across restarts, but in a container the daemon is often pid 1 on every start, so a stale lock from a crash looks held. **systemd is the supported runner.** If you must use a container, remove `live.lock` in the entrypoint only when you know no other instance shares the data directory.

**Data growth.** The daemon never rotates its files; files are per UTC day, so rotate or compress old ones with your own tooling. Plan for **about 25–30 MB a day with the sampler on** at the default 60 s tick. The record sizes were measured in the [validation run](#validation); the inventory figure is computed for its difference records, which came after it:

| stream | per day | why |
|---|---|---|
| inventory | ≈ 14 MB | A full record (about 45 KB) every 5 minutes. Rysk regenerates the listed strikes as spot moves, so between them a `changed` record of well under 1 KB is written about once a minute. |
| quotes | ≈ 5 MB | About 1 KB per RFQ, about 190 RFQs an hour. |
| state and decisions | 5–10 MB | 1.4 KB a tick, plus 1–3 KB per side. |
| public fills | under 1 MB | |

Without the sampler, expect 5–10 MB a day.

## Research data streams

Every stream is append-only JSONL at `<dataDir>/<stream>/YYYY-MM-DD.jsonl` (UTC days). Each line is written with one `appendFileSync`, so a crash loses at most the line being written.

**Envelope.** Every record carries `{ v: 1, kind, tsMs, runId, mode, codeRev, configHash }`:
- `runId` is per process;
- `codeRev` is `git describe --always --dirty`: the short sha, with `-dirty` when the checkout has uncommitted changes;
- `configHash` is the first 16 hex characters of the config file's SHA-256.

**Units.** Every `*E18`, `*E8` and `*6` field is a decimal string. Every record, the loop's, `sellOption`'s and the sampler's, goes through one redacting recorder (the logger's redaction), so the RPC URL and provider keys never appear in them.

**Sharing.** Some streams are market data; others describe the wallet.
- **Shareable:** the sampler's `quotes` records (zero-address RFQs), `inventory` and `public-fills`. One exception: the taker pair's `self` leg (`takerKind: "self"`) is an RFQ from the wallet, and Rysk's public RFQ channel shows its taker, so drop those records first.
- **Identify the wallet:** `state` (balances, allowances, vault counter, positions), `decisions` (capital, basis), `executions` (its trades), the strategy's `quotes` records (`purpose` `candidate` or `fallback-custom`, whose timing matches the wallet's RFQs on the public channel), `STATUS.json` and the logs (the startup line names the address).

| stream | one record per | carries |
|---|---|---|
| `state` | tick | `tick`, `nowSec` (block time), `localNowMs`, the chain reads (block, balances, allowances, vault counter, `pendingNonceGap`), `spotE8`, `inventoryTs`, `consistency`, both sides' `capital` (free / locked / pending / total / budget), `basis` (`basisE8`, `qtyE18`, `residualE18`, `reliable`, `reason`), `lastDeployTs`, the 24 h counts, row counts by phase, `anomalies`, `warnings`, and the memo (cooldowns, halt flag, backoffs, waits) |
| `decisions` | side per tick | `gates` (every applicable gate's `{ id, pass, detail }`), `capital`, `basis`, `floor.minApr`, `plan` (hold reason or `prefilterBypassed`, with a `detail`), `candidates` (key, rank, mode, quantity, collateral, indicative APR and delta), `excluded` (each filtered listing and why), `backedOff`, the `quotes` obtained, and `result`: a trade's terms and `minPriceE18`, or a hold's reason and best quote. While a side waits for `replanDueSec`, the record is just `{ replanDueSec, result }`. |
| `quotes` | RFQ, whatever its outcome | see below |
| `executions` | `sellOption` step | `{ execId, step, detail }` for `precheck`, `approve` (`wouldApprove` in dry-run), `requote`, `gas` (the echo verbatim), `checks` (every C1–C18 result), and in live `trade-intent` (write-ahead), `confirm-sent`, `confirm-reply`, `receipt`, `premium-shortfall` (the premium received is below the expected net), `verified`, `stop`. Then the loop's `{ tick, step: "result", execId, side, intent, result, backoff }`, e.g. `result: { status: "aborted", stage: "dry-run", echoOk, wouldApprove }`; `backoff` is `{ key, untilSec, n }` when a pre-confirm abort backed the instrument off, else `null`. Later, `visible` (with `visibilityLatencySec`), `visibility-timeout`, `unknown-resolved`, `unknown-expired` and `rejected-filled` (a row matching a rejected confirm). |
| `inventory` | full: first and every `inventoryEveryMin`; diff: a listed-set or cap change in between | `trigger`, `contentHash` (of what is listed and the cap limits) and `inventoryTs`. A full record (`first` / `interval`) adds every parsed HYPE listing (strike, expiry, side, delta, `indicativeApr`, `indexUsd`, products), the HYPE-relevant caps (GLOBAL, HYPE, the sampled tokens) with usage, and `droppedCaps` (cap entries the parser dropped). A `changed` record adds only the difference from the previous record: `added` and `removed` instrument keys, `productsChanged` (keys whose products changed) and `capsChanged` (`{ name, type, capE18, previousCapE18 }`, `null` for a cap that is new or gone). |
| `public-fills` | public fill new to this run | `{ fromSec, toSec, fill }`, where `fill` is the `/api/history` row as returned |

**`quotes` records** carry:
- `purpose`: `candidate`, `fallback-custom`, `sweep`, `pinned` or `taker-pair`; strategy records also carry the loop's `tick`, sampler records the stream's `run` (1 for its first), and all of them `side` (`put` or `call`);
- `instrument`: `key` = `side|strikeE8|expirySec`, `isPut`, strike, expiry, quantity, `usd`, `collateralAsset`. Sampler records add `usdSymbol`, `collateralSymbol` and `listed`; strategy records add `candidateMode` and `rank`;
- `takerKind`: `zero` or `self`;
- `context`: `spotE8`, `inventoryTs`, `indicativeApr`, `delta`, `tenorSec`, `weekdayUtc`, `hourUtc`. Sampler records add `spotSource`: `asset` for the WHYPE asset price the loop uses, `index` for the inventory's index when no snapshot has arrived yet, or `none` (with `spotE8: null`) when neither is known;
- `requestedAtMs`, `respondedAtMs`;
- `outcome`: `quote`, `error`, `timeout`, `mismatch` or `socket-closed`, with `error` and `message`;
- `quote`: `maker`, `priceE18`, `validUntil`, `ttlSec` at arrival, `nonce`, `apy` (Rysk's percent);
- `makerSigOk`: whether the maker's EIP-712 signature recovers the maker;
- `premium6`;
- `aprGross`, our APR as a fraction;
- strategy records only: the gas preview `gas` and `aprNet` after it;
- `aprGrossOverIndicative` (all records) and `aprNetOverIndicative` (strategy records only): the APR over the listing's indicative APR. In the validation run real quotes ran 1.05–2.82 × the inventory's indicative APR (mean 1.46), which is why the floor is applied only to real quotes.

A finished sweep also writes one summary to `quotes`: `{ purpose: "sweep-summary", run, legs, sent, skippedUnlisted }`, the legs it planned, the RFQs it sent and the legs it skipped because their instrument was no longer listed. Filter it out (it has no `outcome`) when you read RFQs.

**De-duplicating `public-fills`.** Within one run, a fill is recorded once per `txHash`, compared lowercase. The windows overlap by 5 minutes, though, and a restart re-reads from startup minus 5 minutes. So de-duplicate offline by lowercase `fill.txHash` across all files.

### Analyzing the streams

Shell one-liners with `jq`, and SQL for DuckDB (`duckdb` CLI or its Python package). Run them from the repository directory.

```sh
# Bid-price time series per instrument and collateral (USD per contract), oldest first
jq -r 'select(.outcome == "quote") | [.tsMs, .purpose, .instrument.key, (.instrument.collateralSymbol // .instrument.collateralAsset), (.quote.priceE18 | tonumber / 1e18)] | @tsv' data/quotes/*.jsonl

# USDC vs USDT0 put legs of the same sweep: gross APR side by side
jq -s 'map(select(.purpose == "sweep" and .instrument.isPut and .outcome == "quote"))
  | group_by([.runId, .run, .instrument.key])
  | map({key: .[0].instrument.key, apr: (map({(.instrument.usdSymbol): .aprGross}) | add)})' data/quotes/*.jsonl

# WHYPE / kHYPE / LHYPE / wstHYPE call legs of the same sweep
jq -s 'map(select(.purpose == "sweep" and (.instrument.isPut | not) and .outcome == "quote"))
  | group_by([.runId, .run, .instrument.key])
  | map({key: .[0].instrument.key, price: (map({(.instrument.collateralSymbol): (.quote.priceE18 | tonumber / 1e18)}) | add)})' data/quotes/*.jsonl

# Taker self vs zero: the two legs of each taker pair
jq -s 'map(select(.purpose == "taker-pair" and .outcome == "quote"))
  | group_by([.runId, .run])
  | map({key: .[0].instrument.key, price: (map({(.takerKind): .quote.priceE18}) | add)})' data/quotes/*.jsonl

# Real over indicative APR, per purpose
jq -s 'map(select(.aprGrossOverIndicative != null)) | group_by(.purpose)
  | map({purpose: .[0].purpose, n: length, mean: (map(.aprGrossOverIndicative) | add / length)})' data/quotes/*.jsonl

# Why each side held, by reason
jq -r '"\(.side) \(.result.reason // .result.kind)"' data/decisions/*.jsonl | sort | uniq -c

# Public fills, de-duplicated by txHash across files
jq -s 'unique_by(.fill.txHash | ascii_downcase) | length' data/public-fills/*.jsonl
```

```sql
-- duckdb: bid price per instrument and collateral, one row per answered RFQ
SELECT to_timestamp(tsMs / 1000) AS t, purpose, instrument.key AS instrument,
       coalesce(instrument.collateralSymbol, instrument.collateralAsset) AS collateral,
       CAST(quote.priceE18 AS DOUBLE) / 1e18 AS price, aprGross, aprGrossOverIndicative
FROM read_json_auto('data/quotes/*.jsonl', union_by_name = true)
WHERE outcome = 'quote'
ORDER BY instrument, collateral, t;

-- duckdb: USDC vs USDT0 put legs of each sweep
SELECT instrument.key AS instrument, run, runId,
       max(aprGross) FILTER (WHERE instrument.usdSymbol = 'USDC')  AS apr_usdc,
       max(aprGross) FILTER (WHERE instrument.usdSymbol = 'USDT0') AS apr_usdt0
FROM read_json_auto('data/quotes/*.jsonl', union_by_name = true)
WHERE purpose = 'sweep' AND instrument.isPut AND outcome = 'quote'
GROUP BY ALL ORDER BY instrument;

-- duckdb: public fills de-duplicated by txHash
SELECT count(DISTINCT lower(fill.txHash)) AS fills
FROM read_json_auto('data/public-fills/*.jsonl', union_by_name = true);
```

Settlement history and daily P&L are not streamed; derive them offline from `GET /api/user/positions?address=` (see the protocol reference, §11).

## Validation

Validated on 2026-10-16 against mainnet from a sandbox, read-only: nothing was signed, confirmed or sent on chain.

**Setup.** `rysk run --max-trades 1` in dry-run with:
- the sampler on;
- `tickSeconds: 20` and `minAprPct: 40`;
- a wallet that holds USDC, WHYPE and existing positions, so both sides had capital.

The run stopped by itself (exit 0) after 15 minutes, at its first dry-run execution.

**Streams written.**
- **Ticks:** 44 `state` records and 88 `decisions`, one per side per tick, each with its gate results.
  - For the first 900 s, both sides held on G3 (`settlement-pending`).
  - The put side then held on S2 (`interval`): the wallet had sold a put within `minIntervalHours`.
  - The call side planned 3 candidates.
- **Candidate quotes:** all 3 were answered and maker-signed, with a gas preview of 0. Their APRs were 121 %, 86 % and 78 % (gross = net). Real over indicative APR (`aprGrossOverIndicative`) was 1.54, 1.36 and 2.00. The best, a 6.5-day call 1.6 % OTM, cleared the 40 % floor.
- **One dry-run execution:**
  - PRECHECK passed, and `wouldApprove` was 25 WHYPE.
  - No requote was needed (57 s of TTL left).
  - The full-body `/api/gas` echo matched: 18 sent fields plus the 12 known extra keys, `gasFee "0"`.
  - C1–C18 all passed, with C1 and C13 `n/a`.
  - The result was `aborted('dry-run')` with `echoOk: true`.
- **RFQs:** 100 in total (3 candidate, 86 sweep, 9 pinned, 2 taker pair).
  - 63 were answered by 5 makers, and every maker signature recovered.
  - TTL at arrival was 35–90 s, nearly constant per maker. Response time was 2.1–3.7 s (mean 2.4 s).
  - The taker pair (self vs zero) was priced within 0.000003 USD a contract (one sample).
  - 37 zero-address RFQs were refused with the custom-strike volume error: their strikes had been de-listed by the time the paced sweep reached them (see [Limitations](#limitations-and-open-questions)). The sweep now skips such legs.
- **Inventory:** 15 records in 15 minutes, 14 of them for a changed listed set, about 45 KB each.
- **Status and secrets:** `STATUS.json` was rewritten every tick, and no `STOP` was written. The RPC URL appears in no record; the log has only its host.

`pnpm test:live` passed: 3 tests, including one zero-address quote and its gas preview.

## Limitations and open questions

**Not built (v1).**
- Trading USDT0 or USDH products, or liquid-staking collateral (kHYPE, wstHYPE, LHYPE). The sampler records their quotes; the strategy trades only USDC puts and WHYPE calls.
- Positions in other stables still count. A WHYPE call or put settled in USDT0 still moves WHYPE, so it counts for the basis ledger and locked capital, but such rows are never traded.
- Wrapping native HYPE, early close, other underlyings, alerts, a database, multi-wallet, multi-host and testnet.

**Known limitations.**
- **HyperEVM's `pending` nonce tag is unverified.** G8's `tx-pending` gate compares the `pending` and `latest` nonces. If HyperEVM's `pending` does not reflect mempool transactions, that gate never fires; the exact-allowance rule still makes a repeated approve harmless.
- **The fee bump for a stuck approve is not implemented.** The design specifies one replacement after 5 minutes at +30 % fees. Today an unmined approve aborts the trade as `approve`/`stuck`, and the `tx-pending` gate holds while it is pending.
- **Custom strikes need trading volume.** The RFQ server treats a strike that is not in the current inventory for that expiry as custom. It refuses it (JSON-RPC error `-32603`) unless the taker wallet has at least 250 000 USD of notional trading volume: `custom strikes require >= 250000 notional volume (have 0)`. A strike refused while unlisted was quoted 17 minutes later, once the inventory listed it again. A few strikes were still quoted after they left the inventory, presumably within the server's refresh lag. A taker with enough volume was quoted an unlisted strike. In practice:
  - For a fresh wallet, `call.fallback.customStrikeFirst` costs one refused RFQ each time the custom strike's backoff lapses (5 minutes, doubling up to an hour); the listed fallback strike is still quoted.
  - The zero-address sampler's pinned series can lose its quotes once its strikes are de-listed.
  - A full sweep takes about 25 minutes at 6 RFQ a minute, while the listed strikes change about every minute. In the validation run 37 of 100 RFQs hit strikes that were no longer listed. The sweep now skips a leg whose instrument is not listed when its turn comes and counts it in `skippedUnlisted`, so a sweep covers fewer legs than it planned.
- **A fresh process waits about 15 minutes** (`settlementGraceSec`) before its first strategy RFQ. Live also needs `startupQuietSec`, which runs at the same time. The sampler starts at once.
- **`fallback.scope: "all-listed"` lengthens the call-side tenor check.** C11's maximum tenor becomes `max(366 d, maxDaysToExpiry)`, so a far-dated listing above the basis can execute. Puts keep their window.
- **The execution requote is outside the RFQ buckets.** Waiting for a token would spend the quote's TTL. The config keeps `strategyRfqPerMin + samplerRfqPerMin ≤ 18` under the hard cap of 20; there is at most one requote per execution.
- **`*EveryMin: 0` turns a sampler stream off.** `*RfqPerMin` must be positive.
- **The lock takeover can race.** When two instances start at the same moment against a stale lock, the second one's removal of the stale file can delete the first one's fresh lock, and both then run. Start one instance per wallet, under one supervisor.
- **Docker reuses pids.** See [Running in production](#running-in-production).
- **The inventory stream is still the largest:** a full record is about 45 KB, every `inventoryEveryMin` (see Data growth). Compacting each listing's repeated product addresses would shrink it.

**Open questions for the first supervised live trade** (spec §12).
1. Whether `confirm` accepts our body plus the allowlisted echo extras. The app sends the echo spread instead.
2. What `validUntil` means beside `quoteValidUntil`, and whether the relayer enforces it.
3. Several smaller unknowns:
   - whether concurrent RFQs on one socket are allowed or last-wins;
   - whether makers price `taker = self` differently from zero (the taker-pair stream measures this);
   - whether the server checks `nonce` recency;
   - what caps `usage` counts;
   - how long settlement lags;
   - what else the Gamma controller `0x577b…` does: in the verified fill it minted the short (`ShortOtokenMinted`), which receipt verification now pins to it, while the vault store emitted `VaultOpened`.

## Development

```sh
pnpm check        # typecheck, lint (biome), unit tests, secrets check: run before every commit
pnpm test         # unit tests only
pnpm test:live    # RYSK_LIVE_TESTS=1: also runs src/rysk/live.test.ts against production Rysk (read-only; never confirms)
```

The live smoke tests run only with `RYSK_LIVE_TESTS=1`. They parse `assets`, `inventory` and `caps` with nothing dropped. They re-read the inventory and request one zero-address quote for the nearest ~0.25-delta put, accepting a maker-signed quote with a TTL under an hour, or a timeout; the test is skipped when the server refuses the strike as a custom strike (it was de-listed in between). They then preview its gas.

**Public repository.**
- `.gitignore` covers `keystore/`, `config.json` and `config.*.json` (except `config.example.json`), `data/`, `*.password`, `*.key`, `*.pem`, `.env` and `.env.*`.
- `pnpm check:secrets` fails on any tracked keystore ciphertext or 32-byte hex literal (with or without `0x`) outside `test/fixtures/`, and on any file it cannot read.
- Fixtures are derived from the public on-chain activity of a third-party seller; its address, transaction hashes and block hash are replaced; amounts and timestamps are real market data.
- Never commit wallet addresses, keys, tx hashes or RPC keys.
