import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { type Address, isAddressEqual, parseGwei } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { vaultStoreAbi } from '../chain/abi.ts';
import { createChainClients } from '../chain/clients.ts';
import { createApproveDeps } from '../chain/erc20.ts';
import { verifyFillReceipt } from '../chain/receipts.ts';
import { ADDRESSES, TRADED_PRODUCTS } from '../domain/constants.ts';
import { hypeAsset } from '../domain/inventory.ts';
import type { Asset, Quote } from '../domain/types.ts';
import { gasPreviewBody } from '../execution/body.ts';
import { sellOption } from '../execution/sell.ts';
import type { ExecutionEvent, TradeDeps } from '../execution/types.ts';
import { sleep } from '../lib/time.ts';
import {
  type ConfirmationMessage,
  makerSignatureOk,
  recoverQuoteSigner,
  signConfirmation,
} from '../rysk/eip712.ts';
import { RyskRest } from '../rysk/rest.ts';
import { JsonRpcSocket } from '../rysk/socket.ts';
import { RyskTaker } from '../rysk/taker.ts';
import type { Candidate, QuoteOutcome, Snapshot } from '../strategy/wheel/types.ts';
import { combinedBucket, HARD_CAP_RFQ_PER_MIN, type RfqBucket, TokenBucket } from './bucket.ts';
import type { AppConfig } from './config.ts';
import type { Lock } from './lock.ts';
import { redactRecord } from './logger.ts';
import type { LoopDeps } from './loop.ts';
import { Memo } from './memo.ts';
import { Recorder, type RecorderEnvelope, type RecordStream } from './recorder.ts';
import type { SamplerDeps } from './sampler.ts';
import { gatherSnapshot, type SnapshotSources } from './snapshot.ts';
import { stopFilePresent, writeStatus, writeStopFile } from './status.ts';
import { type ExecutedInstrument, executionConfig, freshStateOf } from './trade.ts';
import { FrontendVersionWatcher } from './version.ts';

export type WireOptions = {
  /** The decrypted trading account, live only; dry-run never loads the keystore and passes `null`. */
  account: PrivateKeyAccount | null;
  log: Logger;
  /** Aborted on shutdown: ends the loop and the sampler, and `sellOption` checks it right before `confirm`. */
  signal: AbortSignal;
  /** The `live.lock` taken (live): check C1 requires it held. Dry-run takes none and needs none. */
  lock?: Lock | null;
  /** `configHashOf` the config file's bytes, for the record envelope (`'unknown'` when not given). */
  configHash?: string;
  /** `codeRevision()`, for the record envelope (`'unknown'` when not given: the one-shot commands record nothing). */
  codeRev?: string;
};

export type Wired = {
  loopDeps: LoopDeps;
  samplerDeps: SamplerDeps;
  /** The strategy's and the sampler's sockets: close them on shutdown so no queued frame is sent later. */
  sockets: JsonRpcSocket[];
  version: FrontendVersionWatcher;
  /** `sellOption`'s deps for one execution of `target`, its checklist sized by the WHYPE `asset`. */
  tradeDeps(target: ExecutedInstrument, asset: Asset): TradeDeps;
  envelope: RecorderEnvelope;
};

const RECEIPT_TIMEOUT_MS = 120_000;
const VERSION_POLL_MS = 3_600_000;
const HASH_HEX_CHARS = 16;
const GIT_TIMEOUT_MS = 2_000;

/**
 * Builds the daemon from its config (spec §9): one Rysk REST client feeding the memo's server skew, a JSON-RPC socket
 * and taker each for the strategy and the sampler, batched HyperEVM clients (a wallet client in live only), the
 * recorder, the memo and the frontend version tripwire. Nothing connects or starts here: sockets open on their first
 * call and the tripwire on `version.start()`.
 *
 * - `loopDeps.snapshot` gathers a snapshot and keeps it as the latest, whose listings and spot the sampler reads.
 * - `loopDeps.quote` takes a strategy token (12/min and the shared 20/min), sends the RFQ, then previews its gas and
 *   checks the maker's signature.
 * - `loopDeps.execute` runs `sellOption` in the configured mode; only live has a signer.
 * - Executions are serialized by the loop (`memo.inFlight`), so no other execution is ever in flight
 *   (`guards.inFlightExcludingSelf` is false) and the fresh state evaluates gate G8 without the running one.
 * - The execution's re-quote goes straight to the strategy taker and takes no token, from the strategy bucket or the
 *   shared hard cap: waiting for one would spend the quote's TTL. There is at most one per execution, and executions
 *   are few: they run one at a time, each after its own RFQ round trip and gas preview; a side whose confirm was sent
 *   cools down (60 s after a refusal or revert, else until the fill or other evidence shows), and one that aborted
 *   before the confirm backs its key off. With the config keeping `strategyRfqPerMin + samplerRfqPerMin` at most 18,
 *   the 2 a minute left under the 20-a-minute hard cap cover the re-quotes.
 * - Every record (the loop's, `sellOption`'s and the sampler's) goes through one redacting recorder, which replaces
 *   the RPC URL and provider keys with `<rpc>` (`redactRecord`).
 */
