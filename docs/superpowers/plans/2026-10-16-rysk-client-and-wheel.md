# Rysk Client and Bidirectional Wheel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript client for Rysk V12 on HyperEVM plus a bidirectional HYPE/USDC wheel daemon that
sells cash-secured puts and covered calls against a minimum APR, with a dry-run mode that doubles as a
quote recorder.

**Architecture:** Single package, layered `domain → chain/rysk → execution → strategy → daemon → cli`, with
a pure decision core (`domain`, `strategy`) and an imperative shell. All strategy state is derived each tick
from the positions API, one batched chain read and config; nothing is persisted except append-only JSONL
research logs. One guarded code path signs.

**Tech Stack:** Node ≥ 22.22 running `.ts` natively (no build step), pnpm, TypeScript strict ESM, viem, zod,
pino, `read`; vitest, biome, `ws` (tests only).

**Spec:** `docs/superpowers/specs/2026-10-16-rysk-client-and-wheel-design.md` (read it first; Appendix A has
the shared types, Appendix B the config). Protocol facts: `docs/rysk-protocol.md`.

## Global Constraints

- Node `>=22.22`; `"type": "module"`; tsconfig `module`/`moduleResolution: NodeNext`, `verbatimModuleSyntax`,
  `erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`, `strict`, `noUncheckedIndexedAccess`.
  Relative imports carry `.ts`. No enums, namespaces or parameter properties (Node strip-only mode rejects them).
- On-wire integers are `bigint` with the unit suffix in the name (`strikeE8`, `quantityE18`, `priceE18`,
  `amount6`); timestamps carry `Sec`/`Ms`; APRs are fractions. Decimal strings never pass through floats.
- Pinned constants (lowercase strings compared with `isAddressEqual`): chain id `999`; Rysk
  `0x8C8bcb6D2c0E31c5789253EcC8431cA6209B4E35`; MarginPool `0x24a44f1dc25540c62c1196FfC297dFC951C91aB4`;
  MMarket `0x691a5fc3a81a144e36c6C4fBCa1fC82843c80d0d`; vault store `0x84d84e481b49b8bc5a55f17aaf8181c21a29b212`;
  WHYPE `0x5555555555555555555555555555555555555555`; USDC `0xb88339CB7199b77E23DB6E890353E22632Ba630f`;
  USDT0 `0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb`; USDH `0x111111a1a0667d36bd57c0a9f569b98057111111`;
  kHYPE `0xfD739d4e423301CE9385c1fb8850539D657C296D`; wstHYPE `0x94e8396e0869c9f2200760af0621afd240e1cf38`;
  LHYPE `0x5748ae796ae46a4f1348a1693de4b50560485562`. EIP-712 domain `{ name: 'rysk', version: '0.0.0',
  chainId: 999, verifyingContract: Rysk }`.
- `domain/` and `strategy/` import only from `domain/`, `strategy/`, `src/lib/`, and `viem`; never `node:`.
- Public repo: `.gitignore` covers `keystore/`, `config.json`, `data/`, `*.password`, `node_modules/` before
  anything else is committed; no raw private keys, no third-party API keys, no real wallet addresses or tx
  hashes outside `test/fixtures/`; `pnpm check:secrets` must pass before every commit.
- Commits: author only, no co-author or model trailers (CLAUDE.md). Messages ≤ 15 words. Branch `staging`.
- Tests are colocated `*.test.ts`; fixtures in `test/fixtures/`; run with `pnpm test`.

## Review Focus

1. A gas echo that contains an unknown extra key or a changed value for a known extra (`isPremium: true`)
   must abort before signing; Task 13 and Task 14 test both.
2. A `confirm` reply whose result is not a 32-byte hash must yield `unknown`, never a retryable rejection;
   Task 11 and Task 15 test it.
3. A positions row with an unparseable field on a `foreign` (non-WHYPE) position must warn, not hold the
   strategy forever; Task 5 tests it.
4. A quote with `validUntil` in milliseconds must be rejected as `mismatch`; Task 11 tests it.
5. A stale allowance larger than the needed collateral must trigger a fresh exact approve, not a skip;
   Task 7 tests it.

---

## Milestone 1: scaffold and domain

### Task 1: Scaffold, toolchain, secrets check, lib

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `.nvmrc`, `.gitignore`,
  `scripts/check-secrets.mjs`, `src/lib/json.ts`, `src/lib/json.test.ts`, `src/lib/time.ts`,
  `test/architecture.test.ts`
- Create fixtures (copy from `/tmp/claude-0/-home-user-rysk-client/1f712338-0699-5a5a-9d72-3af5671a84c0/scratchpad/fixtures/`):
  `test/fixtures/positions.json`, `receipt.json`, `inventory.json`, `assets.json`, `caps.json`,
  `history.json`, `spike-capture.json`, `keystore-anvil0.json`

**Interfaces:**
- Produces: `stringifyBig(value: unknown, space?: number): string` (bigint → decimal string);
  `sleep(ms: number, signal?: AbortSignal): Promise<void>`; `type Clock = { nowMs(): number }`;
  `systemClock: Clock`.

- [ ] **Step 1: Write `.gitignore` first** with `node_modules/`, `dist/`, `keystore/`, `config.json`, `data/`,
  `*.password`, `.env`, `coverage/`. Commit it alone: `git commit -m "Ignore keystore, config, data and build output"`.
- [ ] **Step 2: `pnpm init`, set `"type": "module"`, `"engines": { "node": ">=22.22" }`, `.nvmrc` = `22.22`;
  scripts: `rysk: node src/cli/main.ts`, `typecheck: tsc --noEmit`, `lint: biome check .`,
  `format: biome format --write .`, `test: vitest run`, `test:live: RYSK_LIVE_TESTS=1 vitest run`,
  `check:secrets: node scripts/check-secrets.mjs`, `check: pnpm typecheck && pnpm lint && pnpm test && pnpm check:secrets`.
  Add deps `viem zod pino read@4` and dev deps `typescript vitest @biomejs/biome ws @types/ws @types/node pino-pretty`.**
- [ ] **Step 3: Write `tsconfig.json`** with the Global Constraints flags, `target: ES2022`, `lib: [ES2023]`,
  `types: [node]`, `include: [src, test, scripts]`. Write `biome.json` (recommended rules, 2-space indent,
  single quotes, line width 110) and `vitest.config.ts` (`include: ['src/**/*.test.ts', 'test/**/*.test.ts']`).
- [ ] **Step 4: Write the failing test `src/lib/json.test.ts`**:
  `stringifyBig({ a: 25n * 10n ** 18n, b: [1n], c: 'x' })` equals `'{"a":"25000000000000000000","b":["1"],"c":"x"}'`.
- [ ] **Step 5: Run `pnpm vitest run src/lib/json.test.ts`** — expected FAIL (module not found).
- [ ] **Step 6: Implement `src/lib/json.ts` and `src/lib/time.ts`** per Interfaces.
- [ ] **Step 7: Write `scripts/check-secrets.mjs`**: for every `git ls-files` path not under `test/fixtures/`,
  fail (exit 1, print path and line) if a line contains `"ciphertext"` or matches `/0x[0-9a-fA-F]{64}/`.
  Print `secrets check ok` otherwise.
- [ ] **Step 8: Write `test/architecture.test.ts`**: glob `src/domain/**/*.ts` and `src/strategy/**/*.ts`
  (excluding `*.test.ts`), extract `from '...'` specifiers, assert each is relative and resolves inside
  `src/domain`, `src/strategy` or `src/lib`, or equals `viem` / starts with `viem/`; assert none starts with `node:`.
  It passes trivially now (no files) and guards later tasks.
- [ ] **Step 9: Copy the eight fixtures into `test/fixtures/`.** Run `pnpm check:secrets` — expected `secrets check ok`.
- [ ] **Step 10: Run `pnpm check`** — expected all green (no source yet).
- [ ] **Step 11: Commit** `git commit -m "Scaffold toolchain, fixtures, secrets check and lib helpers"`.

### Task 2: Domain constants and types

**Files:**
- Create: `src/domain/constants.ts`, `src/domain/types.ts`, `src/domain/constants.test.ts`, `src/domain/index.ts`

**Interfaces:**
- Produces: `CHAIN_ID = 999 as const`; `ADDRESSES: { rysk; marginPool; mmarket; vaultStore; multicall3 }` (all
  `Address`, checksummed via `getAddress`); `TOKENS: Record<'USDC'|'USDT0'|'USDH'|'WHYPE'|'KHYPE'|'WSTHYPE'|'LHYPE',
  { address: Address; symbol: string; decimals: number }>`; `TRADED_PRODUCTS: { put: Product; call: Product }`;
  `SAMPLED_PUT_STABLES: Address[]` (USDC, USDT0); `SAMPLED_CALL_COLLATERALS: Address[]` (WHYPE, kHYPE, LHYPE, wstHYPE);
  `ZERO_ADDRESS`; `DEFAULT_STRIKE_PRECISION_E8 = 1_000_000n`; `tokenBySymbol(symbol: string): TokenInfo`;
  `tokenByAddress(address: Address): TokenInfo | undefined`; every type in spec Appendix A `domain/types.ts`
  block, verbatim, plus `GasPreviewBody` (the 9 preview fields) and `ConfirmParams = ConfirmBody & { gasFee: string;
  isEIP1271: false; signature: Hex } & Record<string, unknown>`.

- [ ] **Step 1: Write failing `constants.test.ts`**: `ADDRESSES.rysk` equals `getAddress('0x8c8bcb6d2c0e31c5789253ecc8431ca6209b4e35')`;
  `TOKENS.USDC.decimals === 6`, `TOKENS.WHYPE.decimals === 18`; `TRADED_PRODUCTS.put` is
  `{ underlying: WHYPE, strikeAsset: USDC, collateralAsset: USDC, isPut: true }`; `tokenByAddress('0xb88339cb7199b77e23db6e890353e22632ba630f')?.symbol === 'USDC'` (lowercase input).
