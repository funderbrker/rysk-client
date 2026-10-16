import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import type { Logger } from 'pino';
import { read } from 'read';
import { isAddressEqual } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { assertChainId, createChainClients } from '../chain/clients.ts';
import { loadAccount, resolvePassword } from '../chain/keystore.ts';
import {
  type AppConfig,
  acquireLock,
  codeRevision,
  configHashOf,
  createLogger,
  type Lock,
  LockHeldError,
  runLoop,
  runSampler,
  type Wired,
  wireDaemon,
} from '../daemon/index.ts';
import { CHAIN_ID } from '../domain/constants.ts';
import { deriveState } from '../strategy/wheel/index.ts';
import type { RunCommand } from './args.ts';

/** Spec §9.4: after SIGINT or SIGTERM the process exits within this, whatever is still running. */
const HARD_EXIT_MS = 20_000;
/** The forced exit's code (2 is a usage error); the usage text lists both. */
const HARD_EXIT_CODE = 3;

/** What the daemon runs with once startup has passed. */
type Started = {
  log: Logger;
  account: PrivateKeyAccount | null;
  lock: Lock | null;
  controller: AbortController;
  shutdown: (reason: string) => void;
};

/**
 * `rysk run` (spec §9.1, §9.4, §9.5): the daemon loop and, unless `--no-sampler` or `sampler.enabled` is false, the
 * research sampler, until SIGINT or SIGTERM, or `--max-trades` completed executions. Live only (`--live` and mode
 * "live"): takes `live.lock`, decrypts the keystore (prompting on a TTY, else `KEYSTORE_PASSWORD_FILE`), and requires
 * its address to be the configured account and an EOA. Dry-run never touches the keystore. Both modes check the chain
 * id, start the frontend version tripwire and log one startup summary (the RPC host only, never its URL).
 *
 * The process handlers come first, so a signal during startup stops it at the next step and still releases the lock.
 * A signal aborts everything: the sockets close at once, `sellOption` stops before any confirm it has not sent, and the
 * process exits within 20 s regardless (code 3). An unhandled rejection or exception logs fatal and exits 1. Resolves
 * to the exit code: 0 after a clean stop (a signal during startup included), 1 when startup fails.
 */
export async function runCommand(cmd: RunCommand, loaded: AppConfig): Promise<number> {
  const config: AppConfig = cmd.maxTrades === undefined ? loaded : { ...loaded, maxTrades: cmd.maxTrades };
  const log = createLogger({ level: config.logLevel, rpcUrl: config.rpcUrl });
  const controller = new AbortController();
  const shutdown = installProcessHandlers(log, controller);
  let lock: Lock | null = null;
  // Every exit path, `process.exit` from a handler included; `release` is idempotent.
  process.once('exit', () => lock?.release());
  const stoppedDuringStartup = (): number => {
    log.info('stopped during startup');
    return 0;
  };
  try {
    for (const warning of config.warnings) log.warn(warning);
    warnIfKeystoreTracked(log);
    let account: PrivateKeyAccount | null = null;
    if (config.mode === 'live') {
      try {
        lock = acquireLock(config.dataDir);
      } catch (error) {
        if (!(error instanceof LockHeldError)) throw error;
        log.fatal({ err: error }, 'another live instance holds the lock');
        return 1;
      }
      try {
        account = await decryptAccount(config);
      } catch (error) {
        log.fatal({ err: error }, 'cannot load the trading account');
        return 1;
      }
      if (!isAddressEqual(account.address, config.account.address)) {
        log.fatal(
          { keystoreAddress: account.address, configuredAddress: config.account.address },
          'the keystore is not the configured account',
        );
        return 1;
      }
      if (controller.signal.aborted) return stoppedDuringStartup();
    }
    if (!(await chainChecksPass(config, log))) return 1;
    if (controller.signal.aborted) return stoppedDuringStartup();
    return await runDaemon(cmd, config, { log, account, lock, controller, shutdown });
  } finally {
    lock?.release();
  }
}

/**
 * SIGINT and SIGTERM abort `controller` (once) and arm the hard exit; an unhandled rejection or exception logs fatal
 * and exits 1. Returns the shutdown, which the run calls itself when the loop ends.
 */
function installProcessHandlers(log: Logger, controller: AbortController): (reason: string) => void {
  const shutdown = (reason: string): void => {
    if (controller.signal.aborted) return;
    log.warn({ reason }, 'shutting down');
    controller.abort();
    setTimeout(() => {
      log.error({ afterMs: HARD_EXIT_MS }, 'shutdown did not finish in time: exiting');
      process.exit(HARD_EXIT_CODE);
    }, HARD_EXIT_MS).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => exitFatal(log, reason, 'unhandled rejection'));
  process.on('uncaughtException', (error) => exitFatal(log, error, 'uncaught exception'));
  return shutdown;
}