export function wireDaemon(config: AppConfig, opts: WireOptions): Wired {
  const { log, signal } = opts;
  const { mode, dataDir, rpcUrl } = config;
  const c = config.wheel;
  const self = config.account.address;
  const account = mode === 'live' ? liveAccount(opts.account, self) : null;
  const lock = opts.lock ?? null;

  const memo = new Memo(Date.now());
  const clock = {
    nowMs: () => Date.now(),
    serverNowSec: () => Math.floor((Date.now() - memo.serverSkewMs) / 1000),
  };
  const rest = new RyskRest({
    baseUrl: config.rysk.restUrl,
    onServerDate: (serverMs) => memo.observeServerDate(serverMs, clock.nowMs()),
  });
  const socketFor = (component: string): JsonRpcSocket =>
    new JsonRpcSocket({ url: config.rysk.wsUrl, logger: log.child({ component }) });
  const strategySocket = socketFor('strategy-socket');
  const samplerSocket = socketFor('sampler-socket');
  const takerClock = { nowSec: clock.serverNowSec, nowMs: clock.nowMs };
  const strategyTaker = new RyskTaker(strategySocket, takerClock);
  const samplerTaker = new RyskTaker(samplerSocket, takerClock);

  const { publicClient, walletClient } = createChainClients({
    rpcUrl,
    ...(account === null ? {} : { account }),
  });
  const approveDeps = createApproveDeps(publicClient, walletClient, {
    maxFeePerGas: parseGwei(String(c.safety.maxFeePerGasGwei)),
  });
  const vaultCounter = (): Promise<bigint> =>
    publicClient.readContract({
      address: ADDRESSES.vaultStore,
      abi: vaultStoreAbi,
      functionName: 'getAccountVaultCounter',
      args: [self],
    });

  const envelope: RecorderEnvelope = {
    runId: randomUUID(),
    mode,
    codeRev: opts.codeRev ?? 'unknown',
    configHash: opts.configHash ?? 'unknown',
  };
  const fileRecorder = new Recorder({ dataDir, envelope, clock });
  const recorder: Pick<Recorder, 'append'> = {
    append: (stream: RecordStream, body: object) => fileRecorder.append(stream, redactRecord(body, rpcUrl)),
  };

  const version = new FrontendVersionWatcher({
    appUrl: config.rysk.appUrl,
    fetch: (input, init) => fetch(input, init),
    intervalMs: VERSION_POLL_MS,
    onError: (error) => {
      try {
        log.warn({ err: error }, 'frontend version check failed');
      } catch {
        // The watcher must never see a throw.
      }
    },
  });

  const hardCap = new TokenBucket(HARD_CAP_RFQ_PER_MIN, clock);
  const strategyBucket = combinedBucket(new TokenBucket(c.quoting.strategyRfqPerMin, clock), hardCap);
  const samplerBucket = combinedBucket(new TokenBucket(c.quoting.samplerRfqPerMin, clock), hardCap);

  const sources: SnapshotSources = { chain: publicClient, rest, self, clock, memo, mode, log };
  let latest: Snapshot | null = null;
  const snapshot = async (): Promise<Snapshot> => {
    const s = await gatherSnapshot(sources);
    latest = s;
    return s;
  };

  const quote = async (candidate: Candidate): Promise<QuoteOutcome> => {
    const requestedAtMs = clock.nowMs();
    if (!(await tokenFrom(strategyBucket, signal))) {
      return { ok: false, error: 'socket-closed', message: 'shutdown: RFQ not sent', requestedAtMs };
    }
    const result = await strategyTaker.requestQuote(candidate.request, {
      timeoutMs: c.quoting.rfqTimeoutMs,
      signal,
    });
    if (!result.ok) return result;
    const [gas, makerSigOk] = await Promise.all([
      gasPreview(rest, result.quote, log),
      makerSignatureOk(result.quote, recoverQuoteSigner),
    ]);
    return { ...result, makerSigOk, gas };
  };

  const signer =
    account === null
      ? null
      : {
          address: account.address,
          signConfirmation: (message: ConfirmationMessage) => signConfirmation(account, message),
        };

  const tradeDeps = (target: ExecutedInstrument, asset: Asset): TradeDeps => ({
    mode,
    signal,
    walletAddress: self,
    freshState: async () => {
      const token = TRADED_PRODUCTS[target.side].collateralAsset;
      const [taken, allowance] = await Promise.all([
        gatherSnapshot(sources),
        approveDeps.allowance(token, self, ADDRESSES.marginPool),
      ]);
      const reads = { allowance, stopFile: stopFilePresent(dataDir), frontendChanged: version.changed };
      return freshStateOf(target, taken, c, reads);
    },
    quotes: strategyTaker,
    rest,
    rpc: strategyTaker,
    collateral: { ...approveDeps, vaultCounter },
    signer,
    clock,
    record: (event) => recorder.append('executions', event),
    checks: executionConfig(target.side, c, asset),
    verifyReceipt: verifyFillReceipt,
    writeStop: (reason) => writeStopFile(dataDir, reason),
    timeouts: {
      requoteMs: c.quoting.rfqTimeoutMs,
      confirmMs: c.safety.confirmTimeoutMs,
      receiptMs: RECEIPT_TIMEOUT_MS,
    },
    usedQuoteNonces: memo.usedQuoteNonces,
    lastNonceMs: memo.lastNonceMs,
    onConfirmSent: (side, atSec) => {
      memo.lastConfirmSec[side] = atSec;
      // The loop's `applyTradeResult` replaces this with the result's own cooldown.
      memo.cooldownUntilSec[side] = atSec + c.safety.unknownMaxWaitSec;
    },
    onConfirmCleared: (side) => {
      delete memo.lastConfirmSec[side];
    },
    guards: {
      stopFile: () => stopFilePresent(dataDir),
      lockHeld: () => lock?.held ?? mode === 'dry-run',
      inFlightExcludingSelf: () => false,
    },
    recoverMaker: async (q) => {
      try {
        return await recoverQuoteSigner(q);
      } catch {
        return null;
      }
    },
  });

  const loopDeps: LoopDeps = {
    snapshot,
    quote,
    execute: (intent, onExecId) => {
      if (latest === null) throw new Error('no snapshot yet to size the checklist from');
      const deps = tradeDeps(intent.candidate, hypeAsset(latest.market.assets));
      return sellOption({ ...deps, record: reportingExecId(deps.record, onExecId) }, intent);
    },
    vaultCounter,
    recorder,
    status: (status) => writeStatus(dataDir, status),
    stopFile: () => stopFilePresent(dataDir),
    frontendChanged: () => version.changed,
    frontendSha: () => version.sha,
    writeStop: (reason) => writeStopFile(dataDir, reason),
    clock,
    log: log.child({ component: 'loop' }),
    memo,
    signal,
    sleep,
  };

  const samplerDeps: SamplerDeps = {
    taker: samplerTaker,
    rest,
    recorder,
    bucket: samplerBucket,
    clock,
    sleep,
    signal,
    listings: () => latest?.market.listings ?? [],
    isExecuting: () => memo.inFlight,
    self,
    recoverMaker: recoverQuoteSigner,
    spotE8: () => latest?.market.spotE8 ?? null,
    log: log.child({ component: 'sampler' }),
  };

  return {
    loopDeps,
    samplerDeps,
    sockets: [strategySocket, samplerSocket],
    version,
    tradeDeps,
    envelope,
  };
}