- [ ] **Step 2: Run it** — FAIL. **Step 3: Implement.** **Step 4: Run `pnpm test` and `pnpm typecheck`** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Add domain constants and shared types"`.

### Task 3: Units and APR math

**Files:**
- Create: `src/domain/units.ts`, `src/domain/units.test.ts`, `src/domain/apr.ts`, `src/domain/apr.test.ts`

**Interfaces:**
- Produces (`units.ts`): `strikeE8FromKey(key: string): { strikeE8: bigint; expirySec: number }`;
  `strikeE8FromNumber(strike: number): bigint` (via `strike.toFixed(8)` string, never float multiply);
  `strikeE8ToE18`, `strikeE18ToE8` (throws `UnitError` unless divisible by 1e10); `formatStrike(strikeE8): string`
  (`"78.5"`); `floorToIncrement(qE18, stepE18): bigint`; `collateralForCall(qE18, decimals): bigint`;
  `collateralForPut(qE18, strikeE8): bigint`; `putQuantityFromUsd(usd6, strikeE8): bigint`;
  `premium6(qE18, priceE18): bigint`; `usd6FromDecimal(s: string): bigint`; `e18FromDecimal(s: string): bigint`;
  `fractionFromPct(n: number): number`.
- Produces (`apr.ts`): `SECONDS_PER_YEAR = 31_557_600n`; `collateral6For(side: Side, qE18, strikeE8, spotE8): bigint`;
  `aprFraction(net6: bigint, collateral6: bigint, nowSec: number, expirySec: number): number`;
  `minPriceE18ForApr(aprFloor: number, collateral6, qE18, nowSec, expirySec, gasFee6): bigint`;
  `aprFractionFromRyskApy(apy: number): number` (`apy / 100`).

- [ ] **Step 1: Write failing `units.test.ts`** asserting: `strikeE8FromKey('86.500000-1793952000')` →
  `{ strikeE8: 8650000000n, expirySec: 1793952000 }`; `strikeE8FromKey('0.004600-1792742400').strikeE8 === 460000n`;
  `strikeE8FromNumber(78.5) === 7850000000n`; `strikeE18ToE8(78500000000000000000n) === 7850000000n` and
  `strikeE18ToE8(1n)` throws; `floorToIncrement(10n*10n**18n, 25n*10n**18n) === 0n`;
  `floorToIncrement(60n*10n**18n, 25n*10n**18n) === 50n*10n**18n`; `collateralForPut(25n*10n**18n, 7850000000n) === 1962500000n`;
  `collateralForCall(25n*10n**18n, 18) === 25n*10n**18n`; `collateralForCall(5n*10n**16n, 8) === 5000000n`;
  `premium6(25n*10n**18n, 1899452000000000000n) === 47486300n`; `premium6(25n*10n**18n, 1109494507915005812n) === 27737362n`;
  `putQuantityFromUsd(1962500000n, 7850000000n) === 25n*10n**18n`; `usd6FromDecimal('20000') === 20000000000n`;
  `e18FromDecimal('0.05') === 5n*10n**16n`; `formatStrike(7850000000n) === '78.5'`.
- [ ] **Step 2: Write failing `apr.test.ts`**: `aprFraction(47486300n, 1962500000n, 1792131925, 1793347200)`
  `toBeCloseTo(0.6283, 4)` (the real fill, 62.83 %); `aprFraction(27737362n, 1950000000n, 1792146507, 1792742400)`
  within `0.0005` of `0.753299` (spike put vs `quote.apy` 75.33); `collateral6For('put', 25e18, 7850000000n, 8148032044n) === 1962500000n`
  and `collateral6For('call', 25e18, 7850000000n, 8148032044n) === 2037008011n`; property:
  `p = minPriceE18ForApr(0.4, 1950000000n, 25e18, 1792146507, 1792742400, 0n)` satisfies
  `aprFraction(premium6(25e18, p), …) >= 0.4` and `aprFraction(premium6(25e18, p - 10n**15n), …) < 0.4`.
- [ ] **Step 3: Run both** — FAIL. **Step 4: Implement** (use viem `parseUnits`/`formatUnits` for decimal strings;
  `aprFraction` computes in bigint scaled by 1e9 then divides to `number`; `minPriceE18ForApr` rounds the
  needed premium **up**). **Step 5: Run** — PASS.
- [ ] **Step 6: Commit** `git commit -m "Add unit conversions and APR math"`.

### Task 4: Inventory, assets and caps parsing

**Files:**
- Create: `src/domain/inventory.ts`, `src/domain/inventory.test.ts`, `src/domain/caps.ts`, `src/domain/caps.test.ts`

**Interfaces:**
- Produces: `parseAssets(json: unknown, chainId = 999): { assets: Asset[]; dropped: number }`;
  `hypeAsset(assets: Asset[]): Asset` (the WHYPE entry; throws if absent); `parseInventory(json: unknown, opts:
  { underlyingSymbol: 'HYPE'; underlying: Address; observedAtSec: number }): { listings: Listing[]; dropped: number }`
  where `Listing.indicativeApr = apy / 100`, `strikeE8` from the key, each product `{ underlying, strikeAsset,
  collateralAsset: entry.collateralAsset, isPut }`; `parseCaps(json: unknown): { caps: Cap[]; dropped: number }`
  (entries with `type` other than CONTRACTS/NOTIONAL dropped; `GLOBAL` rows keep their own type);
  `remainingCapacityE18(caps: Cap[], target: { underlyingSymbol: string; asset: Address; isPut: boolean },
  notionalPriceE8: bigint): bigint | null` (null = no applicable cap; `cap == 0` entries skipped; NOTIONAL
  headroom converted to contracts as `(cap − usage) × 10^8 / notionalPriceE8`).

- [ ] **Step 1: Write failing `inventory.test.ts`** on the fixtures: `parseAssets` returns a WHYPE asset with
  `minTradeSizeE18 === 25n*10n**18n`, `maxTradeSizeE18 === 5000n*10n**18n`, `decimals 18`, `active true`,
  `strikePrecisionE8 === 1_000_000n` (default when absent); `parseInventory(inventory, …)` yields 48 listings;
  the listing with key `105.000000-1795766400` has `strikeE8 10500000000n`, `isPut false`, `expirySec 1795766400`,
  and products with collateral WHYPE and kHYPE both having `strikeAsset` USDC; a listing for a put has a product
  with `collateralAsset` USDC and one with USDT0; a malformed combination (`strike: 'x'`) injected into a copy is
  dropped with `dropped === 1` and the rest parse.
- [ ] **Step 2: Write failing `caps.test.ts`**: `parseCaps(caps)` gives 107 entries; `remainingCapacityE18(caps,
  { underlyingSymbol: 'HYPE', asset: WHYPE, isPut: false }, 8148032044n)` is `> 32480n*10n**18n` and `< 32481n*10n**18n`
  (binding NOTIONAL cap); for `isPut: true` with price `7850000000n` it is `> 12738n*10n**18n` and `< 12739n*10n**18n`;
  with all matching entries set to `cap: '0'` it returns `null`.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run `pnpm test`** — PASS.
- [ ] **Step 6: Commit** `git commit -m "Parse inventory, assets and caps with capacity math"`.

### Task 5: Positions parsing and settlement classification

**Files:**
- Create: `src/domain/positions.ts`, `src/domain/positions.test.ts`

**Interfaces:**
- Produces: `class PositionParseError extends Error`; `parsePositions(json: unknown, opts: { underlying: Address;
  chainId: 999 }): { positions: Position[]; otherRows: { chainId: number; key: string }[]; warnings: string[] }`.
  Rows with `chainId === 999 && address == underlying` are parsed strictly (throw `PositionParseError` on any
  invalid field); all other rows are parsed only for `chainId` and `key` (invalid → warning).
  `Position.status`: `''` → `'open'`, `'SETTLED'` → `'settled'`, else `'unknown'`; `isBuy !== true` → `'unknown'`.
  `Position.settlement` per spec §6.5; `premium6 = BigInt(premium) / 10n**12n` (throws if not exact);
  `strikeE8 = strikeE18ToE8(BigInt(strike))`; `key = `${txHash}|${isPut}|${strikeE8}|${expirySec}|${collateral}|${quantityE18}``.

- [ ] **Step 1: Write failing `positions.test.ts`** on `positions.json` with `underlying: WHYPE`: `positions.length === 77`,
  `otherRows.length === 10`, `warnings.length === 0`; counts: `status 'open'` 3, `'settled'` 74;
  settlements: `assigned` 7, `exercised` 8, `expiredOtm` 59, `anomaly` 0; the open put has `strikeE8 7850000000n`,
  `quantityE18 25n*10n**18n`, `premium6 47486300n`; an exercised call with `strikeE8 9050000000n` has
  `settlement.receivedStable6 === 4525000000n`; an assigned put with `strikeE8 8000000000n` has
  `receivedUnderlyingE18 === 50n*10n**18n`; an OTM put with `strikeE8 8100000000n` has `collateralReturned === 2025000000n`;
  mutated copies: `status: 'WEIRD'` → `status 'unknown'` (no throw); WHYPE row with `quantity: 'abc'` →
  throws `PositionParseError`; a `foreign` row with `quantity: 'abc'` → no throw, `warnings.length === 1`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; run `pnpm vitest run test/architecture.test.ts` — PASS.
- [ ] **Step 5: Commit** `git commit -m "Parse positions and classify settlement outcomes"`.