/** The wiring, the tripwire, the startup summary, then the loop and the sampler until either ends. */
async function runDaemon(cmd: RunCommand, config: AppConfig, started: Started): Promise<number> {
  const { log, account, lock, controller, shutdown } = started;
  const { signal } = controller;
  const configHash = configHashOf(readFileSync(cmd.config));
  const codeRev = codeRevision();
  const wired = wireDaemon(config, { account, log, signal, lock, configHash, codeRev });
  const closeSockets = (): void => {
    for (const socket of wired.sockets) socket.close();
  };
  // `JsonRpcSocket.close()` is not terminal: a later call would reconnect. No confirm goes out after shutdown because
  // `sellOption` checks the signal synchronously right before `rpc.confirm`, and every caller passes this signal,
  // aborted from then on. Closing at once drops the frames already queued.
  signal.addEventListener('abort', closeSockets, { once: true });

  await wired.version.start();
  if (wired.version.sha === null) {
    log.warn('frontend version unknown: the tripwire stays inactive until a version check succeeds');
  }
  const samplerOn = cmd.sampler && config.sampler.enabled;
  log.info(await startupSummary(config, wired, samplerOn), 'rysk daemon starting');

  // Caught at once: a rejection must not wait for the loop to end to be handled.
  const sampler = (samplerOn ? runSampler(wired.samplerDeps, config.sampler) : Promise.resolve()).catch(
    (error: unknown) => log.error({ err: error }, 'the sampler failed'),
  );
  let code = 0;
  try {
    await runLoop(wired.loopDeps, config);
    if (!signal.aborted) log.info({ maxTrades: config.maxTrades }, 'max trades reached');
  } catch (error) {
    log.fatal({ err: error }, 'the loop failed');
    code = 1;
  }
  shutdown('loop ended');
  await sampler;
  closeSockets();
  wired.version.stop();
  log.info({ code }, 'rysk daemon stopped');
  return code;
}

/** The keystore decrypted with the password from a hidden prompt (TTY) or `KEYSTORE_PASSWORD_FILE` (owner-only). */
async function decryptAccount(config: AppConfig): Promise<PrivateKeyAccount> {
  const password = await resolvePassword({
    isTTY: process.stdin.isTTY === true,
    env: process.env,
    prompt: (message) => read({ prompt: message, silent: true, replace: '', output: process.stderr }),
    readFile: (path) => readFileSync(path, 'utf8'),
    fileMode: (path) => statSync(path).mode,
  });
  return loadAccount(config.account.keystorePath, password);
}

/** The RPC serves chain 999 and, in live, the account has no code (an EOA; `isEIP1271` is pinned false). */
async function chainChecksPass(config: AppConfig, log: Logger): Promise<boolean> {
  const { publicClient } = createChainClients({ rpcUrl: config.rpcUrl });
  try {
    await assertChainId(publicClient, CHAIN_ID);
    if (config.mode === 'live') {
      const code = await publicClient.getCode({ address: config.account.address });
      if (code !== undefined && code !== '0x') {
        log.fatal({ address: config.account.address }, 'the account has contract code: live needs an EOA');
        return false;
      }
    }
    return true;
  } catch (error) {
    log.fatal({ err: error }, 'startup chain check failed');
    return false;
  }
}

/**
 * The startup log (spec §9.5): mode, the RPC host (never the URL, which may carry a key), the chain, the account,
 * its balances and vault counter, the derived state, the frontend sha and the config without secrets. A failed
 * snapshot is reported in it and the loop holds until one succeeds.
 */
async function startupSummary(config: AppConfig, wired: Wired, samplerOn: boolean): Promise<object> {
  const summary = {
    mode: config.mode,
    rpcHost: new URL(config.rpcUrl).host,
    chainId: CHAIN_ID,
    address: config.account.address,
    runId: wired.envelope.runId,
    codeRev: wired.envelope.codeRev,
    configHash: wired.envelope.configHash,
    frontendSha: wired.version.sha,
    maxTrades: config.maxTrades ?? null,
    sampler: samplerOn,
    config: {
      tickSeconds: config.tickSeconds,
      dataDir: config.dataDir,
      logLevel: config.logLevel,
      keystorePath: config.account.keystorePath,
      rysk: config.rysk,
      wheel: config.wheel,
      sampler: config.sampler,
    },
  };
  try {
    const s = await wired.loopDeps.snapshot();
    const st = deriveState(s, config.wheel);
    const { chain } = s;
    return {
      ...summary,
      block: { number: chain.blockNumber, ts: chain.blockTs },
      balances: {
        nativeHypeE18: chain.nativeHypeE18,
        whypeE18: chain.whypeE18,
        usdc6: chain.usdc6,
        usdt06: chain.usdt06,
        allowanceUsdc6: chain.allowanceUsdc6,
        allowanceWhypeE18: chain.allowanceWhypeE18,
      },
      vaultCounter: chain.vaultCounter,
      state: {
        spotE8: s.market.spotE8,
        positions: s.positions.length,
        listings: s.market.listings.length,
        consistency: st.consistency,
        capital: st.capital,
        basis: st.basis,
        lastDeployTs: st.lastDeployTs,
        deploymentsLast24h: st.deploymentsLast24h,
        notionalLast24h6: st.notionalLast24h6,
        anomalies: st.anomalies,
        warnings: st.warnings,
      },
    };
  } catch (error) {
    return { ...summary, snapshotError: error instanceof Error ? error.message : String(error) };
  }
}

/** Spec §5.1: a keystore tracked by git is one push away from public. */
function warnIfKeystoreTracked(log: Logger): void {
  let tracked: string;
  try {
    tracked = execFileSync('git', ['ls-files', '--', 'keystore'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return;
  }
  if (tracked !== '') {
    log.warn(
      { files: tracked.split('\n').length },
      'git tracks files under keystore/: remove them from the index',
    );
  }
}

function exitFatal(log: Logger, error: unknown, message: string): void {
  try {
    log.fatal({ err: error }, message);
  } finally {
    process.exit(1);
  }
}