/** The first 16 hex characters of the SHA-256 of the config file's bytes. */
export function configHashOf(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, HASH_HEX_CHARS);
}

/**
 * `git describe --always --dirty` of this checkout: the short sha (or the nearest tag), with `-dirty` when the
 * working tree has uncommitted changes; `'unknown'` outside a checkout, or when git takes over 2 s.
 */
export function codeRevision(): string {
  try {
    const rev = execFileSync('git', ['describe', '--always', '--dirty'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    return rev === '' ? 'unknown' : rev;
  } catch {
    return 'unknown';
  }
}

/** `record`, first passing the execution's id to `onExecId` (once, on its first record). */
function reportingExecId(
  record: (event: ExecutionEvent) => void,
  onExecId: ((execId: string) => void) | undefined,
): (event: ExecutionEvent) => void {
  let reported = false;
  return (event) => {
    if (!reported) {
      reported = true;
      onExecId?.(event.execId);
    }
    record(event);
  };
}

/** Live trades as the configured account and nothing else. */
function liveAccount(account: PrivateKeyAccount | null, self: Address): PrivateKeyAccount {
  if (account === null) throw new Error('live mode needs the decrypted account');
  if (!isAddressEqual(account.address, self)) {
    throw new Error(`the keystore's account ${account.address} is not the configured ${self}`);
  }
  return account;
}

/** Waits for a token from `bucket`; false once `signal` aborts. */
async function tokenFrom(bucket: RfqBucket, signal: AbortSignal): Promise<boolean> {
  while (!signal.aborted) {
    if (bucket.take()) return true;
    await sleep(Math.max(1, bucket.waitMs()), signal);
  }
  return false;
}

/** The quote's gas through the app's 9-field preview; a failed call is an `http` failure, logged. */
async function gasPreview(
  rest: RyskRest,
  quote: Quote,
  log: Logger,
): Promise<Extract<QuoteOutcome, { ok: true }>['gas']> {
  try {
    const gas = await rest.gasFee(gasPreviewBody(quote));
    return gas.ok ? { ok: true, gasFee6: gas.gasFee6 } : { ok: false, reason: gas.reason };
  } catch (error) {
    log.warn({ err: error }, 'gas preview failed');
    return { ok: false, reason: 'http' };
  }
}