## Milestone 2: chain layer and REST

### Task 6: Foundry keystore decryption

**Files:**
- Create: `src/chain/keystore.ts`, `src/chain/keystore.test.ts`

**Interfaces:**
- Produces: `class KeystoreError extends Error`; `decryptKeystore(json: string, password: string): Hex`;
  `loadAccount(path: string, password: string): PrivateKeyAccount` (reads file, decrypts, `privateKeyToAccount`);
  `resolvePassword(opts: { isTTY: boolean; env: NodeJS.ProcessEnv; prompt: (msg: string) => Promise<string>;
  readFile: (p: string) => string; fileMode: (p: string) => number }): Promise<string>` implementing spec §5.1
  (TTY prompt → `KEYSTORE_PASSWORD_FILE` refused if mode & 0o077 → `KeystoreError`).

- [ ] **Step 1: Write failing `keystore.test.ts`**: `decryptKeystore(fixture, 'hunter2')` →
  `privateKeyToAccount(pk).address === '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'`; wrong password throws
  `KeystoreError` matching `/mac/i`; `resolvePassword` with `isTTY: true` returns the prompt's value; with
  `isTTY: false` and a file of mode `0o644` throws; with mode `0o600` returns the file content trimmed;
  with neither throws.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** with `node:crypto` `scryptSync(password, salt, dklen, { N, r, p, maxmem: 512 * 1024 * 1024 })`,
  MAC `keccak256(concat(dk[16..32], ciphertext))`, `createDecipheriv('aes-128-ctr', dk[0..16], iv)`; accept hex
  with or without `0x`. **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Decrypt Foundry keystores without extra dependencies"`.

### Task 7: Chain clients, batched snapshot, exact approve

**Files:**
- Create: `src/chain/clients.ts`, `src/chain/snapshot.ts`, `src/chain/snapshot.test.ts`, `src/chain/erc20.ts`,
  `src/chain/erc20.test.ts`, `src/chain/abi.ts`

