import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureAssets } from '../../test/helpers/wheelSnapshot.ts';
import { loadAccount } from '../chain/keystore.ts';
import { ADDRESSES, TOKENS } from '../domain/constants.ts';
import { hypeAsset } from '../domain/inventory.ts';
import { type AppConfig, parseConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { codeRevision, configHashOf, wireDaemon } from './wire.ts';

const EXAMPLE_PATH = fileURLToPath(new URL('../../config.example.json', import.meta.url));
const KEYSTORE_PATH = fileURLToPath(new URL('../../test/fixtures/keystore-anvil0.json', import.meta.url));
// The public Anvil #0 account, as in the keystore fixture.
const ANVIL0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ASSET = hypeAsset(fixtureAssets());
const CALL = { side: 'call' as const, strikeE8: 9000000000n, expirySec: 1793347200 };
const PUT = { side: 'put' as const, strikeE8: 7850000000n, expirySec: 1793347200 };
const log = createLogger({ level: 'silent', rpcUrl: 'https://rpc.example.com/evm' });

type Json = Record<string, Record<string, unknown>>;

/**
 * config.example.json with the call fallback's scope and, for live, the mode and a real account. The fallback's
 * floor (2 USD) differs from `safety.minNetPremiumUsd` (1 USD), so the checklist mapping of each is pinned.
 */
function config(scope: 'window' | 'all-listed', live = false): AppConfig {
  const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')) as Json & { call: { fallback: Json[string] } };
  raw.call.fallback.scope = scope;
  raw.call.fallback.minNetPremiumUsd = '2';
  raw.basis = { ...raw.basis, anchor: { ts: 1760000000, qtyWhype: '100', basisUsd: '50' } };
  if (live) {
    (raw as Record<string, unknown>).mode = 'live';
    (raw.account as Record<string, unknown>).address = ANVIL0;
  }
  return parseConfig(raw, { live });
}

function wire(cfg: AppConfig, extra: Partial<Parameters<typeof wireDaemon>[1]> = {}) {
  return wireDaemon(cfg, { account: null, log, signal: new AbortController().signal, ...extra });
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every line written under `<dataDir>/<stream>/`. */
function linesOf(dataDir: string, stream: string): string[] {
  const dir = join(dataDir, stream);
  return readdirSync(dir).flatMap((file) => readFileSync(join(dir, file), 'utf8').trim().split('\n'));
}

describe('wireDaemon', () => {
  it('wires dry-run without a signer or a wallet, holding no lock it needs', async () => {
    const cfg = config('window');
    const wired = wire(cfg, { configHash: '0123456789abcdef', codeRev: 'abc1234' });
    const trade = wired.tradeDeps(PUT, ASSET);

    expect(trade.mode).toBe('dry-run');
    expect(trade.signer).toBeNull();
    expect(trade.walletAddress).toBe(cfg.account.address);
    expect(trade.guards.lockHeld()).toBe(true);
    expect(trade.guards.inFlightExcludingSelf()).toBe(false);
    expect(trade.timeouts).toEqual({ requoteMs: 15_000, confirmMs: 60_000, receiptMs: 120_000 });
    expect(trade.usedQuoteNonces).toBe(wired.loopDeps.memo.usedQuoteNonces);
    expect(trade.lastNonceMs).toBe(wired.loopDeps.memo.lastNonceMs);
    await expect(
      trade.collateral.approve(TOKENS.USDC.address, ADDRESSES.marginPool, 1_000000n),
    ).rejects.toThrow('wallet client');

    expect(wired.sockets).toHaveLength(2);
    expect(wired.sockets[0]).not.toBe(wired.sockets[1]);
    expect(wired.envelope).toMatchObject({
      mode: 'dry-run',
      configHash: '0123456789abcdef',
      codeRev: 'abc1234',
    });
    expect(wire(cfg).envelope).toMatchObject({ configHash: 'unknown', codeRev: 'unknown' });
    expect(wired.envelope.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("builds each side's checklist, a call's tenor reaching a year under fallback scope 'all-listed'", () => {
    const windowed = wire(config('window'));
    expect(windowed.tradeDeps(CALL, ASSET).checks.maxDaysToExpiry).toBe(16);

    const allListed = wire(config('all-listed'));
    const call = allListed.tradeDeps(CALL, ASSET).checks;
    const put = allListed.tradeDeps(PUT, ASSET).checks;
    expect(call.maxDaysToExpiry).toBe(366);
    expect(put.maxDaysToExpiry).toBe(16);
    expect(call).toMatchObject({ minApr: 0.4, minOtmPct: 0.01, minTradeSizeE18: ASSET.minTradeSizeE18 });
    for (const checks of [call, put]) {
      expect(checks).toMatchObject({ minNetPremium6: 1_000000n, fallbackMinNetPremium6: 2_000000n });
    }
  });

  it('starts and clears the side cooldown on the confirm callbacks', () => {
    const wired = wire(config('window'));
    const { memo } = wired.loopDeps;
    const trade = wired.tradeDeps(PUT, ASSET);

    trade.onConfirmSent('put', 1_793_000_000);
    expect(memo.lastConfirmSec.put).toBe(1_793_000_000);
    expect(memo.cooldownUntilSec.put).toBe(1_793_000_000 + 1800);

    trade.onConfirmCleared('put');
    expect(memo.lastConfirmSec.put).toBeUndefined();
  });

  it("redacts the RPC URL from every record through one recorder: the loop's, sellOption's and the sampler's", () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'rysk-wire-'));
    tempDirs.push(dataDir);
    const rpcUrl = 'https://rpc.example.org/evm/0123456789abcdefKEY';
    const cfg = { ...config('window'), dataDir, rpcUrl };
    const wired = wire(cfg);
    expect(wired.samplerDeps.recorder).toBe(wired.loopDeps.recorder);

    wired.loopDeps.recorder.append('decisions', { detail: `upstream ${rpcUrl} refused` });
    wired.samplerDeps.recorder.append('quotes', {
      message: `via https://proxy.example/evm/0123456789abcdefKEY`,
    });
    wired.tradeDeps(PUT, ASSET).record({ execId: 'e1', step: 'gas', detail: { error: `${rpcUrl}/x` } });

    const lines = [
      ...linesOf(dataDir, 'decisions'),
      ...linesOf(dataDir, 'quotes'),
      ...linesOf(dataDir, 'executions'),
    ];
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toContain('0123456789abcdefKEY');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      kind: 'decisions',
      detail: 'upstream <rpc> refused',
    });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ message: 'via https://proxy.example<rpc>' });
    expect(JSON.parse(lines[2] ?? '{}')).toMatchObject({ execId: 'e1', detail: { error: '<rpc>/x' } });
  });

  it('signs in live as the configured account only, and needs the lock held', () => {
    const cfg = config('window', true);
    const account = loadAccount(KEYSTORE_PATH, 'hunter2');

    expect(() => wire(cfg)).toThrow('live mode needs the decrypted account');
    const other = config('window', true);
    other.account = { ...other.account, address: TOKENS.WHYPE.address };
    expect(() => wire(other, { account })).toThrow('is not the configured');

    const unlocked = wire(cfg, { account }).tradeDeps(PUT, ASSET);
    expect(unlocked.mode).toBe('live');
    expect(unlocked.signer?.address).toBe(account.address);
    expect(unlocked.guards.lockHeld()).toBe(false);
    const lock = { held: true, release: () => {} };
    const locked = wire(cfg, { account, lock }).tradeDeps(PUT, ASSET);
    expect(locked.guards.lockHeld()).toBe(true);
    lock.held = false;
    expect(locked.guards.lockHeld()).toBe(false);
  });
});

describe('the record envelope', () => {
  it('hashes the config bytes to 16 hex characters', () => {
    expect(configHashOf('{}')).toBe('44136fa355b3678a');
    expect(configHashOf(readFileSync(EXAMPLE_PATH))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('names the checkout revision, marked when the working tree has changes', () => {
    // `git describe --always --dirty`: a short sha or a tag description, `-dirty` with uncommitted changes.
    expect(codeRevision()).toMatch(/^([0-9A-Za-z._/-]*[0-9a-f]{4,40}(-dirty)?|unknown)$/);
  });
});