**Interfaces:**
- Produces: `createChainClients({ rpcUrl, account? }): { publicClient; walletClient? }` on viem `hyperEvm` with
  `http(rpcUrl)`; `assertChainId(publicClient, expected = 999): Promise<void>`;
  `type ChainSnapshot = { blockNumber: bigint; blockTs: number; nativeHypeE18; whypeE18; usdc6; usdt06;
  allowanceUsdc6; allowanceWhypeE18; vaultCounter; pendingNonce: number; latestNonce: number }` (bigints unless noted);
  `type ChainReader = { multicall; getBlock; getTransactionCount }` (the viem subset used);
  `readChainSnapshot(client: ChainReader, self: Address): Promise<ChainSnapshot>` — one `multicall` with
  `allowFailure: false` over `[WHYPE.balanceOf(self), USDC.balanceOf(self), USDT0.balanceOf(self),
  USDC.allowance(self, MarginPool), WHYPE.allowance(self, MarginPool), vaultStore.getAccountVaultCounter(self),
  multicall3.getEthBalance(self)]`, plus `getBlock()` and two `getTransactionCount` calls; any failure rethrows;
  `type ApproveDeps = { allowance(token, owner, spender): Promise<bigint>; approve(token, spender, amount): Promise<Hex>;
  waitForReceipt(hash, timeoutMs): Promise<TransactionReceipt | null>; nonces(owner): Promise<{ pending: number; latest: number }> }`;
  `approveExact(deps: ApproveDeps, args: { token; owner; spender; amount; waitMs: 60_000 }): Promise<
  { status: 'skipped' } | { status: 'approved'; hash: Hex } | { status: 'tx-pending' } | { status: 'stuck'; hash: Hex }>`;
  `abi.ts`: `erc20Abi` (viem's), `vaultStoreAbi` (`getAccountVaultCounter(address) view returns (uint256)`),
  `multicall3GetEthBalanceAbi`, and event ABIs for Task 8 (`Transfer`, `VaultOpened(address indexed accountOwner,
  uint256 vaultId, uint256 indexed vaultType)`, `ShortOtokenMinted(address indexed otoken, address indexed AccountOwner,
  address indexed to, uint256 vaultId, uint256 amount)`).

- [ ] **Step 1: Write failing `snapshot.test.ts`** with a fake `ChainReader` whose `multicall` returns
  `[100n*10n**18n, 5000_000000n, 0n, 0n, 0n, 87n, 2n*10n**18n]`, `getBlock` → `{ number: 1000n, timestamp: 1792144000n }`,
  `getTransactionCount` → 12 for both: result fields equal those values, `vaultCounter === 87n`, `blockTs === 1792144000`;
  a rejecting `multicall` makes `readChainSnapshot` reject.
- [ ] **Step 2: Write failing `erc20.test.ts`** for `approveExact`: allowance `== amount` → `skipped` and `approve` not called;
  allowance `> amount` (stale) → `approve` called with exactly `amount` → `approved`; allowance `< amount` → `approved`;
  `nonces` pending ≠ latest → `tx-pending` and no approve; `waitForReceipt` resolving `null` → `stuck` with the hash.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement** (`approveExact` also re-reads the allowance after the receipt and
  returns `stuck` if it still differs). **Step 5: Run** — PASS.
- [ ] **Step 6: Commit** `git commit -m "Add chain clients, batched snapshot and exact approve"`.

### Task 8: Fill receipt verification

**Files:**
- Create: `src/chain/receipts.ts`, `src/chain/receipts.test.ts`

**Interfaces:**
- Produces: `type FillExpectation = { self: Address; collateralToken: Address; collateralAmount: bigint;
  premium6: bigint; gasFee6: bigint; counterBefore: bigint; quantityE18: bigint }`;
  `verifyFillReceipt(receipt: TransactionReceipt, expected: FillExpectation): { ok: true; vaultId: bigint;
  premiumReceived6: bigint } | { ok: false; problems: string[] }` with problem codes `'reverted' | 'wrong-to' |
  'collateral-transfer' | 'premium-transfer' | 'vault-opened' | 'short-minted' | 'extra-transfer-from-self'`.
  Event topics are computed with viem `decodeEventLog` from `abi.ts` (no 64-hex constants in source).

- [ ] **Step 1: Write failing `receipts.test.ts`** on `receipt.json` (seller is `0x000000000000000000000000000000000000beef`):
  with `{ self: beef, collateralToken: USDC, collateralAmount: 1962500000n, premium6: 47486300n, gasFee6: 0n,
  counterBefore: 86n, quantityE18: 25n*10n**18n }` → `ok: true`, `vaultId === 87n`, `premiumReceived6 === 47486300n`;
  `collateralAmount: 1962500001n` → `problems` includes `'collateral-transfer'`; `counterBefore: 80n` → `'vault-opened'`;
  `status: 'reverted'` copy → `['reverted']`; `quantityE18: 50n*10n**18n` → `'short-minted'`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `pnpm check:secrets` — ok.
- [ ] **Step 5: Commit** `git commit -m "Verify fill receipts against expected transfers"`.

### Task 9: Rysk REST client

**Files:**
- Create: `src/rysk/rest.ts`, `src/rysk/rest.test.ts`, `src/rysk/errors.ts`

**Interfaces:**
- Produces (`errors.ts`): `RyskRpcError(code, message)`, `SocketClosedError`, `CallTimeoutError`, `RestError(status, message)`.
- Produces (`rest.ts`): `type GasResult = { ok: true; gasFee6: bigint; echoed: Record<string, unknown> } |
  { ok: false; reason: 'exceeds-premium' | 'http'; status: number; message: string }`;
  `class RyskRest { constructor(opts: { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number;
  retries?: number; onServerDate?: (serverMs: number) => void; sleep?: (ms) => Promise<void> });
  assets(): Promise<unknown>; inventory(): Promise<unknown>; caps(): Promise<unknown>;
  userPositions(address: Address): Promise<unknown>; publicHistory(fromSec: number, toSec: number): Promise<unknown>;
  gasFee(body: ConfirmBody | GasPreviewBody): Promise<GasResult> }`. Retries (3, backoff 100 ms → 5 s) on network
  errors and 5xx only; 4xx throws `RestError` (except in `gasFee`, which returns `ok: false`); every response's
  `Date` header is reported through `onServerDate`.

- [ ] **Step 1: Write failing `rest.test.ts`** with an injected fake `fetch`: `assets()` returns parsed JSON and
  calls `onServerDate` with the `Date` header's epoch ms; two 500s then 200 → resolves after 3 calls; a 400 →
  `RestError` after 1 call; `gasFee(body)` with a 200 echoing `spike-capture.json`'s `gas.full.body` →
  `{ ok: true, gasFee6: 0n, echoed }`; a 400 with text `gas fee more than premium` → `ok: false, reason 'exceeds-premium'`;
  a never-resolving fetch with `timeoutMs: 50` rejects with `CallTimeoutError`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** with `AbortSignal.timeout`. **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Add Rysk REST client with retries and gas fee result"`.

## Milestone 3: WebSocket, taker, EIP-712

### Task 10: JSON-RPC socket

**Files:**
- Create: `src/rysk/socket.ts`, `src/rysk/socket.test.ts`, `src/rysk/socket.integration.test.ts`

**Interfaces:**
- Produces: `type WebSocketLike = Pick<WebSocket, 'send' | 'close' | 'readyState' | 'addEventListener'>`;
  `type SocketOptions = { url: string; createWebSocket?: (url: string) => WebSocketLike; connectTimeoutMs?: number
  (10_000); idleCloseMs?: number (30_000); openSettleMs?: number (500); backoff?: { baseMs: 1000; capMs: 30_000; jitter: 0.25 };
  random?: () => number; logger?: Logger }`;
  `class JsonRpcSocket { constructor(opts: SocketOptions); call<T>(method: string, params: unknown, opts: { timeoutMs: number;
  accept?: (result: unknown) => boolean; signal?: AbortSignal }): Promise<T>; close(): void; get connectionId(): number;
  get state(): 'idle' | 'connecting' | 'open' | 'closed' }`. Frames are `{ jsonrpc: '2.0', method, id: method, params }`.
  Calls are serialized per method; a reply whose `result` fails `accept` is ignored; `error` → `RyskRpcError`;
  close while pending → `SocketClosedError`; deadline → `CallTimeoutError` (also while queued, unsent).

- [ ] **Step 1: Write failing `socket.test.ts`** using `vi.useFakeTimers()` and a `FakeWebSocket` test double
  (records `sent` frames, lets the test `emit('message' | 'open' | 'close' | 'error')`, static `instances[]`):
  (a) `call('assets', {})` sends `{"jsonrpc":"2.0","method":"assets","id":"assets","params":{}}` after `open` + 500 ms
  and resolves with `result` of a reply `id: 'assets'`; (b) a reply failing `accept` is ignored and a later
  matching reply resolves; (c) no reply within `timeoutMs` → `CallTimeoutError`, and a reply arriving afterwards
  does not throw; (d) two `request` calls: the second frame is sent only after the first resolves; a `caps` call
  interleaves freely; (e) `close` with a pending call → `SocketClosedError`; the next call creates a second
  `FakeWebSocket` after `baseMs` backoff; (f) no `open` within `connectTimeoutMs` → reconnect attempt;
  (g) idle for `idleCloseMs` → `close()` called on the socket and `state === 'idle'`; (h) an `error` reply →
  `RyskRpcError` with its code; (i) a queued call whose deadline passes before send rejects without a frame.
- [ ] **Step 2: Write `socket.integration.test.ts`**: start a local `ws` `WebSocketServer` that replies to any
  frame with `{ jsonrpc: '2.0', id: frame.id, result: { echo: frame.params } }`; one `call('ping', { a: 1 })`
  resolves to `{ echo: { a: 1 } }`; close both.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run** — PASS.
- [ ] **Step 6: Commit** `git commit -m "Add JSON-RPC WebSocket client with per-method serialization"`.

### Task 11: Taker client

**Files:**
- Create: `src/rysk/taker.ts`, `src/rysk/taker.test.ts`

**Interfaces:**
- Produces: `type QuoteResult = { ok: true; quote: Quote; requestedAtMs: number; respondedAtMs: number } |
  { ok: false; error: 'timeout' | 'rpc-error' | 'mismatch' | 'socket-closed'; message: string; requestedAtMs: number }`;
  `type ConfirmReply = { kind: 'hash'; txHash: Hex } | { kind: 'rejected'; code: number; message: string } |
  { kind: 'bad-result'; raw: unknown } | { kind: 'no-reply'; reason: 'timeout' | 'socket-closed' }`;
  `type RpcCaller = Pick<JsonRpcSocket, 'call'>`;
  `class RyskTaker { constructor(socket: RpcCaller, opts: { nowSec: () => number; nowMs: () => number; minGapMs?: 250 });
  requestQuote(req: QuoteRequest, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<QuoteResult>;
  confirm(params: ConfirmParams, opts: { timeoutMs: number }): Promise<ConfirmReply> }`.
  `accept` for `request`: `assetAddress`, `chainId`, `expiry`, `isPut`, `quantity`, `strike`, `usd`, `collateralAsset`
  equal the request (addresses via `isAddressEqual`, numerics via `BigInt`). A matching reply is `mismatch` when
  `isTakerBuy !== false` or not `nowSec < validUntil <= nowSec + 3600`.

- [ ] **Step 1: Write failing `taker.test.ts`** with a fake `call` that returns the put quote from
  `spike-capture.json` (`requests[0].reply.result`) when `accept(result)` is true: `requestQuote(requests[0].request)`
  → `ok: true`, `quote.price === '1109494507915005812'`, `quote.validUntil === 1792146573` (with `nowSec` 1792146510);
  the fake invoking `accept` with the call quote (different strike) returns `false`; a reply with
  `isTakerBuy: true` → `error 'mismatch'`; `validUntil: 1792146573000` → `'mismatch'`; `call` rejecting
  `CallTimeoutError` → `'timeout'`; `RyskRpcError(-32601, 'Method not found')` → `'rpc-error'` with the message;
  `confirm`: result `'0x' + 'ab'.repeat(32)` → `kind 'hash'`; result `'ok'` → `'bad-result'`; `RyskRpcError` → `'rejected'`;
  `CallTimeoutError` → `no-reply 'timeout'`; two `requestQuote` calls back-to-back are at least `minGapMs` apart (fake clock).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Add taker client for quote requests and confirmations"`.

### Task 12: EIP-712 signing and recovery

**Files:**
- Create: `src/rysk/eip712.ts`, `src/rysk/eip712.test.ts`

**Interfaces:**
- Produces: `EIP712_DOMAIN`; `CONFIRMATION_TYPES` (17 fields, order from spec §6.8 / protocol doc §9);
  `QUOTE_TYPES` (13 fields); `type ConfirmationMessage` (all numerics `bigint`, `isTakerBuy: false`);
  `toConfirmationMessage(body: ConfirmBody, gasFee6: bigint): ConfirmationMessage`;
  `hashConfirmation(m: ConfirmationMessage): Hex`; `signConfirmation(account: PrivateKeyAccount, m: ConfirmationMessage): Promise<Hex>`;
  `recoverQuoteSigner(quote: Quote): Promise<Address>`; `normalizeV(sig: Hex): Hex` (0/1 → 27/28).

- [ ] **Step 1: Write failing `eip712.test.ts`**: derive the account from `keystore-anvil0.json` with `'hunter2'`;
  build a body from the spike put quote with `taker` = that address, `collateralAmount '1950000000'`, `nonce '1792146516346'`;
  `signConfirmation` then viem `verifyTypedData({ address, domain: EIP712_DOMAIN, types: CONFIRMATION_TYPES,
  primaryType: 'Confirmation', message, signature })` is `true`; `hashConfirmation` is stable across two calls and
  changes when `gasFee6` changes; `recoverQuoteSigner` on each of the three spike quotes returns a valid address.
- [ ] **Step 2: Run the recovery against the spike makers** (`0x66799bc69d7a7daaf50b6aa03cd5c6a2df1a9454`,
  `0xf7f97e0b45c230d209d0a721414ff7abfcacae80`, `0x403426e707fcc907d17b96ab2e4ddf7962040233`). If a recovered address
  equals its maker, pin that equality in the test (it validates the pinned domain). If none match, pin only
  "returns a valid address" and add one line under Open questions in `docs/rysk-protocol.md` stating the observed
  recovered addresses did not match (makers may sign via contracts).
- [ ] **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** `git commit -m "Add EIP-712 confirmation signing and quote recovery"`.

## Milestone 4: execution

### Task 13: Gas echo check and confirm body

**Files:**
- Create: `src/execution/types.ts`, `src/execution/echo.ts`, `src/execution/echo.test.ts`, `src/execution/body.ts`, `src/execution/body.test.ts`

**Interfaces:**
- Produces (`types.ts`): spec Appendix A `execution/types.ts` block verbatim plus
  `type FreshState = { gateHold: HoldReason | null; trancheQuantityE18: bigint; basisE8: bigint | null;
  basisReliable: boolean; basisEligibleEmpty: boolean; freshFallbackStrikeE8: bigint | null; freeCollateral: bigint;
  spotE8: bigint; listedStrikesE8ForExpiry: bigint[]; expiriesSec: number[]; deploymentsLast24h: number;
  notionalLast24h6: bigint; nativeHypeE18: bigint; allowance: bigint }` and `TradeDeps.freshState(): Promise<FreshState>`
  (replacing the spec's `{ snapshot; state }` so execution never imports strategy). Deviations from Appendix A, binding:
  `TradeDeps.quotes.requestQuote(...)` returns Task 11's `QuoteResult`; `TradeDeps.rpc.confirm(...)` returns Task 11's
  `ConfirmReply` (not `Hex`); `TradeDeps.collateral` is Task 7's `ApproveDeps & { vaultCounter(): Promise<bigint> }` and
  `sell.ts` calls `approveExact(deps.collateral, …)`. Also `type ExecutionEvent = { execId: string; step: string;
  detail: Record<string, unknown> }` and `type CheckResult = { id: string; pass: boolean; na?: boolean; detail?: string }`.
- Produces (`echo.ts`): `GAS_ECHO_EXTRA_KEYS` (the 12 keys, spec §7.3); `EXPECTED_EXTRA_VALUES: Record<string, '' | false>`
  (all `''` except `isPremium: false`; `gasFee`, `signature`, `isEIP1271` exempt); `echoMismatches(sent: ConfirmBody,
  echoed: Record<string, unknown>): string[]` (field names, by kind: address/uint/bool/hex; missing = mismatch;
  unknown extra key → `'extra:<key>'`; wrong extra value → `'extra-value:<key>'`); `parseGasFee(echoed): bigint | null`
  (`''`/missing → `0n`; non-`/^\d+$/` → null).
- Produces (`body.ts`): `buildConfirmBody(a: { quote: Quote; taker: Address; collateralAmount: bigint; nonceMs: number }): ConfirmBody`
  (`quantity`/`strike` from the quote, `quoteValidUntil = validUntil = quote.validUntil`, `isTakerBuy: false`);
  `gasPreviewBody(quote: Quote): GasPreviewBody` (exactly 9 keys); `buildConfirmParams(body: ConfirmBody, echoed, gasFee6, signature): ConfirmParams`
  (= `{ ...body, ...allowlistedExtras, gasFee: gasFee6.toString(), isEIP1271: false, signature }`).

- [ ] **Step 1: Write failing `echo.test.ts`** on `spike-capture.json` (`gas.full.sent` as `sent`, parsed `gas.full.body` as `echoed`):
  `echoMismatches(sent, echoed)` is `[]`; `echoed.price = '1'` → `['price']`; `echoed.taker` uppercased → `[]`;
  `delete echoed.nonce` → `['nonce']`; `echoed.foo = 1` → `['extra:foo']`; `echoed.isPremium = true` → `['extra-value:isPremium']`;
  `parseGasFee({ gasFee: '0' }) === 0n`, `parseGasFee({}) === 0n`, `parseGasFee({ gasFee: '1.5' }) === null`.
- [ ] **Step 2: Write failing `body.test.ts`**: `buildConfirmBody` from the spike put quote with `collateralAmount 1950000000n`
  equals `gas.full.sent` except `nonce` and `taker`; `Object.keys(gasPreviewBody(quote)).sort()` equals the 9 names;
  `buildConfirmParams` output has `gasFee '0'`, `isEIP1271 false`, our `signature`, and `isPremium false`.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run** — PASS.
- [ ] **Step 6: Commit** `git commit -m "Add gas echo verification and confirm body builder"`.

### Task 14: Pre-sign checks

**Files:**
- Create: `src/execution/checks.ts`, `src/execution/checks.test.ts`

**Interfaces:**
- Produces: `type CheckedConfirmBody = ConfirmBody & { readonly __checked: unique symbol }`;
  `type CheckContext = { mode: 'live' | 'dry-run'; intent: TradeIntent; freshQuote: Quote; body: ConfirmBody;
  echoed: Record<string, unknown>; gasFee6: bigint; fresh: FreshState; config: ExecutionConfig; serverNowSec: number;
  nowMs: number; signerAddress: Address | null; usedQuoteNonces: Set<string>; lastNonceMs: number; stopFile: boolean;
  lockHeld: boolean; inFlightExcludingSelf: boolean; recoveredMaker: Address | null }`;
  `type ExecutionConfig` = the `safety` block of Appendix B normalized (`maxGasFee6`, `maxGasFeeBps`, `minNetPremium6`,
  `minQuoteTtlSec`, `maxQuoteTtlSec`, `maxPremiumFractionOfCollateral`, `aprEchoTolerancePp`, `verifyMakerSig`,
  `maxDeploymentsPer24h`, `maxNotionalPer24h6`, `minNativeHypeE18`) plus `minApr`, `minOtmPct`, `minStrikeOverBasisPct`,
  `fallbackMinNetPremium6`, `minTradeSizeE18`, `maxTradeSizeE18`, `maxContractsPerTradeE18`, `strikePrecisionE8`;
  `runPreSignChecks(ctx: CheckContext): { ok: true; body: CheckedConfirmBody; results: CheckResult[] } |
  { ok: false; failed: CheckResult; results: CheckResult[] }` implementing C1–C18 from spec §7.2 in order, with
  C1 and the allowance clause of C13 marked `na: true` in dry-run.

- [ ] **Step 1: Write failing `checks.test.ts`**: a `happyContext()` builder from the spike put quote (taker = fixture
  address, `fresh` with `gateHold: null`, `trancheQuantityE18 25e18`, `basisE8 null` for a put, `freeCollateral 5000_000000n`,
  `spotE8 8148032044n`, `allowance 1950000000n`, listed strikes including `7800000000n`, expiries including `1792742400`),
  `serverNowSec 1792146510`, `config.minApr 0.4`: result `ok: true` with 18 results all `pass`. Then one test per
  failure: `stopFile: true` → C1; `gateHold: 'cooldown'` → C2; `trancheQuantityE18 50e18` → C2; `body.usd = USDT0` → C3;
  `freshQuote.strike = '7900000000'` → C4; `usedQuoteNonces` containing the nonce → C5; `serverNowSec 1792146570` → C6;
  `freshQuote.price = '20000000000000000000'` (≥ 15 % of strike) → C7; `config.minApr 0.9` → C8;
  `echoed.price = '1'` → C9; `gasFee6 1000000n` (above 2 % of premium) → C9; `spotE8 10000000000n` (put strike no longer
  ≤ 0.99 S? use `7800000000n` vs spot `7800000000n` to fail the OTM band) → C10; `fresh.expiriesSec = [1793347200]` → C11;
  `body.quantity = '26000000000000000000'` → C12; `fresh.allowance 1949999999n` → C13 in live, `na` in dry-run;
  `deploymentsLast24h 4` → C16; a call intent with `basisE8 8500000000n` and `body.strike '8450000000'` → C18.
  In `mode: 'dry-run'` with `signerAddress: null` and `fresh.allowance 0n` the happy context passes with C1 and C13 `na`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Add pre-sign checklist producing a checked confirm body"`.

### Task 15: Sell state machine

**Files:**
- Create: `src/execution/sell.ts`, `src/execution/sell.test.ts`, `src/execution/index.ts`

**Interfaces:**
- Consumes: Task 7 `approveExact`-shaped deps via `TradeDeps.collateral`, Task 11 `QuoteResult`/`ConfirmReply`
  via `TradeDeps.quotes`/`rpc`, Task 13 echo/body, Task 14 checks, Task 8 `verifyFillReceipt`.
- Produces: `sellOption(deps: TradeDeps, intent: TradeIntent): Promise<TradeResult>` following spec §7.1 exactly,
  with `TradeDeps` extended by `{ checks: ExecutionConfig; verifyReceipt: (receipt, expected: FillExpectation) =>
  ReturnType<typeof verifyFillReceipt>; writeStop: (reason: string) => void; usedQuoteNonces: Set<string>;
  lastNonceMs: { value: number }; onConfirmSent: (side: Side, atSec: number) => void; onConfirmCleared: (side: Side) => void }`.
  Nonces join `usedQuoteNonces` at SIGN. The cooldown callbacks fire at CONFIRM send and on `confirm-rejected`/`reverted`.

- [ ] **Step 1: Write failing `sell.test.ts`** with a `fakes()` builder (every dep is a `vi.fn` with recorded calls):
  (a) live happy path: `allowance` 0 → `approve` called with `1950000000n` → `requestQuote` (fresh) → `gasFee` → checks →
  `signConfirmation` → `confirm` returns a hash → `waitForReceipt` → `verifyReceipt ok` → `vaultCounter` 87 → 88 →
  `{ status: 'filled' }`; `record` calls include steps `trade-intent` before `confirm-sent`; `onConfirmSent` called once.
  (b) dry-run: `signer: null`, result `{ status: 'aborted', stage: 'dry-run', echoOk: true, wouldApprove: 1950000000n }`,
  `approve`/`signConfirmation`/`confirm` never called, `gasFee` called once. (c) re-quote below `minPriceE18` →
  `aborted('price-floor')`, no sign. (d) echo mismatch → `aborted('echo')` and `writeStop` called in live. (e) `confirm`
  `rejected` → `aborted('confirm-rejected')` and `onConfirmCleared`. (f) `confirm` `bad-result` → `unknown('bad-result')`.
  (g) receipt `status: 'reverted'` → `reverted` and `onConfirmCleared`. (h) `verifyReceipt` not ok → `writeStop` and
  `unknown('verify-failed')`. (i) `waitForReceipt` null → `unknown('receipt-timeout')`. (j) `signal` aborted before
  confirm → `aborted('shutdown')` and `confirm` not called. (k) `approveExact` `stuck` → `aborted('approve')`.
  (l) `confirm` called at most once even when `rpc.confirm` throws.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run `pnpm test`** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Add guarded sell state machine with receipt verification"`.

## Milestone 5: wheel strategy

### Task 16: Strategy types, config type, row classification

**Files:**
- Create: `src/strategy/wheel/types.ts`, `src/strategy/wheel/config.ts`, `src/strategy/wheel/classify.ts`,
  `src/strategy/wheel/classify.test.ts`

**Interfaces:**
- Produces: spec Appendix A `strategy/wheel/types.ts` block with two additions: `Snapshot.otherRowCount: number`
  (rows that are not chain-999 WHYPE positions, from `parsePositions().otherRows.length`) and
  `Snapshot.memo.lastNoPendingSeenSec: number | null` (for gate G3); `type WheelConfig` (plain TS, spec §8.9:
  `mode`, `enabled`, `self`, `put`/`call: SideConfig` with `minApr`, `minHoursToExpiry`, `maxDaysToExpiry`, `minAbsDelta`,
  `maxAbsDelta`, `minOtmPct` (fraction), `minIntervalHours`, `trancheFraction`, `maxContractsPerTradeE18`,
  `reserve6`/`reserveE18`, `maxCapital6?`/`maxCapitalE18?`, call extras `minStrikeOverBasisPct` (fraction) and `fallback
  { enabled; scope; customStrikeFirst; maxDiscountToBasisPct?; minNetPremium6 }`, `tranche.allowSingleLot`, `basis`
  (`anchor { ts; qtyE18; basisE8 }`, `externalFlows[]`, `residualPolicy`, `residualToleranceE18`), `quoting`, `safety`
  normalized as in Task 14's `ExecutionConfig` plus `startupQuietSec`, `settlementGraceSec`, `maxClockSkewMs`,
  `maxHypeExposurePct?`, `pauseOnFrontendChange`);
  `classifyRow(p: Position, nowSec: number): { cls: RowClass; phase: Phase }`; `isBasisRelevant(cls): boolean`
  (`managedPut | managedCall | whypePutOtherUsd | whypeCallOtherUsd`); `isManaged(cls)`.

- [ ] **Step 1: Write failing `classify.test.ts`** on the parsed fixture (`parsePositions` from Task 5) with `nowSec 1792144000`:
  class counts `managedPut 10`, `managedCall 17`, `whypePutOtherUsd 21`, `whypeCallOtherUsd 29`; phases `open 3`,
  `settled 74`, `pendingSettlement 0`; with `nowSec 1793400000` the two positions expiring `1793347200` and the one at
  `1792742400` are `pendingSettlement` (3). A kHYPE-collateral call built by mutating a row → `hypeForeignCollateral`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** (incl. architecture test) — PASS.
- [ ] **Step 5: Commit** `git commit -m "Add wheel types and position classification"`.

### Task 17: Basis ledger

**Files:**
- Create: `src/strategy/wheel/basis.ts`, `src/strategy/wheel/basis.test.ts`

**Interfaces:**
- Produces: `type BasisEvent = { tsSec: number; kind: 'add' | 'remove'; qtyE18: bigint; priceE8?: bigint;
  source: 'row' | 'flow'; order: [number, string] }`; `type BasisResult = { basisE8: bigint | null; qtyE18: bigint;
  residualE18: bigint; reliable: boolean; reason?: 'basis-negative' | 'anchor-in-settlement-window' | 'settlement-pending' | 'residual-blocked';
  warnings: string[] }`; `basisEvents(rows: { position: Position; cls: RowClass; phase: Phase }[], config: WheelConfig['basis']): BasisEvent[]`
  (settled ITM basis-relevant rows with `expirySec > anchor.ts`, ts = `expirySec`; flows with `ts > anchor.ts`;
  ordering per spec §8.4); `computeBasis(args: { events: BasisEvent[]; config: WheelConfig['basis']; observedHypeE18: bigint | null
  /* null when a basis-relevant row is pending */; anchorInsideSettlementWindow: boolean }): BasisResult` (exact bigint
  replay; `basisE8 = ceilDiv(cost, q)`).

- [ ] **Step 1: Write failing `basis.test.ts`** with synthetic events (anchor `{ ts: 1000, qtyE18: 100e18, basisE8: 3000000000n }`):
  add 50 @ `8000000000n` at 2000 → `basisE8 4666666667n`, `qtyE18 150e18`; then remove 50 at 3000 → `basisE8 4666666667n`,
  `qtyE18 100e18`; `observedHypeE18 120e18` with `absorb` → re-run with Q0 120 → `basisE8 4470588236n`, `residualE18 20e18`;
  `observedHypeE18 90e18` → final removal of 10, `basisE8 4666666667n`, warning matches `/external-withdrawal/`;
  `residualPolicy 'block-calls'` with residual 20 → `reliable false, reason 'residual-blocked'`; anchor qty 0 with a
  remove → `reliable false, reason 'basis-negative'`; `observedHypeE18 null` → `reason 'settlement-pending'`;
  `anchorInsideSettlementWindow true` → `reason 'anchor-in-settlement-window'`; same-ts add and remove: add applied first
  (q never negative); `basisEvents` on the fixture rows with anchor ts `1760000000` yields 15 events in expiry order
  (the first is an add of 50 @ `4050000000n` at `1763107200`, the last two removes of 50 @ `9050000000n` at `1790323200`)
  and with anchor ts `1792000000` yields 0 events.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Add average-cost HYPE basis ledger"`.

### Task 18: State derivation

**Files:**
- Create: `src/strategy/wheel/state.ts`, `src/strategy/wheel/state.test.ts`

**Interfaces:**
- Consumes: Tasks 16–17.
- Produces: `deriveState(s: Snapshot, c: WheelConfig): WheelState` per spec §8.2 (de-dup by key with warning;
  consistency from `vaultCounter` vs `positions.length + otherRows.length`; capital table; basis; `lastDeployTs`;
  rolling 24 h counts). Uses `Snapshot.otherRowCount` defined in Task 16.

- [ ] **Step 1: Write failing `state.test.ts`** with a `snapshotFromFixtures()` builder (`nowSec 1792144000`, `vaultCounter 87n`,
  `whypeE18 30e18`, `usdc6 5000_000000n`, `otherRowCount 10`, config anchor `{ ts: 1792000000, qtyE18: 130e18, basisE8: 5000000000n }`):
  `consistency 'ok'`; `capital.put.locked === 1962500000n`, `capital.put.free === 5000_000000n`, `capital.put.total === 6962500000n`;
  `capital.call.locked === 100n*10n**18n`, `capital.call.free === 30n*10n**18n`; `basis.basisE8 === 5000000000n`
  (no events after the anchor; `observed 130e18` matches); `lastDeployTs.put === 1792131925`, `lastDeployTs.call === 1791196075`;
  `deploymentsLast24h === 1`; `vaultCounter 86n` → `'api-lag'`; `88n` → `'inconsistent'` with an anomaly; duplicating a row
  → same capital and one warning; shuffling rows → deep-equal state; a row with `status 'unknown'` → anomaly.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Derive wheel state from positions, chain snapshot and config"`.

### Task 19: Gates and tranche sizing

**Files:**
- Create: `src/strategy/wheel/gates.ts`, `src/strategy/wheel/gates.test.ts`, `src/strategy/wheel/tranche.ts`, `src/strategy/wheel/tranche.test.ts`

**Interfaces:**
- Produces: `checkGates(side: Side, st: WheelState, s: Snapshot, c: WheelConfig): { hold: HoldReason | null; results: { id: string; pass: boolean; detail?: string }[] }`
  implementing G1–G11 and S1–S5 in order (spec §8.3; G7/G9/G11 only when `s.mode === 'live'`; G3 uses
  `s.memo.lastNoPendingSeenSec`); `trancheQuantityE18(side: Side, st: WheelState, strikeE8: bigint, s: Snapshot, c: WheelConfig,
  capacityE18: bigint | null): bigint` (spec §8.5; returns `0n` when below one lot); `lotE18 = minTradeSizeE18`.
  `Snapshot.memo.lastNoPendingSeenSec` is defined in Task 16.

- [ ] **Step 1: Write failing `gates.test.ts`**: from the Task 18 happy snapshot every gate passes (`hold null`); then one
  case each: anomaly → `'anomaly'`; `'api-lag'`; a pending row → `'settlement-pending'`; `lastNoPendingSeenSec` 100 s ago
  with grace 900 → `'settlement-pending'`; `blockTs` 40 s older than `localNowMs` → `'stale-data'`; `serverSkewMs 5000` →
  `'clock-skew'`; WHYPE asset `active false` → `'market-closed'`; live with `uptimeSec 10` → `'quiet-period'`;
  `inFlight` → `'in-flight'`; `pendingNonceGap 1` → `'tx-pending'`; `cooldownUntilSec` in the future → `'cooldown'`;
  live `nativeHypeE18 10n**16n` → `'gas-reserve'`; `stopFile` → `'kill-switch'`; `frontendChanged` with pause on → `'frontend-changed'`;
  live `deploymentsLast24h 4` → `'daily-limit'`; `lastDeployTs.put` 1 h ago → `'interval'`; call with `basis.reliable false` →
  `'basis-unreliable'`; put with `maxHypeExposurePct 0.5` and HYPE worth 80 % → `'exposure-cap'`.
- [ ] **Step 2: Write failing `tranche.test.ts`**: put, budget 10 000 USDC (free 10 000, locked 0), fraction 0.25, strike
  `7850000000n` → `25n*10n**18n`; free 1500 → `0n`; call, free 30 WHYPE total 30, fraction 0.25, `allowSingleLot` → `25e18`;
  `allowSingleLot false` → `0n`; `maxContractsPerTradeE18 25e18` with budget 100 000 → `25e18`; `capacityE18 30e18` → `25e18`;
  `capacityE18 10e18` → `0n`.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run** — PASS.
- [ ] **Step 6: Commit** `git commit -m "Add strategy gates and DCA tranche sizing"`.

### Task 20: Candidates and fallback

**Files:**
- Create: `src/strategy/wheel/candidates.ts`, `src/strategy/wheel/candidates.test.ts`

**Interfaces:**
- Consumes: Task 19.
- Produces: `planSide(side: Side, st: WheelState, s: Snapshot, c: WheelConfig): SidePlan` (spec §8.6: gates first;
  candidate filter, ranking, diversified top-`quotesPerSide`; call basis rule with threshold `basisE8 × (1 + minStrikeOverBasisPct)`;
  fallback with `scope`, `customStrikeFirst`, `maxDiscountToBasisPct`); `basisEligible(listings, basisE8, c): Listing[]`;
  `fallbackStrike(listings, c): { listing: Listing; expirySec: number } | null`; `customFallbackStrikeE8(basisE8, spotE8, precisionE8): bigint`
  (`ceil(min(basis, 1.4 S × 0.995))` to precision). `Candidate.request` uses `taker = c.self`, `quantity` from
  `trancheQuantityE18`, `assetName` = collateral symbol.

- [ ] **Step 1: Write failing `candidates.test.ts`** with fixture inventory (`spotE8 8148032044n`, now `1792144000`, side
  config `minHoursToExpiry 36`, `maxDaysToExpiry 16`, `minAbsDelta 0.05`, `maxAbsDelta 0.45`, `minOtmPct 0.01`,
  `prefilterRatio 0.5`, `minApr 0.1`, `quotesPerSide 3`): put plan has `kind 'quote'`, ≤ 3 candidates, all `isPut`,
  expiries ⊆ `{1792742400, 1793347200}`, first candidate has the highest `indicativeApr`, at least two distinct expiries
  when available, every `request.taker === c.self` and `request.usd === USDC`; call plan with `basisE8 5000000000n`
  behaves the same for calls; `basisE8 12000000000n` → single candidate `mode 'basis-fallback'`, `strikeE8 8850000000n`,
  `expirySec 1792742400`; same with `maxDiscountToBasisPct 0.1` → `hold 'fallback-too-far-below-basis'`;
  `customStrikeFirst true` → first candidate `mode 'basis-fallback-custom'` with `strikeE8 === customFallbackStrikeE8(…)`
  and `listing null`; `scope 'all-listed'` with `basisE8 10000000000n` → `kind 'quote'` normal candidates with strikes
  `≥ 10000000000n`; `basisEligible` non-empty but all below `prefilterRatio` → `kind 'quote'` still (prefilter is
  not part of eligibility) — assert candidates exist; `basis.reliable false` → `hold 'basis-unreliable'`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Plan candidate strikes with basis rule and fallback"`.

### Task 21: Quote evaluation

**Files:**
- Create: `src/strategy/wheel/evaluate.ts`, `src/strategy/wheel/evaluate.test.ts`, `src/strategy/wheel/index.ts`

**Interfaces:**
- Produces: `evaluate(side: Side, qs: QuotedCandidate[], st: WheelState, s: Snapshot, c: WheelConfig): Decision`
  (spec §8.7: `aprNet` from `premium6 − gasFee6`, floor skipped for fallback modes, `minNetPremium6`, tie-breaks,
  `minPriceE18 = minPriceE18ForApr(minApr, …, gasFee6)` or for fallback the price where `net6 == fallback.minNetPremium6`;
  `maxGasFee6 = c.safety.maxGasFee6`; `lossIfExercisedUsd` for fallback); `pickSide(decisions: Decision[], c): Decision | null`
  (largest `aprNet − minApr`).

- [ ] **Step 1: Write failing `evaluate.test.ts`**: two quoted put candidates (strike 78 price `1109494507915005812`,
  strike 80 price `1500000000000000000`, both gas `0n`, now `1792146510`, expiry `1792742400`) with `minApr 0.4` →
  `kind 'trade'` choosing strike 80 (higher APR), `aprNet` ≈ `1.0` within 0.02, `minPriceE18 > 0n`; `minApr 1.5` → `hold 'apr-floor'`
  with `best.aprNet` ≈ 1.0; a `gas.ok false` outcome is skipped; `gasFee6` equal to the premium → skipped (`net6 < minNetPremium6`);
  fallback candidate with `aprNet 0.05` and `minApr 0.4` → `kind 'trade'` with `lossIfExercisedUsd` defined;
  no `ok` quotes → `hold 'no-quotes'`; `pickSide([putTrade(aprNet 0.9), callTrade(aprNet 0.7)], c)` → the put.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run `pnpm check`** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Evaluate quotes against the APR floor"`.

## Milestone 6: daemon and CLI

### Task 22: Config loading, logger

**Files:**
- Create: `src/daemon/config.ts`, `src/daemon/config.test.ts`, `src/daemon/logger.ts`, `src/daemon/logger.test.ts`,
  `config.example.json` (spec Appendix B, with anchor placeholders `{ "ts": 1760000000, "qtyWhype": "100", "basisUsd": "50" }`)

**Interfaces:**
- Produces: `type AppConfig = { mode: 'live' | 'dry-run'; account: { address: Address; keystorePath: string };
  rpcUrl: string; rysk: { restUrl; wsUrl; appUrl }; tickSeconds: number; dataDir: string; logLevel: string;
  wheel: WheelConfig; sampler: SamplerConfig; maxTrades?: number /* from the CLI, not the file */ }`; `type SamplerConfig` (Appendix B `sampler` with `putStables`/`callCollaterals`
  resolved to addresses); `loadConfig(path: string, flags: { live: boolean }): AppConfig` (zod schema; unit
  normalization per spec §8.9; mode resolution per §9.1: `--live` + `mode: dry-run` throws `ConfigError`; `mode: live`
  without `--live` → `dry-run` with `warnings`); `createLogger(opts: { level; rpcUrl }): Logger` (pino, bigint
  formatter, error serializer redacting `rpcUrl` and `/\/v2\/[A-Za-z0-9_-]{16,}/g` to `<rpc>`).

- [ ] **Step 1: Write failing `config.test.ts`**: `loadConfig('config.example.json', { live: false })` parses with
  `mode 'dry-run'`, `wheel.put.minApr === 0.4`, `wheel.put.minOtmPct === 0.01`, `wheel.put.reserve6 === 0n`,
  `wheel.safety.maxNotionalPer24h6 === 20000_000000n`, `wheel.safety.minNativeHypeE18 === 5n*10n**16n`,
  `wheel.basis.anchor.basisE8 === 5000000000n`, `wheel.safety.maxGasFee6 === 500000n`, `wheel.call.fallback.minNetPremium6 === 1_000000n`,
  `wheel.put.maxCapital6 === undefined`; `{ live: true }` on the example throws `ConfigError`; a copy with `mode: 'live'`
  and `{ live: true }` → `mode 'live'`; `call.enabled true` with `anchor.basisUsd '0'` throws; `sampler.callCollaterals`
  resolves to 4 addresses.
- [ ] **Step 2: Write failing `logger.test.ts`**: logging `{ q: 25n*10n**18n }` to a buffered destination yields
  `"q":"25000000000000000000"`; logging an error whose message contains `https://x.g.alchemy.com/v2/abcdefghijklmnop1234`
  yields `<rpc>` and not the key.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run** — PASS; `pnpm check:secrets` ok.
- [ ] **Step 6: Commit** `git commit -m "Load and normalize config, add redacting logger"`.

### Task 23: Recorder, status file, lock, version tripwire

**Files:**
- Create: `src/daemon/recorder.ts`, `src/daemon/recorder.test.ts`, `src/daemon/status.ts`, `src/daemon/lock.ts`,
  `src/daemon/lock.test.ts`, `src/daemon/version.ts`, `src/daemon/version.test.ts`

**Interfaces:**
- Produces: `class Recorder { constructor(opts: { dataDir: string; envelope: { runId; mode; codeRev; configHash }; clock: Clock });
  append(stream: 'quotes' | 'decisions' | 'executions' | 'inventory' | 'public-fills' | 'state', record: object): void }`
  (path `data/<stream>/YYYY-MM-DD.jsonl` UTC, `appendFileSync`, `stringifyBig`, envelope `{ v: 1, kind: stream, tsMs, … }`);
  `writeStatus(dataDir, status: StatusFile): void` with `type StatusFile = { tsMs; health: 'ok' | 'holding' | 'halted';
  holdReasons: Partial<Record<Side, HoldReason>>; halted: boolean; lastTradeAtSec: number | null; tick: number; mode }`;
  `stopFilePresent(dataDir): boolean`, `writeStopFile(dataDir, reason): void`;
  `acquireLock(dataDir): { release(): void }` (`data/live.lock`, `O_EXCL`, pid inside; takes over when the pid is dead;
  throws `LockHeldError` otherwise);
  `class FrontendVersionWatcher { constructor(opts: { appUrl; fetch; intervalMs: 3_600_000 }); start(): Promise<void>;
  get changed(): boolean; get sha(): string | null; stop(): void }` polling `/api/version/`.

- [ ] **Step 1: Write failing tests** in a temp dir: `recorder.append('quotes', { a: 1n })` writes one line parsing to
  `{ v: 1, kind: 'quotes', tsMs, runId, mode, codeRev, configHash, a: '1' }` in `quotes/<utc-date>.jsonl`; two appends → two lines;
  `writeStatus` then read back equals input; `writeStopFile` makes `stopFilePresent` true; `acquireLock` twice → second
  throws `LockHeldError`; a lock file with pid `999999` is taken over; `FrontendVersionWatcher` with a fake fetch returning
  sha `a` then `b` → `changed` false after start, true after the second poll (fake timers).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Add JSONL recorder, status file, lock and version tripwire"`.

### Task 24: Snapshot gathering and the tick loop

**Files:**
- Create: `src/daemon/snapshot.ts`, `src/daemon/loop.ts`, `src/daemon/loop.test.ts`, `src/daemon/memo.ts`

**Interfaces:**
- Produces (`memo.ts`): `class Memo` holding spec `Snapshot.memo` fields plus `keyBackoff: Map<string, { untilSec; n }>`,
  `replanDueSec: Partial<Record<Side, number>>`, `usedQuoteNonces`, `lastNonceMs`, with `backoffKey(key, nowSec)`,
  `isBackedOff(key, nowSec)`, `resetBackoffIf(spotMovedPct, …)`.
- Produces (`snapshot.ts`): `type SnapshotSources = { chain: ChainReader; rest: RyskRest; self: Address; clock: Clock;
  memo: Memo; mode }`; `gatherSnapshot(src: SnapshotSources): Promise<Snapshot>` (parallel: `readChainSnapshot`,
  `userPositions` → `parsePositions`, `inventory` → `parseInventory`, `assets` → `parseAssets`, `caps` → `parseCaps`;
  `spotE8` from the WHYPE asset `priceE18 / 10^10`; any rejection rethrows).
- Produces (`loop.ts`): `type LoopDeps = { snapshot(): Promise<Snapshot>; quote(c: Candidate): Promise<QuoteOutcome>
  /* requestQuote + gas preview + makerSigOk */; execute(i: TradeIntent): Promise<TradeResult>; recorder: Recorder;
  status: (s: StatusFile) => void; clock: Clock; log: Logger; memo: Memo; signal: AbortSignal; sleep: typeof sleep }`;
  `runLoop(deps: LoopDeps, config: AppConfig): Promise<void>` (fixed delay; per tick spec §9.1; applies key backoff and
  `replanSec` before `planSide`; dry-run records a simulated deployment after `aborted('dry-run')`; live executes
  `pickSide`'s decision; three consecutive snapshot failures → `log.error`; stops when `signal` aborts or
  `--max-trades` reached via `config.maxTrades`). Also in `loop.ts`: `applyTradeResult(memo, side, result, nowSec, c): void`
  implementing the spec §7.5 cooldown table (`aborted` before confirm → none; `confirm-rejected`/`reverted` → 60 s and
  `memo.confirmErrors` counted, three in an hour or two reverts in 24 h → `writeStopFile`; `filled` → `memo.pendingVisibility.push({ side, txHash, sinceSec })`
  and cooldown until that `txHash` appears among `snapshot.positions` or `unknownMaxWaitSec` elapses; `unknown` → cooldown until
  a position with `createdAtSec ≥ confirmSentAtSec` and matching terms appears, or the vault counter increased, or
  `unknownMaxWaitSec`). Each tick the loop also updates `memo.lastNoPendingSeenSec` (set to `nowSec` when no basis-relevant
  row is pending) and `memo.serverSkewMs` from the REST `onServerDate` callback.
  `config.maxTrades` comes from the CLI (Task 22 type).

- [ ] **Step 1: Write failing `loop.test.ts`** with fake deps and fake timers, fixture-based snapshot, dry-run config with
  `minApr 0.1`: after two ticks `recorder` has `state` records, `decisions` for both sides, at least one `quotes` record,
  one `executions` record with `stage 'dry-run'`, `execute` called with `mode` dry-run only (never live), and the second
  tick's put decision is `hold 'interval'` (simulated deployment advanced the clock); a snapshot rejecting three times
  → `log.error` called once and no decisions; `signal.abort()` ends the loop. `applyTradeResult` unit tests: `reverted` sets
  `cooldownUntilSec = now + 60` and clears `lastConfirmSec`; `filled` adds a `pendingVisibility` entry and a later snapshot
  containing that `txHash` clears the cooldown; `unknown` keeps the cooldown until `unknownMaxWaitSec` passes; a third
  `confirm-rejected` within an hour calls `writeStopFile`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Gather snapshots and run the fixed-delay tick loop"`.

### Task 25: Research sampler

**Files:**
- Create: `src/daemon/sampler.ts`, `src/daemon/sampler.test.ts`, `src/daemon/bucket.ts`, `src/daemon/bucket.test.ts`

**Interfaces:**
- Produces (`bucket.ts`): `class TokenBucket { constructor(perMinute: number, clock: Clock); take(): boolean; waitMs(): number }`.
- Produces (`sampler.ts`): `buildSweep(listings: Listing[], cfg: SamplerConfig, quantityE18: bigint, random: () => number):
  QuoteRequest[]` (puts × `putStables`, calls × `callCollaterals`, pair legs adjacent in random order, `taker` zero);
  `pickPinned(listings, n: 4): Listing[]` (nearest expiry, |delta| closest to 0.10 and 0.25 per side);
  `runSampler(deps: { taker: RyskTaker; rest: RyskRest; recorder: Recorder; bucket: TokenBucket; clock; sleep; signal;
  listings: () => Listing[]; isExecuting: () => boolean; self: Address }, cfg: SamplerConfig): Promise<void>`
  (fixed-delay schedules for sweep, pinned, taker pair, inventory snapshot, public fills; pauses while `isExecuting()`).

- [ ] **Step 1: Write failing `bucket.test.ts`**: `perMinute 6` allows 6 immediate `take()`s then false; after 10 s one more.
  **Write failing `sampler.test.ts`**: `buildSweep(fixtureListings, cfg, 25e18, () => 0.5)` has 144 requests
  (24 puts × 2 + 24 calls × 4), all `taker` zero, every put request's `usd === collateralAsset`, and for each put
  listing its USDC and USDT0 legs are adjacent; `pickPinned` returns 4 listings all at `1792742400`;
  `runSampler` with a fake taker for one scheduled sweep records 144 `quotes` entries with `purpose 'sweep'` and
  stops on abort; with `isExecuting` true no request is made.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Add research quote sampler with token bucket"`.

### Task 26: CLI

**Files:**
- Create: `src/cli/main.ts`, `src/cli/run.ts`, `src/cli/state.ts`, `src/cli/quote.ts`, `src/cli/history.ts`,
  `src/cli/wallet.ts`, `src/cli/basis.ts`, `src/cli/args.test.ts`, `src/daemon/index.ts`, `src/daemon/wire.ts`

**Interfaces:**
- Produces (`wire.ts`): `wireDaemon(config: AppConfig, opts: { account: PrivateKeyAccount | null; log }): { loopDeps: LoopDeps;
  samplerDeps; sockets: JsonRpcSocket[]; version: FrontendVersionWatcher }` (builds `RyskRest`, two `JsonRpcSocket`s,
  `RyskTaker`s, chain clients, `Recorder`, `Memo`; `quote(c)` = `requestQuote` + `gasFee(gasPreviewBody)` + `recoverQuoteSigner`;
  `execute(i)` = `sellOption` with `freshState` built from `gatherSnapshot` + `deriveState` + `checkGates` + `trancheQuantityE18`
  + `basisEligible` + `fallbackStrike`).
- Produces (`main.ts`): subcommand dispatch on `positionals[0]` with `parseArgs({ strict: true })` per command;
  `run [--live] [--max-trades N] [--config path] [--no-sampler]` (live: `acquireLock`, resolve password, `loadAccount`,
  assert address and `getCode`, `assertChainId`, startup summary, SIGINT/SIGTERM → abort with 20 s hard exit);
  `state`, `quote --side --strike --expiry [--qty] [--collateral] [--usd]`, `history --from --to --out`, `wallet`,
  `basis suggest-anchor` (prints `{ ts: blockTs, qtyWhype: formatUnits(whype + lockedCalls, 18) }`).
  `parseCli(argv: string[]): CliCommand` is pure and tested.

- [ ] **Step 1: Write failing `args.test.ts`**: `parseCli(['run', '--live', '--max-trades', '1'])` →
  `{ cmd: 'run', live: true, maxTrades: 1, sampler: true, config: 'config.json' }`; `parseCli(['quote', '--side', 'put',
  '--strike', '78.5', '--expiry', '1793347200'])` → `{ cmd: 'quote', side: 'put', strikeE8: 7850000000n, expirySec: 1793347200,
  quantityE18: 25n*10n**18n, collateral: 'usdc', usd: 'usdc' }`; `parseCli(['basis', 'suggest-anchor'])` → `{ cmd: 'basis-suggest-anchor' }`;
  unknown command throws with usage text.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `args`, `wire`, commands. **Step 4: Run `pnpm check`** — PASS.
- [ ] **Step 5: Smoke from the sandbox (network open):** `NODE_USE_ENV_PROXY=1 pnpm rysk wallet --config config.example.json`
  prints address and balances (zero for the placeholder address) and `vaultCounter 0`; `NODE_USE_ENV_PROXY=1 pnpm rysk quote
  --side put --strike <a listed strike> --expiry <nearest expiry> --config config.example.json` prints a real quote with
  price, premium, TTL and APR. Expected: both succeed; nothing is signed.
- [ ] **Step 6: Commit** `git commit -m "Add CLI with run, state, quote, history, wallet and basis commands"`.

## Milestone 7: docs and live dry-run validation

### Task 27: README, production notes, dry-run validation

**Files:**
- Create: `README.md`; Modify: `docs/rysk-protocol.md` (open questions resolved by the spike: `/api/gas` echo shape,
  TTLs observed, Node requests work with the zero address), `config.example.json` if validation shows a gap.

- [ ] **Step 1: Write `README.md`**: what it is; safety model (dry-run default, double live gate, STOP file, lock);
  setup (`pnpm i`, `cast wallet import` into `keystore/`, copy config, `rysk basis suggest-anchor`, set `basisUsd`);
  commands; config reference (one line per key with units); running in production (systemd unit with
  `Restart=on-failure`, `RestartSec=30`, `TimeoutStopSec=30`, password file `0600`, journald, one instance per wallet,
  provider RPC, data growth ~10 MB/day); research data streams and how to analyze them; limitations (§1.2) and
  open questions (§12).
- [ ] **Step 1b: Add opt-in live smoke tests `src/rysk/live.test.ts`** (`describe.skipIf(!process.env.RYSK_LIVE_TESTS)`):
  `RyskRest.assets()`/`inventory()`/`caps()` parse through Task 4's parsers with `dropped === 0`; one zero-address
  `requestQuote` for the nearest-expiry ~0.25-delta put returns `ok: true` with `validUntil` within 3600 s, or `ok: false`
  with `error 'timeout'`; one `gasFee(gasPreviewBody(quote))` returns `ok: true`. Never `confirm`. Run with
  `NODE_USE_ENV_PROXY=1 pnpm test:live` from the sandbox — expected PASS.
- [ ] **Step 2: Live dry-run validation from the sandbox**: `NODE_USE_ENV_PROXY=1 pnpm rysk run --config config.example.json`
  with `tickSeconds 20` for at least 3 ticks, then stop. Expected: `data/state/*.jsonl` has ≥ 3 lines; `data/decisions`
  shows both sides with gate results; `data/quotes` has `candidate` records with `ok: true` and `aprOverIndicative` between
  1 and 4; `data/executions` has one `stage 'dry-run'` record with `echoOk: true` and `wouldApprove` set; the sampler
  wrote `inventory` records; `STATUS.json` exists; no `STOP`; `pnpm check:secrets` ok and `git status` shows no `data/`.
  Record any protocol surprise in `docs/rysk-protocol.md`.
- [ ] **Step 3: Run `pnpm check`** — PASS. **Step 4: Commit** `git commit -m "Add README, production notes and dry-run validation results"`.
- [ ] **Step 5: Push** `git push -u origin staging`.
